const db = require('./db');

// ─── 라우트 등록 ─────────────────────────────────────────────
function registerAdminRoutes(app) {

  // ═══ 관리자 출결 현황 페이지 ═══════════════════════════════
  app.get('/admin/attendance', async (req, res) => {
    try {
      const courses = await db.query(`
        SELECT course_id, course_name, course_code, cohort, course_type
        FROM courses ORDER BY course_type, course_name
      `);
      res.send(renderAttendancePage(courses.rows));
    } catch (err) {
      res.status(500).send('오류: ' + err.message);
    }
  });

  // ═══ API: 과정의 회차 목록 ═════════════════════════════════
  app.get('/api/admin/sessions/:courseId', async (req, res) => {
    try {
      const r = await db.query(`
        SELECT cs.session_id, cs.session_number, cs.session_date,
               cs.start_time, cs.end_time, cs.late_cutoff, cs.early_leave_cutoff,
               cs.is_workshop, cs.note,
               COALESCE(cr.classroom_name, dcr.classroom_name, '-') AS classroom_name,
               (SELECT COUNT(*) FROM attendance a WHERE a.session_id = cs.session_id) AS attendance_count
        FROM course_sessions cs
        JOIN courses c ON c.course_id = cs.course_id
        LEFT JOIN classrooms cr ON cr.classroom_id = cs.classroom_id
        LEFT JOIN classrooms dcr ON dcr.classroom_id = c.default_classroom_id
        WHERE cs.course_id = $1
        ORDER BY cs.session_number
      `, [req.params.courseId]);
      res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 회차별 출결 상세 ═════════════════════════════════
  app.get('/api/admin/attendance/:sessionId', async (req, res) => {
    try {
      // 해당 회차의 과정에 등록된 전체 수강생 + 출결 기록 (LEFT JOIN)
      const r = await db.query(`
        SELECT 
          s.student_id, s.name, s.phone,
          a.attendance_id, a.check_in_at, a.check_out_at, 
          a.status, a.exit_type, a.is_manual_override,
          cs.late_cutoff, cs.early_leave_cutoff,
          cs.session_date, cs.start_time, cs.end_time
        FROM course_sessions cs
        JOIN enrollments e ON e.course_id = cs.course_id
        JOIN students s ON s.student_id = e.student_id AND s.status = 'active'
        LEFT JOIN attendance a ON a.student_id = s.student_id AND a.session_id = cs.session_id
        WHERE cs.session_id = $1
        ORDER BY s.name
      `, [req.params.sessionId]);

      // 요약 계산
      const total = r.rows.length;
      const attended = r.rows.filter(r => r.status === '출석').length;
      const late = r.rows.filter(r => r.status === '지각').length;
      const earlyLeave = r.rows.filter(r => r.status === '조퇴').length;
      const absent = total - r.rows.filter(r => r.check_in_at).length;

      res.json({
        students: r.rows,
        summary: { total, attended, late, earlyLeave, absent },
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 출결 상태 수동 변경 ══════════════════════════════
  app.put('/api/admin/attendance/:attendanceId', async (req, res) => {
    try {
      const { status } = req.body;
      const validStatuses = ['출석', '지각', '조퇴', '결석'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: '유효하지 않은 상태값' });
      }

      await db.query(`
        UPDATE attendance SET status = $1::attendance_status, is_manual_override = TRUE, updated_at = NOW()
        WHERE attendance_id = $2
      `, [status, req.params.attendanceId]);

      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 입실/퇴실 시각 수동 수정 ═══════════════════════════
  app.patch('/api/admin/attendance/:attendanceId/time', async (req, res) => {
    try {
      const { attendanceId } = req.params;
      const { field, value } = req.body;

      if (!['check_in_at', 'check_out_at'].includes(field)) {
        return res.status(400).json({ error: '잘못된 필드입니다.' });
      }

      if (!value || value.trim() === '') {
        await db.query(
          'UPDATE attendance SET ' + field + ' = NULL, is_manual_override = TRUE, updated_at = NOW() WHERE attendance_id = $1',
          [attendanceId]
        );
      } else {
        await db.query(
          'UPDATE attendance SET ' + field + ' = ($2)::TIMESTAMP AT TIME ZONE \'Asia/Seoul\', is_manual_override = TRUE, updated_at = NOW() WHERE attendance_id = $1',
          [attendanceId, value]
        );
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[Admin] 시각 수정 오류:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══ API: 미입실자 결석 일괄 처리 ═════════════════════════
  app.post('/api/admin/mark-absent/:sessionId', async (req, res) => {
    try {
      const sessionRes = await db.query(
        'SELECT session_id, course_id FROM course_sessions WHERE session_id = $1',
        [req.params.sessionId]
      );
      if (sessionRes.rows.length === 0) return res.status(404).json({ error: '회차 없음' });

      const session = sessionRes.rows[0];

      // 출결 기록이 없는 수강생에게 결석 기록 생성
      const r = await db.query(`
        INSERT INTO attendance (student_id, session_id, status, is_manual_override)
        SELECT e.student_id, $1, '결석', TRUE
        FROM enrollments e
        JOIN students s ON s.student_id = e.student_id AND s.status = 'active'
        WHERE e.course_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM attendance a WHERE a.student_id = e.student_id AND a.session_id = $1
          )
        RETURNING student_id
      `, [req.params.sessionId, session.course_id]);

      res.json({ success: true, count: r.rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 과정별 출결 요약 (전체 회차) ═════════════════════
  app.get('/api/admin/summary/:courseId', async (req, res) => {
    try {
      const r = await db.query(`
        SELECT 
          s.name, s.phone,
          COUNT(CASE WHEN a.status = '출석' THEN 1 END) AS attended,
          COUNT(CASE WHEN a.status = '지각' THEN 1 END) AS late,
          COUNT(CASE WHEN a.status = '조퇴' THEN 1 END) AS early_leave,
          COUNT(CASE WHEN a.status = '결석' THEN 1 END) AS absent,
          COUNT(CASE WHEN a.check_in_at IS NOT NULL THEN 1 END) AS total_present,
          (SELECT COUNT(*) FROM course_sessions cs2 WHERE cs2.course_id = $1) AS total_sessions
        FROM enrollments e
        JOIN students s ON s.student_id = e.student_id AND s.status = 'active'
        LEFT JOIN attendance a ON a.student_id = s.student_id
          AND a.session_id IN (SELECT session_id FROM course_sessions WHERE course_id = $1)
        WHERE e.course_id = $1
        GROUP BY s.student_id, s.name, s.phone
        ORDER BY s.name
      `, [req.params.courseId]);

      // 출석률 계산
      const rows = r.rows.map(row => ({
        ...row,
        attendance_rate: row.total_sessions > 0
          ? Math.round((parseInt(row.total_present) / parseInt(row.total_sessions)) * 100)
          : 0,
      }));

      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ 구글시트 동기화 관리 페이지 ═══════════════════════════
  app.get('/admin/sync', async (req, res) => {
    try {
      const courses = await db.query(`
        SELECT course_id, course_name, course_code, cohort, course_type, spreadsheet_id
        FROM courses ORDER BY course_type, course_name
      `);
      res.send(renderSyncPage(courses.rows));
    } catch (err) {
      res.status(500).send('오류: ' + err.message);
    }
  });
}


// ═════════════════════════════════════════════════════════════
// 관리자 출결 현황 페이지 HTML
// ═════════════════════════════════════════════════════════════
function renderAttendancePage(courses) {
  const courseOptions = courses.map(c =>
    `<option value="${c.course_id}">${c.course_name} ${c.cohort || ''} [${c.course_type || ''}]</option>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>출결 현황 - 관리자</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Malgun Gothic', sans-serif; background: #f5f5f7; color: #1d1d1f; padding: 16px; }
    .container { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .subtitle { color: #86868b; font-size: 13px; margin-bottom: 20px; }
    .top-bar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
    select { padding: 10px 14px; border: 1.5px solid #d2d2d7; border-radius: 10px; font-size: 14px; background: #fff; min-width: 200px; }
    .tab-bar { display: flex; gap: 4px; margin-bottom: 16px; }
    .tab { padding: 8px 16px; border-radius: 8px; font-size: 13px; cursor: pointer; border: none; background: #e5e5e7; color: #1d1d1f; }
    .tab.active { background: #1a73e8; color: #fff; }
    .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
    .stat { background: #f5f5f7; border-radius: 8px; padding: 12px 16px; text-align: center; min-width: 80px; }
    .stat-num { font-size: 24px; font-weight: 700; }
    .stat-num.blue { color: #1a73e8; }
    .stat-num.green { color: #34c759; }
    .stat-num.orange { color: #ff9500; }
    .stat-num.red { color: #ff3b30; }
    .stat-label { font-size: 11px; color: #86868b; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 10px; background: #f5f5f7; color: #86868b; font-weight: 500; font-size: 12px; position: sticky; top: 0; }
    td { padding: 8px 10px; border-top: 1px solid #f0f0f0; }
    tr:hover { background: #fafafa; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
    .b-출석 { background: #e6f4ea; color: #137333; }
    .b-지각 { background: #fef3e0; color: #e37400; }
    .b-조퇴 { background: #fce8e6; color: #c5221f; }
    .b-결석 { background: #f1f3f4; color: #5f6368; }
    .b-미체크 { background: #fff3e0; color: #e65100; }
    .time { font-variant-numeric: tabular-nums; font-size: 12px; color: #555; }
    .btn { padding: 6px 12px; border: none; border-radius: 6px; font-size: 12px; cursor: pointer; }
    .btn-primary { background: #1a73e8; color: #fff; }
    .btn-primary:hover { background: #1557b0; }
    .btn-small { padding: 4px 8px; font-size: 11px; }
    .btn-outline { background: #fff; color: #1a73e8; border: 1px solid #1a73e8; }
    .status-select { padding: 4px 8px; border: 1px solid #d2d2d7; border-radius: 6px; font-size: 12px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    .empty { text-align: center; padding: 40px; color: #86868b; }
    .back-link { font-size: 13px; color: #1a73e8; text-decoration: none; }
    .session-btn { padding: 8px 12px; border: 1px solid #e5e5e7; border-radius: 8px; background: #fff; cursor: pointer; text-align: left; font-size: 13px; display: block; width: 100%; margin-bottom: 6px; }
    .session-btn:hover { border-color: #1a73e8; background: #f8faff; }
    .session-btn.active { border-color: #1a73e8; background: #e8f0fe; }
    .session-info { display: flex; justify-content: space-between; align-items: center; }
    .session-num { font-weight: 600; }
    .session-date { color: #86868b; font-size: 12px; }
    .session-count { font-size: 12px; color: #1a73e8; }
    .manual-tag { font-size: 10px; color: #ff9500; margin-left: 4px; }
    .rate-bar { width: 60px; height: 6px; background: #e5e5e7; border-radius: 3px; display: inline-block; vertical-align: middle; margin-right: 6px; }
    .rate-fill { height: 100%; border-radius: 3px; background: #34c759; }
    #loading { text-align: center; padding: 20px; color: #86868b; }
    .editable-time { cursor: pointer; border-bottom: 1px dashed #007AFF; display: inline-block; }
    .editable-time:hover { background: #e8f4fd; border-radius: 4px; }
  </style>
</head>
<body>
<div class="container">
  <a href="/" class="back-link">← 대시보드로 돌아가기</a>
  <h1 style="margin-top:12px;">📊 출결 현황</h1>
  <p class="subtitle">과정 선택 → 회차 선택 → 출결 조회/수정</p>

  <div class="top-bar">
    <select id="courseSelect" onchange="loadSessions()">
      <option value="">-- 과정 선택 --</option>
      ${courseOptions}
    </select>
    <button class="tab" id="tabDetail" onclick="switchTab('detail')">회차별 상세</button>
    <button class="tab" id="tabSummary" onclick="switchTab('summary')">전체 요약</button>
  </div>

  <div id="content">
    <div class="empty">왼쪽에서 과정을 선택하세요.</div>
  </div>
</div>

<script>
let currentTab = 'detail';
let currentCourseId = null;
let currentSessionId = null;

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tabDetail').className = 'tab' + (tab === 'detail' ? ' active' : '');
  document.getElementById('tabSummary').className = 'tab' + (tab === 'summary' ? ' active' : '');
  if (!currentCourseId) return;
  if (tab === 'summary') loadSummary();
  else loadSessions();
}

// ─── 회차 목록 로드 ──────────────────────────────────────
async function loadSessions() {
  currentCourseId = document.getElementById('courseSelect').value;
  if (!currentCourseId) { document.getElementById('content').innerHTML = '<div class="empty">과정을 선택하세요.</div>'; return; }
  currentTab = 'detail';
  document.getElementById('tabDetail').className = 'tab active';
  document.getElementById('tabSummary').className = 'tab';

  document.getElementById('content').innerHTML = '<div id="loading">불러오는 중...</div>';
  const res = await fetch('/api/admin/sessions/' + currentCourseId);
  const sessions = await res.json();

  if (sessions.length === 0) {
    document.getElementById('content').innerHTML = '<div class="empty">등록된 회차가 없습니다.</div>';
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  let html = '<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;">';
  html += '<div style="min-width:220px;max-width:280px;">';
  html += '<div class="card"><b>회차 선택</b><br><br>';
  for (const s of sessions) {
    const isToday = s.session_date && s.session_date.split('T')[0] === today;
    html += '<button class="session-btn" id="sess-' + s.session_id + '" onclick="loadAttendance(\\'' + s.session_id + '\\')">';
    html += '<div class="session-info">';
    html += '<span class="session-num">' + s.session_number + '회' + (s.is_workshop ? ' 🏕️' : '') + (isToday ? ' 📌' : '') + '</span>';
    html += '<span class="session-date">' + (s.session_date ? s.session_date.split('T')[0] : '-') + '</span>';
    html += '</div>';
    html += '<div class="session-info" style="margin-top:4px;">';
    html += '<span style="font-size:11px;color:#86868b;">' + s.classroom_name + '</span>';
    html += '<span class="session-count">' + s.attendance_count + '명 기록</span>';
    html += '</div>';
    html += '</button>';
  }
  html += '</div></div>';
  html += '<div style="flex:1;min-width:300px;" id="attendanceArea"><div class="empty">회차를 선택하세요.</div></div>';
  html += '</div>';

  document.getElementById('content').innerHTML = html;
}

// ─── 회차별 출결 상세 ────────────────────────────────────
async function loadAttendance(sessionId) {
  currentSessionId = sessionId;
  document.querySelectorAll('.session-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('sess-' + sessionId);
  if (btn) btn.classList.add('active');

  const area = document.getElementById('attendanceArea');
  area.innerHTML = '<div id="loading">불러오는 중...</div>';

  const res = await fetch('/api/admin/attendance/' + sessionId);
  const data = await res.json();
  const { students, summary } = data;

  let html = '<div class="card">';

  // 요약
  html += '<div class="stats">';
  html += '<div class="stat"><div class="stat-num blue">' + summary.total + '</div><div class="stat-label">전체</div></div>';
  html += '<div class="stat"><div class="stat-num green">' + summary.attended + '</div><div class="stat-label">출석</div></div>';
  html += '<div class="stat"><div class="stat-num orange">' + summary.late + '</div><div class="stat-label">지각</div></div>';
  html += '<div class="stat"><div class="stat-num orange">' + summary.earlyLeave + '</div><div class="stat-label">조퇴</div></div>';
  html += '<div class="stat"><div class="stat-num red">' + summary.absent + '</div><div class="stat-label">결석/미체크</div></div>';
  html += '</div>';

  // 버튼
  html += '<div class="actions">';
  html += '<button class="btn btn-primary btn-small" onclick="loadAttendance(\\'' + sessionId + '\\')">🔄 새로고침</button>';
  html += '<button class="btn btn-outline btn-small" onclick="markAbsent(\\'' + sessionId + '\\')">미입실자 결석 일괄 처리</button>';
  html += '</div>';

  // 테이블
  html += '<div style="overflow-x:auto;"><table>';
  html += '<tr><th>이름</th><th>전화번호</th><th>입실</th><th>퇴실</th><th>상태</th><th>변경</th></tr>';

  for (const s of students) {
    const checkIn = s.check_in_at ? new Date(s.check_in_at).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', second:'2-digit'}) : '-';
    const checkOut = s.check_out_at ? new Date(s.check_out_at).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', second:'2-digit'}) : '-';
    const status = s.status || '미체크';
    const badgeClass = 'b-' + status;
    const manual = s.is_manual_override ? '<span class="manual-tag">수동</span>' : '';

    html += '<tr>';
    html += '<td><b>' + s.name + '</b></td>';
    html += '<td class="time">' + s.phone + '</td>';

    if (s.attendance_id) {
      const ciRaw = s.check_in_at || '';
      const coRaw = s.check_out_at || '';
      html += '<td class="time"><span class="editable-time" onclick="editTime(\\'' + s.attendance_id + '\\', \\'check_in_at\\', \\'' + ciRaw + '\\', \\'' + sessionId + '\\')" title="클릭하여 수정">' + checkIn + '</span></td>';
      html += '<td class="time"><span class="editable-time" onclick="editTime(\\'' + s.attendance_id + '\\', \\'check_out_at\\', \\'' + coRaw + '\\', \\'' + sessionId + '\\')" title="클릭하여 수정">' + checkOut + '</span></td>';
    } else {
      html += '<td class="time">' + checkIn + '</td>';
      html += '<td class="time">' + checkOut + '</td>';
    }
    html += '<td><span class="badge ' + badgeClass + '">' + status + '</span>' + manual + '</td>';

    if (s.attendance_id) {
      html += '<td><select class="status-select" onchange="changeStatus(\\'' + s.attendance_id + '\\', this.value)">';
      html += '<option value="">변경</option>';
      ['출석','지각','조퇴','결석'].forEach(st => {
        html += '<option value="' + st + '"' + (st === s.status ? ' disabled' : '') + '>' + st + '</option>';
      });
      html += '</select></td>';
    } else {
      html += '<td style="color:#86868b;font-size:12px;">기록 없음</td>';
    }
    html += '</tr>';
  }

  html += '</table></div></div>';
  area.innerHTML = html;
}

// ─── 상태 수동 변경 ──────────────────────────────────────
async function changeStatus(attendanceId, newStatus) {
  if (!newStatus) return;
  if (!confirm(newStatus + '(으)로 변경하시겠습니까?')) {
    loadAttendance(currentSessionId);
    return;
  }
  await fetch('/api/admin/attendance/' + attendanceId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: newStatus })
  });
  loadAttendance(currentSessionId);
}

// ─── 미입실자 결석 일괄 처리 ─────────────────────────────
async function markAbsent(sessionId) {
  if (!confirm('입실 기록이 없는 수강생을 모두 결석 처리하시겠습니까?')) return;
  const res = await fetch('/api/admin/mark-absent/' + sessionId, { method: 'POST' });
  const data = await res.json();
  alert(data.count + '명 결석 처리되었습니다.');
  loadAttendance(sessionId);
}

// ─── 전체 요약 ───────────────────────────────────────────
async function loadSummary() {
  if (!currentCourseId) return;
  document.getElementById('content').innerHTML = '<div id="loading">불러오는 중...</div>';

  const res = await fetch('/api/admin/summary/' + currentCourseId);
  const rows = await res.json();

  let html = '<div class="card">';
  html += '<b>전체 회차 출결 요약</b><br><br>';
  html += '<div style="overflow-x:auto;"><table>';
  html += '<tr><th>이름</th><th>전화번호</th><th>출석</th><th>지각</th><th>조퇴</th><th>결석</th><th>출석률</th></tr>';

  for (const r of rows) {
    const rate = r.attendance_rate;
    const barColor = rate >= 80 ? '#34c759' : rate >= 50 ? '#ff9500' : '#ff3b30';
    html += '<tr>';
    html += '<td><b>' + r.name + '</b></td>';
    html += '<td class="time">' + r.phone + '</td>';
    html += '<td style="color:#137333;">' + r.attended + '</td>';
    html += '<td style="color:#e37400;">' + r.late + '</td>';
    html += '<td style="color:#c5221f;">' + r.early_leave + '</td>';
    html += '<td style="color:#5f6368;">' + r.absent + '</td>';
    html += '<td><div class="rate-bar"><div class="rate-fill" style="width:' + rate + '%;background:' + barColor + ';"></div></div>' + rate + '%</td>';
    html += '</tr>';
  }

  html += '</table></div></div>';
  document.getElementById('content').innerHTML = html;
}

// ─── 입실/퇴실 시각 수정 ────────────────────────────────────
async function editTime(attendanceId, field, currentValue, sessionId) {
  const fieldName = field === 'check_in_at' ? '입실 시각' : '퇴실 시각';

  let defaultVal = '';
  if (currentValue) {
    const d = new Date(currentValue);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    defaultVal = hh + ':' + mm;
  }

  const input = prompt(
    fieldName + '을 수정합니다.\\n' +
    '시각을 HH:MM 형식으로 입력하세요. (예: 09:30)\\n' +
    '비워두면 시각이 삭제됩니다.',
    defaultVal
  );

  if (input === null) return;

  let value = '';
  if (input.trim() !== '') {
    const match = input.trim().match(/^(\\d{1,2}):(\\d{2})$/);
    if (!match) {
      alert('형식이 올바르지 않습니다. HH:MM (예: 09:30)');
      return;
    }
    const hh = parseInt(match[1]);
    const mm = parseInt(match[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      alert('유효하지 않은 시각입니다.');
      return;
    }
    const today = new Date().toISOString().split('T')[0];
    value = today + ' ' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00';
  }

  try {
    const res = await fetch('/api/admin/attendance/' + attendanceId + '/time', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: field, value: value }),
    });
    const data = await res.json();
    if (data.success) {
      loadAttendance(sessionId);
    } else {
      alert('수정 실패: ' + (data.error || ''));
    }
  } catch (err) {
    alert('네트워크 오류: ' + err.message);
  }
}
</script>
</body>
</html>`;
}

// ═════════════════════════════════════════════════════════════
// 구글시트 동기화 페이지 HTML
// ═════════════════════════════════════════════════════════════
function renderSyncPage(courses) {
  const rows = courses.map(c => `
    <tr id="row-${c.course_id}">
      <td><b>${c.course_name}</b><br><span style="font-size:11px;color:#86868b;">${c.course_type || ''} ${c.cohort || ''}</span></td>
      <td><input type="text" class="sheet-input" id="sheet-${c.course_id}" value="${c.spreadsheet_id || ''}" placeholder="스프레드시트 ID 입력"></td>
      <td>
        <button class="btn btn-small" onclick="saveSheetId('${c.course_id}')">저장</button>
        <button class="btn btn-small btn-sync" onclick="syncCourse('${c.course_id}')" ${c.spreadsheet_id ? '' : 'disabled'}>동기화</button>
      </td>
      <td class="status-cell" id="status-${c.course_id}"></td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>구글시트 동기화 - 관리자</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Malgun Gothic', sans-serif; background: #f5f5f7; color: #1d1d1f; padding: 16px; }
    .container { max-width: 1000px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .subtitle { color: #86868b; font-size: 13px; margin-bottom: 20px; }
    .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card h2 { font-size: 16px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #e5e5e7; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 10px; background: #f5f5f7; color: #86868b; font-weight: 500; font-size: 12px; }
    td { padding: 10px 10px; border-top: 1px solid #f0f0f0; vertical-align: middle; }
    .sheet-input { width: 100%; padding: 8px 10px; border: 1.5px solid #d2d2d7; border-radius: 8px; font-size: 13px; font-family: monospace; }
    .sheet-input:focus { border-color: #1a73e8; outline: none; }
    .btn { padding: 6px 12px; border: none; border-radius: 6px; font-size: 12px; cursor: pointer; background: #1a73e8; color: #fff; }
    .btn:hover { background: #1557b0; }
    .btn:disabled { background: #d2d2d7; cursor: not-allowed; }
    .btn-small { padding: 5px 10px; font-size: 11px; }
    .btn-sync { background: #34c759; margin-left: 4px; }
    .btn-sync:hover { background: #2da44e; }
    .btn-all { background: #34c759; padding: 10px 20px; font-size: 14px; }
    .btn-all:hover { background: #2da44e; }
    .status-cell { font-size: 12px; min-width: 100px; }
    .back-link { font-size: 13px; color: #1a73e8; text-decoration: none; }
    .info-box { background: #e8f0fe; border-radius: 8px; padding: 14px 18px; margin-bottom: 16px; font-size: 13px; color: #1a73e8; line-height: 1.8; }
    .step-box { background: #f5f5f7; border-radius: 8px; padding: 12px 16px; margin: 8px 0; font-size: 13px; line-height: 1.8; }
    code { background: #e8e8e8; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  </style>
</head>
<body>
<div class="container">
  <a href="/" class="back-link">← 대시보드로 돌아가기</a>
  <h1 style="margin-top:12px;">📤 구글시트 동기화</h1>
  <p class="subtitle">과정별 출결 데이터를 구글시트로 내보내기</p>

  <div class="card">
    <h2>📋 사용법</h2>
    <div class="step-box">
      <b>1단계:</b> 과정별로 빈 구글 스프레드시트를 1개씩 만듭니다.<br>
      <b>2단계:</b> 스프레드시트 주소에서 ID를 복사합니다.<br>
      　　예: <code>https://docs.google.com/spreadsheets/d/<b style="color:#1a73e8;">여기가_ID</b>/edit</code><br>
      <b>3단계:</b> 스프레드시트를 서비스 계정 이메일과 공유합니다. (편집 권한)<br>
      <b>4단계:</b> 아래 표에서 ID를 붙여넣고 "저장" → "동기화" 클릭
    </div>
  </div>

  <div class="card">
    <h2>과정별 스프레드시트 설정</h2>
    <div style="overflow-x:auto;">
      <table>
        <tr><th>과정</th><th>스프레드시트 ID</th><th>작업</th><th>상태</th></tr>
        ${rows}
      </table>
    </div>
    <div style="margin-top:16px; text-align:right;">
      <button class="btn btn-all" onclick="syncAll()">🔄 전체 동기화</button>
    </div>
  </div>
</div>

<script>
  async function saveSheetId(courseId) {
    const input = document.getElementById('sheet-' + courseId);
    const statusEl = document.getElementById('status-' + courseId);
    const val = input.value.trim();

    const res = await fetch('/api/admin/course-sheet/' + courseId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spreadsheetId: val })
    });

    if (res.ok) {
      statusEl.innerHTML = '<span style="color:#34c759;">✅ 저장됨</span>';
      // 동기화 버튼 활성화
      const syncBtn = document.querySelector('#row-' + courseId + ' .btn-sync');
      if (syncBtn) syncBtn.disabled = !val;
    } else {
      statusEl.innerHTML = '<span style="color:#ff3b30;">❌ 저장 실패</span>';
    }
  }

  async function syncCourse(courseId) {
    const statusEl = document.getElementById('status-' + courseId);
    statusEl.innerHTML = '<span style="color:#1a73e8;">⏳ 동기화 중...</span>';

    try {
      const res = await fetch('/api/admin/sync/' + courseId, { method: 'POST' });
      const data = await res.json();

      if (data.success) {
        statusEl.innerHTML = '<span style="color:#34c759;">✅ 완료 (' + data.studentsCount + '명, ' + data.sheetsUpdated + '탭)</span>';
      } else {
        statusEl.innerHTML = '<span style="color:#ff3b30;">❌ ' + (data.error || '실패') + '</span>';
      }
    } catch (err) {
      statusEl.innerHTML = '<span style="color:#ff3b30;">❌ ' + err.message + '</span>';
    }
  }

  async function syncAll() {
    if (!confirm('전체 과정을 구글시트로 동기화하시겠습니까?')) return;

    document.querySelectorAll('.status-cell').forEach(el => {
      if (el.closest('tr').querySelector('.sheet-input').value.trim()) {
        el.innerHTML = '<span style="color:#1a73e8;">⏳ 대기 중...</span>';
      }
    });

    try {
      const res = await fetch('/api/admin/sync-all', { method: 'POST' });
      const results = await res.json();

      for (const r of results) {
        // 과정명으로 매칭 (간접)
        const rows = document.querySelectorAll('tr[id^="row-"]');
        for (const row of rows) {
          if (row.querySelector('b').textContent === r.courseName) {
            const statusEl = row.querySelector('.status-cell');
            if (r.status === 'success') {
              statusEl.innerHTML = '<span style="color:#34c759;">✅ 완료</span>';
            } else {
              statusEl.innerHTML = '<span style="color:#ff3b30;">❌ ' + r.error + '</span>';
            }
          }
        }
      }
    } catch (err) {
      alert('동기화 오류: ' + err.message);
    }
  }
</script>
</body>
</html>`;
}

module.exports = { registerAdminRoutes };
