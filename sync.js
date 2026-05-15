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
  const courseRes = await db.query(
    'SELECT course_name, cohort FROM courses WHERE course_id = $1', [courseId]
  );
  if (courseRes.rows.length === 0) throw new Error('과정 없음');
  const course = courseRes.rows[0];

  const sessionsRes = await db.query(`
    SELECT session_id, session_number, session_date, late_cutoff, early_leave_cutoff
    FROM course_sessions WHERE course_id = $1 ORDER BY session_number
  `, [courseId]);
  const sessions = sessionsRes.rows;

  const studentsRes = await db.query(`
    SELECT s.student_id, s.name, s.phone
    FROM students s
    JOIN enrollments e ON e.student_id = s.student_id
    WHERE e.course_id = $1 AND s.status = 'active'
    ORDER BY s.name
  `, [courseId]);
  const students = studentsRes.rows;

  const attendanceRes = await db.query(`
    SELECT a.student_id, a.session_id, a.status, a.check_in_at, a.check_out_at, a.exit_type
    FROM attendance a
    WHERE a.session_id IN (SELECT session_id FROM course_sessions WHERE course_id = $1)
  `, [courseId]);

  const attendanceMap = {};
  for (const a of attendanceRes.rows) {
    attendanceMap[a.student_id + '_' + a.session_id] = a;
  }

  return { course, sessions, students, attendanceMap };
}


// ─── 출결 상태 결정 (세분화) ─────────────────────────────────
function getDetailedStatus(a) {
  if (!a) return '';  // 기록 없음 (미래 회차 등)

  const hasIn = !!a.check_in_at;
  const hasOut = !!a.check_out_at;

  if (!hasIn && !hasOut) return '결석';
  if (!hasIn && hasOut) return '입실누락';
  if (hasIn && !hasOut) return '퇴실누락';

  // 입실O, 퇴실O → DB 상태 사용
  return a.status || '출석';
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
  header1.push('출석', '지각', '조퇴', '결석', '입실누락', '퇴실누락', '출석률');
  rows.push(header1);

  // 3행: 헤더 - 날짜
  const header2 = [''];
  for (const s of sessions) {
    const d = s.session_date ? new Date(s.session_date) : null;
    header2.push(d ? `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')}` : '');
  }
  header2.push('', '', '', '', '', '', '');
  rows.push(header2);

  // 4행: 지각/조퇴 기준
  const header3 = ['[기준시간]'];
  for (const s of sessions) {
    const late = s.late_cutoff ? s.late_cutoff.slice(0, 5) : '';
    const early = s.early_leave_cutoff ? s.early_leave_cutoff.slice(0, 5) : '';
    header3.push(`지각${late}/조퇴${early}`);
  }
  header3.push('', '', '', '', '', '', '');
  rows.push(header3);

  // 수강생별 출결
  for (const student of students) {
    const row = [student.name];
    let attended = 0, late = 0, earlyLeave = 0, absent = 0, missedIn = 0, missedOut = 0;

    for (const session of sessions) {
      const key = student.student_id + '_' + session.session_id;
      const a = attendanceMap[key];
      const status = getDetailedStatus(a);

      row.push(status);
      if (status === '출석') attended++;
      else if (status === '지각') late++;
      else if (status === '조퇴') earlyLeave++;
      else if (status === '결석') absent++;
      else if (status === '입실누락') missedIn++;
      else if (status === '퇴실누락') missedOut++;
    }

    const totalSessions = sessions.length;
    const rate = totalSessions > 0 ? Math.round((attended / totalSessions) * 100) + '%' : '';

    row.push(attended, late, earlyLeave, absent, missedIn, missedOut, rate);
    rows.push(row);
  }

  return rows;
}


// ─── 출결요약 시트 색상 포맷팅 ───────────────────────────────
async function formatSummarySheet(sheets, spreadsheetId, sheetTitle, data) {
  // 시트 ID 조회
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = spreadsheet.data.sheets.find(s => s.properties.title === sheetTitle);
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;

  const numStudents = data.students.length;
  const numSessions = data.sessions.length;

  // 데이터 범위: 5행(헤더4행 + 학생시작)부터, B열(2열)부터 세션수만큼
  const startRow = 4;  // 0-indexed (5행)
  const endRow = startRow + numStudents;
  const startCol = 1;  // B열 (0-indexed)
  const endCol = startCol + numSessions;

  // 색상 정의 (RGB 0~1)
  const colors = {
    '출석':   { red: 0.9, green: 0.96, blue: 0.92 },   // 연한 초록
    '지각':   { red: 1.0, green: 0.95, blue: 0.88 },   // 연한 주황
    '조퇴':   { red: 0.99, green: 0.91, blue: 0.9 },   // 연한 빨강
    '결석':   { red: 0.94, green: 0.94, blue: 0.94 },   // 연한 회색
    '입실누락': { red: 0.93, green: 0.9, blue: 0.98 },  // 연한 보라
    '퇴실누락': { red: 0.88, green: 0.94, blue: 1.0 },  // 연한 파랑
  };

  const textColors = {
    '출석':   { red: 0.07, green: 0.45, blue: 0.2 },
    '지각':   { red: 0.89, green: 0.45, blue: 0.0 },
    '조퇴':   { red: 0.77, green: 0.13, blue: 0.12 },
    '결석':   { red: 0.37, green: 0.39, blue: 0.42 },
    '입실누락': { red: 0.48, green: 0.28, blue: 0.73 },
    '퇴실누락': { red: 0.1, green: 0.4, blue: 0.7 },
  };

  // 기존 조건부 서식 삭제 후 새로 추가
  const requests = [];

  // 기존 조건부 서식 모두 삭제
  if (sheet.conditionalFormats && sheet.conditionalFormats.length > 0) {
    for (let i = sheet.conditionalFormats.length - 1; i >= 0; i--) {
      requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
    }
  }

  // 각 상태별 조건부 서식 추가
  const statusList = ['출석', '지각', '조퇴', '결석', '입실누락', '퇴실누락'];
  for (const status of statusList) {
    requests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [{
            sheetId,
            startRowIndex: startRow,
            endRowIndex: endRow,
            startColumnIndex: startCol,
            endColumnIndex: endCol,
          }],
          booleanRule: {
            condition: {
              type: 'TEXT_EQ',
              values: [{ userEnteredValue: status }],
            },
            format: {
              backgroundColor: colors[status],
              textFormat: {
                foregroundColor: textColors[status],
                bold: true,
                fontSize: 10,
              },
            },
          },
        },
        index: 0,
      },
    });
  }

  // 헤더 서식: 볼드 + 배경
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: endCol + 7 },
      cell: {
        userEnteredFormat: {
          textFormat: { bold: true, fontSize: 10 },
          backgroundColor: { red: 0.96, green: 0.96, blue: 0.96 },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)',
    },
  });

  // 셀 테두리 + 가운데 정렬 (데이터 영역)
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
      cell: {
        userEnteredFormat: {
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(horizontalAlignment)',
    },
  });

  // 열 너비 자동 조정
  requests.push({
    autoResizeDimensions: {
      dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: endCol + 7 },
    },
  });

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }
}


// ─── 회차별 상세 시트 데이터 생성 ────────────────────────────
function buildSessionSheet(data, sessionIndex) {
  const { sessions, students, attendanceMap } = data;
  const session = sessions[sessionIndex];
  if (!session) return null;

  const rows = [];
  rows.push(['이름', '입실', '퇴실', '상태', '퇴실유형']);

  for (const student of students) {
    const key = student.student_id + '_' + session.session_id;
    const a = attendanceMap[key];

    if (a) {
      const checkIn = a.check_in_at ? new Date(a.check_in_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
      const checkOut = a.check_out_at ? new Date(a.check_out_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
      const status = getDetailedStatus(a);
      rows.push([student.name, checkIn, checkOut, status, a.exit_type || '']);
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

  // 기존 시트 탭 목록 확인
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);

  // 1. "출결요약" 시트 업데이트/생성
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

  // 출결요약 색상 포맷팅
  try {
    await formatSummarySheet(sheets, spreadsheetId, summaryTitle, data);
  } catch (err) {
    console.warn('[Sync] 색상 포맷팅 오류 (무시):', err.message);
  }

  // 2. 회차별 시트 업데이트/생성
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


// ─── 통합 관리 시트 동기화 (수강생 명단 + 생체인증 등록 여부) ──
async function syncManagementSheet(spreadsheetId) {
  const sheets = getSheets();

  // 전체 과정 + 수강생 + 생체인증 정보 조회
  const studentsRes = await db.query(`
    SELECT 
      s.student_id, s.name, s.phone, s.status,
      c.course_name, c.cohort, c.course_type,
      CASE WHEN cr.cred_count > 0 THEN '등록완료' ELSE '미등록' END AS bio_status,
      COALESCE(cr.cred_count, 0) AS cred_count,
      cr.last_used_at,
      ps.push_status
    FROM students s
    JOIN enrollments e ON e.student_id = s.student_id
    JOIN courses c ON c.course_id = e.course_id
    LEFT JOIN (
      SELECT student_id, COUNT(*) AS cred_count, MAX(last_used_at) AS last_used_at
      FROM credentials GROUP BY student_id
    ) cr ON cr.student_id = s.student_id
    LEFT JOIN (
      SELECT student_id, '구독중' AS push_status
      FROM push_subscriptions GROUP BY student_id
    ) ps ON ps.student_id = s.student_id
    WHERE s.status = 'active'
    ORDER BY c.course_name, c.cohort, s.name
  `);

  const rows = [['과정명', '기수', '이름', '전화번호', '상태', '생체인증', '마지막 인증일', '푸시알림']];

  for (const s of studentsRes.rows) {
    const lastUsed = s.last_used_at ? new Date(s.last_used_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-';
    rows.push([
      s.course_name,
      s.cohort || '',
      s.name,
      s.phone,
      s.status === 'active' ? '활성' : s.status,
      s.bio_status,
      lastUsed,
      s.push_status || '미구독',
    ]);
  }

  // 시트 생성/업데이트
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);
  const sheetTitle = '수강생관리';

  if (!existingSheets.includes(sheetTitle)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetTitle } } }] },
    });
  }

  // 기존 데이터 삭제 후 새로 쓰기
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetTitle}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  // 색상 포맷팅 (조건부 서식)
  const sheet = (await sheets.spreadsheets.get({ spreadsheetId })).data.sheets.find(s => s.properties.title === sheetTitle);
  if (sheet) {
    const sheetId = sheet.properties.sheetId;
    const formatRequests = [];

    // 헤더 서식
    formatRequests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.96, green: 0.96, blue: 0.96 } } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });

    // 생체인증 "등록완료" → 초록, "미등록" → 빨강
    formatRequests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rows.length, startColumnIndex: 5, endColumnIndex: 6 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '등록완료' }] },
            format: { backgroundColor: { red: 0.9, green: 0.96, blue: 0.92 }, textFormat: { foregroundColor: { red: 0.07, green: 0.45, blue: 0.2 } } },
          },
        },
        index: 0,
      },
    });
    formatRequests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rows.length, startColumnIndex: 5, endColumnIndex: 6 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '미등록' }] },
            format: { backgroundColor: { red: 0.99, green: 0.91, blue: 0.9 }, textFormat: { foregroundColor: { red: 0.77, green: 0.13, blue: 0.12 } } },
          },
        },
        index: 0,
      },
    });

    // 열 너비 자동 조정
    formatRequests.push({
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 8 },
      },
    });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: formatRequests },
    });
  }

  return { success: true, count: studentsRes.rows.length };
}


// ─── 전체 과정 동기화 ────────────────────────────────────────
async function syncAllCourses() {
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


module.exports = { syncToGoogleSheets, syncAllCourses, syncManagementSheet };
