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
      let currentRegToken = null;

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
          if (err.name === 'NotAllowedError' || err.name === 'AbortError' || (err.message && err.message.includes('No credentials'))) {
            // 패스키 없음 또는 인증 취소 → 전화번호 입력으로
            msgEl.innerHTML = '<div class="msg msg-info">전화번호로 본인확인 후 진행합니다.</div>';
            setTimeout(function() { showStep(1); }, 1200);
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
            registerFcmToken();
          } else {
            // 미등록 → 등록 토큰 발급 후 등록 안내
            try {
              var tokenRes = await fetch('/api/register/phone-lookup', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: phone })
              });
              var tokenData = await tokenRes.json();
              if (tokenData.found && tokenData.hasToken) {
                currentRegToken = tokenData.token;
              }
            } catch (e) { console.log('토큰 발급 실패:', e); }
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

        if (!currentRegToken) {
          msgEl.innerHTML = '<div class="msg msg-error">등록 토큰이 없습니다. QR을 다시 스캔해주세요.</div>';
          btn.disabled = false;
          btn.textContent = '지문 / Face ID 등록하기';
          return;
        }

        try {
          // 등록 옵션 요청
          const optRes = await fetch('/api/register/options', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: currentStudentId, token: currentRegToken })
          });
          const options = await optRes.json();
          if (options.error) throw new Error(options.error);

          // 브라우저 생체인증 등록
          const regResp = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });

          // 서버 검증
          const verifyRes = await fetch('/api/register/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: currentStudentId, token: currentRegToken, response: regResp })
          });
          const verifyData = await verifyRes.json();

          if (verifyData.verified) {
            msgEl.innerHTML = '<div class="msg msg-success">✅ 등록 완료! 이제 출결 인증을 진행합니다.</div>';
            // 1.5초 후 인증 단계로
            setTimeout(() => {
              document.getElementById('studentName').textContent = currentStudentName + '님';
              showStep(2);
              registerFcmToken();
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
      let prefetchedOptions = null;

      function showStep(n) {
        document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
        document.getElementById('step' + n).classList.add('active');
      }

      // 페이지 로드 시 등록 옵션 미리 요청
      async function prefetchOptions() {
        try {
          const optRes = await fetch('/api/register/options', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: STUDENT_ID, token: REG_TOKEN })
          });
          const options = await optRes.json();
          if (!options.error) {
            prefetchedOptions = options;
          }
        } catch (e) { console.log('옵션 미리받기 실패:', e); }
      }
      prefetchOptions();

      async function doRegister() {
        const btn = document.getElementById('regBtn');
        const msgEl = document.getElementById('msg1');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 등록 중...';
        msgEl.innerHTML = '';

        try {
          var options = prefetchedOptions;
          if (!options) {
            // 미리 받기 실패 시 다시 시도
            var optRes = await fetch('/api/register/options', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ studentId: STUDENT_ID, token: REG_TOKEN })
            });
            options = await optRes.json();
            if (options.error) throw new Error(options.error);
          }

          const regResp = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
          // 사용한 옵션은 1회성이므로 초기화
          prefetchedOptions = null;

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
              registerFcmToken();
            }
          } else {
            throw new Error(verifyData.error || '등록 실패');
          }
        } catch (err) {
          const msg = err.name === 'NotAllowedError' ? '인증 팝업이 닫혔습니다. 아래 버튼을 다시 눌러주세요.'
            : err.name === 'InvalidStateError' ? '이미 이 기기에 등록되어 있습니다. 관리자에게 초기화를 요청하세요.'
            : err.message;
          msgEl.innerHTML = '<div class="msg msg-error">' + msg + '</div>';
          // 재시도를 위해 옵션 다시 미리 받기
          prefetchOptions();
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

      // ─── FCM 토큰 등록 (TWA/설치형 앱 전용) ─────────────────
      function loadScript(src) {
        return new Promise(function(resolve, reject) {
          var s = document.createElement('script');
          s.src = src;
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }

      async function registerFcmToken() {
        var msgEl = document.getElementById('pushMsg');
        try {
          if (!appStudentId) return;
          var isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
          var isAndroid = /Android/i.test(navigator.userAgent);
          if (!isStandalone || !isAndroid) return;

          // 삼성 브라우저 감지 → Chrome 안내
          if (/SamsungBrowser/i.test(navigator.userAgent)) {
            if (msgEl) msgEl.innerHTML = '<div style="font-size:12px;color:#ff9500;line-height:1.6;">⚠️ 알림을 받으려면 Chrome을 기본 브라우저로 설정해주세요.<br><span style="color:#86868b;">설정 → 앱 → 기본 앱 → 브라우저 → Chrome</span></div>';
            return;
          }

          // Firebase SDK 동적 로드
          if (typeof firebase === 'undefined') {
            await loadScript('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
            await loadScript('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');
          }

          await navigator.serviceWorker.register('/sw.js');
          var swReg = await navigator.serviceWorker.ready;

          var firebaseConfig = {
            apiKey: "AIzaSyD3sYGrLF0wmbjyJLziHVqBF-o4UuVE5Po",
            authDomain: "sangnam-attendance.firebaseapp.com",
            projectId: "sangnam-attendance",
            storageBucket: "sangnam-attendance.firebasestorage.app",
            messagingSenderId: "390976491268",
            appId: "1:390976491268:web:f92814cd53f5662885ca51"
          };
          if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
          var messaging = firebase.messaging();

          var permission = await Notification.requestPermission();
          if (permission !== 'granted') return;

          var token = await messaging.getToken({
            vapidKey: 'BPUVObyUjiiSBFWkNG1U2E625alOLUgZ4B9LESnk2hMuMkuNpyVtm1JqTiScZ60wAF11ovs3NE3Y2GfulIK5waY',
            serviceWorkerRegistration: swReg
          });
          if (!token) return;

          await fetch('/api/push/fcm-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: appStudentId, fcmToken: token })
          });

          var toggle = document.getElementById('pushToggle');
          if (toggle) toggle.checked = true;
          if (msgEl) msgEl.innerHTML = '<div style="font-size:12px;color:#34c759;">알림이 활성화되었습니다.</div>';
        } catch (err) {
          if (msgEl) msgEl.innerHTML = '<div style="font-size:12px;color:#ff3b30;">알림 등록 실패: ' + err.message + '</div>';
        }
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
          // iOS cold start 대응: 페이지 로드 후 재시도
          setTimeout(function() { handleCheckoutFromPush(); }, 1500);
          registerFcmToken();

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
        window._pendingCheckout = { sid: window._checkoutData.sid, aid: window._checkoutData.aid };
        await handleCheckoutFromPush(true);
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

      // ─── 퇴실 인증 재시도 ─────────────────────────────────────
      async function retryCheckout(studentId, attendanceId) {
        window._pendingCheckout = { sid: studentId, aid: attendanceId };
        await handleCheckoutFromPush(true);
      }

      // ─── 푸시 알림에서 퇴실 처리 (위치확인 → 생체인증 → 퇴실) ──
      var checkoutFromPushHandled = false;
      async function handleCheckoutFromPush(hasGesture) {
        if (checkoutFromPushHandled) return;
        var params = new URLSearchParams(window.location.search);
        if (params.get('checkout')) checkoutFromPushHandled = true;
        // URL 파라미터에서 checkout 정보 추출 → _pendingCheckout에 저장
        var params = new URLSearchParams(window.location.search);
        if (params.get('checkout') === 'true') {
          window._pendingCheckout = { sid: params.get('sid'), aid: params.get('aid') };
          window.history.replaceState({}, '', '/app');
        }

        if (!window._pendingCheckout) return;
        var studentId = window._pendingCheckout.sid;
        var attendanceId = window._pendingCheckout.aid;
        if (!studentId || !attendanceId) return;


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

        var locationPassed = false;
        try {
          var pos;
          try {
            pos = await new Promise(function(resolve, reject) {
              navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
            });
          } catch (firstErr) {
            pos = await new Promise(function(resolve, reject) {
              navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 });
            });
          }
          var dist = getDistanceMeters(pos.coords.latitude, pos.coords.longitude, buildingSettings.lat, buildingSettings.lng);
          if (dist > (buildingSettings.radius || 200)) {
            showMsg('<div style="font-size:24px;margin-bottom:8px;">🚫</div><div style="font-size:15px;font-weight:600;color:#ff3b30;">건물 외부 감지</div><div style="font-size:13px;color:#86868b;margin-top:6px;">건물에서 너무 멀리 있습니다.</div>');
            return;
          }
          locationPassed = true;
        } catch (locErr) {
          // 위치 실패 → 건너뛰기 옵션 제공
          locationPassed = await new Promise(function(resolve) {
            showMsg('<div style="font-size:24px;margin-bottom:8px;">📍</div>'
              + '<div style="font-size:15px;font-weight:600;color:#ff3b30;">위치 확인을 할 수 없습니다</div>'
              + '<div style="font-size:13px;color:#86868b;margin:8px 0;">기기에서 위치 정보를 가져올 수 없습니다.</div>'
              + '<button id="locSkipBtn" style="margin-top:12px;padding:10px 20px;background:#ff9500;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;">위치 확인 없이 진행</button>'
              + ' <button id="locCancelBtn" style="margin-top:12px;padding:10px 20px;background:#86868b;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;">취소</button>');
            document.getElementById('locSkipBtn').onclick = function() { resolve(true); };
            document.getElementById('locCancelBtn').onclick = function() { resolve(false); };
          });
        }

        if (!locationPassed) {
          showMsg('<div style="font-size:15px;color:#86868b;">퇴실 처리가 취소되었습니다.</div>');
          return;
        }
      }


        // ── Step 3: 생체인증 + 퇴실 처리 ─────────────────────
        showMsg('<div style="font-size:16px;margin-bottom:8px;">🔐</div><div style="font-size:14px;color:#1a73e8;">생체인증을 진행해주세요</div>');
        await new Promise(function(r) { setTimeout(r, 400); });

        try {
          // discoverable: false → allowCredentials 포함 (PIN 폴백 지원)
          var optRes = await fetch('/api/auth/passkey-start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: studentId, discoverable: false })
          });
          var options = await optRes.json();
          if (options.error) throw new Error(options.error);

          // iOS QR 프롬프트 방지: transports를 internal로 제한
          if (options.allowCredentials) {
            options.allowCredentials = options.allowCredentials.map(function(c) {
              return { id: c.id, type: c.type, transports: ['internal'] };
            });
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
            // iOS PIN 등 제스처 필요 → 에러 없이 인증 버튼 표시
            msgEl.innerHTML = '<div style="text-align:center;padding:24px;background:#f5f5f7;border-radius:12px;margin-bottom:12px;">' +
              '<div style="font-size:28px;margin-bottom:10px;">🔐</div>' +
              '<div style="font-size:15px;font-weight:600;color:#1d1d1f;margin-bottom:6px;">퇴실 인증</div>' +
              '<div style="font-size:13px;color:#86868b;margin-bottom:16px;">아래 버튼을 눌러 본인 인증 후 퇴실 처리하세요.</div>' +
              '<button onclick="handleCheckoutFromPush(true)" ' +
              'style="width:100%;padding:14px;background:#1a73e8;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;">퇴실 인증하기</button>' +
              '</div>';
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
  <div class="container"><div style="padding:14px 0 10px 0;"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAACT8AAAJnCAYAAABbULXpAAAACXBIWXMAAAsTAAALEwEAmpwYAAOHxklEQVR4nOzdBXwc57U28GdJK2YGy8wMiTkOg8OcNEmbNG2/tilzb9tb7i1z0jZNGm6YE4fMzCSjwGJmXN7vd2ZfxbIl2YJF6fnfu1Us2J2dnZ2deed5z9G53W4QERERERERERERERERERERERGFGn2gF4CIiIiIiIiIiIiIiIiIiIiIiGgoGH4iIiIiIiIiIiIiIiIiIiIiIqKQxPATERERERERERERERERERERERGFJIafiIiIiIiIiIiIiIiIiIiIiIgoJDH8REREREREREREREREREREREREIYnhJyIiIiIiIiIiIiIiIiIiIiIiCkkMPxERERERERERERERERERERERUUhi+ImIiIiIiIiIiIiIiIiIiIiIiEISw09ERERERERERERERERERERERBSSGH4iIiIiIiIiIiIiIiIiIiIiIqKQxPATERERERERERERERERERERERGFJIafiIiIiIiIiIiIiIiIiIiIiIgoJDH8REREREREREREREREREREREREIYnhJyIiIiIiIiIiIiIiIiIiIiIiCkkMPxERERERERERERERERERERERUUhi+ImIiIiIiIiIiIiIiIiIiIiIiEISw09ERERERERERERERERERERERBSSGH4iIiIiIiIiIiIiIiIiIiIiIqKQxPATERERERERERERERERERERERGFJIafiIiIiIiIiIiIiIiIiIiIiIgoJDH8REREREREREREREREREREREREIYnhJyIiIiIiIiIiIiIiIiIiIiIiCkkMPxERERERERERERERERERERERUUhi+ImIiIiIiIiIiIiIiIiIiIiIiEISw09ERERERERERERERERERERERBSSGH4iIiIiIiIiIiIiIiIiIiIiIqKQxPATERERERERERERERERERERERGFJIafiIiIiIiIiIiIiIiIiIiIiIgoJDH8REREREREREREREREREREREREIYnhJyIiIiIiIiIiIiIiIiIiIiIiCkkMPxERERERERERERERERERERERUUhi+ImIiIiIiIiIiIiIiIiIiIiIiEISw09ERERERERERERERERERERERBSSGH4iIiIiIiIiIiIiIiIiIiIiIqKQxPATERERERERERERERERERERERGFJIafiIiIiIiIiIiIiIiIiIiIiIgoJDH8REREREREREREREREREREREREIYnhJyIiIiIiIiIiIiIiIiIiIiIiCkkMPxERERERERERERERERERERERUUhi+ImIiIiIiIiIiIiIiIiIiIiIiEISw09ERERERERERERERERERERERBSSGH4iIiIiIiIiIiIiIiIiIiIiIqKQxPATERERERERERERERERERERERGFJIafiIiIiIiIiIiIiIiIiIiIiIgoJDH8REREREREREREREREREREREREIYnhJyIiIiIiIiIiIiIiIiIiIiIiCkkMPxERERERERERERERERERERERUUhi+ImIiIiIiIiIiIiIiIiIiIiIiEISw09ERERERERERERERERERERERBSSGH4iIiIiIiIiIiIiIiIiIiIiIqKQxPATERERERERERERERERERERERGFJIafiIiIiIiIiIiIiIiIiIiIiIgoJDH8REREREREREREREREREREREREIYnhJyIiIiIiIiIiIiIiIiIiIiIiCkkMPxERERERERERERERERERERERUUhi+ImIiIiIiIiIiIiIiIiIiIiIiEISw09ERERERERERERERERERERERBSSGH4iIiIiIiIiIiIiIiIiIiIiIqKQxPATERERERERERERERERERERERGFJIafiIiIiIiIiIiIiIiIiIiIiIgoJDH8REREREREREREREREREREREREIYnhJyIiIiIiIiIiIiIiIiIiIiIiCkkMPxERERERERERERERERERERERUUhi+ImIiIiIiIiIiIiIiIiIiIiIiEISw09ERERERERERERERERERERERBSSGH4iIiIiIiIiIiIiIiIiIiIiIqKQxPATERERERERERERERERERERERGFJIafiIiIiIiIiIiIiIiIiIiIiIgoJBkDvQBENCxRAMYASFVhRnePnxkA1AMoAdAcwGUkokFo7bBg3if/jKLjFUBMRKAXh4iIiIiIiIiIiIiIiIgoaLi3/7rX9xh+IvJ/WEkHwAwgXv1bAkvhPf7tUrcYAEnneZ/K/SQDiFP32zP8JGGoNgB1ADrPcR9OAC0AGtXfSGiqS32vXX2vSwWoOtTPW724ToiIiIiIiIiIiIiIiIiIiIiGhOEnIu+IUOGjcBVICgNg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" alt="연세대학교 상남경영원" style="height:52px;display:block;"></div>
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

// FCM 토큰 등록 (TWA 앱 전용)
app.post('/api/push/fcm-token', async (req, res) => {
  try {
    const { studentId, fcmToken } = req.body;
    if (!studentId || !fcmToken) return res.status(400).json({ error: '필수 정보 누락' });
    await push.saveFcmToken(studentId, fcmToken);
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

// ─── 개인정보처리방침 ───────────────────────────────────────
app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>개인정보처리방침 - 상남경영원 출결관리</title>
<style>body{font-family:-apple-system,sans-serif;max-width:700px;margin:0 auto;padding:20px 16px;line-height:1.8;color:#333}
h1{font-size:22px;border-bottom:2px solid #003876;padding-bottom:10px}
h2{font-size:17px;margin-top:30px;color:#003876}p{margin:8px 0}</style></head>
<body>
<h1>개인정보처리방침</h1>
<p>상남경영원(이하 "기관")은 「개인정보 보호법」에 따라 수강생의 개인정보를 보호하고 관련 고충을 처리하기 위하여 다음과 같은 개인정보처리방침을 수립·공개합니다.</p>

<h2>1. 수집하는 개인정보 항목</h2>
<p>기관은 출결관리 서비스 제공을 위해 다음 정보를 수집합니다.</p>
<p>- 이름, 전화번호<br>- 생체인증 공개키 (지문·얼굴 등 생체정보 자체는 기기에만 저장되며 서버에 전송되지 않습니다)<br>- 출결 기록 (입실·퇴실 시각)<br>- 푸시 알림 구독 정보</p>

<h2>2. 개인정보의 수집 및 이용 목적</h2>
<p>- 수강생 본인 확인 및 출결 관리<br>- 퇴실 알림 등 서비스 안내</p>

<h2>3. 개인정보의 보유 및 이용 기간</h2>
<p>수강 기간 종료 후 3개월 이내 파기합니다. 단, 관계 법령에 따라 보존이 필요한 경우 해당 기간 동안 보관합니다.</p>

<h2>4. 개인정보의 제3자 제공</h2>
<p>기관은 수강생의 개인정보를 제3자에게 제공하지 않습니다.</p>

<h2>5. 개인정보의 안전성 확보 조치</h2>
<p>- 데이터 전송 시 SSL/TLS 암호화 적용<br>- 생체인증은 FIDO2/WebAuthn 표준 사용 (생체정보 서버 미저장)<br>- 데이터베이스 접근 권한 제한</p>

<h2>6. 정보주체의 권리</h2>
<p>수강생은 언제든지 본인의 개인정보에 대한 열람, 정정, 삭제를 요청할 수 있습니다.</p>

<h2>7. 개인정보 보호책임자</h2>
<p>상남경영원 관리자<br>문의: 기관 사무실로 연락</p>

<p style="margin-top:40px;color:#888;font-size:13px">시행일: 2026년 6월 8일</p>
</body></html>`);
});

// ─── 계정 삭제 요청 페이지 ──────────────────────────────────
app.get('/delete-account', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>계정 삭제 요청 - 상남경영원 출결관리</title>
<style>body{font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px 16px;line-height:1.8;color:#333}
h1{font-size:22px;border-bottom:2px solid #003876;padding-bottom:10px}
.box{background:#f5f5f5;border-radius:8px;padding:20px;margin-top:20px}
p{margin:8px 0}</style></head>
<body>
<h1>계정 및 데이터 삭제 요청</h1>
<p>상남경영원 출결관리 앱에 등록된 본인의 계정 및 데이터 삭제를 요청하실 수 있습니다.</p>
<div class="box">
  <p><strong>삭제 요청 방법</strong></p>
  <p>아래 정보를 포함하여 기관 담당자에게 직접 요청해 주세요.</p>
  <p>- 이름<br>- 등록된 전화번호<br>- 삭제 요청 사유 (선택)</p>
  <p style="margin-top:16px"><strong>요청 후 처리 기간:</strong> 영업일 기준 3일 이내</p>
  <p><strong>삭제되는 데이터:</strong> 이름, 전화번호, 생체인증 정보, 출결 기록, 푸시 알림 구독 정보</p>
</div>
<p style="margin-top:40px;color:#888;font-size:13px">문의: 상남경영원 사무실</p>
</body></html>`);
});


// ─── assetlinks 라우트 ───────────────────────────────────────────────
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.sangnam.attendance',
        sha256_cert_fingerprints: [
          '3D:4B:BD:55:0D:CD:A3:78:97:D6:CD:BB:FD:16:0C:07:E3:D0:AA:8E:06:11:49:ED:6B:9A:E3:61:EB:6C:61:AF',
          '90:96:50:FB:8E:7F:E3:C0:22:71:01:7C:BA:EB:BF:48:F0:51:A8:E6:46:C5:4F:96:40:35:6D:43:95:7C:82:85'
        ]
      }
    }
  ]);
});


// ─── 서버 시작 ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('서버 실행 중: http://localhost:' + PORT);

  // 푸시 알림 초기화 + 스케줄러
  if (push.initPush()) {
    push.startScheduler();
  }
});
