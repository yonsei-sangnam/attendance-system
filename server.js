require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const qr = require('./qr');

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
    const dbCheck = await db.query('SELECT NOW() AS server_time');
    const serverTime = dbCheck.rows[0].server_time;
    const classrooms = await db.query('SELECT classroom_code, classroom_name FROM classrooms ORDER BY classroom_code');
    const courses = await db.query(`
      SELECT c.course_name, c.course_code, c.course_type, c.cohort, cr.classroom_name AS default_room
      FROM courses c LEFT JOIN classrooms cr ON cr.classroom_id = c.default_classroom_id
      ORDER BY c.course_type, c.course_name
    `);
    const studentCount = await db.query('SELECT COUNT(*) AS cnt FROM students');
    const sessionCount = await db.query('SELECT COUNT(*) AS cnt FROM course_sessions');
    const attendanceCount = await db.query('SELECT COUNT(*) AS cnt FROM attendance');

    // 서버 기본 URL 추출
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    res.send(renderAdminPage({
      serverTime, baseUrl,
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


// ════════════════════════════════════════════════════════════
// QR 코드 관련 라우트
// ════════════════════════════════════════════════════════════

// ─── QR 표시 화면 (강의실별) ─────────────────────────────────
// 각 강의실의 태블릿/노트북에서 이 주소를 열어둔다
// 예: https://서버주소/qr/ROOM_105
// ─────────────────────────────────────────────────────────────
app.get('/qr/:classroomCode', async (req, res) => {
  const { classroomCode } = req.params;

  // 강의실 존재 확인
  const crRes = await db.query(
    'SELECT classroom_code, classroom_name FROM classrooms WHERE classroom_code = $1',
    [classroomCode]
  );

  if (crRes.rows.length === 0) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif; padding:40px; text-align:center;">
        <h1>❌ 존재하지 않는 강의실</h1>
        <p>"${classroomCode}"는 등록되지 않은 코드입니다.</p>
        <p><a href="/">← 관리자 페이지로 돌아가기</a></p>
      </body></html>
    `);
  }

  const classroom = crRes.rows[0];
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  res.send(renderQRPage(classroom, baseUrl));
});


// ─── API: 새 QR 토큰 발급 ───────────────────────────────────
// QR 표시 화면이 55초마다 이 API를 호출하여 새 토큰을 받음
// ─────────────────────────────────────────────────────────────
app.post('/api/qr-token/:classroomCode', async (req, res) => {
  try {
    const token = await qr.generateToken(req.params.classroomCode);
    res.json(token);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── 수강생 스캔 페이지 ──────────────────────────────────────
// 수강생이 QR을 스캔하면 이 페이지로 이동
// 예: https://서버주소/scan?token=xxx&room=ROOM_105
// ─────────────────────────────────────────────────────────────
app.get('/scan', async (req, res) => {
  const { token, room } = req.query;

  if (!token || !room) {
    return res.send(renderScanPage({ error: 'QR 코드를 다시 스캔해주세요.' }));
  }

  // 토큰 검증
  const result = await qr.validateToken(token, room);

  if (!result.valid) {
    return res.send(renderScanPage({ error: result.reason }));
  }

  // 유효한 토큰 → 출결 체크 페이지 표시
  res.send(renderScanPage({
    valid: true,
    classroomCode: result.classroomCode,
    classroomName: result.classroomName,
    token: token,
  }));
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
             c.cohort, c.total_sessions, cr.classroom_code, cr.classroom_name
      FROM courses c LEFT JOIN classrooms cr ON cr.classroom_id = c.default_classroom_id
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
      SELECT s.student_id, s.name, s.phone, s.status, c.course_name
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


// ════════════════════════════════════════════════════════════
// 페이지 렌더링 함수들
// ════════════════════════════════════════════════════════════

// ─── 관리자 대시보드 ─────────────────────────────────────────
function renderAdminPage(data) {
  const classroomRows = data.classrooms.map(c => `
    <tr>
      <td>${c.classroom_code}</td>
      <td>${c.classroom_name}</td>
      <td><a href="/qr/${c.classroom_code}" target="_blank" class="btn btn-small">QR 화면 열기 →</a></td>
    </tr>
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
    .btn { display: inline-block; padding: 6px 14px; background: #1a73e8; color: #fff; text-decoration: none; border-radius: 6px; font-size: 13px; }
    .btn:hover { background: #1557b0; }
    .btn-small { padding: 4px 10px; font-size: 12px; }
    .info-box { background: #e8f0fe; border-radius: 8px; padding: 14px 18px; margin-top: 12px; font-size: 13px; color: #1a73e8; line-height: 1.6; }
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
        <div class="stat-box"><div class="stat-number">${data.courses.length}</div><div class="stat-label">교육과정</div></div>
        <div class="stat-box"><div class="stat-number">${data.classrooms.length}</div><div class="stat-label">강의실</div></div>
        <div class="stat-box"><div class="stat-number">${data.studentCount}</div><div class="stat-label">수강생</div></div>
        <div class="stat-box"><div class="stat-number">${data.sessionCount}</div><div class="stat-label">회차 스케줄</div></div>
        <div class="stat-box"><div class="stat-number">${data.attendanceCount}</div><div class="stat-label">출결 기록</div></div>
      </div>
    </div>

    <div class="card">
      <h2>🚪 강의실 QR 코드 (${data.classrooms.length}개)</h2>
      <table>
        <tr><th>코드</th><th>이름</th><th>QR 화면</th></tr>
        ${classroomRows}
      </table>
      <div class="info-box">
        💡 <strong>사용법:</strong> 각 강의실에 놓을 태블릿이나 노트북에서 "QR 화면 열기"를 클릭하세요.<br>
        QR 코드가 60초마다 자동으로 바뀌며, 수강생이 스마트폰 카메라로 스캔하면 출결 체크가 됩니다.
      </div>
    </div>

    <div class="card">
      <h2>🏫 교육과정 (${data.courses.length}개)</h2>
      <table>
        <tr><th>과정명</th><th>약칭</th><th>종류</th><th>기수</th><th>기본 강의실</th></tr>
        ${courseRows}
      </table>
    </div>
  </div>
</body>
</html>`;
}


// ─── QR 표시 화면 (강의실 전용) ──────────────────────────────
function renderQRPage(classroom, baseUrl) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QR 출결 - ${classroom.classroom_name}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, 'Malgun Gothic', sans-serif;
      background: #000;
      color: #fff;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .room-name {
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .instruction {
      font-size: 18px;
      color: #86868b;
      margin-bottom: 30px;
    }
    #qr-container {
      background: #fff;
      border-radius: 24px;
      padding: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #qr-canvas {
      width: 280px;
      height: 280px;
    }
    .timer-bar {
      margin-top: 30px;
      text-align: center;
    }
    .timer-text {
      font-size: 48px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .timer-label {
      font-size: 14px;
      color: #86868b;
      margin-top: 4px;
    }
    .timer-warn { color: #ff9500; }
    .timer-urgent { color: #ff3b30; }
    .progress-bg {
      width: 300px;
      height: 6px;
      background: #333;
      border-radius: 3px;
      margin: 16px auto 0;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: #34c759;
      border-radius: 3px;
      transition: width 1s linear, background 0.3s;
    }
    .progress-fill.warn { background: #ff9500; }
    .progress-fill.urgent { background: #ff3b30; }
    .status-msg {
      margin-top: 20px;
      font-size: 14px;
      color: #86868b;
    }
    .error-msg {
      color: #ff3b30;
      font-size: 16px;
      margin-top: 20px;
    }
    .scan-hint {
      position: fixed;
      bottom: 30px;
      font-size: 16px;
      color: #555;
    }
  </style>
</head>
<body>
  <div class="room-name">${classroom.classroom_name}</div>
  <div class="instruction">스마트폰 카메라로 QR 코드를 스캔하세요</div>

  <div id="qr-container">
    <canvas id="qr-canvas"></canvas>
  </div>

  <div class="timer-bar">
    <div class="timer-text" id="timer">60</div>
    <div class="timer-label">초 후 새 QR 생성</div>
    <div class="progress-bg">
      <div class="progress-fill" id="progress"></div>
    </div>
  </div>

  <div class="status-msg" id="status">QR 코드 생성 중...</div>
  <div class="scan-hint">📱 카메라 앱을 열고 QR 코드를 비추세요</div>

  <!-- QR 코드 생성 라이브러리 (CDN) -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js"></script>

  <script>
    const CLASSROOM_CODE = '${classroom.classroom_code}';
    const BASE_URL = '${baseUrl}';
    const REFRESH_INTERVAL = 55;  // 55초마다 새 토큰 요청 (만료 전 5초 여유)

    let countdown = 60;
    let timerInterval = null;

    const qrCanvas = document.getElementById('qr-canvas');
    const timerEl = document.getElementById('timer');
    const progressEl = document.getElementById('progress');
    const statusEl = document.getElementById('status');

    // QR 코드 인스턴스
    const qrCode = new QRious({
      element: qrCanvas,
      size: 280,
      level: 'M',
      background: '#ffffff',
      foreground: '#000000',
    });

    // ─── 새 토큰 요청 + QR 갱신 ────────────────────────────
    async function refreshQR() {
      try {
        const res = await fetch('/api/qr-token/' + CLASSROOM_CODE, { method: 'POST' });
        if (!res.ok) throw new Error('서버 응답 오류: ' + res.status);
        
        const data = await res.json();
        
        // QR에 담을 URL 생성
        const scanUrl = BASE_URL + '/scan?token=' + data.token + '&room=' + CLASSROOM_CODE;
        
        // QR 코드 업데이트
        qrCode.value = scanUrl;
        
        // 카운트다운 리셋
        countdown = 60;
        statusEl.textContent = '✅ QR 코드 활성 중';
        statusEl.style.color = '#34c759';

      } catch (err) {
        statusEl.textContent = '⚠️ QR 갱신 실패: ' + err.message;
        statusEl.style.color = '#ff3b30';
        console.error('QR 갱신 오류:', err);
      }
    }

    // ─── 카운트다운 타이머 ──────────────────────────────────
    function updateTimer() {
      countdown--;
      if (countdown < 0) countdown = 0;

      timerEl.textContent = countdown;
      
      // 프로그레스 바
      const pct = (countdown / 60) * 100;
      progressEl.style.width = pct + '%';

      // 색상 변화
      timerEl.className = 'timer-text';
      progressEl.className = 'progress-fill';
      if (countdown <= 10) {
        timerEl.classList.add('urgent');
        progressEl.classList.add('urgent');
      } else if (countdown <= 20) {
        timerEl.classList.add('warn');
        progressEl.classList.add('warn');
      }

      // 5초 이하: 재스캔 안내
      if (countdown <= 5 && countdown > 0) {
        statusEl.textContent = '⏳ 잠시 후 새 QR이 생성됩니다. 기다려주세요.';
        statusEl.style.color = '#ff9500';
      }
    }

    // ─── 시작 ──────────────────────────────────────────────
    async function start() {
      // 첫 QR 즉시 생성
      await refreshQR();

      // 1초마다 카운트다운
      timerInterval = setInterval(updateTimer, 1000);

      // 55초마다 새 토큰 요청
      setInterval(refreshQR, REFRESH_INTERVAL * 1000);
    }

    start();

    // 화면 꺼짐 방지 (가능한 경우)
    async function keepScreenOn() {
      try {
        if ('wakeLock' in navigator) {
          await navigator.wakeLock.request('screen');
        }
      } catch (e) { /* 지원 안 되면 무시 */ }
    }
    keepScreenOn();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') keepScreenOn();
    });
  </script>
</body>
</html>`;
}


// ─── 수강생 스캔 페이지 ──────────────────────────────────────
function renderScanPage(data) {
  if (data.error) {
    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>출결 체크</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Malgun Gothic', sans-serif; background: #f5f5f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #fff; border-radius: 16px; padding: 40px 24px; max-width: 360px; width: 100%; text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin-bottom: 12px; color: #ff3b30; }
    p { font-size: 15px; color: #86868b; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h1>스캔 실패</h1>
    <p>${data.error}</p>
  </div>
</body>
</html>`;
  }

  // 유효한 스캔 → 출결 확인 페이지
  // (4단계에서 생체인증 추가, 5단계에서 실제 출결 기록 처리 예정)
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>출결 체크 - ${data.classroomName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Malgun Gothic', sans-serif; background: #f5f5f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #fff; border-radius: 16px; padding: 40px 24px; max-width: 360px; width: 100%; text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin-bottom: 8px; }
    .room { font-size: 15px; color: #86868b; margin-bottom: 24px; }
    .info { background: #e6f4ea; color: #137333; padding: 14px; border-radius: 10px; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>QR 인증 성공</h1>
    <p class="room">${data.classroomName}</p>
    <div class="info">
      📌 다음 단계에서 생체인증(지문/Face ID)과<br>
      출결 기록 기능이 추가될 예정입니다.
    </div>
  </div>
</body>
</html>`;
}


// ─── 서버 시작 ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('서버 실행 중: http://localhost:' + PORT);
  console.log('환경: ' + (process.env.NODE_ENV || 'development'));
});
