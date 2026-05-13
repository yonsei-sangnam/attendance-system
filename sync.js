const { google } = require('googleapis');
const db = require('./db');

// ─── Google Sheets 인증 ──────────────────────────────────────
function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
  if (!creds.client_email) throw new Error('GOOGLE_CREDENTIALS 환경변수가 설정되지 않았습니다.');

  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}


// ─── 과정별 출결 데이터 조회 ─────────────────────────────────
async function getCourseAttendanceData(courseId) {
  // 과정 정보
  const courseRes = await db.query(
    'SELECT course_name, cohort FROM courses WHERE course_id = $1', [courseId]
  );
  if (courseRes.rows.length === 0) throw new Error('과정 없음');
  const course = courseRes.rows[0];

  // 회차 목록
  const sessionsRes = await db.query(`
    SELECT session_id, session_number, session_date, late_cutoff, early_leave_cutoff
    FROM course_sessions WHERE course_id = $1 ORDER BY session_number
  `, [courseId]);
  const sessions = sessionsRes.rows;

  // 수강생 + 출결
  const studentsRes = await db.query(`
    SELECT s.student_id, s.name, s.phone
    FROM students s
    JOIN enrollments e ON e.student_id = s.student_id
    WHERE e.course_id = $1 AND s.status = 'active'
    ORDER BY s.name
  `, [courseId]);
  const students = studentsRes.rows;

  // 출결 기록 전체 조회
  const attendanceRes = await db.query(`
    SELECT a.student_id, a.session_id, a.status, a.check_in_at, a.check_out_at
    FROM attendance a
    WHERE a.session_id IN (SELECT session_id FROM course_sessions WHERE course_id = $1)
  `, [courseId]);

  // 학생ID+세션ID → 출결 매핑
  const attendanceMap = {};
  for (const a of attendanceRes.rows) {
    attendanceMap[a.student_id + '_' + a.session_id] = a;
  }

  return { course, sessions, students, attendanceMap };
}


// ─── 출결요약 시트 데이터 생성 ───────────────────────────────
function buildSummarySheet(data) {
  const { course, sessions, students, attendanceMap } = data;
  const rows = [];

  // 1행: 제목
  rows.push([`${course.course_name} ${course.cohort || ''} 출결`]);

  // 2행: 헤더 - 회차 번호
  const header1 = ['이름'];
  for (const s of sessions) header1.push(s.session_number + '회');
  header1.push('출석일계', '지각일계', '조퇴일계', '결석일계', '출석률');
  rows.push(header1);

  // 3행: 헤더 - 날짜
  const header2 = [''];
  for (const s of sessions) {
    const d = s.session_date ? new Date(s.session_date) : null;
    header2.push(d ? `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')}` : '');
  }
  header2.push('', '', '', '', '');
  rows.push(header2);

  // 4행: 지각/조퇴 기준
  const header3 = ['[기준시간]'];
  for (const s of sessions) {
    const late = s.late_cutoff ? s.late_cutoff.slice(0, 5) : '';
    const early = s.early_leave_cutoff ? s.early_leave_cutoff.slice(0, 5) : '';
    header3.push(`지각${late}/조퇴${early}`);
  }
  header3.push('', '', '', '', '');
  rows.push(header3);

  // 수강생별 출결
  for (const student of students) {
    const row = [student.name];
    let attended = 0, late = 0, earlyLeave = 0, absent = 0;

    for (const session of sessions) {
      const key = student.student_id + '_' + session.session_id;
      const a = attendanceMap[key];

      if (!a) {
        row.push('');  // 미래 회차 또는 미체크
      } else {
        row.push(a.status || '');
        if (a.status === '출석') attended++;
        else if (a.status === '지각') late++;
        else if (a.status === '조퇴') earlyLeave++;
        else if (a.status === '결석') absent++;
      }
    }

    const total = attended + late + earlyLeave + absent;
    const rate = total > 0 ? Math.round((attended / sessions.length) * 100) + '%' : '';

    row.push(attended, late, earlyLeave, absent, rate);
    rows.push(row);
  }

  return rows;
}


// ─── 회차별 상세 시트 데이터 생성 ────────────────────────────
function buildSessionSheet(data, sessionIndex) {
  const { sessions, students, attendanceMap } = data;
  const session = sessions[sessionIndex];
  if (!session) return null;

  const rows = [];

  // 헤더
  rows.push(['이름', '입실', '퇴실', '상태', '퇴실유형']);

  // 수강생별
  for (const student of students) {
    const key = student.student_id + '_' + session.session_id;
    const a = attendanceMap[key];

    if (a) {
      const checkIn = a.check_in_at ? new Date(a.check_in_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
      const checkOut = a.check_out_at ? new Date(a.check_out_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
      rows.push([student.name, checkIn, checkOut, a.status || '', '']);
    } else {
      rows.push([student.name, '', '', '', '']);
    }
  }

  return rows;
}


// ─── 구글시트로 동기화 (메인 함수) ───────────────────────────
async function syncToGoogleSheets(courseId, spreadsheetId) {
  const sheets = getSheets();
  const data = await getCourseAttendanceData(courseId);

  // 1. 기존 시트 탭 목록 확인
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);

  // 2. "출결요약" 시트 업데이트/생성
  const summaryTitle = '출결요약';
  if (!existingSheets.includes(summaryTitle)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: summaryTitle } } }] },
    });
  }

  const summaryData = buildSummarySheet(data);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${summaryTitle}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: summaryData },
  });

  // 3. 회차별 시트 업데이트/생성
  for (let i = 0; i < data.sessions.length; i++) {
    const session = data.sessions[i];
    const sheetTitle = `${session.session_number}회`;

    if (!existingSheets.includes(sheetTitle)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: sheetTitle } } }] },
      });
    }

    const sessionData = buildSessionSheet(data, i);
    if (sessionData) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetTitle}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: sessionData },
      });
    }
  }

  return {
    success: true,
    courseName: data.course.course_name,
    sheetsUpdated: data.sessions.length + 1,
    studentsCount: data.students.length,
  };
}


// ─── 전체 과정 동기화 ────────────────────────────────────────
async function syncAllCourses() {
  // 과정별 스프레드시트 매핑 (DB에서 조회)
  const courses = await db.query(`
    SELECT course_id, course_name, spreadsheet_id
    FROM courses WHERE spreadsheet_id IS NOT NULL
  `);

  const results = [];
  for (const c of courses.rows) {
    try {
      const r = await syncToGoogleSheets(c.course_id, c.spreadsheet_id);
      results.push({ ...r, status: 'success' });
    } catch (err) {
      results.push({ courseName: c.course_name, status: 'error', error: err.message });
    }
  }
  return results;
}


module.exports = { syncToGoogleSheets, syncAllCourses };
