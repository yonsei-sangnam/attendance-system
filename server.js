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
  <body>
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:52px;display:block;"></div><div class="container">
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
