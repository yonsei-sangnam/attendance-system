require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── 미들웨어 ────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));


// ─── 헬스 체크 (UptimeRobot용) ──────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});


// ─── 관리자 대시보드 (메인 페이지) ───────────────────────────
app.get('/', async (req, res) => {
  try {
    // DB 연결 상태 확인
    const dbCheck = await db.query('SELECT NOW() AS server_time');
    const serverTime = dbCheck.rows[0].server_time;

    // 강의실 목록
    const classrooms = await db.query(
      'SELECT classroom_code, classroom_name FROM classrooms ORDER BY classroom_code'
    );

    // 과정 목록 (기본 강의실 포함)
    const courses = await db.query(`
      SELECT c.course_name, c.course_code, c.course_type, c.cohort,
             cr.classroom_name AS default_room
      FROM courses c
      LEFT JOIN classrooms cr ON cr.classroom_id = c.default_classroom_id
      ORDER BY c.course_type, c.course_name
    `);

    // 수강생 수
    const studentCount = await db.query('SELECT COUNT(*) AS cnt FROM students');

    // 회차 스케줄 수
    const sessionCount = await db.query('SELECT COUNT(*) AS cnt FROM course_sessions');

    // 출결 기록 수
    const attendanceCount = await db.query('SELECT COUNT(*) AS cnt FROM attendance');

    res.send(renderAdminPage({
      serverTime,
      classrooms: classrooms.rows,
      courses: courses.rows,
      studentCount: studentCount.rows[0].cnt,
      sessionCount: sessionCount.rows[0].cnt,
      attendanceCount: attendanceCount.rows[0].cnt,
    }));

  } catch (err) {
    res.status(500).send(`
      <html><body style="font-family:sans-serif; padding:40px;">
        <h1>⚠️ DB 연결 실패</h1>
        <p>오류: ${err.message}</p>
        <p>Render 환경변수에 DATABASE_URL이 올바르게 설정되어 있는지 확인하세요.</p>
      </body></html>
    `);
  }
});


// ─── API: 강의실 목록 ────────────────────────────────────────
app.get('/api/classrooms', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT classroom_id, classroom_code, classroom_name FROM classrooms ORDER BY classroom_code'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── API: 과정 목록 ─────────────────────────────────────────
app.get('/api/courses', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT c.course_id, c.course_name, c.course_code, c.course_type, 
             c.cohort, c.total_sessions,
             cr.classroom_code, cr.classroom_name
      FROM courses c
      LEFT JOIN classrooms cr ON cr.classroom_id = c.default_classroom_id
      ORDER BY c.course_type, c.course_name
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── API: 수강생 목록 ────────────────────────────────────────
app.get('/api/students', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT s.student_id, s.name, s.phone, s.status,
             c.course_name
      FROM students s
      LEFT JOIN enrollments e ON e.student_id = s.student_id
      LEFT JOIN courses c ON c.course_id = e.course_id
      ORDER BY c.course_name, s.name
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── API: 회차 스케줄 ────────────────────────────────────────
app.get('/api/sessions', async (req, res) => {
  try {
    const { course_id } = req.query;
    let query = `
      SELECT cs.session_id, cs.session_number, cs.session_date,
             cs.start_time, cs.end_time, cs.late_cutoff, cs.early_leave_cutoff,
             cs.is_workshop, cs.note,
             c.course_name,
             COALESCE(cr.classroom_name, dcr.classroom_name) AS classroom_name
      FROM course_sessions cs
      JOIN courses c ON c.course_id = cs.course_id
      LEFT JOIN classrooms cr ON cr.classroom_id = cs.classroom_id
      LEFT JOIN classrooms dcr ON dcr.classroom_id = c.default_classroom_id
    `;
    const params = [];
    if (course_id) {
      query += ' WHERE cs.course_id = $1';
      params.push(course_id);
    }
    query += ' ORDER BY c.course_name, cs.session_number';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── 관리자 페이지 HTML 생성 ─────────────────────────────────
function renderAdminPage(data) {
  const classroomRows = data.classrooms.map(c => `
    <tr><td>${c.classroom_code}</td><td>${c.classroom_name}</td></tr>
  `).join('');

  const courseRows = data.courses.map(c => `
    <tr>
      <td>${c.course_name}</td>
      <td>${c.course_code || ''}</td>
      <td><span class="badge ${c.course_type === '모집과정' ? 'blue' : c.course_type === '위탁과정' ? 'green' : c.course_type === '산교연과정' ? 'orange' : 'gray'}">${c.course_type || '-'}</span></td>
      <td>${c.cohort || '-'}</td>
      <td>${c.default_room || '-'}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>출결 관리 시스템 - 관리자</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Malgun Gothic', sans-serif; background: #f5f5f7; color: #1d1d1f; padding: 20px; }
    .container { max-width: 1000px; margin: 0 auto; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #86868b; font-size: 14px; margin-bottom: 24px; }
    .status-bar { background: #fff; border-radius: 12px; padding: 16px 20px; margin-bottom: 20px; display: flex; gap: 24px; flex-wrap: wrap; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .status-item { display: flex; flex-direction: column; }
    .status-label { font-size: 12px; color: #86868b; }
    .status-value { font-size: 18px; font-weight: 600; }
    .status-ok { color: #34c759; }
    .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card h2 { font-size: 16px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #e5e5e7; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; padding: 8px 12px; background: #f5f5f7; color: #86868b; font-weight: 500; font-size: 12px; }
    td { padding: 8px 12px; border-top: 1px solid #e5e5e7; }
    .badge { padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
    .blue { background: #e8f0fe; color: #1a73e8; }
    .green { background: #e6f4ea; color: #137333; }
    .orange { background: #fef3e0; color: #e37400; }
    .gray { background: #f1f3f4; color: #5f6368; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .stat-box { background: #f5f5f7; border-radius: 8px; padding: 16px; text-align: center; }
    .stat-number { font-size: 28px; font-weight: 700; color: #1a73e8; }
    .stat-label { font-size: 12px; color: #86868b; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📋 출결 관리 시스템</h1>
    <p class="subtitle">관리자 대시보드</p>

    <div class="status-bar">
      <div class="status-item">
        <span class="status-label">서버 상태</span>
        <span class="status-value status-ok">● 정상</span>
      </div>
      <div class="status-item">
        <span class="status-label">DB 연결</span>
        <span class="status-value status-ok">● 연결됨</span>
      </div>
      <div class="status-item">
        <span class="status-label">서버 시간 (KST)</span>
        <span class="status-value">${new Date(data.serverTime).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</span>
      </div>
    </div>

    <div class="card">
      <h2>📊 현재 데이터 현황</h2>
      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-number">${data.courses.length}</div>
          <div class="stat-label">교육과정</div>
        </div>
        <div class="stat-box">
          <div class="stat-number">${data.classrooms.length}</div>
          <div class="stat-label">강의실</div>
        </div>
        <div class="stat-box">
          <div class="stat-number">${data.studentCount}</div>
          <div class="stat-label">수강생</div>
        </div>
        <div class="stat-box">
          <div class="stat-number">${data.sessionCount}</div>
          <div class="stat-label">회차 스케줄</div>
        </div>
        <div class="stat-box">
          <div class="stat-number">${data.attendanceCount}</div>
          <div class="stat-label">출결 기록</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>🏫 교육과정 (${data.courses.length}개)</h2>
      <table>
        <tr><th>과정명</th><th>약칭</th><th>종류</th><th>기수</th><th>기본 강의실</th></tr>
        ${courseRows}
      </table>
    </div>

    <div class="card">
      <h2>🚪 강의실 (${data.classrooms.length}개)</h2>
      <table>
        <tr><th>코드</th><th>이름</th></tr>
        ${classroomRows}
      </table>
    </div>
  </div>
</body>
</html>`;
}


// ─── 서버 시작 ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(`환경: ${process.env.NODE_ENV || 'development'}`);
});
