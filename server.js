require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const qr = require('./qr');
const auth = require('./auth');
const attend = require('./attendance');
const admin = require('./admin');
const sync = require('./sync');
const push = require('./push');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 관리자 출결 현황 라우트 등록
admin.registerAdminRoutes(app);


// ════════════════════════════════════════════════════════════
// 기본 라우트
// ════════════════════════════════════════════════════════════

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});


// ═══ 루트: 수강생 앱으로 안내 ═════════════════════════════════
app.get('/', (req, res) => {
  res.redirect('/app');
});

// ═══ 관리자 대시보드 ═════════════════════════════════════════
app.get('/admin', async (req, res) => {
  try {
    const dbCheck = await db.query('SELECT NOW() AS server_time');
    const classrooms = await db.query('SELECT classroom_code, classroom_name FROM classrooms ORDER BY classroom_code');
    const courses = await db.query(`
      SELECT c.course_name, c.course_code, c.course_type, c.cohort, cr.classroom_name AS default_room
      FROM courses c LEFT JOIN classrooms cr ON cr.classroom_id = c.default_classroom_id
      ORDER BY c.course_type, c.course_name
    `);
    const studentCount = await db.query('SELECT COUNT(*) AS cnt FROM students');
    const credCount = await db.query('SELECT COUNT(DISTINCT student_id) AS cnt FROM credentials');
    const sessionCount = await db.query('SELECT COUNT(*) AS cnt FROM course_sessions');
    const attendanceCount = await db.query('SELECT COUNT(*) AS cnt FROM attendance');
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    res.send(renderAdminPage({
      serverTime: dbCheck.rows[0].server_time, baseUrl,
      classrooms: classrooms.rows, courses: courses.rows,
      studentCount: studentCount.rows[0].cnt,
      credCount: credCount.rows[0].cnt,
      sessionCount: sessionCount.rows[0].cnt,
      attendanceCount: attendanceCount.rows[0].cnt,
    }));
  } catch (err) {
    res.status(500).send(`<html><body style="font-family:sans-serif;padding:40px;"><h1>DB 연결 실패</h1><p>${err.message}</p></body></html>`);
  }
});


// ════════════════════════════════════════════════════════════
// QR 코드 라우트 (3단계에서 만든 것)
// ════════════════════════════════════════════════════════════

app.get('/qr/:classroomCode', async (req, res) => {
  const crRes = await db.query('SELECT classroom_code, classroom_name FROM classrooms WHERE classroom_code = $1', [req.params.classroomCode]);
  if (crRes.rows.length === 0) return res.status(404).send('존재하지 않는 강의실');
  res.send(renderQRPage(crRes.rows[0], `${req.protocol}://${req.get('host')}`));
});

app.post('/api/qr-token/:classroomCode', async (req, res) => {
  try {
    const token = await qr.generateToken(req.params.classroomCode);
    res.json(token);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ════════════════════════════════════════════════════════════
// 수강생 스캔 → 생체인증 흐름
// ════════════════════════════════════════════════════════════

// ─── 스캔 페이지 (QR 스캔 후 도착) ──────────────────────────
app.get('/scan', async (req, res) => {
  const { token, room } = req.query;
  if (!token || !room) return res.send(renderErrorPage('QR 코드를 다시 스캔해주세요.'));

  const result = await qr.validateToken(token, room);
  if (!result.valid) return res.send(renderErrorPage(result.reason));

  // QR 유효 → 본인확인 + 생체인증 페이지
  res.send(renderScanAuthPage(result.classroomCode, result.classroomName, token));
});

// ─── API: 전화번호로 수강생 조회 ─────────────────────────────
app.post('/api/student/lookup', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: '전화번호를 입력해주세요.' });

    const cleaned = phone.replace(/[^0-9]/g, '');
    const formatted = cleaned.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');

    const result = await db.query(`
      SELECT s.student_id, s.name, s.phone,
             (SELECT COUNT(*) FROM credentials cr WHERE cr.student_id = s.student_id) > 0 AS has_credential
      FROM students s WHERE s.phone = $1 OR s.phone = $2
    `, [phone, formatted]);

    if (result.rows.length === 0) {
      return res.json({ found: false });
    }

    const student = result.rows[0];
    res.json({
      found: true,
      studentId: student.student_id,
      name: student.name,
      hasCredential: student.has_credential,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ════════════════════════════════════════════════════════════
// 수강생 전용 앱 페이지 (PWA 홈 화면 저장용)
// ════════════════════════════════════════════════════════════
app.get('/app', (req, res) => {
  res.send(renderAppPage());
});

// ─── API: 오늘 출결 상태 (수강생 개인용) ─────────────────────
app.get('/api/my/status/:studentId', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT a.attendance_id, a.check_in_at, a.check_out_at, a.status, a.exit_type,
             c.course_name, cr.classroom_name,
             cs.session_number, cs.start_time, cs.end_time
      FROM attendance a
      JOIN course_sessions cs ON cs.session_id = a.session_id
      JOIN courses c ON c.course_id = cs.course_id
      LEFT JOIN classrooms cr ON cr.classroom_id = a.classroom_id
      WHERE a.student_id = $1
        AND cs.session_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE
      ORDER BY a.check_in_at DESC LIMIT 1
    `, [req.params.studentId]);
    if (r.rows.length === 0) return res.json({ hasRecord: false });
    res.json({ hasRecord: true, ...r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ════════════════════════════════════════════════════════════
// 생체인증 등록 (온보딩)
// ════════════════════════════════════════════════════════════

// ─── 등록 페이지 ─────────────────────────────────────────────
app.get('/register', async (req, res) => {
  const { token } = req.query;

  // 토큰 없이 접근 → 전화번호 입력 페이지 (공용 등록 입구)
  if (!token) {
    return res.send(renderRegisterPhonePage());
  }

  // 토큰 검증
  try {
    const tokenRes = await db.query(`
      SELECT ac.student_id, s.name
      FROM auth_challenges ac
      JOIN students s ON s.student_id = ac.student_id
      WHERE ac.challenge = $1 AND ac.type = 'reg_token' AND ac.expires_at > NOW()
    `, [token]);

    if (tokenRes.rows.length === 0) {
      return res.send(renderRegisterExpiredPage());
    }

    res.send(renderRegisterPage(token, tokenRes.rows[0].student_id, tokenRes.rows[0].name));
  } catch (err) {
    res.status(500).send(renderRegisterExpiredPage());
  }
});

// ─── API: 전화번호로 토큰 조회 ───────────────────────────────
app.post('/api/register/phone-lookup', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.json({ found: false, error: '전화번호를 입력하세요.' });

    // 전화번호 정규화
    const digits = phone.replace(/\D/g, '');
    let normalized = '';
    if (digits.length === 11) {
      normalized = digits.slice(0,3) + '-' + digits.slice(3,7) + '-' + digits.slice(7);
    } else if (digits.length === 8) {
      normalized = '010-' + digits.slice(0,4) + '-' + digits.slice(4);
    } else {
      return res.json({ found: false, error: '올바른 전화번호 형식이 아닙니다.' });
    }

    // 수강생 조회
    const studentRes = await db.query(
      "SELECT student_id, name FROM students WHERE phone = $1 AND status = 'active'",
      [normalized]
    );
    if (studentRes.rows.length === 0) {
      return res.json({ found: false, error: '등록되지 않은 번호입니다.' });
    }
    const student = studentRes.rows[0];

    // 크레덴셜(생체인증) 등록 여부 확인
    const credRes = await db.query(
      'SELECT COUNT(*) AS cnt FROM credentials WHERE student_id = $1',
      [student.student_id]
    );
    const hasCredential = parseInt(credRes.rows[0].cnt) > 0;

    if (hasCredential) {
      // ── 재등록: 관리자 발급 토큰 필요 ───────────────────────
      const tokenRes = await db.query(
        "SELECT challenge FROM auth_challenges WHERE student_id = $1 AND type = 'reg_token' AND expires_at > NOW()",
        [student.student_id]
      );
      if (tokenRes.rows.length === 0) {
        return res.json({ found: true, hasToken: false, name: student.name,
          error: '이미 등록된 번호입니다. 기기 변경이 필요하면 담당자에게 문의하세요.' });
      }
      return res.json({ found: true, hasToken: true, token: tokenRes.rows[0].challenge, name: student.name });
    }

    // ── 신규 등록: 토큰 자동 생성 후 즉시 등록 허용 ─────────
    const crypto = require('crypto');
    const token = crypto.randomBytes(24).toString('base64url');
    await db.query(`
      INSERT INTO auth_challenges (student_id, challenge, type, expires_at)
      VALUES ($1, $2, 'reg_token', NOW() + INTERVAL '10 minutes')
      ON CONFLICT (student_id, type) DO UPDATE SET challenge = $2, expires_at = NOW() + INTERVAL '10 minutes'
    `, [student.student_id, token]);

    res.json({ found: true, hasToken: true, token, name: student.name, isNew: true });
  } catch (err) {
    res.status(500).json({ found: false, error: err.message });
  }
});

// ─── API: 등록 옵션 생성 ─────────────────────────────────────
app.post('/api/register/options', async (req, res) => {
  try {
    const { studentId, token } = req.body;

    const tokenRes = await db.query(`
      SELECT student_id FROM auth_challenges
      WHERE challenge = $1 AND student_id = $2 AND type = 'reg_token' AND expires_at > NOW()
    `, [token, studentId]);

    if (tokenRes.rows.length === 0) {
      return res.status(403).json({ error: '유효하지 않은 등록 링크입니다. 관리자에게 새 링크를 요청하세요.' });
    }

    const student = await db.query('SELECT student_id, name FROM students WHERE student_id = $1', [studentId]);
    if (student.rows.length === 0) return res.status(404).json({ error: '수강생 정보 없음' });

    const options = await auth.createRegistrationOptions(req, studentId, student.rows[0].name);
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: 등록 검증 ─────────────────────────────────────────
app.post('/api/register/verify', async (req, res) => {
  try {
    const { studentId, token, response } = req.body;

    const tokenRes = await db.query(`
      SELECT student_id FROM auth_challenges
      WHERE challenge = $1 AND student_id = $2 AND type = 'reg_token' AND expires_at > NOW()
    `, [token, studentId]);

    if (tokenRes.rows.length === 0) {
      return res.status(403).json({ error: '유효하지 않은 등록 링크입니다.' });
    }

    // 기존 등록 여부 확인 → 있으면 보류 처리
    const existingCred = await db.query(
      'SELECT COUNT(*) AS cnt FROM credentials WHERE student_id = $1', [studentId]
    );
    const isReRegister = parseInt(existingCred.rows[0].cnt) > 0;

    const result = await auth.verifyRegistration(req, studentId, response, isReRegister);

    if (result.verified) {
      // 토큰 소멸 (보류 포함 1회용)
      await db.query(
        "DELETE FROM auth_challenges WHERE student_id = $1 AND type = 'reg_token'",
        [studentId]
      );
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ════════════════════════════════════════════════════════════
// 생체인증 인증 (출결 체크 시)
// ════════════════════════════════════════════════════════════

// ─── API: 인증 옵션 생성 ─────────────────────────────────────
app.post('/api/auth/options', async (req, res) => {
  try {
    const { studentId } = req.body;
    const options = await auth.createAuthenticationOptions(req, studentId);
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: 인증 검증 + 출결 기록 ─────────────────────────────
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { studentId, response, classroomCode } = req.body;
    const result = await auth.verifyAuthentication(req, studentId, response);

    if (!result.verified) {
      return res.json(result);
    }

    // 생체인증 성공 → 출결 기록
    if (classroomCode) {
      const attendResult = await attend.recordAttendance(studentId, classroomCode);
      return res.json({ verified: true, attendance: attendResult });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: 패스키 직접 인증 (전화번호 불필요) ─────────────────
app.post('/api/auth/passkey-start', async (req, res) => {
  try {
    const { studentId, discoverable } = req.body || {};
    const options = await auth.createPasskeyAuthOptions(req, studentId || null, !!discoverable);
    res.json(options);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/passkey-verify', async (req, res) => {
  try {
    const { response, classroomCode, attendanceId } = req.body;
    const result = await auth.verifyPasskeyAuth(req, response);

    if (!result.verified) {
      return res.json(result);
    }

    // 출결 기록 (QR 스캔 입실용)
    if (classroomCode) {
      const attendResult = await attend.recordAttendance(result.studentId, classroomCode);
      return res.json({ verified: true, studentId: result.studentId, studentName: result.studentName, attendance: attendResult });
    }

    // 퇴실 처리 (패스키 인증 + 퇴실 통합)
    if (attendanceId) {
      // attendanceId가 인증된 수강생의 것인지 확인
      const attCheck = await db.query(
        'SELECT attendance_id, student_id, check_out_at FROM attendance WHERE attendance_id = $1',
        [attendanceId]
      );
      if (attCheck.rows.length === 0) {
        return res.json({ verified: true, checkoutSuccess: false, error: '출결 기록을 찾을 수 없습니다.' });
      }
      if (attCheck.rows[0].student_id !== result.studentId) {
        return res.json({ verified: true, checkoutSuccess: false, error: '본인의 출결 기록이 아닙니다.' });
      }
      if (attCheck.rows[0].check_out_at) {
        return res.json({ verified: true, checkoutSuccess: true, message: '이미 퇴실 처리되었습니다.' });
      }

      await db.query(
        "UPDATE attendance SET check_out_at = NOW(), exit_type = '정상', updated_at = NOW() WHERE attendance_id = $1",
        [attendanceId]
      );
      console.log('[Checkout] ' + result.studentName + ' 퇴실 처리 완료 (인증퇴실)');
      return res.json({ verified: true, checkoutSuccess: true, message: result.studentName + '님 퇴실이 처리되었습니다.' });
    }

    res.json(result);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.json({ verified: false, error: 'NOT_FOUND', message: '등록되지 않은 기기입니다. /register 에서 재등록해주세요.' });
    }
    if (err.message === 'WRONG_STUDENT') {
      return res.json({ verified: false, error: 'WRONG_STUDENT', message: '본인 기기로 인증해주세요.' });
    }
    console.error('[passkey-verify] 오류:', err.message);
    return res.json({ verified: false, error: err.message, message: err.message });
  }
});

// ─── API: 패스키 인증 + 퇴실 처리 (원자적) ──────────────────
// 패스키 검증 성공 시 서버에서 직접 퇴실 처리 (클라이언트가 별도 API 호출 불필요)
app.post('/api/auth/checkout', async (req, res) => {
  try {
    const { response, studentId, attendanceId } = req.body;
    if (!response || !studentId || !attendanceId) {
      return res.json({ success: false, error: '필수 정보가 누락되었습니다.' });
    }

    // 1. 패스키 검증
    const authResult = await auth.verifyPasskeyAuth(req, response);
    if (!authResult.verified) {
      return res.json({ success: false, error: authResult.message || '인증 실패' });
    }

    // 2. 인증된 수강생과 퇴실 대상 일치 확인
    if (authResult.studentId !== studentId) {
      return res.json({ success: false, error: '본인 기기로 인증해주세요.' });
    }

    // 3. 출결 기록 확인
    const record = await db.query(`
      SELECT a.attendance_id, a.check_out_at, s.name
      FROM attendance a
      JOIN students s ON s.student_id = a.student_id
      WHERE a.attendance_id = $1 AND a.student_id = $2
    `, [attendanceId, studentId]);

    if (record.rows.length === 0) {
      return res.json({ success: false, error: '출결 기록을 찾을 수 없습니다.' });
    }
    if (record.rows[0].check_out_at) {
      return res.json({ success: true, message: '이미 퇴실 처리되었습니다.' });
    }

    // 4. 퇴실 처리
    await db.query(`
      UPDATE attendance SET check_out_at = NOW(), exit_type = '정상', updated_at = NOW()
      WHERE attendance_id = $1
    `, [attendanceId]);

    console.log('[Auth Checkout] ' + record.rows[0].name + ' 퇴실 처리 완료 (생체인증)');
    return res.json({ success: true, message: record.rows[0].name + '님 퇴실이 처리되었습니다.' });

  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.json({ success: false, error: '등록되지 않은 기기입니다. /register 에서 재등록해주세요.' });
    if (err.message === 'WRONG_STUDENT') return res.json({ success: false, error: '본인 기기로 인증해주세요.' });
    console.error('[Auth Checkout] 오류:', err.message);
    return res.json({ success: false, error: err.message || '인증 또는 퇴실 처리 중 오류가 발생했습니다.' });
  }
});


// ════════════════════════════════════════════════════════════
// API 라우트
// ════════════════════════════════════════════════════════════

app.get('/api/classrooms', async (req, res) => {
  try {
    const r = await db.query('SELECT classroom_id, classroom_code, classroom_name FROM classrooms ORDER BY classroom_code');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/courses', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT c.course_id, c.course_name, c.course_code, c.course_type, c.cohort, c.total_sessions, cr.classroom_code, cr.classroom_name
      FROM courses c LEFT JOIN classrooms cr ON cr.classroom_id = c.default_classroom_id ORDER BY c.course_type, c.course_name
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/students', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT s.student_id, s.name, s.phone, s.status, c.course_name,
             (SELECT COUNT(*) FROM credentials cr WHERE cr.student_id = s.student_id) > 0 AS has_credential
      FROM students s LEFT JOIN enrollments e ON e.student_id = s.student_id
      LEFT JOIN courses c ON c.course_id = e.course_id ORDER BY c.course_name, s.name
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: 오늘 출결 현황 ─────────────────────────────────────
app.get('/api/attendance/today', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT s.name, s.phone, c.course_name,
             a.check_in_at, a.check_out_at, a.status, a.exit_type,
             cr.classroom_name
      FROM attendance a
      JOIN students s ON s.student_id = a.student_id
      JOIN course_sessions cs ON cs.session_id = a.session_id
      JOIN courses c ON c.course_id = cs.course_id
      LEFT JOIN classrooms cr ON cr.classroom_id = a.classroom_id
      WHERE cs.session_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE
      ORDER BY c.course_name, a.check_in_at
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ════════════════════════════════════════════════════════════
// Google Sheets 동기화 라우트
// ════════════════════════════════════════════════════════════

// ─── API: 과정별 스프레드시트 ID 저장 ────────────────────────
app.put('/api/admin/course-sheet/:courseId', async (req, res) => {
  try {
    const { spreadsheetId } = req.body;
    await db.query('UPDATE courses SET spreadsheet_id = $1 WHERE course_id = $2', [spreadsheetId || null, req.params.courseId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: 과정 1개 → 구글시트 동기화 ────────────────────────
app.post('/api/admin/sync/:courseId', async (req, res) => {
  try {
    const courseRes = await db.query('SELECT spreadsheet_id FROM courses WHERE course_id = $1', [req.params.courseId]);
    if (courseRes.rows.length === 0) return res.status(404).json({ error: '과정 없음' });
    const { spreadsheet_id } = courseRes.rows[0];
    if (!spreadsheet_id) return res.status(400).json({ error: '스프레드시트 ID가 설정되지 않았습니다.' });

    const { sessionNumbers, includeSummary } = req.body || {};
    const options = {};
    if (sessionNumbers && Array.isArray(sessionNumbers) && sessionNumbers.length > 0) {
      options.sessionNumbers = sessionNumbers;
      options.includeSummary = includeSummary !== false;
    }
    const result = await sync.syncToGoogleSheets(req.params.courseId, spreadsheet_id, options);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: 전체 과정 일괄 동기화 ─────────────────────────────
app.post('/api/admin/sync-all', async (req, res) => {
  try {
    const results = await sync.syncAllCourses();
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ════════════════════════════════════════════════════════════
// 페이지 렌더링
// ════════════════════════════════════════════════════════════

// ─── 공통 CSS ────────────────────────────────────────────────
const COMMON_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Malgun Gothic', sans-serif; background: #f5f5f7; color: #1d1d1f; }
  .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
  .card { background: #fff; border-radius: 16px; padding: 32px 24px; max-width: 400px; width: 100%; margin: 0 auto; text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h1 { font-size: 22px; margin-bottom: 8px; }
  h2 { font-size: 16px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #e5e5e7; }
  .subtitle { color: #86868b; font-size: 14px; margin-bottom: 24px; }
  .form-group { margin-bottom: 16px; text-align: left; }
  .form-group label { display: block; font-size: 13px; color: #86868b; margin-bottom: 6px; }
  .form-group input { width: 100%; padding: 12px 14px; border: 1.5px solid #d2d2d7; border-radius: 10px; font-size: 16px; outline: none; }
  .form-group input:focus { border-color: #1a73e8; }
  .btn { display: inline-block; width: 100%; padding: 14px; background: #1a73e8; color: #fff; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; }
  .btn:hover { background: #1557b0; }
  .btn:disabled { background: #d2d2d7; cursor: not-allowed; }
  .btn-outline { background: #fff; color: #1a73e8; border: 1.5px solid #1a73e8; }
  .msg { padding: 12px; border-radius: 10px; font-size: 14px; margin: 16px 0; line-height: 1.5; }
  .msg-success { background: #e6f4ea; color: #137333; }
  .msg-error { background: #fce8e6; color: #c5221f; }
  .msg-info { background: #e8f0fe; color: #1a73e8; }
  .student-name { font-size: 20px; font-weight: 700; margin: 12px 0 4px; }
  .student-phone { font-size: 14px; color: #86868b; margin-bottom: 20px; }
  .step { display: none; }
  .step.active { display: block; }
  .spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

// ─── 에러 페이지 ─────────────────────────────────────────────
function renderErrorPage(message) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>오류</title>
  <style>${COMMON_CSS}</style></head>
  <body style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;background:#003776;">
    <div class="card"><div class="icon">❌</div><h1>스캔 실패</h1><p style="color:#86868b;margin-top:12px;">${message}</p></div>
  </body></html>`;
}


// ─── 스캔 + 생체인증 페이지 ──────────────────────────────────
function renderScanAuthPage(classroomCode, classroomName, token) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>출결 체크 - ${classroomName}</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#1a73e8">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <style>${COMMON_CSS}</style>
  <script src="https://unpkg.com/@simplewebauthn/browser@11/dist/bundle/index.umd.min.js"></script>
  </head>
  <body style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;background:#003776;">
    <div class="card">

      <!-- Step 0: 패스키 직접 인증 (기본) -->
      <div id="step0" class="step active">
        <div class="icon">🔐</div>
        <h1>출결 체크</h1>
        <p class="subtitle">${classroomName}</p>
        <button class="btn" id="passkeyBtn" onclick="passkeyAuth()" style="font-size:18px;padding:16px 32px;">인증하기</button>
        <div id="passkeyMsg" style="margin-top:12px;"></div>
        <div style="margin-top:20px;"><a href="#" onclick="showStep(1);return false;" style="font-size:13px;color:#86868b;">전화번호로 인증 →</a></div>
      </div>

      <!-- Step 1: 전화번호 입력 (폴백) -->
      <div id="step1" class="step">
        <div class="icon">📱</div>
        <h1>전화번호 인증</h1>
        <p class="subtitle">${classroomName}</p>
        <div class="form-group">
          <label>전화번호 뒷자리 8자리</label>
          <input type="tel" id="phoneInput" placeholder="12345678" maxlength="8" inputmode="numeric" autocomplete="off">
        </div>
        <button class="btn" id="lookupBtn" onclick="lookupStudent()">확인</button>
        <div id="lookupMsg"></div>
        <div style="margin-top:12px;"><a href="#" onclick="showStep(0);return false;" style="font-size:13px;color:#86868b;">← 패스키 인증으로 돌아가기</a></div>
      </div>

      <!-- Step 2: 본인확인 + 생체인증 -->
      <div id="step2" class="step">
        <div class="icon">👋</div>
        <div class="student-name" id="studentName"></div>
        <div class="student-phone" id="studentPhone"></div>
        <button class="btn" id="authBtn" onclick="authenticate()">지문 / Face ID 인증</button>
        <div id="authMsg"></div>
        <button class="btn btn-outline" style="margin-top:12px;" onclick="goBack()">다른 번호로 다시 입력</button>
      </div>

      <!-- Step 3: 미등록 → 등록 안내 -->
      <div id="step3" class="step">
        <div class="icon">🔐</div>
        <h1>생체인증 등록 필요</h1>
        <p class="subtitle">처음 사용하시는 분은 생체인증을 등록해야 합니다.</p>
        <button class="btn" id="regBtn" onclick="registerBiometric()">지문 / Face ID 등록하기</button>
        <div id="regMsg"></div>
      </div>

      <!-- Step 4: 완료 -->
      <div id="step4" class="step">
        <div class="icon">✅</div>
        <div id="doneType" style="font-size:20px;font-weight:700;margin-bottom:8px;"></div>
        <div class="student-name" id="doneName"></div>
        <div style="font-size:14px;color:#86868b;margin-bottom:4px;" id="doneCourse"></div>
        <div style="font-size:14px;color:#86868b;margin-bottom:16px;" id="doneRoom"></div>
        <div class="msg msg-success" id="doneMsg"></div>
        <div style="font-size:15px;font-weight:600;margin-top:12px;font-variant-numeric:tabular-nums;" id="doneTime"></div>
      </div>

    </div>

    <script>
      const CLASSROOM_CODE = '${classroomCode}';
      const TOKEN = '${token}';
      let currentStudentId = null;
      let currentStudentName = null;

      // ─── 단계 전환 ──────────────────────────────────────
      function showStep(n) {
        document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
        document.getElementById('step' + n).classList.add('active');
        if (n === 1) {
          setTimeout(function() { document.getElementById('phoneInput').focus(); }, 100);
        }
      }

      function goBack() {
        showStep(1);
        document.getElementById('phoneInput').value = '';
        document.getElementById('lookupMsg').innerHTML = '';
      }

      // ─── 0. 패스키 직접 인증 (전화번호 불필요) ───────────
      async function passkeyAuth() {
        const btn = document.getElementById('passkeyBtn');
        const msgEl = document.getElementById('passkeyMsg');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 인증 중...';
        msgEl.innerHTML = '';

        try {
          // 패스키 옵션 요청 (입실: 수강생 미특정 → 기기의 모든 패스키 표시)
          const optRes = await fetch('/api/auth/passkey-start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          const options = await optRes.json();
          if (options.error) throw new Error(options.error);

          // 브라우저 패스키 인증 실행
          const authResp = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });

          // 서버 검증 + 출결 기록
          const verifyRes = await fetch('/api/auth/passkey-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response: authResp, classroomCode: CLASSROOM_CODE })
          });
          const verifyData = await verifyRes.json();

          if (verifyData.verified) {
            currentStudentId = verifyData.studentId || null;
            currentStudentName = verifyData.studentName;
            showResult(verifyData);
          } else if (verifyData.error === 'NOT_FOUND') {
            // 등록되지 않은 기기 → 전화번호 입력으로 전환
            msgEl.innerHTML = '<div class="msg msg-info">등록되지 않은 기기입니다. 전화번호로 등록해주세요.</div>';
            setTimeout(function() { showStep(1); }, 1500);
          } else {
            throw new Error(verifyData.error || verifyData.message || '인증 실패');
          }
        } catch (err) {
          if (err.name === 'NotAllowedError') {
            msgEl.innerHTML = '<div class="msg msg-info">인증이 취소되었습니다.</div>';
          } else if (err.name === 'AbortError' || err.message.includes('No credentials')) {
            // 패스키 없음 → 전화번호 입력으로
            msgEl.innerHTML = '<div class="msg msg-info">등록된 패스키가 없습니다. 전화번호로 진행해주세요.</div>';
            setTimeout(function() { showStep(1); }, 1500);
          } else {
            msgEl.innerHTML = '<div class="msg msg-error">' + (err.message || '인증 오류') + '</div>';
          }
        } finally {
          btn.disabled = false;
          btn.innerHTML = '인증하기';
          btn.style.fontSize = '18px';
        }
      }

      // ─── 결과 표시 (공통) ─────────────────────────────────
      function showResult(verifyData) {
        const a = verifyData.attendance;
        document.getElementById('doneName').textContent = currentStudentName + '님';

        if (a && a.success) {
          const typeMap = {
            'check_in': '🟢 입실 완료',
            'check_out': '🔵 퇴실 완료',
            'duplicate': '☑️ 이미 입실됨',
            'already_done': '✅ 출결 완료',
          };
          document.getElementById('doneType').textContent = typeMap[a.type] || a.type;
          document.getElementById('doneMsg').textContent = a.message;
          document.getElementById('doneCourse').textContent = a.courseName || '';
          document.getElementById('doneRoom').textContent = a.classroomName || '';

          if (a.isLate) document.getElementById('doneMsg').textContent += ' ⏰';
          if (a.isEarlyLeave) document.getElementById('doneMsg').textContent += ' ⏰';

          const timeEl = document.getElementById('doneTime');
          if (a.checkInTime && a.type === 'check_in') {
            timeEl.textContent = '입실: ' + new Date(a.checkInTime).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul'});
          } else if (a.checkOutTime) {
            timeEl.textContent = '퇴실: ' + new Date(a.checkOutTime).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul'});
          } else if (a.checkInTime) {
            timeEl.textContent = '입실: ' + new Date(a.checkInTime).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul'});
          } else {
            timeEl.textContent = '';
          }
        } else if (a && !a.success) {
          document.getElementById('doneType').textContent = '⚠️ 출결 처리 불가';
          document.getElementById('doneMsg').textContent = a.message;
          document.getElementById('doneCourse').textContent = a.courseName || '';
          document.getElementById('doneRoom').textContent = a.classroomName || '';
          document.getElementById('doneTime').textContent = '';
        }
        showStep(4);
        registerPushIfReady();
      }

      // ─── 1. 전화번호로 수강생 조회 ──────────────────────
      async function lookupStudent() {
        const input = document.getElementById('phoneInput').value.trim();
        const msgEl = document.getElementById('lookupMsg');
        const btn = document.getElementById('lookupBtn');

        if (input.length < 7) {
          msgEl.innerHTML = '<div class="msg msg-error">전화번호 뒷자리 8자리를 입력해주세요.</div>';
          return;
        }

        // 010 + 입력값으로 변환
        const phone = '010-' + input.slice(0, 4) + '-' + input.slice(4);

        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';

        try {
          const res = await fetch('/api/student/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
          });
          const data = await res.json();

          if (!data.found) {
            msgEl.innerHTML = '<div class="msg msg-error">등록되지 않은 전화번호입니다.<br>관리자에게 문의해주세요.</div>';
            return;
          }

          currentStudentId = data.studentId;
          currentStudentName = data.name;

          document.getElementById('studentName').textContent = data.name + '님';
          document.getElementById('studentPhone').textContent = phone;

          if (data.hasCredential) {
            // 이미 등록됨 → 인증 단계로
            showStep(2);
          } else {
            // 미등록 → 등록 안내
            showStep(3);
          }
        } catch (err) {
          msgEl.innerHTML = '<div class="msg msg-error">서버 오류: ' + err.message + '</div>';
        } finally {
          btn.disabled = false;
          btn.textContent = '확인';
        }
      }

      // ─── 2. 생체인증 실행 ───────────────────────────────
      async function authenticate() {
        const btn = document.getElementById('authBtn');
        const msgEl = document.getElementById('authMsg');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 인증 중...';
        msgEl.innerHTML = '';

        try {
          // 인증 옵션 요청
          const optRes = await fetch('/api/auth/options', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: currentStudentId })
          });
          const options = await optRes.json();
          if (options.error) throw new Error(options.error);

          // 브라우저 생체인증 실행
          const authResp = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });

          // 서버 검증 + 출결 기록
          const verifyRes = await fetch('/api/auth/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: currentStudentId, response: authResp, classroomCode: CLASSROOM_CODE })
          });
          const verifyData = await verifyRes.json();

          if (verifyData.verified) {
            showResult(verifyData);
          } else {
            throw new Error(verifyData.error || '인증 실패');
          }
        } catch (err) {
          const msg = err.name === 'NotAllowedError' ? '생체인증이 취소되었습니다. 다시 시도해주세요.'
            : err.message || '인증 중 오류가 발생했습니다.';
          msgEl.innerHTML = '<div class="msg msg-error">' + msg + '</div>';
        } finally {
          btn.disabled = false;
          btn.textContent = '지문 / Face ID 인증';
        }
      }

      // ─── 3. 생체인증 등록 ───────────────────────────────
      async function registerBiometric() {
        const btn = document.getElementById('regBtn');
        const msgEl = document.getElementById('regMsg');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 등록 중...';
        msgEl.innerHTML = '';

        try {
          // 등록 옵션 요청
          const optRes = await fetch('/api/register/options', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: currentStudentId })
          });
          const options = await optRes.json();
          if (options.error) throw new Error(options.error);

          // 브라우저 생체인증 등록
          const regResp = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });

          // 서버 검증
          const verifyRes = await fetch('/api/register/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: currentStudentId, response: regResp })
          });
          const verifyData = await verifyRes.json();

          if (verifyData.verified) {
            msgEl.innerHTML = '<div class="msg msg-success">✅ 등록 완료! 이제 출결 인증을 진행합니다.</div>';
            // 1.5초 후 인증 단계로
            setTimeout(() => {
              document.getElementById('studentName').textContent = currentStudentName + '님';
              showStep(2);
            }, 1500);
          } else {
            throw new Error(verifyData.error || '등록 실패');
          }
        } catch (err) {
          const msg = err.name === 'NotAllowedError' ? '생체인증 등록이 취소되었습니다. 다시 시도해주세요.'
            : err.name === 'InvalidStateError' ? '이 기기에서 이미 등록되어 있습니다.'
            : err.message || '등록 중 오류가 발생했습니다.';
          msgEl.innerHTML = '<div class="msg msg-error">' + msg + '</div>';
        } finally {
          btn.disabled = false;
          btn.textContent = '지문 / Face ID 등록하기';
        }
      }

      // 엔터키로 확인
      document.getElementById('phoneInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') lookupStudent();
      });

      // ─── 서비스 워커 등록 + 푸시 구독 ──────────────────
      async function registerPushIfReady() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
        try {
          const reg = await navigator.serviceWorker.register('/sw.js');
          const keyRes = await fetch('/api/push/vapid-key');
          const { key } = await keyRes.json();
          if (!key) return;

          const existing = await reg.pushManager.getSubscription();
          if (existing) {
            await fetch('/api/push/subscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ studentId: currentStudentId, subscription: existing.toJSON() })
            });
            return;
          }

          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: key
          });

          await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: currentStudentId, subscription: sub.toJSON() })
          });
        } catch (e) { console.log('Push 등록 스킵:', e.message); }
      }
    </script>
  </body></html>`;
}


// ─── 등록 페이지 (토큰 유효 시) ─────────────────────────────
function renderRegisterPage(token, studentId, studentName) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>생체인증 등록 - ${studentName}</title>
  <style>${COMMON_CSS}</style>
  <script src="https://unpkg.com/@simplewebauthn/browser@11/dist/bundle/index.umd.min.js"></script>
  </head>
  <body style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;background:#003776;">
    <div class="card">

      <div id="step1" class="step active">
        <div class="icon">🔐</div>
        <h1>생체인증 등록</h1>
        <div class="student-name" style="margin-top:8px;">${studentName}님</div>
        <p class="subtitle" style="margin-top:8px;">아래 버튼을 눌러 이 기기의 지문 또는 Face ID를 등록하세요.</p>
        <button class="btn" id="regBtn" onclick="doRegister()" style="margin-top:8px;">지문 / Face ID 등록하기</button>
        <div id="msg1"></div>
      </div>

      <div id="step2" class="step">
        <div class="icon">✅</div>
        <h1>등록 완료!</h1>
        <div class="student-name">${studentName}님</div>
        <p class="subtitle" style="margin-top:8px;">이제 강의실 QR 스캔 시 이 기기로만 출결 체크가 됩니다.</p>
      </div>

      <div id="step3" class="step">
        <div class="icon">⏳</div>
        <h1>재등록 요청 접수</h1>
        <div class="student-name">${studentName}님</div>
        <p class="subtitle" style="margin-top:8px;">이미 등록된 번호이므로 관리자 승인 후 변경됩니다.<br>승인 전까지 기존 기기로 출결 체크가 가능합니다.</p>
      </div>

    </div>

    <script>
      const REG_TOKEN = '${token}';
      const STUDENT_ID = '${studentId}';

      function showStep(n) {
        document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
        document.getElementById('step' + n).classList.add('active');
      }

      async function doRegister() {
        const btn = document.getElementById('regBtn');
        const msgEl = document.getElementById('msg1');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 등록 중...';
        msgEl.innerHTML = '';

        try {
          const optRes = await fetch('/api/register/options', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: STUDENT_ID, token: REG_TOKEN })
          });
          const options = await optRes.json();
          if (options.error) throw new Error(options.error);

          const regResp = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });

          const verifyRes = await fetch('/api/register/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: STUDENT_ID, token: REG_TOKEN, response: regResp })
          });
          const verifyData = await verifyRes.json();

          if (verifyData.verified) {
            if (verifyData.pending) {
              showStep(3); // 재등록 → 관리자 승인 대기
            } else {
              showStep(2); // 신규 등록 완료
            }
          } else {
            throw new Error(verifyData.error || '등록 실패');
          }
        } catch (err) {
          const msg = err.name === 'NotAllowedError' ? '등록이 취소되었습니다. 다시 시도해주세요.'
            : err.name === 'InvalidStateError' ? '이미 이 기기에 등록되어 있습니다. 관리자에게 초기화를 요청하세요.'
            : err.message;
          msgEl.innerHTML = '<div class="msg msg-error">' + msg + '</div>';
        } finally {
          btn.disabled = false; btn.textContent = '지문 / Face ID 등록하기';
        }
      }
    </script>
  </body></html>`;
}

// ─── 등록 페이지 (공용 입구 - 전화번호 입력) ────────────────
function renderRegisterPhonePage() {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>생체인증 등록</title><style>${COMMON_CSS}</style>
  </head>
  <body style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;background:#003776;">
  <div class="card">

    <div id="step1" class="step active">
      <div class="icon">🔐</div>
      <h1>생체인증 등록</h1>
      <p class="subtitle" style="margin-top:6px;">전화번호를 입력하면 본인 등록 페이지로 이동합니다.</p>
      <div class="form-group" style="margin-top:16px;">
        <label>전화번호 뒷자리 8자리</label>
        <input type="tel" id="phoneInput" placeholder="12345678" maxlength="8" inputmode="numeric" autocomplete="off">
      </div>
      <button class="btn" id="lookupBtn" onclick="doLookup()">확인</button>
      <div id="msg1" style="margin-top:10px;"></div>
    </div>

    <div id="step2" class="step">
      <div class="icon">⏳</div>
      <h1>이동 중...</h1>
    </div>

  </div>
  <script>
    async function doLookup() {
      const input = document.getElementById('phoneInput').value.trim();
      const msgEl = document.getElementById('msg1');
      msgEl.innerHTML = '';
      if (input.length < 8) {
        msgEl.innerHTML = '<div class="msg msg-error">전화번호 뒷자리 8자리를 입력해주세요.</div>'; return;
      }
      const btn = document.getElementById('lookupBtn');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        const res = await fetch('/api/register/phone-lookup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: input })
        });
        const data = await res.json();
        if (!data.found || !data.hasToken) {
          msgEl.innerHTML = '<div class="msg msg-error">' + (data.error || '등록 링크가 없습니다.') + '</div>';
          return;
        }
        // 개인 등록 페이지로 이동
        document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
        document.getElementById('step2').classList.add('active');
        location.href = '/register?token=' + encodeURIComponent(data.token);
      } catch (err) {
        msgEl.innerHTML = '<div class="msg msg-error">오류: ' + err.message + '</div>';
      } finally {
        btn.disabled = false; btn.textContent = '확인';
      }
    }
    document.getElementById('phoneInput').addEventListener('keypress', e => { if (e.key === 'Enter') doLookup(); });
    document.getElementById('phoneInput').focus();
  </script>
  </body></html>`;
}

// ─── 등록 페이지 (토큰 만료 시) ─────────────────────────────
function renderRegisterExpiredPage() {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>링크 만료</title><style>${COMMON_CSS}</style></head>
  <body style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;background:#003776;">
    <div class="card">
      <div class="icon">⏰</div>
      <h1>등록 링크가 만료되었습니다</h1>
      <p class="subtitle" style="margin-top:8px;">링크는 발급 후 24시간만 유효합니다.<br>담당자에게 새 링크를 요청하세요.</p>
    </div>
  </body></html>`;
}


// ─── 수강생 전용 앱 페이지 (PWA) ────────────────────────────────
function renderAppPage() {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>출결체크</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#1a73e8">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <script src="https://unpkg.com/@simplewebauthn/browser@11/dist/bundle/index.umd.min.js"></script>
  <style>${COMMON_CSS}
    .toggle-row { display:flex; justify-content:space-between; align-items:center; padding:14px 0; border-bottom:1px solid #e5e5e7; }
    .toggle-label { font-size:15px; font-weight:500; }
    .toggle-desc { font-size:12px; color:#86868b; margin-top:2px; }
    .toggle-switch { position:relative; width:51px; height:31px; }
    .toggle-switch input { opacity:0; width:0; height:0; }
    .toggle-slider { position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:#e5e5e7; border-radius:31px; transition:.3s; }
    .toggle-slider:before { content:""; position:absolute; height:27px; width:27px; left:2px; bottom:2px; background:#fff; border-radius:50%; transition:.3s; box-shadow:0 1px 3px rgba(0,0,0,0.2); }
    .toggle-switch input:checked + .toggle-slider { background:#34c759; }
    .toggle-switch input:checked + .toggle-slider:before { transform:translateX(20px); }
    .status-row { display:flex; justify-content:space-between; padding:10px 0; font-size:14px; }
    .status-label2 { color:#86868b; }
    .status-value2 { font-weight:600; }
    .install-guide { background:#fff3e0; border-radius:10px; padding:14px 18px; margin-top:16px; font-size:13px; color:#e65100; line-height:1.8; }
  </style>
  </head>
  <body style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;background:#003776;">
    <div class="card" style="max-width:420px;">

      <!-- Step 1: 전화번호 입력 -->
      <div id="step1" class="step active">
        <div class="icon">📱</div>
        <h1>출결체크 앱</h1>
        <p class="subtitle">전화번호를 입력하여 시작하세요.</p>
        <div class="form-group">
          <label>전화번호 뒷자리 8자리</label>
          <input type="tel" id="phoneInput" placeholder="12345678" maxlength="8" inputmode="numeric" autocomplete="off">
        </div>
        <button class="btn" id="lookupBtn" onclick="appLogin()">시작</button>
        <div id="msg1"></div>
      </div>

      <!-- Step 2: 메인 화면 -->
      <div id="step2" class="step">
        <div class="icon">✅</div>
        <div class="student-name" id="appName"></div>
        <div class="student-phone" id="appPhone" style="margin-bottom:16px;"></div>

        <!-- 오늘 출결 현황 -->
        <div id="todayStatus" style="text-align:left; margin-bottom:20px;"></div>

        <!-- 퇴실 알림 토글 -->
        <div style="text-align:left;">
          <div class="toggle-row">
            <div>
              <div class="toggle-label">퇴실 알림</div>
              <div class="toggle-desc">수업 종료 10분 전 알림 받기</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="pushToggle" onchange="togglePush()">
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div id="pushMsg" style="margin-top:8px;"></div>

        <!-- 홈 화면 추가 안내 -->
        <div id="installGuide"></div>

        <button class="btn btn-outline" style="display:none;" onclick="appLogout()">
      </div>

    </div>

    <script>
      let appStudentId = null;
      let appStudentName = null;

      // ─── 자동 로그인 (localStorage) ──────────────────────
      window.addEventListener('load', function() {
        const saved = localStorage.getItem('app_phone');
        if (saved) {
          document.getElementById('phoneInput').value = saved;
          appLogin();
        }
        showInstallGuide();
      });

      function showStep(n) {
        document.querySelectorAll('.step').forEach(function(el) { el.classList.remove('active'); });
        document.getElementById('step' + n).classList.add('active');
      }

      // ─── 로그인 ────────────────────────────────────────────
      async function appLogin() {
        const input = document.getElementById('phoneInput').value.trim();
        const msgEl = document.getElementById('msg1');
        if (input.length < 7) { msgEl.innerHTML = '<div class="msg msg-error">전화번호 뒷자리 8자리를 입력해주세요.</div>'; return; }

        const phone = '010-' + input.slice(0, 4) + '-' + input.slice(4);
        const btn = document.getElementById('lookupBtn');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';

        try {
          const res = await fetch('/api/student/lookup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: phone })
          });
          const data = await res.json();
          if (!data.found) { msgEl.innerHTML = '<div class="msg msg-error">등록되지 않은 전화번호입니다.</div>'; return; }

          appStudentId = data.studentId;
          appStudentName = data.name;
          localStorage.setItem('app_phone', input);

          document.getElementById('appName').textContent = data.name + '님';
          document.getElementById('appPhone').textContent = phone;

          showStep(2);
          loadTodayStatus();
          checkPushStatus();
          handleCheckoutFromPush();
        } catch (err) {
          msgEl.innerHTML = '<div class="msg msg-error">' + err.message + '</div>';
        } finally { btn.disabled = false; btn.textContent = '시작'; }
      }

      function appLogout() {
        localStorage.removeItem('app_phone');
        appStudentId = null;
        document.getElementById('phoneInput').value = '';
        document.getElementById('msg1').innerHTML = '';
        showStep(1);
      }

      // ─── 오늘 출결 현황 ───────────────────────────────────
      async function loadTodayStatus() {
        const el = document.getElementById('todayStatus');
        try {
          const res = await fetch('/api/my/status/' + appStudentId);
          const data = await res.json();

          if (!data.hasRecord) {
            el.innerHTML = '<div class="msg msg-info">오늘 출결 기록이 없습니다.</div>';
            return;
          }

          // 퇴실 버튼용 데이터 저장
          window._checkoutData = null;
          if (data.check_in_at && !data.check_out_at && data.attendance_id) {
            window._checkoutData = { sid: appStudentId, aid: data.attendance_id };
          }

          let html = '<div style="background:#f5f5f7;border-radius:10px;padding:14px;">';
          html += '<div style="font-size:13px;font-weight:600;margin-bottom:8px;">오늘 출결 현황</div>';
          html += '<div class="status-row"><span class="status-label2">과정</span><span class="status-value2">' + (data.course_name || '-') + '</span></div>';
          html += '<div class="status-row"><span class="status-label2">입실</span><span class="status-value2">' + (data.check_in_at ? new Date(data.check_in_at).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit'}) : '-') + '</span></div>';
          html += '<div class="status-row"><span class="status-label2">퇴실</span><span class="status-value2">' + (data.check_out_at ? new Date(data.check_out_at).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit'}) : '-') + '</span></div>';
          html += '<div class="status-row"><span class="status-label2">상태</span><span class="status-value2">' + (data.status || '-') + '</span></div>';

          // 입실O + 퇴실X → 퇴실하기 버튼 표시
          if (data.check_in_at && !data.check_out_at) {
            html += '<div style="margin-top:12px;text-align:center;">';
            html += '<button onclick="manualCheckout()" style="width:100%;padding:14px;background:#1a73e8;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;">🔐 퇴실하기</button>';
            html += '<div style="font-size:11px;color:#86868b;margin-top:4px;">위치 확인 + 생체인증 후 퇴실 처리됩니다</div>';
            html += '</div>';
          }

          html += '</div>';
          el.innerHTML = html;
        } catch (err) {
          el.innerHTML = '<div class="msg msg-error">현황 조회 실패</div>';
        }
      }

      // ─── 수동 퇴실 (앱 내 버튼) ────────────────────────────
      async function manualCheckout() {
        if (!window._checkoutData) {
          alert('퇴실할 출결 기록이 없습니다.');
          return;
        }
        // handleCheckoutFromPush와 동일한 플로우 실행
        const url = '/app?checkout=true&sid=' + encodeURIComponent(window._checkoutData.sid) + '&aid=' + encodeURIComponent(window._checkoutData.aid);
        window.history.replaceState({}, '', url);
        await handleCheckoutFromPush();
      }

      // ─── 푸시 알림 ────────────────────────────────────────
      async function checkPushStatus() {
        const toggle = document.getElementById('pushToggle');
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
          toggle.disabled = true;
          document.getElementById('pushMsg').innerHTML = '<div style="font-size:12px;color:#86868b;">이 브라우저는 알림을 지원하지 않습니다.</div>';
          return;
        }

        try {
          const reg = await navigator.serviceWorker.register('/sw.js');
          const sub = await reg.pushManager.getSubscription();
          toggle.checked = !!sub;
        } catch (e) {
          toggle.checked = false;
        }
      }

      async function togglePush() {
        const toggle = document.getElementById('pushToggle');
        const msgEl = document.getElementById('pushMsg');

        if (toggle.checked) {
          // 구독 등록
          try {
            const reg = await navigator.serviceWorker.ready;
            const keyRes = await fetch('/api/push/vapid-key');
            const { key } = await keyRes.json();
            if (!key) { msgEl.innerHTML = '<div style="font-size:12px;color:#ff3b30;">서버 VAPID 키 미설정</div>'; toggle.checked = false; return; }

            const sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: key
            });

            await fetch('/api/push/subscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ studentId: appStudentId, subscription: sub.toJSON() })
            });

            msgEl.innerHTML = '<div style="font-size:12px;color:#34c759;">알림이 활성화되었습니다.</div>';
          } catch (err) {
            toggle.checked = false;
            if (err.name === 'NotAllowedError') {
              msgEl.innerHTML = '<div style="font-size:12px;color:#ff3b30;">알림 권한이 거부되었습니다. 기기 설정에서 허용해주세요.</div>';
            } else {
              msgEl.innerHTML = '<div style="font-size:12px;color:#ff3b30;">알림 등록 실패: ' + err.message + '</div>';
            }
          }
        } else {
          // 구독 해제
          try {
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            if (sub) {
              await fetch('/api/push/unsubscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: sub.endpoint })
              });
              await sub.unsubscribe();
            }
            msgEl.innerHTML = '<div style="font-size:12px;color:#86868b;">알림이 해제되었습니다.</div>';
          } catch (err) {
            msgEl.innerHTML = '<div style="font-size:12px;color:#ff3b30;">해제 실패: ' + err.message + '</div>';
          }
        }
      }

      // ─── 푸시 알림에서 퇴실 처리 (위치확인 → 생체인증 → 퇴실) ──
      async function handleCheckoutFromPush() {
        var params = new URLSearchParams(window.location.search);
        if (params.get('checkout') !== 'true') return;

        var studentId = params.get('sid');
        var attendanceId = params.get('aid');
        if (!studentId || !attendanceId) return;

        window.history.replaceState({}, '', '/app');

        var msgEl = document.getElementById('todayStatus');
        function showMsg(text) {
          msgEl.innerHTML = '<div style="text-align:center;padding:20px;background:#f5f5f7;border-radius:12px;margin-bottom:12px;">' + text + '</div>';
        }

        // ── Step 1: 위치 설정 조회 ────────────────────────────
        showMsg('<div style="font-size:16px;margin-bottom:8px;">⏳</div><div style="font-size:14px;color:#86868b;">퇴실 처리 준비 중...</div>');

        var buildingSettings = { enabled: false };
        try { var sRes = await fetch('/api/settings/building'); buildingSettings = await sRes.json(); } catch (e) {}

        // ── Step 2: 위치 검증 ──────────────────────────────────
        if (buildingSettings.enabled && buildingSettings.lat && buildingSettings.lng) {
          showMsg('<div style="font-size:16px;margin-bottom:8px;">📍</div><div style="font-size:14px;color:#1a73e8;">위치 확인 중...</div>');
          try {
            var pos = await new Promise(function(resolve, reject) {
              navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
            });
            var dist = getDistanceMeters(pos.coords.latitude, pos.coords.longitude, buildingSettings.lat, buildingSettings.lng);
            if (dist > (buildingSettings.radius || 200)) {
              showMsg('<div style="font-size:24px;margin-bottom:8px;">🚫</div><div style="font-size:15px;font-weight:600;color:#ff3b30;">건물 외부 감지</div><div style="font-size:13px;color:#86868b;margin-top:6px;">건물에서 ' + Math.round(dist) + 'm 떨어져 있어 퇴실 처리가 되지 않았습니다.</div>');
              return;
            }
          } catch (locErr) {
            showMsg('<div style="font-size:24px;margin-bottom:8px;">📵</div><div style="font-size:15px;font-weight:600;color:#ff3b30;">' + (locErr.code === 1 ? '위치 권한이 거부되었습니다' : '위치 확인 실패') + '</div><div style="font-size:13px;color:#86868b;margin-top:6px;">퇴실 처리가 되지 않았습니다.</div>');
            return;
          }
        }

        // ── Step 3: 생체인증 + 퇴실 처리 (통합) ─────────────
        showMsg('<div style="font-size:16px;margin-bottom:8px;">🔐</div><div style="font-size:14px;color:#1a73e8;">생체인증을 진행해주세요</div>');
        await new Promise(function(r) { setTimeout(r, 400); });

        try {
          // discoverable: true → allowCredentials 미포함 (iOS PWA QR 프롬프트 방지)
          var optRes = await fetch('/api/auth/passkey-start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: studentId, discoverable: true })
          });
          var options = await optRes.json();
          if (options.error) throw new Error(options.error);

          // 안전장치: allowCredentials가 포함되어 있으면 제거 (iOS PWA 호환)
          if (options.allowCredentials) {
            delete options.allowCredentials;
          }

          var authResp = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });

          // 패스키 검증 + 퇴실 처리를 한 번에 (attendanceId 전달)
          var verifyRes = await fetch('/api/auth/passkey-verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response: authResp, attendanceId: attendanceId })
          });
          var verifyData = await verifyRes.json();

          if (!verifyData.verified) {
            var errMsg = verifyData.message || verifyData.error || '인증 실패';
            showMsg('<div style="font-size:24px;margin-bottom:8px;">❌</div><div style="font-size:15px;font-weight:600;color:#ff3b30;">' + errMsg + '</div>');
            return;
          }

          if (verifyData.checkoutSuccess) {
            msgEl.innerHTML = '<div style="text-align:center;padding:20px;background:#e6f4ea;border-radius:12px;margin-bottom:12px;"><div style="font-size:28px;margin-bottom:6px;">✅</div><div style="font-size:16px;font-weight:600;color:#137333;">' + (verifyData.message || '퇴실 처리 완료') + '</div></div>';
            setTimeout(function() { loadTodayStatus(); }, 1500);
          } else {
            showMsg('<div style="font-size:24px;margin-bottom:8px;">⚠️</div><div style="font-size:15px;font-weight:600;color:#ff3b30;">퇴실 처리 실패</div><div style="font-size:13px;color:#86868b;margin-top:6px;">' + (verifyData.error || '') + '</div>');
          }
        } catch (authErr) {
          if (authErr.name === 'NotAllowedError') {
            showMsg('<div style="font-size:24px;margin-bottom:8px;">✋</div><div style="font-size:15px;font-weight:600;color:#ff9500;">인증 취소됨</div><div style="font-size:13px;color:#86868b;margin-top:6px;">앱의 "퇴실하기" 버튼으로 재시도하세요.</div>');
          } else {
            showMsg('<div style="font-size:24px;margin-bottom:8px;">⚠️</div><div style="font-size:15px;font-weight:600;color:#ff3b30;">인증 오류</div><div style="font-size:13px;color:#86868b;margin-top:6px;">' + (authErr.message || '오류 발생') + '</div>');
          }
        }
      }

      // ─── Haversine 거리 계산 (미터) ──────────────────────
      function getDistanceMeters(lat1, lon1, lat2, lon2) {
        var R = 6371000;
        var p1 = lat1 * Math.PI / 180;
        var p2 = lat2 * Math.PI / 180;
        var dp = (lat2 - lat1) * Math.PI / 180;
        var dl = (lon2 - lon1) * Math.PI / 180;
        var a = Math.sin(dp/2)*Math.sin(dp/2) + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      }

      // ─── 홈 화면 추가 안내 ────────────────────────────────
      function showInstallGuide() {
        const el = document.getElementById('installGuide');
        if (!el) return;
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
        if (isStandalone) { el.innerHTML = ''; return; }

        const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
        const isAndroid = /android/i.test(navigator.userAgent);

        if (isIOS) {
          el.innerHTML = '<div class="install-guide"><b>홈 화면에 추가하기 (필수)</b><br>Safari 하단의 공유 버튼(□↑)을 누르고<br>"홈 화면에 추가"를 선택하세요.<br><br>홈 화면에 추가해야 퇴실 알림을 받을 수 있습니다.</div>';
        } else if (isAndroid) {
          el.innerHTML = '<div class="install-guide"><b>홈 화면에 추가하기</b><br>크롬 메뉴(⋮)를 누르고<br>"홈 화면에 추가" 또는 "앱 설치"를 선택하세요.</div>';
        }
      }

      document.getElementById('phoneInput').addEventListener('keypress', function(e) { if (e.key === 'Enter') appLogin(); });
      document.getElementById('phoneInput').focus();
    </script>
  </body></html>`;
}


// ─── 관리자 대시보드 ─────────────────────────────────────────
function renderAdminPage(data) {
  const classroomRows = data.classrooms.map(c => `
    <tr><td>${c.classroom_code}</td><td>${c.classroom_name}</td>
    <td><a href="/qr/${c.classroom_code}" target="_blank" class="btn-link">QR 화면 열기 →</a></td></tr>
  `).join('');
  const courseRows = data.courses.map(c => `
    <tr><td>${c.course_name}</td><td>${c.course_code||''}</td>
    <td><span class="badge ${c.course_type==='모집과정'?'blue':c.course_type==='위탁과정'?'green':c.course_type==='산교연과정'?'orange':'gray'}">${c.course_type||'-'}</span></td>
    <td>${c.cohort||'-'}</td><td>${c.default_room||'-'}</td></tr>
  `).join('');

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>출결 관리 시스템</title>
  <style>
    ${COMMON_CSS}
    .status-bar { background:#fff; border-radius:12px; padding:16px 20px; margin-bottom:20px; display:flex; gap:24px; flex-wrap:wrap; align-items:center; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
    .status-item { display:flex; flex-direction:column; }
    .status-label { font-size:12px; color:#86868b; }
    .status-value { font-size:18px; font-weight:600; }
    .status-ok { color:#34c759; }
    .card { max-width:100%; text-align:left; padding:20px; margin-bottom:20px; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th { text-align:left; padding:8px 12px; background:#f5f5f7; color:#86868b; font-weight:500; font-size:12px; }
    td { padding:8px 12px; border-top:1px solid #e5e5e7; }
    .badge { padding:2px 8px; border-radius:4px; font-size:12px; font-weight:500; }
    .blue { background:#e8f0fe; color:#1a73e8; } .green { background:#e6f4ea; color:#137333; }
    .orange { background:#fef3e0; color:#e37400; } .gray { background:#f1f3f4; color:#5f6368; }
    .stats-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:12px; }
    .stat-box { background:#f5f5f7; border-radius:8px; padding:16px; text-align:center; }
    .stat-number { font-size:28px; font-weight:700; color:#1a73e8; }
    .stat-label { font-size:12px; color:#86868b; margin-top:4px; }
    .btn-link { color:#1a73e8; text-decoration:none; font-size:13px; }
    .btn-link:hover { text-decoration:underline; }
    .info-box { background:#e8f0fe; border-radius:8px; padding:14px 18px; margin-top:12px; font-size:13px; color:#1a73e8; line-height:1.6; }
  </style></head>
  <body><div class="container">
    <h1>📋 출결 관리 시스템</h1><p class="subtitle">관리자 대시보드</p>
    <div class="status-bar">
      <div class="status-item"><span class="status-label">서버</span><span class="status-value status-ok">● 정상</span></div>
      <div class="status-item"><span class="status-label">DB</span><span class="status-value status-ok">● 연결됨</span></div>
      <div class="status-item"><span class="status-label">KST</span><span class="status-value">${new Date(data.serverTime).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}</span></div>
    </div>
    <div class="card"><h2>📊 현재 데이터 현황</h2>
      <div class="stats-grid">
        <div class="stat-box"><div class="stat-number">${data.courses.length}</div><div class="stat-label">교육과정</div></div>
        <div class="stat-box"><div class="stat-number">${data.classrooms.length}</div><div class="stat-label">강의실</div></div>
        <div class="stat-box"><div class="stat-number">${data.studentCount}</div><div class="stat-label">수강생</div></div>
        <div class="stat-box"><div class="stat-number">${data.credCount}</div><div class="stat-label">생체인증 등록</div></div>
        <div class="stat-box"><div class="stat-number">${data.sessionCount}</div><div class="stat-label">회차 스케줄</div></div>
        <div class="stat-box"><div class="stat-number">${data.attendanceCount}</div><div class="stat-label">출결 기록</div></div>
      </div>
    </div>
    <div class="card"><h2>📊 출결 현황 관리</h2>
      <p style="font-size:14px;color:#86868b;margin-bottom:12px;">과정별/회차별 출결 조회, 상태 수동 변경, 결석 일괄 처리:</p>
      <a href="/admin/attendance" class="btn-link" style="font-size:15px;font-weight:600;">출결 현황 페이지 열기 →</a>
    </div>
    <div class="card"><h2>👥 수강생 관리</h2>
      <p style="font-size:14px;color:#86868b;margin-bottom:12px;">수강생 일괄 등록, 생체인증 등록 현황, 통합 관리 시트:</p>
      <a href="/admin/students" class="btn-link" style="font-size:15px;font-weight:600;">수강생 관리 페이지 열기 →</a>
    </div>
    <div class="card"><h2>🏫 교육과정 관리</h2>
      <p style="font-size:14px;color:#86868b;margin-bottom:12px;">교육과정 추가/수정/삭제, 회차 관리, 강의실 관리:</p>
      <a href="/admin/courses" class="btn-link" style="font-size:15px;font-weight:600;">교육과정 관리 페이지 열기 →</a>
    </div>
    <div class="card"><h2>⚙️ 시스템 설정</h2>
      <p style="font-size:14px;color:#86868b;margin-bottom:12px;">퇴실 위치 검증, 건물 반경 설정:</p>
      <a href="/admin/settings" class="btn-link" style="font-size:15px;font-weight:600;">시스템 설정 열기 →</a>
    </div>
    <div class="card"><h2>📤 구글시트 동기화</h2>
      <p style="font-size:14px;color:#86868b;margin-bottom:12px;">과정별 출결 데이터를 구글시트로 자동 내보내기:</p>
      <a href="/admin/sync" class="btn-link" style="font-size:15px;font-weight:600;">구글시트 동기화 설정 →</a>
    </div>
    <div class="card"><h2>🚪 강의실 QR 코드</h2>
      <table><tr><th>코드</th><th>이름</th><th>QR</th></tr>${classroomRows}</table>
      <div class="info-box">💡 각 강의실 태블릿/노트북에서 "QR 화면 열기"를 클릭하세요.</div>
    </div>
    <div class="card"><h2>🔐 생체인증 등록 페이지</h2>
      <p style="font-size:14px;color:#86868b;margin-bottom:12px;">수업 첫날 수강생 단체 등록 시 아래 주소를 안내하세요:</p>
      <div style="background:#f5f5f7;padding:12px;border-radius:8px;font-family:monospace;font-size:14px;word-break:break-all;">${data.baseUrl}/register</div>
      <div class="info-box">💡 수강생이 이 주소에 접속 → 전화번호 입력 → 지문/Face ID 등록</div>
    </div>
    <div class="card"><h2>📱 수강생 앱 (PWA)</h2>
      <p style="font-size:14px;color:#86868b;margin-bottom:12px;">생체인증 등록 후, 아래 주소를 홈 화면에 추가하도록 안내하세요:</p>
      <div style="background:#f5f5f7;padding:12px;border-radius:8px;font-family:monospace;font-size:14px;word-break:break-all;">${data.baseUrl}/app</div>
      <div class="info-box">💡 수강생이 이 주소에 접속 → 전화번호 입력 → 홈 화면에 추가 → 알림 토글 켜기</div>
    </div>
    <div class="card"><h2>🏫 교육과정</h2>
      <table><tr><th>과정명</th><th>약칭</th><th>종류</th><th>기수</th><th>강의실</th></tr>${courseRows}</table>
    </div>
  </div></body></html>`;
}


// ─── QR 표시 화면 ────────────────────────────────────────────
function renderQRPage(classroom, baseUrl) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>QR - ${classroom.classroom_name}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,'Malgun Gothic',sans-serif;background:#000;color:#fff;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden}
    .room-name{font-size:32px;font-weight:700;margin-bottom:8px}
    .instruction{font-size:18px;color:#86868b;margin-bottom:30px}
    #qr-container{background:#fff;border-radius:24px;padding:32px}
    #qr-canvas{width:280px;height:280px}
    .timer-bar{margin-top:30px;text-align:center}
    .timer-text{font-size:48px;font-weight:700;font-variant-numeric:tabular-nums}
    .timer-label{font-size:14px;color:#86868b;margin-top:4px}
    .timer-warn{color:#ff9500}.timer-urgent{color:#ff3b30}
    .progress-bg{width:300px;height:6px;background:#333;border-radius:3px;margin:16px auto 0;overflow:hidden}
    .progress-fill{height:100%;background:#34c759;border-radius:3px;transition:width 1s linear,background .3s}
    .progress-fill.warn{background:#ff9500}.progress-fill.urgent{background:#ff3b30}
    .status-msg{margin-top:20px;font-size:14px;color:#86868b}
    .scan-hint{position:fixed;bottom:30px;font-size:16px;color:#555}
  </style></head>
  <body>
    <div class="room-name">${classroom.classroom_name}</div>
    <div class="instruction">스마트폰 카메라로 QR 코드를 스캔하세요</div>
    <div id="qr-container"><canvas id="qr-canvas"></canvas></div>
    <div class="timer-bar">
      <div class="timer-text" id="timer">60</div>
      <div class="timer-label">초 후 새 QR 생성</div>
      <div class="progress-bg"><div class="progress-fill" id="progress"></div></div>
    </div>
    <div class="status-msg" id="status">QR 코드 생성 중...</div>
    <div class="scan-hint">📱 카메라 앱을 열고 QR 코드를 비추세요</div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js"></script>
    <script>
      const CC='${classroom.classroom_code}',BU='${baseUrl}';
      let cd=60;const qr=new QRious({element:document.getElementById('qr-canvas'),size:280,level:'M',background:'#fff',foreground:'#000'});
      async function refresh(){try{const r=await fetch('/api/qr-token/'+CC,{method:'POST'});const d=await r.json();qr.value=BU+'/scan?token='+d.token+'&room='+CC;cd=60;document.getElementById('status').textContent='✅ QR 코드 활성 중';document.getElementById('status').style.color='#34c759';}catch(e){document.getElementById('status').textContent='⚠️ 갱신 실패';document.getElementById('status').style.color='#ff3b30';}}
      function tick(){cd--;if(cd<0)cd=0;const t=document.getElementById('timer'),p=document.getElementById('progress');t.textContent=cd;p.style.width=(cd/60*100)+'%';t.className='timer-text';p.className='progress-fill';if(cd<=10){t.classList.add('urgent');p.classList.add('urgent');}else if(cd<=20){t.classList.add('warn');p.classList.add('warn');}if(cd<=5&&cd>0){document.getElementById('status').textContent='⏳ 잠시 후 새 QR 생성';document.getElementById('status').style.color='#ff9500';}}
      refresh();setInterval(tick,1000);setInterval(refresh,55000);
      async function wl(){try{if('wakeLock' in navigator)await navigator.wakeLock.request('screen');}catch(e){}}wl();document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')wl();});
    </script>
  </body></html>`;
}


// ════════════════════════════════════════════════════════════
// PWA 아이콘 (SVG 생성)
// ════════════════════════════════════════════════════════════
app.get('/icon-192.png', (req, res) => { res.redirect('/icon.svg'); });
app.get('/icon-512.png', (req, res) => { res.redirect('/icon.svg'); });
app.get('/icon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="80" fill="#1a73e8"/>
    <text x="256" y="300" text-anchor="middle" font-size="260" fill="#fff" font-family="sans-serif" font-weight="700">✓</text>
  </svg>`);
});


// ════════════════════════════════════════════════════════════
// 푸시 알림 API
// ════════════════════════════════════════════════════════════

// VAPID 공개키 조회 (클라이언트에서 구독 시 필요)
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || '' });
});

// 푸시 구독 등록
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { studentId, subscription } = req.body;
    if (!studentId || !subscription) return res.status(400).json({ error: '필수 정보 누락' });
    await push.saveSubscription(studentId, subscription);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 푸시 구독 해제
app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) await push.removeSubscription(endpoint);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 푸시 알림에서 퇴실 처리 (서비스 워커가 호출)
app.post('/api/push/checkout', async (req, res) => {
  try {
    const { studentId, attendanceId } = req.body;
    if (!studentId || !attendanceId) {
      return res.json({ success: false, error: '필수 정보가 누락되었습니다.' });
    }

    const record = await db.query(`
      SELECT a.attendance_id, a.check_in_at, a.check_out_at, a.student_id,
             s.name, cs.session_id
      FROM attendance a
      JOIN students s ON s.student_id = a.student_id
      JOIN course_sessions cs ON cs.session_id = a.session_id
      WHERE a.attendance_id = $1 AND a.student_id = $2
    `, [attendanceId, studentId]);

    if (record.rows.length === 0) {
      return res.json({ success: false, error: '출결 기록을 찾을 수 없습니다.' });
    }

    const att = record.rows[0];

    if (att.check_out_at) {
      return res.json({ success: true, message: '이미 퇴실 처리되었습니다.' });
    }

    await db.query(`
      UPDATE attendance 
      SET check_out_at = NOW(),
          exit_type = '정상',
          updated_at = NOW()
      WHERE attendance_id = $1
    `, [attendanceId]);

    console.log('[Push Checkout] ' + att.name + ' 퇴실 처리 완료 (알림탭)');
    return res.json({ success: true, message: att.name + '님 퇴실이 처리되었습니다.' });

  } catch (err) {
    console.error('[Push Checkout] 오류:', err);
    return res.json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// ─── 테스트 푸시 발송 (디버깅용) ─────────────────────────────
app.post('/api/push/test', async (req, res) => {
  try {
    const { studentId } = req.body;
    if (!studentId) return res.json({ error: 'studentId 필요' });

    const studentRes = await db.query('SELECT name FROM students WHERE student_id = $1', [studentId]);
    const name = studentRes.rows.length > 0 ? studentRes.rows[0].name : 'unknown';

    // 실제 출결 레코드 조회 (입실O, 퇴실X)
    const attRes = await db.query(`
      SELECT a.attendance_id, c.course_name
      FROM attendance a
      JOIN course_sessions cs ON cs.session_id = a.session_id
      JOIN courses c ON c.course_id = cs.course_id
      WHERE a.student_id = $1 AND a.check_in_at IS NOT NULL AND a.check_out_at IS NULL
      ORDER BY a.check_in_at DESC LIMIT 1
    `, [studentId]);

    const attendanceId = attRes.rows.length > 0 ? attRes.rows[0].attendance_id : null;
    const courseName = attRes.rows.length > 0 ? attRes.rows[0].course_name : '테스트';

    const payload = {
      title: '수업이 곧 종료됩니다',
      body: courseName + ' - 퇴실 확인을 해주세요.',
      url: '/app',
      studentId: studentId,
      attendanceId: attendanceId,
    };

    const results = await push.sendPush(studentId, payload);
    console.log('[Push Test] ' + name + ' 발송 결과:', JSON.stringify(results));
    res.json({ name, attendanceId: attendanceId || '(입실 기록 없음)', results });
  } catch (err) {
    console.error('[Push Test] 오류:', err);
    res.json({ error: err.message });
  }
});

// ─── 푸시 구독 조회 (디버깅용) ───────────────────────────────
app.get('/api/push/subscriptions', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT ps.student_id, s.name, 
             LEFT(ps.endpoint, 80) AS endpoint_prefix,
             ps.created_at, ps.updated_at
      FROM push_subscriptions ps
      JOIN students s ON s.student_id = ps.student_id
      ORDER BY ps.updated_at DESC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── 서버 시작 ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('서버 실행 중: http://localhost:' + PORT);

  // 푸시 알림 초기화 + 스케줄러
  if (push.initPush()) {
    push.startScheduler();
  }
});
