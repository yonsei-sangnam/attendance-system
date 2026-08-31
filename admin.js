const db = require('./db');
const layout = require('./layout');

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

  // ═══ API: 출결 기록 초기화 (삭제) ═══════════════════════════
  app.delete('/api/admin/attendance/:attendanceId', async (req, res) => {
    try {
      await db.query('DELETE FROM attendance WHERE attendance_id = $1', [req.params.attendanceId]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
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

  // ═══ 수강생 관리 페이지 ═══════════════════════════════════════
  app.get('/admin/students', async (req, res) => {
    try {
      const courses = await db.query(`
        SELECT course_id, course_name, course_code, cohort, course_type
        FROM courses ORDER BY course_type, course_name
      `);
      res.send(renderStudentsPage(courses.rows));
    } catch (err) {
      res.status(500).send('오류: ' + err.message);
    }
  });

  // ═══ API: 과정별 수강생 목록 + 생체인증 등록 여부 ═══════════
  app.get('/api/admin/students/:courseId', async (req, res) => {
    try {
      const r = await db.query(`
        SELECT 
          s.student_id, s.name, s.phone, s.status,
          CASE WHEN cr.cred_count > 0 THEN TRUE ELSE FALSE END AS has_credential,
          COALESCE(cr.cred_count, 0) AS cred_count,
          cr.last_used_at,
          CASE WHEN ps.sub_count > 0 THEN TRUE ELSE FALSE END AS has_push
        FROM students s
        JOIN enrollments e ON e.student_id = s.student_id
        LEFT JOIN (
          SELECT student_id, COUNT(*) AS cred_count, MAX(last_used_at) AS last_used_at
          FROM credentials GROUP BY student_id
        ) cr ON cr.student_id = s.student_id
        LEFT JOIN (
          SELECT student_id, COUNT(*) AS sub_count
          FROM push_subscriptions GROUP BY student_id
        ) ps ON ps.student_id = s.student_id
        WHERE e.course_id = $1 AND s.status = 'active'
        ORDER BY s.name
      `, [req.params.courseId]);
      res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 수강생 일괄 등록 ═══════════════════════════════════
  app.post('/api/admin/students/bulk', async (req, res) => {
    const client = await db.connect();
    try {
      const { courseId, students } = req.body;
      // students: [{name, phone}]
      if (!courseId || !students || !Array.isArray(students)) {
        return res.status(400).json({ error: '과정ID와 수강생 목록이 필요합니다.' });
      }

      await client.query('BEGIN');
      let added = 0, skipped = 0, errors = [];

      for (const s of students) {
        const name = (s.name || '').trim();
        let phone = (s.phone || '').trim();
        if (!name || !phone) { skipped++; continue; }

        // 전화번호 정규화 (숫자만 추출 → 010-XXXX-XXXX 형태)
        const digits = phone.replace(/[^0-9]/g, '');
        if (digits.length === 11) {
          phone = digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
        } else if (digits.length === 10) {
          phone = digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
        }
        // else 그대로 사용

        // 기존 학생 확인 (전화번호 기준)
        const existing = await client.query(
          'SELECT student_id FROM students WHERE phone = $1', [phone]
        );

        let studentId;
        if (existing.rows.length > 0) {
          studentId = existing.rows[0].student_id;
          // 이름 업데이트
          await client.query('UPDATE students SET name = $1, status = $2 WHERE student_id = $3', [name, 'active', studentId]);
        } else {
          // 새 학생 등록
          const ins = await client.query(
            'INSERT INTO students (name, phone, status) VALUES ($1, $2, $3) RETURNING student_id',
            [name, phone, 'active']
          );
          studentId = ins.rows[0].student_id;
        }

        // 수강 등록 (중복 방지)
        await client.query(`
          INSERT INTO enrollments (student_id, course_id)
          VALUES ($1, $2)
          ON CONFLICT (student_id, course_id) DO NOTHING
        `, [studentId, courseId]);

        added++;
      }

      await client.query('COMMIT');
      res.json({ success: true, added, skipped });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ═══ API: 수강생 삭제 (수강 등록 해제) ═══════════════════════
  app.delete('/api/admin/students/:studentId/:courseId', async (req, res) => {
    try {
      await db.query('DELETE FROM enrollments WHERE student_id = $1 AND course_id = $2', [req.params.studentId, req.params.courseId]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 생체인증 초기화 ════════════════════════════════════
  app.delete('/api/admin/credentials/:studentId', async (req, res) => {
    try {
      const crypto = require('crypto');
      await db.query('DELETE FROM credentials WHERE student_id = $1', [req.params.studentId]);
      await db.query('DELETE FROM push_subscriptions WHERE student_id = $1', [req.params.studentId]);

      // 인증초기화와 동시에 재등록 토큰 자동 발급 (24시간)
      const token = crypto.randomBytes(24).toString('base64url');
      await db.query(`
        INSERT INTO auth_challenges (student_id, challenge, type, expires_at)
        VALUES ($1, $2, 'reg_token', NOW() + INTERVAL '24 hours')
        ON CONFLICT (student_id, type) DO UPDATE SET challenge = $2, expires_at = NOW() + INTERVAL '24 hours'
      `, [req.params.studentId, token]);

      res.json({ success: true, token });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 등록 토큰 발급 (1회용, 24시간 유효) ════════════════
  app.post('/api/admin/reg-token/:studentId', async (req, res) => {
    try {
      const studentRes = await db.query(
        'SELECT name FROM students WHERE student_id = $1', [req.params.studentId]
      );
      if (studentRes.rows.length === 0) return res.status(404).json({ error: '수강생 없음' });

      const crypto = require('crypto');
      const token = crypto.randomBytes(24).toString('base64url');

      await db.query(`
        INSERT INTO auth_challenges (student_id, challenge, type, expires_at)
        VALUES ($1, $2, 'reg_token', NOW() + INTERVAL '24 hours')
        ON CONFLICT (student_id, type) DO UPDATE SET challenge = $2, expires_at = NOW() + INTERVAL '24 hours'
      `, [req.params.studentId, token]);

      res.json({ token, studentName: studentRes.rows[0].name });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 등록 토큰 일괄 발급 (과정 전체) ═══════════════════
  app.post('/api/admin/reg-token-bulk/:courseId', async (req, res) => {
    try {
      const crypto = require('crypto');

      // 해당 과정 수강생 전원 조회 (등록 여부 무관)
      const students = await db.query(`
        SELECT s.student_id, s.name
        FROM students s
        JOIN enrollments e ON e.student_id = s.student_id
        WHERE e.course_id = $1 AND s.status = 'active'
        ORDER BY s.name
      `, [req.params.courseId]);

      if (students.rows.length === 0) {
        return res.json({ success: false, error: '수강생이 없습니다.' });
      }

      const tokens = [];
      for (const s of students.rows) {
        const token = crypto.randomBytes(24).toString('base64url');
        await db.query(`
          INSERT INTO auth_challenges (student_id, challenge, type, expires_at)
          VALUES ($1, $2, 'reg_token', NOW() + INTERVAL '24 hours')
          ON CONFLICT (student_id, type) DO UPDATE SET challenge = $2, expires_at = NOW() + INTERVAL '24 hours'
        `, [s.student_id, token]);
        tokens.push({ studentId: s.student_id, name: s.name, token });
      }

      res.json({ success: true, tokens });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 보류 등록 목록 조회 ════════════════════════════════
  app.get('/api/admin/pending-creds', async (req, res) => {
    try {
      const r = await db.query(`
        SELECT pc.student_id, pc.requested_at, pc.status,
               s.name, s.phone,
               (SELECT STRING_AGG(c2.course_name, ', ')
                FROM enrollments e2 JOIN courses c2 ON c2.course_id = e2.course_id
                WHERE e2.student_id = pc.student_id) AS courses
        FROM pending_credentials pc
        JOIN students s ON s.student_id = pc.student_id
        WHERE pc.status = 'pending'
        ORDER BY pc.requested_at DESC
      `);
      res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 보류 등록 승인 ═════════════════════════════════════
  app.post('/api/admin/pending-creds/:studentId/approve', async (req, res) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const pc = await client.query(
        "SELECT * FROM pending_credentials WHERE student_id = $1 AND status = 'pending'",
        [req.params.studentId]
      );
      if (pc.rows.length === 0) return res.status(404).json({ error: '보류 건 없음' });
      const p = pc.rows[0];

      // 기존 크레덴셜 + 푸시 삭제 후 신규 등록
      await client.query('DELETE FROM credentials WHERE student_id = $1', [p.student_id]);
      await client.query('DELETE FROM push_subscriptions WHERE student_id = $1', [p.student_id]);
      await client.query(`
        INSERT INTO credentials (student_id, webauthn_cred_id, public_key, counter, transports, registered_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [p.student_id, p.webauthn_cred_id, p.public_key, p.counter, p.transports]);

      await client.query("UPDATE pending_credentials SET status = 'approved' WHERE student_id = $1", [p.student_id]);
      await client.query('COMMIT');

      const name = await db.query('SELECT name FROM students WHERE student_id = $1', [p.student_id]);
      res.json({ success: true, studentName: name.rows[0]?.name });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally { client.release(); }
  });

  // ═══ API: 보류 등록 거부 ═════════════════════════════════════
  app.post('/api/admin/pending-creds/:studentId/reject', async (req, res) => {
    try {
      await db.query(
        "UPDATE pending_credentials SET status = 'rejected' WHERE student_id = $1",
        [req.params.studentId]
      );
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 최근 등록 로그 ═════════════════════════════════════
  app.get('/api/admin/reg-log', async (req, res) => {
    try {
      const recent = await db.query(`
        SELECT s.name, s.phone, c.registered_at, 'completed' AS type
        FROM credentials c JOIN students s ON s.student_id = c.student_id
        WHERE c.registered_at > NOW() - INTERVAL '24 hours'
        UNION ALL
        SELECT s.name, s.phone, pc.requested_at AS registered_at, 'pending' AS type
        FROM pending_credentials pc JOIN students s ON s.student_id = pc.student_id
        WHERE pc.requested_at > NOW() - INTERVAL '24 hours' AND pc.status = 'pending'
        ORDER BY registered_at DESC LIMIT 20
      `);
      res.json(recent.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ 등록 QR 인쇄 페이지 ═════════════════════════════════════
  app.get('/admin/reg-print/:courseId', async (req, res) => {
    try {
      const crypto = require('crypto');
      const baseUrl = `${req.protocol}://${req.get('host')}`;

      // 과정명 조회
      const courseRes = await db.query(
        'SELECT course_name, cohort FROM courses WHERE course_id = $1',
        [req.params.courseId]
      );
      if (courseRes.rows.length === 0) return res.status(404).send('과정 없음');
      const course = courseRes.rows[0];

      // 수강생 전원 토큰 일괄 발급 (있으면 갱신)
      const students = await db.query(`
        SELECT s.student_id, s.name
        FROM students s
        JOIN enrollments e ON e.student_id = s.student_id
        WHERE e.course_id = $1 AND s.status = 'active'
        ORDER BY s.name
      `, [req.params.courseId]);

      if (students.rows.length === 0) return res.status(404).send('수강생 없음');

      const cards = [];
      for (const s of students.rows) {
        const token = crypto.randomBytes(24).toString('base64url');
        await db.query(`
          INSERT INTO auth_challenges (student_id, challenge, type, expires_at)
          VALUES ($1, $2, 'reg_token', NOW() + INTERVAL '24 hours')
          ON CONFLICT (student_id, type) DO UPDATE SET challenge = $2, expires_at = NOW() + INTERVAL '24 hours'
        `, [s.student_id, token]);
        cards.push({ name: s.name, url: `${baseUrl}/register?token=${token}` });
      }

      res.send(renderRegPrintPage(course, cards));
    } catch (err) { res.status(500).send('오류: ' + err.message); }
  });

  // ═══ API: 통합 관리 시트 동기화 ══════════════════════════════
  app.post('/api/admin/sync-management', async (req, res) => {
    try {
      const { spreadsheetId } = req.body;
      if (!spreadsheetId) return res.status(400).json({ error: '스프레드시트 ID 필요' });
      const sync = require('./sync');
      const result = await sync.syncManagementSheet(spreadsheetId);
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ 교육과정 관리 페이지 ═══════════════════════════════════
  app.get('/admin/courses', async (req, res) => {
    try {
      const classrooms = await db.query('SELECT classroom_id, classroom_code, classroom_name FROM classrooms ORDER BY classroom_code');
      res.send(renderCoursesPage(classrooms.rows));
    } catch (err) { res.status(500).send('오류: ' + err.message); }
  });

  // ═══ API: 과정 목록 (상세) ═══════════════════════════════════
  app.get('/api/admin/courses', async (req, res) => {
    try {
      const r = await db.query(`
        SELECT c.course_id, c.course_name, c.course_code, c.course_type, c.cohort,
               c.total_sessions, c.default_classroom_id, c.spreadsheet_id,
               cr.classroom_name AS default_room,
               (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.course_id) AS student_count,
               (SELECT COUNT(*) FROM course_sessions cs WHERE cs.course_id = c.course_id) AS session_count
        FROM courses c
        LEFT JOIN classrooms cr ON cr.classroom_id = c.default_classroom_id
        ORDER BY c.course_type, c.course_name
      `);
      res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 과정 추가 ═════════════════════════════════════════
  app.post('/api/admin/courses', async (req, res) => {
    try {
      const { course_name, course_code, course_type, cohort, default_classroom_id, total_sessions } = req.body;
      if (!course_name) return res.status(400).json({ error: '과정명은 필수입니다.' });
      const r = await db.query(`
        INSERT INTO courses (course_name, course_code, course_type, cohort, default_classroom_id, total_sessions)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING course_id
      `, [course_name, course_code || null, course_type || null, cohort || null,
          default_classroom_id || null, total_sessions || null]);
      res.json({ success: true, courseId: r.rows[0].course_id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 과정 수정 ═════════════════════════════════════════
  app.put('/api/admin/courses/:courseId', async (req, res) => {
    try {
      const { course_name, course_code, course_type, cohort, default_classroom_id, total_sessions } = req.body;
      await db.query(`
        UPDATE courses SET course_name=$1, course_code=$2, course_type=$3, cohort=$4,
               default_classroom_id=$5, total_sessions=$6 WHERE course_id=$7
      `, [course_name, course_code || null, course_type || null, cohort || null,
          default_classroom_id || null, total_sessions || null, req.params.courseId]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 과정 삭제 ═════════════════════════════════════════
  app.delete('/api/admin/courses/:courseId', async (req, res) => {
    try {
      // 관련 데이터 삭제 (출결 → 회차 → 수강등록 → 과정)
      const cid = req.params.courseId;
      await db.query('DELETE FROM attendance WHERE session_id IN (SELECT session_id FROM course_sessions WHERE course_id = $1)', [cid]);
      await db.query('DELETE FROM course_sessions WHERE course_id = $1', [cid]);
      await db.query('DELETE FROM enrollments WHERE course_id = $1', [cid]);
      await db.query('DELETE FROM courses WHERE course_id = $1', [cid]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 회차 추가 (개별) ══════════════════════════════════
  app.post('/api/admin/sessions', async (req, res) => {
    try {
      const { course_id, session_number, session_date, start_time, end_time, late_cutoff, early_leave_cutoff, is_workshop, note } = req.body;
      await db.query(`
        INSERT INTO course_sessions (course_id, session_number, session_date, start_time, end_time, late_cutoff, early_leave_cutoff, is_workshop, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [course_id, session_number, session_date, start_time, end_time,
          late_cutoff || start_time, early_leave_cutoff || end_time, is_workshop || false, note || null]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 회차 일괄 추가 ════════════════════════════════════
  app.post('/api/admin/sessions/bulk', async (req, res) => {
    try {
      const { course_id, sessions } = req.body;
      let added = 0;
      for (const s of sessions) {
        await db.query(`
          INSERT INTO course_sessions (course_id, session_number, session_date, start_time, end_time, late_cutoff, early_leave_cutoff, is_workshop)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT DO NOTHING
        `, [course_id, s.session_number, s.session_date, s.start_time, s.end_time,
            s.late_cutoff || s.start_time, s.early_leave_cutoff || s.end_time, s.is_workshop || false]);
        added++;
      }
      res.json({ success: true, added });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 회차 삭제 ═════════════════════════════════════════
  app.delete('/api/admin/sessions/:sessionId', async (req, res) => {
    try {
      await db.query('DELETE FROM attendance WHERE session_id = $1', [req.params.sessionId]);
      await db.query('DELETE FROM course_sessions WHERE session_id = $1', [req.params.sessionId]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 회차 수정 ═════════════════════════════════════════
  app.put('/api/admin/sessions/:sessionId', async (req, res) => {
    try {
      const { session_date, start_time, end_time, late_cutoff, early_leave_cutoff, is_workshop, note } = req.body;
      await db.query(`
        UPDATE course_sessions SET
          session_date = COALESCE($1, session_date),
          start_time = COALESCE($2, start_time),
          end_time = COALESCE($3, end_time),
          late_cutoff = COALESCE($4, late_cutoff),
          early_leave_cutoff = COALESCE($5, early_leave_cutoff),
          is_workshop = COALESCE($6, is_workshop),
          note = $7
        WHERE session_id = $8
      `, [session_date, start_time, end_time, late_cutoff, early_leave_cutoff, is_workshop, note, req.params.sessionId]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 강의실 추가 ═══════════════════════════════════════
  app.post('/api/admin/classrooms', async (req, res) => {
    try {
      const { classroom_code, classroom_name } = req.body;
      if (!classroom_code || !classroom_name) return res.status(400).json({ error: '코드와 이름 모두 필요합니다.' });
      await db.query('INSERT INTO classrooms (classroom_code, classroom_name) VALUES ($1, $2)', [classroom_code, classroom_name]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 강의실 삭제 ═══════════════════════════════════════
  app.delete('/api/admin/classrooms/:classroomId', async (req, res) => {
    try {
      await db.query('DELETE FROM classrooms WHERE classroom_id = $1', [req.params.classroomId]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ 시스템 설정 페이지 ═════════════════════════════════════
  app.get('/admin/settings', (req, res) => {
    res.send(renderSettingsPage());
  });

  // ═══ API: 설정 조회 (공개) ═══════════════════════════════════
  app.get('/api/settings/building', async (req, res) => {
    try {
      const r = await db.query(
        "SELECT key, value FROM system_settings WHERE key IN ('building_lat','building_lng','building_radius','location_check_enabled','push_interval_minutes','push_remind_before_minutes','push_auto_close_minutes')"
      );
      const s = {};
      for (const row of r.rows) s[row.key] = row.value;
      res.json({
        enabled:  s.location_check_enabled === 'true',
        lat:      s.building_lat  ? parseFloat(s.building_lat)  : null,
        lng:      s.building_lng  ? parseFloat(s.building_lng)  : null,
        radius:   s.building_radius ? parseInt(s.building_radius) : 200,
        pushIntervalMinutes: s.push_interval_minutes ? parseInt(s.push_interval_minutes) : 2,
        pushRemindBeforeMinutes: s.push_remind_before_minutes ? parseInt(s.push_remind_before_minutes) : 10,
        pushAutoCloseMinutes: s.push_auto_close_minutes ? parseInt(s.push_auto_close_minutes) : 10,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 설정 저장 ═════════════════════════════════════════
  app.put('/api/admin/settings', async (req, res) => {
    try {
      const { lat, lng, radius, enabled, pushIntervalMinutes, pushRemindBeforeMinutes, pushAutoCloseMinutes } = req.body;
      const upsert = async (key, value) => db.query(`
        INSERT INTO system_settings (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
      `, [key, value == null ? null : String(value)]);

      await upsert('building_lat',           lat);
      await upsert('building_lng',           lng);
      await upsert('building_radius',        radius || 200);
      await upsert('location_check_enabled', enabled ? 'true' : 'false');
      if (pushIntervalMinutes != null) {
        var piv = parseInt(pushIntervalMinutes) || 2;
        if (piv < 1) piv = 1; if (piv > 30) piv = 30;
        await upsert('push_interval_minutes', piv);
      }
      if (pushRemindBeforeMinutes != null) {
        var prb = parseInt(pushRemindBeforeMinutes) || 10;
        if (prb < 1) prb = 1; if (prb > 30) prb = 30;
        await upsert('push_remind_before_minutes', prb);
      }
      if (pushAutoCloseMinutes != null) {
        var pac = parseInt(pushAutoCloseMinutes) || 10;
        if (pac < 1) pac = 1; if (pac > 60) pac = 60;
        await upsert('push_auto_close_minutes', pac);
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}


// ═════════════════════════════════════════════════════════════
// 시스템 설정 페이지 HTML
// ═════════════════════════════════════════════════════════════
function renderSettingsPage() {
  const pageCss = `
  .st-h1 { margin:0; font-size:32px; font-weight:800; letter-spacing:-0.025em; line-height:1.1; }
  .st-lead { font-size:13px; font-weight:500; color:var(--sn-gray); margin-top:6px; }
  .st-cardtitle { font-size:16px; font-weight:800; letter-spacing:-0.015em; }
  .st-help { font-size:11.5px; color:var(--sn-gray); margin-top:12px; line-height:1.7; }
  .st-note { font-size:12px; color:var(--sn-gray); margin-top:8px; line-height:1.7; }

  .st-toggle {
    appearance:none; border:none; cursor:pointer; flex-shrink:0;
    height:38px; min-width:74px; padding:0 18px; border-radius:999px;
    font-size:13px; font-weight:800; letter-spacing:0.02em;
    background:var(--sn-line); color:var(--sn-gray);
    transition:background .15s ease, color .15s ease;
  }
  .st-toggle.on { background:var(--sn-navy); color:#fff; }

  .st-field { display:flex; flex-direction:column; gap:6px; }
  .st-field label { font-size:11.5px; font-weight:600; color:var(--sn-gray); }
  .st-input {
    height:44px; width:100%; padding:0 14px;
    border:1.5px solid var(--sn-line); border-radius:12px; background:#fff;
    font-size:14px; font-weight:600; color:var(--sn-ink);
    font-variant-numeric:tabular-nums; outline:none;
    transition:border-color .15s ease;
  }
  .st-input:focus { border-color:var(--sn-navy); }

  .st-preview {
    flex:1; min-height:250px; margin-top:14px; border-radius:16px;
    background:var(--sn-bg); display:flex; align-items:center; justify-content:center;
    position:relative; overflow:hidden;
  }
  .st-circle {
    border:2px solid var(--sn-navy); border-radius:50%;
    background:rgba(0,56,118,0.07);
    display:flex; align-items:center; justify-content:center;
    transition:width .2s ease, height .2s ease;
  }
  .st-pin { width:10px; height:10px; border-radius:50%; background:var(--sn-navy); }
  .st-badge {
    position:absolute; bottom:12px; left:12px;
    font-size:11.5px; font-weight:600; color:var(--sn-gray);
    background:#fff; padding:5px 10px; border-radius:999px;
  }
  .st-warn {
    background:#fff8e6; border-radius:14px; padding:14px 16px; margin-top:14px;
    font-size:12px; color:#7a5a05; line-height:1.8;
  }
  .st-warn b { color:#4a3505; }
  `;

  const body =
      '<section class="sn-section">'
    +   '<h1 class="st-h1">시스템 설정</h1>'
    +   '<div class="st-lead">퇴실 위치 검증 · 퇴실 알림 타이밍</div>'

    // ── 1행: 위치 검증 + 반경 미리보기 ──
    +   '<div class="sn-grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-top:18px;">'

    +     '<div class="sn-card">'
    +       '<div style="display:flex;align-items:flex-start;gap:16px;">'
    +         '<div style="flex:1;">'
    +           '<div class="st-cardtitle">퇴실 위치 검증</div>'
    +           '<div class="st-note">'
    +             'ON &middot; 위치 확인 &rarr; 생체인증 &rarr; 퇴실 처리<br>'
    +             'OFF &middot; 생체인증 &rarr; 퇴실 처리 (위치 무관)'
    +           '</div>'
    +         '</div>'
    +         '<button type="button" class="st-toggle" id="locToggle" aria-pressed="false">OFF</button>'
    +       '</div>'
    +       '<div style="margin-top:18px;display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    +         '<div class="st-field"><label for="lat">위도 (Latitude)</label>'
    +           '<input class="st-input" type="number" id="lat" step="0.000001" placeholder="37.564938"></div>'
    +         '<div class="st-field"><label for="lng">경도 (Longitude)</label>'
    +           '<input class="st-input" type="number" id="lng" step="0.000001" placeholder="126.942565"></div>'
    +         '<div class="st-field" style="grid-column:1 / -1;"><label for="radius">허용 반경 (미터)</label>'
    +           '<input class="st-input" type="number" id="radius" min="50" max="2000" placeholder="500"></div>'
    +       '</div>'
    +       '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">'
    +         '<button type="button" class="sn-btn sn-btn-secondary" style="height:44px;" id="btnGetLoc">현재 위치 가져오기</button>'
    +         '<button type="button" class="sn-btn sn-btn-primary" style="height:44px;" data-save>저장</button>'
    +       '</div>'
    +       '<div class="st-help">반경을 너무 좁게 잡으면 건물 안에서도 위치 확인이 실패합니다. 구글지도 좌표와 &lsquo;현재 위치 가져오기&rsquo;를 번갈아 테스트해 정하세요.</div>'
    +       '<div class="st-warn">'
    +         '<b>주의사항</b><br>'
    +         '&middot; 실내 GPS 오차는 10~50m입니다 (건물 구조에 따라 다름)<br>'
    +         '&middot; 반경은 건물 크기 + 여유 50~100m 를 더해 잡는 것을 권장합니다<br>'
    +         '&middot; 위치 권한을 거부한 수강생은 퇴실 처리가 불가합니다<br>'
    +         '&middot; 실제 강의실에서 테스트한 뒤 반경을 조정하세요'
    +       '</div>'
    +     '</div>'

    +     '<div class="sn-card" style="display:flex;flex-direction:column;">'
    +       '<div class="st-cardtitle">허용 반경 미리보기</div>'
    +       '<div class="st-note">입력한 반경의 상대적인 크기를 보여줍니다. 실제 지도가 아닙니다.</div>'
    +       '<div class="st-preview">'
    +         '<div class="st-circle" id="radiusCircle" style="width:190px;height:190px;"><div class="st-pin"></div></div>'
    +         '<div class="st-badge" id="radiusBadge">반경 &mdash;</div>'
    +       '</div>'
    +     '</div>'

    +   '</div>'

    // ── 2행: 퇴실 알림 설정 ──
    +   '<div class="sn-card" style="margin-top:14px;">'
    +     '<div class="st-cardtitle">퇴실 알림 설정</div>'
    +     '<div class="st-note">'
    +       '수업 종료 전후로 퇴실하지 않은 수강생에게 푸시 알림을 보냅니다.<br>'
    +       '종료 후 자동 처리 시간이 지나면 &lsquo;퇴실미확인&rsquo;으로 자동 처리됩니다.'
    +     '</div>'
    +     '<div style="margin-top:18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">'
    +       '<div class="st-field"><label for="remindBefore">종료 전 알림 시작 (분)</label>'
    +         '<input class="st-input" type="number" id="remindBefore" min="1" max="30" value="10"></div>'
    +       '<div class="st-field"><label for="autoClose">종료 후 자동 처리 (분)</label>'
    +         '<input class="st-input" type="number" id="autoClose" min="1" max="60" value="10"></div>'
    +       '<div class="st-field"><label for="pushInterval">발송 간격 (분)</label>'
    +         '<input class="st-input" type="number" id="pushInterval" min="1" max="30" value="2"></div>'
    +     '</div>'
    +     '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">'
    +       '<button type="button" class="sn-btn sn-btn-primary" style="height:44px;" data-save>저장</button>'
    +     '</div>'
    +     '<div class="st-warn">'
    +       '<b>참고</b><br>'
    +       '&middot; 종료 전 알림 시작 &mdash; 수업 종료 N분 전부터 퇴실 알림 발송 시작 (기본 10분)<br>'
    +       '&middot; 종료 후 자동 처리 &mdash; 수업 종료 후 N분까지 퇴실하지 않으면 &lsquo;퇴실미확인&rsquo; 자동 처리 (기본 10분)<br>'
    +       '&middot; 발송 간격 &mdash; 알림 반복 발송 주기 (기본 2분)<br>'
    +       '&middot; 두 카드의 저장 버튼은 모두 <b>전체 설정</b>을 함께 저장합니다'
    +     '</div>'
    +   '</div>'
    + '</section>'

    + '<div id="snToast" style="position:fixed;left:50%;bottom:28px;transform:translateX(-50%);'
    +   'background:var(--sn-navy);color:#fff;font-size:13px;font-weight:700;padding:12px 20px;'
    +   'border-radius:999px;box-shadow:0 8px 24px rgba(0,56,118,0.25);opacity:0;pointer-events:none;'
    +   'transition:opacity .2s ease;z-index:50;max-width:88vw;text-align:center;"></div>';

  const pageJs = `
  var toastTimer = null;
  function showToast(msg, bad) {
    var t = document.getElementById('snToast');
    if (!t) return;
    t.textContent = msg;
    t.style.background = bad ? '#D32F2F' : 'var(--sn-navy)';
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.style.opacity = '0'; }, 2400);
  }

  var locOn = false;
  var toggle = document.getElementById('locToggle');
  function setToggle(v) {
    locOn = !!v;
    toggle.textContent = locOn ? 'ON' : 'OFF';
    toggle.classList.toggle('on', locOn);
    toggle.setAttribute('aria-pressed', locOn ? 'true' : 'false');
  }
  toggle.addEventListener('click', function() { setToggle(!locOn); });

  var radiusInput = document.getElementById('radius');
  function drawRadius() {
    var r = parseInt(radiusInput.value, 10);
    var badge = document.getElementById('radiusBadge');
    var circle = document.getElementById('radiusCircle');
    if (!r || r <= 0) { badge.textContent = '반경 —'; circle.style.width = '120px'; circle.style.height = '120px'; return; }
    // 50m=110px ~ 2000m=230px 사이로 완만하게 매핑 (상대 크기 감각용)
    var px = Math.round(110 + Math.min(1, Math.log(r / 50) / Math.log(40)) * 120);
    circle.style.width = px + 'px';
    circle.style.height = px + 'px';
    badge.textContent = '반경 ' + r + 'm';
  }
  radiusInput.addEventListener('input', drawRadius);

  async function loadSettings() {
    try {
      var res = await fetch('/api/settings/building');
      var data = await res.json();
      setToggle(data.enabled);
      if (data.lat) document.getElementById('lat').value = data.lat;
      if (data.lng) document.getElementById('lng').value = data.lng;
      document.getElementById('radius').value = data.radius || 200;
      document.getElementById('pushInterval').value = data.pushIntervalMinutes || 2;
      document.getElementById('remindBefore').value = data.pushRemindBeforeMinutes || 10;
      document.getElementById('autoClose').value = data.pushAutoCloseMinutes || 10;
      drawRadius();
    } catch (e) {
      showToast('설정을 불러오지 못했습니다', true);
    }
  }

  document.getElementById('btnGetLoc').addEventListener('click', function() {
    if (!navigator.geolocation) { showToast('이 브라우저는 위치를 지원하지 않습니다', true); return; }
    showToast('위치 확인 중…');
    navigator.geolocation.getCurrentPosition(
      function(pos) {
        document.getElementById('lat').value = pos.coords.latitude.toFixed(6);
        document.getElementById('lng').value = pos.coords.longitude.toFixed(6);
        showToast('현재 위치 적용 완료 (정확도 ' + Math.round(pos.coords.accuracy) + 'm)');
      },
      function(err) { showToast('위치 오류: ' + err.message, true); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  async function saveSettings() {
    var data = {
      lat:     parseFloat(document.getElementById('lat').value) || null,
      lng:     parseFloat(document.getElementById('lng').value) || null,
      radius:  parseInt(document.getElementById('radius').value, 10) || 200,
      enabled: locOn,
      pushIntervalMinutes:     parseInt(document.getElementById('pushInterval').value, 10) || 2,
      pushRemindBeforeMinutes: parseInt(document.getElementById('remindBefore').value, 10) || 10,
      pushAutoCloseMinutes:    parseInt(document.getElementById('autoClose').value, 10) || 10
    };
    if (data.enabled && (data.lat === null || data.lng === null)) {
      showToast('위치 검증을 켜려면 위도·경도를 입력하세요', true);
      return;
    }
    try {
      var res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      var r = await res.json();
      showToast(r.success ? '저장 완료' : ('저장 실패: ' + (r.error || '')), !r.success);
    } catch (e) {
      showToast('저장 실패: ' + e.message, true);
    }
  }

  document.querySelectorAll('[data-save]').forEach(function(b) {
    b.addEventListener('click', saveSettings);
  });

  loadSettings();
  `;

  return layout.renderShell({
    active: 'settings',
    title: '시스템 설정',
    body: body,
    pageCss: pageCss,
    pageJs: pageJs
  });
}


// ═════════════════════════════════════════════════════════════
// 관리자 출결 현황 페이지 HTML
// ═════════════════════════════════════════════════════════════
function renderAttendancePage(courses) {
  const esc = layout.esc;

  const courseOptions = courses.map(function(c) {
    const label = c.course_name
      + (c.cohort ? ' ' + c.cohort + '기' : '')
      + (c.course_type ? ' [' + c.course_type + ']' : '');
    return '<option value="' + esc(c.course_id) + '">' + esc(label) + '</option>';
  }).join('');

  const pageCss = `
  .at-h1 { margin:0; font-size:32px; font-weight:800; letter-spacing:-0.025em; line-height:1.1; }
  .at-lead { font-size:13px; font-weight:500; color:var(--sn-gray); margin-top:6px; }

  .at-modebar { display:flex; gap:6px; background:#fff; padding:5px; border-radius:999px; }
  .at-mode {
    appearance:none; border:none; cursor:pointer; height:38px; padding:0 18px;
    border-radius:999px; background:transparent; color:var(--sn-gray);
    font-size:13px; font-weight:700; transition:background .12s ease, color .12s ease;
  }
  .at-mode.on { background:var(--sn-navy); color:#fff; }

  .at-field { display:flex; flex-direction:column; gap:6px; margin:0; }
  .at-field label { font-size:11.5px; font-weight:600; color:var(--sn-gray); }
  .at-select {
    height:44px; width:100%; padding:0 14px;
    border:1.5px solid var(--sn-line); border-radius:12px; background:#fff;
    font-size:13px; font-weight:600; color:var(--sn-ink); outline:none;
  }
  .at-select:focus { border-color:var(--sn-navy); }
  .at-danger {
    height:44px; padding:0 20px; border:none; border-radius:999px;
    background:var(--sn-red-bg); color:#c22525; font-size:13px; font-weight:800; cursor:pointer;
  }
  .at-danger:hover { background:#f7cdcb; }

  .at-chip {
    appearance:none; cursor:pointer; flex:0 0 auto; display:flex; flex-direction:column;
    align-items:center; justify-content:center; gap:1px;
    min-width:76px; padding:8px 12px; border-radius:14px;
    border:1.5px solid var(--sn-line); background:#fff; color:var(--sn-ink);
    transition:background .12s ease, border-color .12s ease, color .12s ease;
  }
  .at-chip:hover { border-color:var(--sn-navy600); }
  .at-chip.on { background:var(--sn-navy); border-color:var(--sn-navy); color:#fff; }
  .at-chip .n { font-size:13px; font-weight:800; font-variant-numeric:tabular-nums; }
  .at-chip .d { font-size:11px; font-weight:500; opacity:0.75; font-variant-numeric:tabular-nums; }

  .at-kpi { background:#fff; border-radius:16px; padding:16px; }
  .at-kpi .lb { font-size:11.5px; font-weight:600; color:var(--sn-gray); }
  .at-kpi .vl { font-size:28px; font-weight:800; line-height:1; margin-top:8px; letter-spacing:-0.03em; font-variant-numeric:tabular-nums; }

  .at-tablewrap { background:#fff; border-radius:20px; padding:8px 20px 14px; overflow-x:auto; }
  table.at-table { width:100%; min-width:900px; border-collapse:collapse; }
  .at-table th {
    text-align:left; padding:12px 10px; font-size:11.5px; font-weight:700;
    color:var(--sn-gray); letter-spacing:0.04em; border-bottom:1px solid var(--sn-line);
    white-space:nowrap;
  }
  .at-table td { padding:11px 10px; border-bottom:1px solid var(--sn-line2); font-size:13px; }
  .at-table tbody tr:hover { background:#f9fafb; }
  .at-num { font-variant-numeric:tabular-nums; }
  .at-mut { color:var(--sn-gray); font-size:12.5px; }

  .at-tag { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11.5px; font-weight:700; white-space:nowrap; }
  .tg-출석 { background:#dce8f5; color:#003876; }
  .tg-지각 { background:#fbe4d5; color:#9a5200; }
  .tg-조퇴 { background:#eae1f8; color:#5b21b6; }
  .tg-결석 { background:#fadedd; color:#c22525; }
  .tg-미체크 { background:#eceded; color:#656668; }
  .at-manual { font-size:10.5px; font-weight:700; color:#9a5200; margin-left:5px; }

  .at-time { cursor:pointer; border-bottom:1px dashed var(--sn-line); }
  .at-time:hover { color:var(--sn-navy); border-bottom-color:var(--sn-navy); }

  .at-rowsel {
    height:38px; min-width:104px; padding:0 10px; border:1.5px solid var(--sn-line);
    border-radius:12px; background:#fff; font-size:12.5px; font-weight:600; outline:none;
  }
  .at-reset {
    height:38px; padding:0 13px; border:none; border-radius:999px;
    background:#fbe4d5; color:#9a5200; font-size:11.5px; font-weight:700;
    cursor:pointer; white-space:nowrap;
  }
  .at-reset:hover { background:#f7d5bf; }

  .at-bar { flex:1; height:8px; background:var(--sn-line); border-radius:999px; min-width:80px; overflow:hidden; }
  .at-bar span { display:block; height:100%; border-radius:999px; }

  .at-empty { background:#fff; border-radius:20px; padding:44px 20px; text-align:center; color:var(--sn-gray); font-size:13.5px; font-weight:600; }

  /* 좁은 화면: 표 대신 카드 */
  .at-cards { display:none; flex-direction:column; gap:12px; }
  @media (max-width:820px) {
    .at-tablewrap { display:none; }
    .at-cards { display:flex; }
    .at-h1 { font-size:26px; }
  }
  .at-card { background:#fff; border-radius:20px; padding:16px; }
  .at-card .grid3 { display:grid; grid-template-columns:repeat(3,1fr); margin-top:12px; background:var(--sn-bg); border-radius:14px; padding:12px 14px; }
  .at-card .grid3 .lb { font-size:11px; font-weight:600; color:var(--sn-gray); }
  .at-card .grid3 .vl { font-size:16px; font-weight:800; font-variant-numeric:tabular-nums; margin-top:3px; }
  `;

  const body =
      '<section class="sn-section">'
    +   '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;">'
    +     '<div>'
    +       '<h1 class="at-h1">출결 현황</h1>'
    +       '<div class="at-lead" id="metaLine">과정 선택 &rarr; 회차 선택 &rarr; 출결 조회·수정</div>'
    +     '</div>'
    +     '<div class="at-modebar">'
    +       '<button type="button" class="at-mode on" id="modeDetail">회차별 상세</button>'
    +       '<button type="button" class="at-mode" id="modeSummary">전체 요약</button>'
    +     '</div>'
    +   '</div>'
    +   '<div class="sn-card" style="padding:16px 18px;margin-top:18px;display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">'
    +     '<div class="at-field" style="min-width:280px;flex:1;">'
    +       '<label for="courseSelect">교육과정</label>'
    +       '<select class="at-select" id="courseSelect"><option value="">-- 과정 선택 --</option>' + courseOptions + '</select>'
    +     '</div>'
    +     '<button type="button" class="sn-btn sn-btn-secondary" style="height:44px;" id="btnRefresh">새로고침</button>'
    +     '<button type="button" class="at-danger" id="btnMarkAbsent">미입실자 결석 일괄</button>'
    +   '</div>'
    + '</section>'

    + '<div id="content"><section class="sn-section"><div class="at-empty">먼저 교육과정을 선택하세요.</div></section></div>'

    + '<div id="snToast" style="position:fixed;left:50%;bottom:28px;transform:translateX(-50%);'
    +   'background:var(--sn-navy);color:#fff;font-size:13px;font-weight:700;padding:12px 20px;'
    +   'border-radius:999px;box-shadow:0 8px 24px rgba(0,56,118,0.25);opacity:0;pointer-events:none;'
    +   'transition:opacity .2s ease;z-index:50;max-width:88vw;text-align:center;"></div>';

  const pageJs = `
  var mode = 'detail';
  var courseId = '';
  var sessionId = '';
  var sessions = [];
  var roster = [];
  var sessionDate = '';   // 시각 수정 시 사용할 회차 날짜 (YYYY-MM-DD)

  var contentEl = document.getElementById('content');
  var selEl = document.getElementById('courseSelect');

  /* ── 토스트 ── */
  var toastTimer = null;
  function showToast(msg, bad) {
    var t = document.getElementById('snToast');
    if (!t) return;
    t.textContent = msg;
    t.style.background = bad ? '#D32F2F' : 'var(--sn-navy)';
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.style.opacity = '0'; }, 2400);
  }

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtTime(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function dateOnly(v) { return v ? String(v).split('T')[0] : ''; }
  function md(v) { var d = dateOnly(v); return d ? d.slice(5).replace('-', '/') : ''; }

  /* ── 모드 전환 ── */
  function setMode(m) {
    mode = m;
    document.getElementById('modeDetail').classList.toggle('on', m === 'detail');
    document.getElementById('modeSummary').classList.toggle('on', m === 'summary');
    if (!courseId) return;
    if (m === 'summary') loadSummary(); else loadSessions();
  }
  document.getElementById('modeDetail').addEventListener('click', function() { setMode('detail'); });
  document.getElementById('modeSummary').addEventListener('click', function() { setMode('summary'); });

  /* ── 과정 선택 ── */
  selEl.addEventListener('change', function() {
    courseId = selEl.value;
    sessionId = '';
    if (!courseId) {
      contentEl.innerHTML = '<section class="sn-section"><div class="at-empty">먼저 교육과정을 선택하세요.</div></section>';
      document.getElementById('metaLine').textContent = '과정 선택 → 회차 선택 → 출결 조회·수정';
      return;
    }
    setMode(mode);
  });

  document.getElementById('btnRefresh').addEventListener('click', function() {
    if (!courseId) { showToast('과정을 먼저 선택하세요', true); return; }
    if (mode === 'summary') loadSummary();
    else if (sessionId) loadAttendance(sessionId);
    else loadSessions();
  });

  document.getElementById('btnMarkAbsent').addEventListener('click', async function() {
    if (!sessionId) { showToast('회차를 먼저 선택하세요', true); return; }
    if (!confirm('입실 기록이 없는 수강생을 모두 결석 처리합니다. 진행할까요?')) return;
    try {
      var res = await fetch('/api/admin/mark-absent/' + sessionId, { method: 'POST' });
      var data = await res.json();
      showToast((data.count || 0) + '명을 결석 처리했습니다');
      loadAttendance(sessionId);
    } catch (e) { showToast('처리 실패: ' + e.message, true); }
  });

  /* ── 회차 목록 ── */
  async function loadSessions() {
    contentEl.innerHTML = '<section class="sn-section"><div class="at-empty">불러오는 중…</div></section>';
    try {
      var res = await fetch('/api/admin/sessions/' + courseId);
      sessions = await res.json();
    } catch (e) {
      contentEl.innerHTML = '<section class="sn-section"><div class="at-empty">회차를 불러오지 못했습니다.</div></section>';
      return;
    }
    if (!sessions.length) {
      contentEl.innerHTML = '<section class="sn-section"><div class="at-empty">등록된 회차가 없습니다.</div></section>';
      return;
    }
    var today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    var chips = sessions.map(function(s) {
      var isToday = dateOnly(s.session_date) === today;
      return '<button type="button" class="at-chip" data-sess="' + esc(s.session_id) + '">'
        + '<span class="n">' + esc(s.session_number) + '회' + (s.is_workshop ? ' ⛺' : '') + (isToday ? ' ●' : '') + '</span>'
        + '<span class="d">' + md(s.session_date) + '</span></button>';
    }).join('');

    contentEl.innerHTML =
        '<section class="sn-section" style="padding-top:18px;">'
      +   '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px;flex-wrap:wrap;">'
      +     '<h2 class="sn-h2" style="font-size:15px;">회차 선택</h2>'
      +     '<span class="sn-sub" id="sessTitle">' + sessions.length + '개 회차 · ●는 오늘</span>'
      +   '</div>'
      +   '<div style="display:flex;gap:8px;overflow-x:auto;padding:2px 0 6px;">' + chips + '</div>'
      + '</section>'
      + '<div id="attArea"><section class="sn-section" style="padding-top:14px;"><div class="at-empty">회차를 선택하세요.</div></section></div>';

    // 오늘 회차가 있으면 자동 선택
    var todayOne = sessions.filter(function(s) { return dateOnly(s.session_date) === today; })[0];
    if (todayOne) loadAttendance(todayOne.session_id);
  }

  /* ── 회차별 출결 ── */
  async function loadAttendance(sid) {
    sessionId = sid;
    document.querySelectorAll('.at-chip').forEach(function(b) {
      b.classList.toggle('on', b.getAttribute('data-sess') === String(sid));
    });
    var area = document.getElementById('attArea');
    if (!area) return;
    area.innerHTML = '<section class="sn-section" style="padding-top:14px;"><div class="at-empty">불러오는 중…</div></section>';
    var data;
    try {
      var res = await fetch('/api/admin/attendance/' + sid);
      data = await res.json();
    } catch (e) {
      area.innerHTML = '<section class="sn-section" style="padding-top:14px;"><div class="at-empty">출결을 불러오지 못했습니다.</div></section>';
      return;
    }
    roster = data.students || [];
    var sm = data.summary || { total: 0, attended: 0, late: 0, earlyLeave: 0, absent: 0 };
    sessionDate = roster.length ? dateOnly(roster[0].session_date) : '';

    var sInfo = sessions.filter(function(s) { return String(s.session_id) === String(sid); })[0];
    if (sInfo) {
      document.getElementById('metaLine').textContent =
        sInfo.session_number + '회차 · ' + (dateOnly(sInfo.session_date) || '-')
        + ' · ' + (sInfo.classroom_name || '강의실 미지정');
    }

    var present = Number(sm.attended) || 0;
    var rate = sm.total ? Math.round(((sm.total - sm.absent) / sm.total) * 100) : 0;

    function kpi(label, val, bg, lc, vc) {
      return '<div class="at-kpi" style="background:' + bg + ';">'
        + '<div class="lb" style="color:' + lc + ';">' + label + '</div>'
        + '<div class="vl" style="color:' + vc + ';">' + val + '</div></div>';
    }
    var kpiHtml = '<div class="sn-grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;">'
      + kpi('전체', sm.total, '#fff', 'var(--sn-gray)', 'var(--sn-ink)')
      + kpi('출석', present, '#fff', 'var(--sn-gray)', 'var(--sn-navy)')
      + kpi('지각', sm.late, '#fff', 'var(--sn-gray)', 'var(--sn-ink)')
      + kpi('조퇴', sm.earlyLeave, '#fff', 'var(--sn-gray)', 'var(--sn-ink)')
      + kpi('결석 · 미체크', sm.absent, 'var(--sn-red-bg)', '#a32020', '#D32F2F')
      + kpi('출석률', rate + '%', 'var(--sn-navy)', '#a9c3dd', '#fff')
      + '</div>';

    // 표(넓은 화면) + 카드(좁은 화면)
    var rows = '', cards = '';
    roster.forEach(function(s, i) {
      var st = s.status || '미체크';
      var aid = s.attendance_id || '';
      var inTxt = fmtTime(s.check_in_at), outTxt = fmtTime(s.check_out_at);
      var manual = s.is_manual_override ? '<span class="at-manual">수동</span>' : '';
      var tag = '<span class="at-tag tg-' + esc(st) + '">' + esc(st) + '</span>' + manual;
      var inCell = aid
        ? '<span class="at-time" data-act="time" data-aid="' + esc(aid) + '" data-field="check_in_at" data-raw="' + esc(s.check_in_at || '') + '" title="클릭하여 수정">' + inTxt + '</span>'
        : inTxt;
      var outCell = aid
        ? '<span class="at-time" data-act="time" data-aid="' + esc(aid) + '" data-field="check_out_at" data-raw="' + esc(s.check_out_at || '') + '" title="클릭하여 수정">' + outTxt + '</span>'
        : outTxt;
      var ctrl = aid
        ? '<div style="display:flex;gap:6px;align-items:center;">'
          + '<select class="at-rowsel" data-act="status" data-aid="' + esc(aid) + '">'
          + '<option value="">상태 변경</option>'
          + ['출석','지각','조퇴','결석'].map(function(v) {
              return '<option value="' + v + '"' + (v === st ? ' disabled' : '') + '>' + v + '</option>'; }).join('')
          + '</select>'
          + '<button type="button" class="at-reset" data-act="reset" data-aid="' + esc(aid) + '" data-name="' + esc(s.name) + '">출결 초기화</button>'
          + '</div>'
        : '<span class="at-mut">기록 없음</span>';

      rows += '<tr>'
        + '<td class="at-num at-mut">' + (i + 1) + '</td>'
        + '<td style="font-weight:700;">' + esc(s.name) + '</td>'
        + '<td class="at-num at-mut">' + esc(s.phone) + '</td>'
        + '<td class="at-num" style="font-weight:600;">' + inCell + '</td>'
        + '<td class="at-num" style="font-weight:600;">' + outCell + '</td>'
        + '<td class="at-mut">' + esc(s.exit_type || '—') + '</td>'
        + '<td>' + tag + '</td>'
        + '<td>' + ctrl + '</td>'
        + '</tr>';

      cards += '<div class="at-card">'
        + '<div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;">'
        +   '<span style="font-size:17px;font-weight:800;letter-spacing:-0.015em;">' + esc(s.name) + '</span>' + tag
        + '</div>'
        + '<div class="at-mut at-num" style="margin-top:3px;">' + esc(s.phone) + '</div>'
        + '<div class="grid3">'
        +   '<div><div class="lb">입실</div><div class="vl">' + inCell + '</div></div>'
        +   '<div><div class="lb">퇴실</div><div class="vl">' + outCell + '</div></div>'
        +   '<div><div class="lb">퇴실유형</div><div class="vl" style="font-size:12.5px;font-weight:700;margin-top:5px;">' + esc(s.exit_type || '—') + '</div></div>'
        + '</div>'
        + '<div style="margin-top:12px;">' + ctrl + '</div>'
        + '</div>';
    });

    area.innerHTML =
        '<section class="sn-section" style="padding-top:14px;">' + kpiHtml + '</section>'
      + '<section class="sn-section" style="padding-top:18px;">'
      +   '<div class="at-tablewrap"><table class="at-table">'
      +     '<thead><tr><th style="width:44px;">#</th><th>이름</th><th>전화번호</th><th>입실</th><th>퇴실</th>'
      +     '<th>퇴실유형</th><th>상태</th><th style="width:250px;">변경 · 초기화</th></tr></thead>'
      +     '<tbody>' + (rows || '<tr><td colspan="8" class="at-mut" style="padding:30px;text-align:center;">등록된 수강생이 없습니다.</td></tr>') + '</tbody>'
      +   '</table></div>'
      +   '<div class="at-cards">' + (cards || '<div class="at-empty">등록된 수강생이 없습니다.</div>') + '</div>'
      + '</section>';
  }

  /* ── 전체 요약 (수강생별 누적) ── */
  async function loadSummary() {
    contentEl.innerHTML = '<section class="sn-section"><div class="at-empty">불러오는 중…</div></section>';
    var rows;
    try {
      var res = await fetch('/api/admin/summary/' + courseId);
      rows = await res.json();
    } catch (e) {
      contentEl.innerHTML = '<section class="sn-section"><div class="at-empty">요약을 불러오지 못했습니다.</div></section>';
      return;
    }
    document.getElementById('metaLine').textContent = '수강생별 전체 회차 누적 출결';
    var body = rows.map(function(r, i) {
      var rate = Number(r.attendance_rate) || 0;
      var color = rate >= 80 ? 'var(--sn-navy)' : (rate >= 50 ? '#2a63a8' : 'var(--sn-amber)');
      return '<tr>'
        + '<td class="at-num at-mut">' + (i + 1) + '</td>'
        + '<td style="font-weight:700;">' + esc(r.name) + '</td>'
        + '<td class="at-num at-mut">' + esc(r.phone) + '</td>'
        + '<td class="at-num" style="font-weight:600;">' + esc(r.attended) + '</td>'
        + '<td class="at-num" style="font-weight:600;">' + esc(r.late) + '</td>'
        + '<td class="at-num" style="font-weight:600;">' + esc(r.early_leave) + '</td>'
        + '<td class="at-num" style="font-weight:800;color:var(--sn-red);">' + esc(r.absent) + '</td>'
        + '<td><div style="display:flex;align-items:center;gap:10px;">'
        +   '<div class="at-bar"><span style="width:' + Math.min(100, rate) + '%;background:' + color + ';"></span></div>'
        +   '<span class="at-num" style="font-size:12.5px;font-weight:800;min-width:42px;text-align:right;">' + rate + '%</span>'
        + '</div></td>'
        + '</tr>';
    }).join('');

    contentEl.innerHTML =
        '<section class="sn-section" style="padding-top:18px;">'
      +   '<div class="at-tablewrap"><table class="at-table" style="min-width:680px;">'
      +     '<thead><tr><th style="width:44px;">#</th><th>이름</th><th>전화번호</th><th>출석</th><th>지각</th>'
      +     '<th>조퇴</th><th>결석</th><th style="width:210px;">출석률</th></tr></thead>'
      +     '<tbody>' + (body || '<tr><td colspan="8" class="at-mut" style="padding:30px;text-align:center;">수강생이 없습니다.</td></tr>') + '</tbody>'
      +   '</table></div>'
      + '</section>';
  }

  /* ── 이벤트 위임 ── */
  contentEl.addEventListener('click', function(ev) {
    var chip = ev.target.closest('.at-chip');
    if (chip) { loadAttendance(chip.getAttribute('data-sess')); return; }

    var el = ev.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (act === 'reset') resetAttendance(el.getAttribute('data-aid'), el.getAttribute('data-name'));
    else if (act === 'time') editTime(el.getAttribute('data-aid'), el.getAttribute('data-field'), el.getAttribute('data-raw'));
  });
  contentEl.addEventListener('change', function(ev) {
    var el = ev.target.closest('[data-act="status"]');
    if (el) changeStatus(el.getAttribute('data-aid'), el.value);
  });

  /* ── 상태 변경 ── */
  async function changeStatus(aid, newStatus) {
    if (!newStatus) return;
    if (!confirm(newStatus + '(으)로 변경할까요?')) { loadAttendance(sessionId); return; }
    try {
      var res = await fetch('/api/admin/attendance/' + aid, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      var d = await res.json();
      if (d.success) showToast(newStatus + '(으)로 변경했습니다');
      else showToast('변경 실패: ' + (d.error || ''), true);
    } catch (e) { showToast('변경 실패: ' + e.message, true); }
    loadAttendance(sessionId);
  }

  /* ── 출결 초기화 ── */
  async function resetAttendance(aid, name) {
    if (!confirm(name + '의 출결 기록을 초기화합니다.\\n입·퇴실 기록이 삭제되고 다시 QR로 입실할 수 있습니다.')) return;
    try {
      var res = await fetch('/api/admin/attendance/' + aid, { method: 'DELETE' });
      var d = await res.json();
      if (d.success) { showToast(name + ' 출결을 초기화했습니다'); loadAttendance(sessionId); }
      else showToast('초기화 실패: ' + (d.error || ''), true);
    } catch (e) { showToast('초기화 실패: ' + e.message, true); }
  }

  /* ── 입·퇴실 시각 수정 ── */
  async function editTime(aid, field, raw) {
    var fieldName = field === 'check_in_at' ? '입실 시각' : '퇴실 시각';
    var def = '';
    if (raw) {
      var d = new Date(raw);
      if (!isNaN(d.getTime())) {
        def = d.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit' });
      }
    }
    var input = prompt(
      fieldName + '을 수정합니다.\\nHH:MM 형식으로 입력하세요. (예: 09:30)\\n비워두면 시각이 삭제됩니다.',
      def
    );
    if (input === null) return;
    var value = '';
    if (input.trim() !== '') {
      var m = input.trim().match(/^(\\d{1,2}):(\\d{2})$/);
      if (!m) { showToast('형식이 올바르지 않습니다 (예: 09:30)', true); return; }
      var hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) { showToast('유효하지 않은 시각입니다', true); return; }
      if (!sessionDate) { showToast('회차 날짜를 확인할 수 없습니다', true); return; }
      value = sessionDate + ' ' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00';
    }
    try {
      var res = await fetch('/api/admin/attendance/' + aid + '/time', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: field, value: value })
      });
      var d2 = await res.json();
      if (d2.success) { showToast(fieldName + '을 수정했습니다'); loadAttendance(sessionId); }
      else showToast('수정 실패: ' + (d2.error || ''), true);
    } catch (e) { showToast('수정 실패: ' + e.message, true); }
  }
  `;

  return layout.renderShell({
    active: 'attendance',
    title: '출결 현황',
    body: body,
    pageCss: pageCss,
    pageJs: pageJs
  });
}

// ═════════════════════════════════════════════════════════════
// 수강생 관리 페이지 HTML
// ═════════════════════════════════════════════════════════════
function renderStudentsPage(courses) {
  const esc = layout.esc;

  const courseOptions = courses.map(function(c) {
    const label = c.course_name
      + (c.cohort ? ' ' + c.cohort + '기' : '')
      + (c.course_type ? ' [' + c.course_type + ']' : '');
    return '<option value="' + esc(c.course_id) + '">' + esc(label) + '</option>';
  }).join('');

  const pageCss = `
  .sd-h1 { margin:0; font-size:32px; font-weight:800; letter-spacing:-0.025em; line-height:1.1; }
  .sd-lead { font-size:13px; font-weight:500; color:var(--sn-gray); margin-top:6px; }

  .sd-field { display:flex; flex-direction:column; gap:6px; margin:0; }
  .sd-field label { font-size:11.5px; font-weight:600; color:var(--sn-gray); }
  .sd-select, .sd-input {
    height:44px; width:100%; padding:0 14px;
    border:1.5px solid var(--sn-line); border-radius:12px; background:#fff;
    font-size:13px; font-weight:600; color:var(--sn-ink); outline:none;
    transition:border-color .15s ease;
  }
  .sd-select:focus, .sd-input:focus { border-color:var(--sn-navy); }
  .sd-area {
    width:100%; min-height:150px; padding:14px;
    border:1.5px solid var(--sn-line); border-radius:14px; background:#fff;
    font-size:13px; font-weight:500; line-height:1.7; color:var(--sn-ink);
    outline:none; resize:vertical; font-family:inherit;
  }
  .sd-area:focus { border-color:var(--sn-navy); }

  .sd-kpi { background:#fff; border-radius:16px; padding:16px; }
  .sd-kpi .lb { font-size:11.5px; font-weight:600; color:var(--sn-gray); }
  .sd-kpi .vl { font-size:28px; font-weight:800; line-height:1; margin-top:8px; letter-spacing:-0.03em; font-variant-numeric:tabular-nums; }

  .sd-tablewrap { background:#fff; border-radius:20px; padding:8px 20px 14px; overflow-x:auto; margin-top:14px; }
  table.sd-table { width:100%; min-width:840px; border-collapse:collapse; }
  .sd-table th {
    text-align:left; padding:12px 10px; font-size:11.5px; font-weight:700;
    color:var(--sn-gray); letter-spacing:0.04em; border-bottom:1px solid var(--sn-line); white-space:nowrap;
  }
  .sd-table td { padding:11px 10px; border-bottom:1px solid var(--sn-line2); font-size:13px; }
  .sd-table tbody tr:hover { background:#f9fafb; }
  .sd-num { font-variant-numeric:tabular-nums; }
  .sd-mut { color:var(--sn-gray); font-size:12.5px; }

  .sd-tag { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11.5px; font-weight:700; white-space:nowrap; }
  .tg-ok   { background:#dce8f5; color:#003876; }
  .tg-no   { background:#fadedd; color:#c22525; }
  .tg-push { background:#e6f4ea; color:#137333; }
  .tg-off  { background:#eceded; color:#656668; }
  .tg-wait { background:#fff3cd; color:#856404; }

  .sd-mini {
    height:34px; padding:0 12px; border-radius:999px; border:1px solid var(--sn-line);
    background:#fff; font-size:11.5px; font-weight:700; cursor:pointer; white-space:nowrap;
    color:var(--sn-navy); transition:background .12s ease;
  }
  .sd-mini:hover { background:var(--sn-bg); }
  .sd-mini.green { background:#e6f4ea; border-color:#cbe6d4; color:#137333; }
  .sd-mini.green:hover { background:#d9edde; }
  .sd-mini.red { background:var(--sn-red-bg); border-color:#f3cdcb; color:#c22525; }
  .sd-mini.red:hover { background:#f7cdcb; }

  .sd-empty { background:#fff; border-radius:20px; padding:36px 20px; text-align:center; color:var(--sn-gray); font-size:13.5px; font-weight:600; }
  .sd-info {
    background:#dce8f5; border-radius:14px; padding:14px 16px;
    font-size:12.5px; color:#003876; line-height:1.8;
  }
  .sd-warncard { border:1.5px solid #f0c36d; background:#fffaf0; }

  /* 등록 링크 모달 */
  .sd-modal {
    display:none; position:fixed; inset:0; background:rgba(16,17,18,0.55);
    z-index:100; align-items:center; justify-content:center; padding:20px;
  }
  .sd-modal.on { display:flex; }
  .sd-modal-in {
    background:#fff; border-radius:26px; padding:30px 26px; max-width:420px; width:100%;
    text-align:center; box-shadow:0 18px 50px rgba(0,56,118,0.25);
  }
  `;

  const body =
      '<section class="sn-section">'
    +   '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;">'
    +     '<div>'
    +       '<h1 class="sd-h1">수강생 관리</h1>'
    +       '<div class="sd-lead">명단 · 생체인증 · 퇴실 알림 구독</div>'
    +     '</div>'
    +     '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    +       '<button type="button" class="sn-btn sn-btn-secondary" style="height:44px;" id="btnRefresh">새로고침</button>'
    +       '<button type="button" class="sn-btn sn-btn-primary" style="height:44px;" id="btnRegPrint">전체 등록링크 발급·인쇄</button>'
    +     '</div>'
    +   '</div>'
    + '</section>'

    // ── 재등록 승인 대기 ──
    + '<section class="sn-section" style="padding-top:18px;display:none;" id="pendingSection">'
    +   '<div class="sn-card sd-warncard">'
    +     '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
    +       '<div style="font-size:16px;font-weight:800;letter-spacing:-0.015em;">재등록 승인 대기</div>'
    +       '<span class="sd-tag tg-wait" id="pendingCount">0건</span>'
    +     '</div>'
    +     '<div class="sd-mut" style="margin-top:6px;line-height:1.7;">이미 등록된 수강생이 다른 기기로 재등록을 시도했습니다. 본인 확인 후 승인하세요.</div>'
    +     '<div id="pendingList" style="margin-top:12px;"></div>'
    +   '</div>'
    + '</section>'

    // ── 수강생 조회 ──
    + '<section class="sn-section" style="padding-top:18px;">'
    +   '<div class="sn-card" style="padding:16px 18px;display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">'
    +     '<div class="sd-field" style="min-width:280px;flex:1;">'
    +       '<label for="courseSelect">교육과정</label>'
    +       '<select class="sd-select" id="courseSelect"><option value="">-- 과정 선택 --</option>' + courseOptions + '</select>'
    +     '</div>'
    +   '</div>'
    +   '<div id="studentArea"><div class="sd-empty" style="margin-top:14px;">먼저 교육과정을 선택하세요.</div></div>'
    + '</section>'

    // ── 일괄 등록 ──
    + '<section class="sn-section" style="padding-top:18px;">'
    +   '<div class="sn-grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));">'
    +     '<div class="sn-card">'
    +       '<div style="font-size:16px;font-weight:800;letter-spacing:-0.015em;">수강생 일괄 등록</div>'
    +       '<div class="sd-info" style="margin-top:12px;">'
    +         '형식: <strong>이름[탭 또는 공백]전화번호</strong> — 한 줄에 한 명<br>'
    +         '예시: 홍길동 01012345678 &nbsp;/&nbsp; 홍길동 010-1234-5678<br>'
    +         '엑셀에서 이름·전화번호 열을 복사해 그대로 붙여넣어도 됩니다.'
    +       '</div>'
    +       '<div class="sd-field" style="margin-top:14px;">'
    +         '<label for="bulkCourseSelect">등록할 과정</label>'
    +         '<select class="sd-select" id="bulkCourseSelect"><option value="">-- 등록할 과정 선택 --</option>' + courseOptions + '</select>'
    +       '</div>'
    +       '<textarea class="sd-area" id="bulkInput" style="margin-top:12px;" placeholder="홍길동 01012345678&#10;김철수 010-9876-5432"></textarea>'
    +       '<div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap;">'
    +         '<button type="button" class="sn-btn sn-btn-primary" style="height:44px;" id="btnBulk">일괄 등록</button>'
    +         '<span class="sd-mut" id="bulkPreview"></span>'
    +       '</div>'
    +     '</div>'

    +     '<div class="sn-card">'
    +       '<div style="font-size:16px;font-weight:800;letter-spacing:-0.015em;">통합 관리 시트</div>'
    +       '<div class="sd-info" style="margin-top:12px;">'
    +         '전체 과정의 수강생 명단 + 생체인증 등록 여부 + 퇴실 알림 구독 여부를 하나의 구글시트로 내보냅니다.<br>'
    +         '시트를 서비스 계정 이메일과 <strong>편집자</strong>로 공유해야 합니다.'
    +       '</div>'
    +       '<div class="sd-field" style="margin-top:14px;">'
    +         '<label for="mgmtSheetId">통합 관리용 스프레드시트 ID</label>'
    +         '<input class="sd-input" type="text" id="mgmtSheetId" placeholder="스프레드시트 ID 입력" autocomplete="off">'
    +       '</div>'
    +       '<button type="button" class="sn-btn sn-btn-secondary" style="height:44px;margin-top:12px;" id="btnMgmt">현황 시트 동기화</button>'

    +       '<div style="border-top:1px solid var(--sn-line);margin-top:18px;padding-top:16px;">'
    +         '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
    +           '<div style="font-size:14px;font-weight:800;">최근 등록 현황</div>'
    +           '<span class="sd-mut">최근 24시간 · 5초마다 자동 갱신</span>'
    +         '</div>'
    +         '<div id="regLog" style="margin-top:10px;"></div>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    + '</section>'

    // ── 등록 링크 모달 ──
    + '<div class="sd-modal" id="regModal">'
    +   '<div class="sd-modal-in">'
    +     '<div style="font-size:19px;font-weight:800;letter-spacing:-0.02em;" id="regName"></div>'
    +     '<div class="sd-mut" style="margin-top:5px;">24시간 유효 · 1회 사용 가능</div>'
    +     '<canvas id="regQR" style="border-radius:14px;border:1px solid var(--sn-line);margin-top:16px;"></canvas>'
    +     '<div style="margin-top:14px;display:flex;gap:8px;">'
    +       '<input class="sd-input" id="regUrl" type="text" readonly style="flex:1;font-size:11.5px;background:var(--sn-bg);">'
    +       '<button type="button" class="sn-btn sn-btn-primary" style="height:44px;" id="btnCopyUrl">복사</button>'
    +     '</div>'
    +     '<div class="sd-mut" style="margin-top:10px;line-height:1.7;">수강생이 이 QR을 스캔하거나 링크를 열면<br>본인 생체인증만 등록할 수 있습니다.</div>'
    +     '<button type="button" class="sn-btn sn-btn-secondary" style="height:46px;width:100%;margin-top:16px;" id="btnCloseModal">닫기</button>'
    +   '</div>'
    + '</div>'

    + '<div id="snToast" style="position:fixed;left:50%;bottom:28px;transform:translateX(-50%);'
    +   'background:var(--sn-navy);color:#fff;font-size:13px;font-weight:700;padding:12px 20px;'
    +   'border-radius:999px;box-shadow:0 8px 24px rgba(0,56,118,0.25);opacity:0;pointer-events:none;'
    +   'transition:opacity .2s ease;z-index:120;max-width:88vw;text-align:center;"></div>';

  const pageJs = `
  var courseId = '';
  var areaEl = document.getElementById('studentArea');
  var selEl = document.getElementById('courseSelect');

  /* ── 공통 ── */
  var toastTimer = null;
  function showToast(msg, bad) {
    var t = document.getElementById('snToast');
    if (!t) return;
    t.textContent = msg;
    t.style.background = bad ? '#D32F2F' : 'var(--sn-navy)';
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.style.opacity = '0'; }, 2600);
  }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDate(v) {
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
  }
  function fmtTime(v) {
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('ko-KR',
      { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /* ── 수강생 목록 ── */
  async function loadStudents() {
    courseId = selEl.value;
    if (!courseId) {
      areaEl.innerHTML = '<div class="sd-empty" style="margin-top:14px;">먼저 교육과정을 선택하세요.</div>';
      return;
    }
    areaEl.innerHTML = '<div class="sd-empty" style="margin-top:14px;">불러오는 중…</div>';
    var students;
    try {
      var res = await fetch('/api/admin/students/' + courseId);
      students = await res.json();
    } catch (e) {
      areaEl.innerHTML = '<div class="sd-empty" style="margin-top:14px;">수강생을 불러오지 못했습니다.</div>';
      return;
    }
    if (!Array.isArray(students)) {
      areaEl.innerHTML = '<div class="sd-empty" style="margin-top:14px;">조회 실패: ' + esc(students.error || '알 수 없는 오류') + '</div>';
      return;
    }
    if (!students.length) {
      areaEl.innerHTML = '<div class="sd-empty" style="margin-top:14px;">이 과정에 등록된 수강생이 없습니다.</div>';
      return;
    }

    var total = students.length;
    var bioOk = students.filter(function(s) { return s.has_credential; }).length;
    var pushOk = students.filter(function(s) { return s.has_push; }).length;

    function kpi(label, val, bg, lc, vc) {
      return '<div class="sd-kpi" style="background:' + bg + ';">'
        + '<div class="lb" style="color:' + lc + ';">' + label + '</div>'
        + '<div class="vl" style="color:' + vc + ';">' + val + '</div></div>';
    }
    var kpiHtml = '<div class="sn-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:14px;">'
      + kpi('전체', total, '#fff', 'var(--sn-gray)', 'var(--sn-ink)')
      + kpi('생체인증 등록', bioOk, '#fff', 'var(--sn-gray)', 'var(--sn-navy)')
      + kpi('미등록', total - bioOk, (total - bioOk) ? 'var(--sn-red-bg)' : '#fff',
            (total - bioOk) ? '#a32020' : 'var(--sn-gray)', (total - bioOk) ? '#D32F2F' : 'var(--sn-ink)')
      + kpi('퇴실 알림 구독', pushOk, '#fff', 'var(--sn-gray)', 'var(--sn-ink)')
      + '</div>';

    var rows = students.map(function(s, i) {
      var bio = s.has_credential
        ? '<span class="sd-tag tg-ok">등록 (' + esc(s.cred_count) + ')</span>'
        : '<span class="sd-tag tg-no">미등록</span>';
      var push = s.has_push
        ? '<span class="sd-tag tg-push">구독중</span>'
        : '<span class="sd-tag tg-off">미구독</span>';
      var act = '';
      if (s.has_credential) {
        act += '<button type="button" class="sd-mini" data-act="resetcred" data-sid="' + esc(s.student_id) + '" data-name="' + esc(s.name) + '">인증 초기화</button> ';
      }
      act += '<button type="button" class="sd-mini green" data-act="regtoken" data-sid="' + esc(s.student_id) + '" data-name="' + esc(s.name) + '">등록링크</button> ';
      act += '<button type="button" class="sd-mini red" data-act="remove" data-sid="' + esc(s.student_id) + '" data-name="' + esc(s.name) + '">삭제</button>';
      return '<tr>'
        + '<td class="sd-num sd-mut">' + (i + 1) + '</td>'
        + '<td style="font-weight:700;">' + esc(s.name) + '</td>'
        + '<td class="sd-num sd-mut">' + esc(s.phone) + '</td>'
        + '<td>' + bio + '</td>'
        + '<td class="sd-mut sd-num">' + fmtDate(s.last_used_at) + '</td>'
        + '<td>' + push + '</td>'
        + '<td style="white-space:nowrap;">' + act + '</td>'
        + '</tr>';
    }).join('');

    areaEl.innerHTML = kpiHtml
      + '<div class="sd-tablewrap"><table class="sd-table">'
      +   '<thead><tr><th style="width:44px;">#</th><th>이름</th><th>전화번호</th><th>생체인증</th>'
      +   '<th>마지막 인증</th><th>퇴실 알림</th><th style="width:280px;">관리</th></tr></thead>'
      +   '<tbody>' + rows + '</tbody>'
      + '</table></div>';
  }
  selEl.addEventListener('change', loadStudents);
  document.getElementById('btnRefresh').addEventListener('click', function() {
    if (!courseId) { showToast('과정을 먼저 선택하세요', true); return; }
    loadStudents();
  });
  document.getElementById('btnRegPrint').addEventListener('click', function() {
    if (!selEl.value) { showToast('과정을 먼저 선택하세요', true); return; }
    window.open('/admin/reg-print/' + selEl.value, '_blank');
  });

  /* ── 행 버튼 (이벤트 위임) ── */
  areaEl.addEventListener('click', function(ev) {
    var b = ev.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    var sid = b.getAttribute('data-sid');
    var name = b.getAttribute('data-name');
    if (act === 'resetcred') resetCred(sid, name);
    else if (act === 'regtoken') issueRegToken(sid, name);
    else if (act === 'remove') removeStudent(sid, name);
  });

  async function resetCred(sid, name) {
    if (!confirm(name + '의 생체인증 등록을 초기화합니다.\\n재등록 링크가 자동 발급됩니다.')) return;
    try {
      var res = await fetch('/api/admin/credentials/' + sid, { method: 'DELETE' });
      var d = await res.json();
      if (d.success) showToast(name + ' 인증을 초기화했습니다 · /register 에서 재등록 가능 (24시간)');
      else showToast('초기화 실패: ' + (d.error || ''), true);
    } catch (e) { showToast('초기화 실패: ' + e.message, true); }
    loadStudents();
  }

  async function removeStudent(sid, name) {
    if (!courseId) { showToast('과정을 먼저 선택하세요', true); return; }
    if (!confirm(name + '을(를) 이 과정에서 삭제할까요?')) return;
    try {
      var res = await fetch('/api/admin/students/' + sid + '/' + courseId, { method: 'DELETE' });
      var d = await res.json();
      if (d.success) showToast(name + '을(를) 삭제했습니다');
      else showToast('삭제 실패: ' + (d.error || ''), true);
    } catch (e) { showToast('삭제 실패: ' + e.message, true); }
    loadStudents();
  }

  /* ── 등록 링크 모달 ── */
  var modal = document.getElementById('regModal');
  document.getElementById('btnCloseModal').addEventListener('click', function() { modal.classList.remove('on'); });
  modal.addEventListener('click', function(ev) { if (ev.target === modal) modal.classList.remove('on'); });
  document.addEventListener('keydown', function(ev) { if (ev.key === 'Escape') modal.classList.remove('on'); });

  document.getElementById('btnCopyUrl').addEventListener('click', function() {
    var el = document.getElementById('regUrl');
    var text = el.value;
    var btn = this;
    function done() { btn.textContent = '복사됨'; setTimeout(function() { btn.textContent = '복사'; }, 1800); }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else { fallback(); }
    function fallback() {
      el.removeAttribute('readonly'); el.select();
      try { document.execCommand('copy'); done(); } catch (e) { showToast('복사에 실패했습니다', true); }
      el.setAttribute('readonly', 'readonly');
    }
  });

  function drawQR(url) {
    var el = document.getElementById('regQR');
    function make() { new QRious({ element: el, value: url, size: 200, level: 'M', background: '#fff', foreground: '#003876' }); }
    if (window.QRious) { make(); return; }
    var sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js';
    sc.onload = make;
    sc.onerror = function() { showToast('QR 라이브러리를 불러오지 못했습니다. 링크는 복사할 수 있습니다', true); };
    document.head.appendChild(sc);
  }

  async function issueRegToken(sid, name) {
    try {
      var res = await fetch('/api/admin/reg-token/' + sid, { method: 'POST' });
      var d = await res.json();
      if (d.error) { showToast('발급 실패: ' + d.error, true); return; }
      var url = location.origin + '/register?token=' + d.token;
      document.getElementById('regName').textContent = name + '님 등록 링크';
      document.getElementById('regUrl').value = url;
      modal.classList.add('on');
      drawQR(url);
    } catch (e) { showToast('발급 실패: ' + e.message, true); }
  }

  /* ── 일괄 등록 ── */
  function parseBulk(text) {
    var out = [];
    text.split('\\n').forEach(function(line) {
      if (!line.trim()) return;
      var m = line.match(/(01[016789][-\\s]?\\d{3,4}[-\\s]?\\d{4})/);
      if (m) {
        var phone = m[1].trim();
        var name = line.replace(phone, '').replace(/[,\\t]/g, '').trim();
        if (name) out.push({ name: name, phone: phone });
      } else {
        var p = line.split(/\\t|,|\\s+/);
        if (p.length >= 2) out.push({ name: p[0].trim(), phone: p.slice(1).join('').trim() });
      }
    });
    return out;
  }

  var bulkEl = document.getElementById('bulkInput');
  bulkEl.addEventListener('input', function() {
    var n = parseBulk(bulkEl.value).length;
    document.getElementById('bulkPreview').textContent = n ? (n + '명 인식됨') : '';
  });

  document.getElementById('btnBulk').addEventListener('click', async function() {
    var cid = document.getElementById('bulkCourseSelect').value;
    if (!cid) { showToast('등록할 과정을 선택하세요', true); return; }
    var list = parseBulk(bulkEl.value);
    if (!list.length) { showToast('인식 가능한 수강생 정보가 없습니다', true); return; }
    if (!confirm(list.length + '명을 등록할까요?')) return;
    showToast('등록 중…');
    try {
      var res = await fetch('/api/admin/students/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courseId: cid, students: list })
      });
      var d = await res.json();
      if (d.success) {
        showToast(d.added + '명 등록 완료' + (d.skipped > 0 ? ' · ' + d.skipped + '명 건너뜀' : ''));
        bulkEl.value = '';
        document.getElementById('bulkPreview').textContent = '';
        if (selEl.value === cid) loadStudents();
      } else {
        showToast('등록 실패: ' + (d.error || ''), true);
      }
    } catch (e) { showToast('등록 실패: ' + e.message, true); }
  });

  /* ── 통합 관리 시트 ── */
  document.getElementById('btnMgmt').addEventListener('click', async function() {
    var id = document.getElementById('mgmtSheetId').value.trim();
    if (!id) { showToast('스프레드시트 ID를 입력하세요', true); return; }
    showToast('동기화 중…');
    try {
      var res = await fetch('/api/admin/sync-management', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheetId: id })
      });
      var d = await res.json();
      if (d.success) showToast(d.count + '명 동기화 완료');
      else showToast('동기화 실패: ' + (d.error || ''), true);
    } catch (e) { showToast('동기화 실패: ' + e.message, true); }
  });

  /* ── 최근 등록 현황 ── */
  async function loadRegLog() {
    try {
      var res = await fetch('/api/admin/reg-log');
      var rows = await res.json();
      var el = document.getElementById('regLog');
      if (!el) return;
      if (!rows.length) {
        el.innerHTML = '<div class="sd-mut" style="padding:8px 0;">최근 등록 내역이 없습니다.</div>';
        return;
      }
      el.innerHTML = rows.map(function(r) {
        var tag = r.type === 'pending'
          ? '<span class="sd-tag tg-wait">승인대기</span>'
          : '<span class="sd-tag tg-push">등록완료</span>';
        return '<div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--sn-line2);font-size:12.5px;">'
          + '<span style="font-weight:700;min-width:70px;">' + esc(r.name) + '</span>'
          + '<span class="sd-mut sd-num">' + esc(r.phone) + '</span>'
          + '<span class="sd-mut sd-num" style="margin-left:auto;">' + fmtTime(r.registered_at) + '</span>'
          + tag + '</div>';
      }).join('');
    } catch (e) { /* 무시 */ }
  }

  /* ── 재등록 승인 대기 ── */
  async function loadPending() {
    try {
      var res = await fetch('/api/admin/pending-creds');
      var rows = await res.json();
      var sec = document.getElementById('pendingSection');
      var el = document.getElementById('pendingList');
      if (!sec || !el) return;
      if (!rows.length) { sec.style.display = 'none'; return; }
      sec.style.display = '';
      document.getElementById('pendingCount').textContent = rows.length + '건';
      el.innerHTML = rows.map(function(r) {
        return '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:11px 0;border-bottom:1px solid var(--sn-line2);font-size:12.5px;">'
          + '<span style="font-weight:800;min-width:70px;">' + esc(r.name) + '</span>'
          + '<span class="sd-mut sd-num">' + esc(r.phone) + '</span>'
          + '<span class="sd-mut">' + esc(r.courses || '-') + '</span>'
          + '<span class="sd-mut sd-num">' + fmtTime(r.requested_at) + '</span>'
          + '<span style="margin-left:auto;display:flex;gap:6px;">'
          +   '<button type="button" class="sd-mini green" data-pact="approve" data-sid="' + esc(r.student_id) + '" data-name="' + esc(r.name) + '">승인</button>'
          +   '<button type="button" class="sd-mini red" data-pact="reject" data-sid="' + esc(r.student_id) + '" data-name="' + esc(r.name) + '">거부</button>'
          + '</span></div>';
      }).join('');
    } catch (e) { /* 무시 */ }
  }

  document.getElementById('pendingList').addEventListener('click', async function(ev) {
    var b = ev.target.closest('[data-pact]');
    if (!b) return;
    var act = b.getAttribute('data-pact');
    var sid = b.getAttribute('data-sid');
    var name = b.getAttribute('data-name');
    if (act === 'approve') {
      if (!confirm(name + '님의 재등록을 승인할까요?\\n기존 기기 인증이 해제되고 새 기기로 변경됩니다.')) return;
    } else {
      if (!confirm(name + '님의 재등록 요청을 거부할까요?\\n기존 등록이 유지됩니다.')) return;
    }
    try {
      var res = await fetch('/api/admin/pending-creds/' + sid + '/' + act, { method: 'POST' });
      var d = await res.json();
      if (d.success) showToast(name + '님 재등록을 ' + (act === 'approve' ? '승인' : '거부') + '했습니다');
      else showToast('처리 실패: ' + (d.error || ''), true);
    } catch (e) { showToast('처리 실패: ' + e.message, true); }
    loadPending(); loadRegLog();
    if (courseId) loadStudents();
  });

  loadRegLog();
  loadPending();
  setInterval(function() { loadRegLog(); loadPending(); }, 5000);
  `;

  return layout.renderShell({
    active: 'students',
    title: '수강생 관리',
    body: body,
    pageCss: pageCss,
    pageJs: pageJs
  });
}

// ═════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════
// 교육과정 관리 페이지 HTML
// ═════════════════════════════════════════════════════════════
function renderCoursesPage(classrooms) {
  const esc = layout.esc;

  const classroomOptions = classrooms.map(function(c) {
    return '<option value="' + esc(c.classroom_id) + '">' + esc(c.classroom_name) + ' (' + esc(c.classroom_code) + ')</option>';
  }).join('');

  const pageCss = `
  .cs-h1 { margin:0; font-size:32px; font-weight:800; letter-spacing:-0.025em; line-height:1.1; }
  .cs-lead { font-size:13px; font-weight:500; color:var(--sn-gray); margin-top:6px; }
  .cs-title { font-size:16px; font-weight:800; letter-spacing:-0.015em; }

  .cs-field { display:flex; flex-direction:column; gap:6px; margin:0; }
  .cs-field label { font-size:11.5px; font-weight:600; color:var(--sn-gray); }
  .cs-input, .cs-select {
    height:44px; width:100%; padding:0 12px;
    border:1.5px solid var(--sn-line); border-radius:12px; background:#fff;
    font-size:13px; font-weight:600; color:var(--sn-ink); outline:none;
    transition:border-color .15s ease;
  }
  .cs-input:focus, .cs-select:focus { border-color:var(--sn-navy); }
  .cs-area {
    width:100%; min-height:120px; padding:14px;
    border:1.5px solid var(--sn-line); border-radius:14px; background:#fff;
    font-size:12.5px; line-height:1.8; color:var(--sn-ink);
    outline:none; resize:vertical;
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  .cs-area:focus { border-color:var(--sn-navy); }

  .cs-tablewrap { background:#fff; border-radius:20px; padding:8px 20px 14px; overflow-x:auto; }
  table.cs-table { width:100%; border-collapse:collapse; }
  .cs-table th {
    text-align:left; padding:12px 10px; font-size:11.5px; font-weight:700;
    color:var(--sn-gray); letter-spacing:0.04em; border-bottom:1px solid var(--sn-line); white-space:nowrap;
  }
  .cs-table td { padding:11px 10px; border-bottom:1px solid var(--sn-line2); font-size:13px; }
  .cs-table tbody tr:hover { background:#f9fafb; }
  .cs-num { font-variant-numeric:tabular-nums; }
  .cs-mut { color:var(--sn-gray); font-size:12.5px; }

  .cs-tag { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11.5px; font-weight:700; white-space:nowrap; }
  .tg-모집과정 { background:#dce8f5; color:#003876; }
  .tg-위탁과정 { background:#e6f4ea; color:#137333; }
  .tg-산교연과정 { background:#fbe4d5; color:#9a5200; }

  .cs-mini {
    height:34px; padding:0 12px; border-radius:999px; border:1px solid var(--sn-line);
    background:#fff; font-size:11.5px; font-weight:700; cursor:pointer; white-space:nowrap;
    color:var(--sn-navy); transition:background .12s ease;
  }
  .cs-mini:hover { background:var(--sn-bg); }
  .cs-mini.red { background:var(--sn-red-bg); border-color:#f3cdcb; color:#c22525; }
  .cs-mini.red:hover { background:#f7cdcb; }

  .cs-day {
    display:inline-flex; align-items:center; justify-content:center;
    min-width:44px; height:40px; padding:0 10px; cursor:pointer;
    border:1.5px solid var(--sn-line); border-radius:12px; background:#fff;
    font-size:13px; font-weight:700; color:var(--sn-ink); user-select:none;
    transition:background .12s ease, border-color .12s ease, color .12s ease;
  }
  .cs-day input { display:none; }
  .cs-day.on { background:var(--sn-navy); border-color:var(--sn-navy); color:#fff; }

  .cs-sub {
    background:var(--sn-bg); border-radius:16px; padding:16px 18px; margin-top:14px;
  }
  .cs-info {
    background:#dce8f5; border-radius:14px; padding:13px 15px;
    font-size:12.5px; color:#003876; line-height:1.8;
  }
  .cs-info code {
    background:rgba(255,255,255,0.75); padding:2px 6px; border-radius:6px;
    font-size:11.5px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  .cs-empty { background:#fff; border-radius:20px; padding:34px 20px; text-align:center; color:var(--sn-gray); font-size:13.5px; font-weight:600; }
  .cs-editbox { background:var(--sn-bg); border-radius:16px; padding:18px; margin-top:14px; }
  `;

  const typeOptions = '<option value="">선택</option>'
    + ['모집과정', '위탁과정', '산교연과정'].map(function(t) {
        return '<option value="' + t + '">' + t + '</option>'; }).join('');

  const body =
      '<section class="sn-section">'
    +   '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;">'
    +     '<div>'
    +       '<h1 class="cs-h1">교육과정 관리</h1>'
    +       '<div class="cs-lead">교육과정 · 회차 · 강의실 관리</div>'
    +     '</div>'
    +     '<button type="button" class="sn-btn sn-btn-secondary" style="height:44px;" id="btnReload">새로고침</button>'
    +   '</div>'
    + '</section>'

    // ── 과정 목록 ──
    + '<section class="sn-section" style="padding-top:18px;">'
    +   '<div class="sn-head-row"><h2 class="sn-h2">과정 목록</h2><span class="sn-sub" id="courseCount"></span></div>'
    +   '<div id="courseList"><div class="cs-empty">불러오는 중…</div></div>'
    +   '<div id="courseEditArea"></div>'
    + '</section>'

    // ── 과정 추가 ──
    + '<section class="sn-section" style="padding-top:18px;">'
    +   '<div class="sn-card">'
    +     '<div class="cs-title">교육과정 추가</div>'
    +     '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:14px;">'
    +       '<div class="cs-field" style="grid-column:span 2;"><label for="cName">과정명 *</label>'
    +         '<input class="cs-input" type="text" id="cName" placeholder="영 오너스 최고경영자과정"></div>'
    +       '<div class="cs-field"><label for="cCode">약칭</label>'
    +         '<input class="cs-input" type="text" id="cCode" placeholder="YO"></div>'
    +       '<div class="cs-field"><label for="cType">종류</label>'
    +         '<select class="cs-select" id="cType">' + typeOptions + '</select></div>'
    +       '<div class="cs-field"><label for="cCohort">기수</label>'
    +         '<input class="cs-input" type="text" id="cCohort" placeholder="10"></div>'
    +       '<div class="cs-field"><label for="cRoom">기본 강의실</label>'
    +         '<select class="cs-select" id="cRoom"><option value="">선택</option>' + classroomOptions + '</select></div>'
    +       '<div class="cs-field"><label for="cTotal">총 회차</label>'
    +         '<input class="cs-input" type="number" id="cTotal" placeholder="15"></div>'
    +     '</div>'
    +     '<button type="button" class="sn-btn sn-btn-primary" style="height:44px;margin-top:14px;" id="btnAddCourse">과정 추가</button>'
    +   '</div>'
    + '</section>'

    // ── 회차 관리 ──
    + '<section class="sn-section" style="padding-top:18px;">'
    +   '<div class="sn-head-row"><h2 class="sn-h2">회차 관리</h2><span class="sn-sub" id="sessionCount"></span></div>'
    +   '<div class="sn-card" style="padding:16px 18px;">'
    +     '<div class="cs-field" style="max-width:420px;">'
    +       '<label for="sessionCourseSelect">과정 선택</label>'
    +       '<select class="cs-select" id="sessionCourseSelect"><option value="">-- 선택 --</option></select>'
    +     '</div>'
    +   '</div>'
    +   '<div id="sessionList" style="margin-top:14px;"></div>'
    +   '<div id="editFormArea"></div>'

    +   '<div id="sessionAddArea" style="display:none;margin-top:14px;">'
    +     '<div class="sn-grid" style="grid-template-columns:repeat(auto-fit,minmax(360px,1fr));">'

    +       '<div class="sn-card">'
    +         '<div class="cs-title">회차 일괄 추가</div>'
    +         '<div class="cs-mut" style="margin-top:6px;">규칙적인 요일·시간으로 반복되는 일정을 한 번에 만듭니다.</div>'
    +         '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-top:14px;">'
    +           '<div class="cs-field"><label for="sStartDate">시작일</label><input class="cs-input" type="date" id="sStartDate"></div>'
    +           '<div class="cs-field"><label for="sCount">회차 수</label><input class="cs-input" type="number" id="sCount" value="15" min="1" max="200"></div>'
    +           '<div class="cs-field"><label for="sWeekInterval">주 간격</label>'
    +             '<select class="cs-select" id="sWeekInterval"><option value="1" selected>매주</option><option value="2">격주</option></select></div>'
    +         '</div>'
    +         '<div class="cs-field" style="margin-top:12px;"><label>수업 요일 (복수 선택)</label>'
    +           '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;">'
    +             [['1','월'],['2','화'],['3','수'],['4','목'],['5','금'],['6','토']].map(function(d) {
                    return '<label class="cs-day' + (d[0] === '5' ? ' on' : '') + '">'
                      + '<input type="checkbox" class="dayCheck" value="' + d[0] + '"' + (d[0] === '5' ? ' checked' : '') + '>' + d[1] + '</label>';
                  }).join('')
    +           '</div>'
    +         '</div>'
    +         '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-top:12px;">'
    +           '<div class="cs-field"><label for="sStart">시작 시각</label><input class="cs-input" type="time" id="sStart" value="09:00"></div>'
    +           '<div class="cs-field"><label for="sEnd">종료 시각</label><input class="cs-input" type="time" id="sEnd" value="18:00"></div>'
    +           '<div class="cs-field"><label for="sLate">지각 기준</label><input class="cs-input" type="time" id="sLate" value="09:20"></div>'
    +           '<div class="cs-field"><label for="sEarly">조퇴 기준</label><input class="cs-input" type="time" id="sEarly" value="17:00"></div>'
    +         '</div>'
    +         '<button type="button" class="sn-btn sn-btn-primary" style="height:44px;margin-top:14px;" id="btnBulkSession">일괄 추가</button>'
    +       '</div>'

    +       '<div class="sn-card">'
    +         '<div class="cs-title">회차 자유 입력</div>'
    +         '<div class="cs-mut" style="margin-top:6px;">불규칙한 일정을 한 줄에 하나씩 직접 적습니다.</div>'
    +         '<div class="cs-info" style="margin-top:12px;">'
    +           '형식: <code>날짜 시작 종료 [지각기준 조퇴기준] [비고]</code><br>'
    +           '<code>2026-03-02 09:00 18:00</code><br>'
    +           '<code>2026-03-11 13:00 18:00 13:20 17:00</code><br>'
    +           '<code>2026-03-17 10:00 15:00 10:20 14:00 외부워크샵</code>'
    +         '</div>'
    +         '<textarea class="cs-area" id="freeSessionInput" style="margin-top:12px;" placeholder="2026-03-02 09:00 18:00&#10;2026-03-11 13:00 18:00 13:20 17:00 오후수업"></textarea>'
    +         '<div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap;">'
    +           '<button type="button" class="sn-btn sn-btn-primary" style="height:44px;" id="btnFreeSession">자유 입력 추가</button>'
    +           '<span class="cs-mut" id="freePreview"></span>'
    +         '</div>'
    +       '</div>'

    +     '</div>'
    +   '</div>'
    + '</section>'

    // ── 강의실 관리 ──
    + '<section class="sn-section" style="padding-top:18px;">'
    +   '<div class="sn-head-row"><h2 class="sn-h2">강의실 관리</h2></div>'
    +   '<div class="sn-card">'
    +     '<div id="classroomList"></div>'
    +     '<div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-top:14px;">'
    +       '<div class="cs-field" style="max-width:150px;"><label for="crCode">강의실 코드</label>'
    +         '<input class="cs-input" type="text" id="crCode" placeholder="ROOM_101"></div>'
    +       '<div class="cs-field" style="max-width:200px;"><label for="crName">강의실 이름</label>'
    +         '<input class="cs-input" type="text" id="crName" placeholder="101호 로렐"></div>'
    +       '<button type="button" class="sn-btn sn-btn-primary" style="height:44px;" id="btnAddRoom">강의실 추가</button>'
    +     '</div>'
    +   '</div>'
    + '</section>'

    + '<div id="snToast" style="position:fixed;left:50%;bottom:28px;transform:translateX(-50%);'
    +   'background:var(--sn-navy);color:#fff;font-size:13px;font-weight:700;padding:12px 20px;'
    +   'border-radius:999px;box-shadow:0 8px 24px rgba(0,56,118,0.25);opacity:0;pointer-events:none;'
    +   'transition:opacity .2s ease;z-index:120;max-width:88vw;text-align:center;"></div>';

  const pageJs = `
  var allCourses = [];
  var allClassrooms = [];
  var sessionMap = {};

  var toastTimer = null;
  function showToast(msg, bad) {
    var t = document.getElementById('snToast');
    if (!t) return;
    t.textContent = msg;
    t.style.background = bad ? '#D32F2F' : 'var(--sn-navy)';
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.style.opacity = '0'; }, 2600);
  }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function hhmm(t) { return t ? String(t).slice(0, 5) : '—'; }
  function dOnly(v) { return v ? String(v).split('T')[0] : '—'; }

  /* ── 과정 목록 ── */
  async function loadCourses() {
    var el = document.getElementById('courseList');
    el.innerHTML = '<div class="cs-empty">불러오는 중…</div>';
    try {
      var res = await fetch('/api/admin/courses');
      allCourses = await res.json();
    } catch (e) {
      el.innerHTML = '<div class="cs-empty">과정을 불러오지 못했습니다.</div>';
      return;
    }
    document.getElementById('courseCount').textContent = allCourses.length + '개 과정';
    if (!allCourses.length) {
      el.innerHTML = '<div class="cs-empty">등록된 과정이 없습니다.</div>';
      updateCourseSelect();
      return;
    }
    var rows = allCourses.map(function(c) {
      var tag = c.course_type
        ? '<span class="cs-tag tg-' + esc(c.course_type) + '">' + esc(c.course_type) + '</span>'
        : '<span class="cs-mut">—</span>';
      return '<tr>'
        + '<td style="font-weight:700;">' + esc(c.course_name) + '</td>'
        + '<td class="cs-mut">' + esc(c.course_code || '—') + '</td>'
        + '<td>' + tag + '</td>'
        + '<td class="cs-num">' + esc(c.cohort || '—') + '</td>'
        + '<td class="cs-mut">' + esc(c.default_room || '—') + '</td>'
        + '<td class="cs-num">' + esc(c.student_count) + '명</td>'
        + '<td class="cs-num">' + esc(c.session_count) + '회</td>'
        + '<td style="white-space:nowrap;">'
        +   '<button type="button" class="cs-mini" data-cact="edit" data-id="' + esc(c.course_id) + '">수정</button> '
        +   '<button type="button" class="cs-mini red" data-cact="del" data-id="' + esc(c.course_id) + '" data-name="' + esc(c.course_name) + '">삭제</button>'
        + '</td></tr>';
    }).join('');
    el.innerHTML = '<div class="cs-tablewrap"><table class="cs-table" style="min-width:820px;">'
      + '<thead><tr><th>과정명</th><th>약칭</th><th>종류</th><th>기수</th><th>강의실</th>'
      + '<th>수강생</th><th>회차</th><th style="width:150px;">관리</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>';
    updateCourseSelect();
  }

  function updateCourseSelect() {
    var sel = document.getElementById('sessionCourseSelect');
    var val = sel.value;
    sel.innerHTML = '<option value="">-- 선택 --</option>'
      + allCourses.map(function(c) {
          return '<option value="' + esc(c.course_id) + '">' + esc(c.course_name)
            + (c.cohort ? ' ' + esc(c.cohort) + '기' : '') + '</option>';
        }).join('');
    sel.value = val;
  }

  document.getElementById('btnReload').addEventListener('click', function() {
    loadCourses(); loadClassrooms();
    if (document.getElementById('sessionCourseSelect').value) loadSessionsForCourse();
    showToast('새로고침했습니다');
  });

  /* ── 과정 추가 ── */
  document.getElementById('btnAddCourse').addEventListener('click', async function() {
    var data = {
      course_name: document.getElementById('cName').value.trim(),
      course_code: document.getElementById('cCode').value.trim() || null,
      course_type: document.getElementById('cType').value || null,
      cohort: document.getElementById('cCohort').value.trim() || null,
      default_classroom_id: document.getElementById('cRoom').value || null,
      total_sessions: parseInt(document.getElementById('cTotal').value, 10) || null
    };
    if (!data.course_name) { showToast('과정명을 입력하세요', true); return; }
    try {
      var res = await fetch('/api/admin/courses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      var r = await res.json();
      if (r.success) {
        showToast('과정을 추가했습니다');
        ['cName','cCode','cCohort','cTotal'].forEach(function(id) { document.getElementById(id).value = ''; });
        document.getElementById('cType').value = '';
        document.getElementById('cRoom').value = '';
        loadCourses();
      } else showToast('추가 실패: ' + (r.error || ''), true);
    } catch (e) { showToast('추가 실패: ' + e.message, true); }
  });

  /* ── 과정 수정 / 삭제 ── */
  document.getElementById('courseList').addEventListener('click', function(ev) {
    var b = ev.target.closest('[data-cact]');
    if (!b) return;
    if (b.getAttribute('data-cact') === 'edit') editCourse(b.getAttribute('data-id'));
    else deleteCourse(b.getAttribute('data-id'), b.getAttribute('data-name'));
  });

  async function deleteCourse(id, name) {
    if (!confirm(name + ' 과정을 삭제합니다.\\n관련된 모든 회차·수강등록·출결 데이터가 함께 삭제됩니다.')) return;
    if (!confirm('되돌릴 수 없습니다. 정말 삭제할까요?')) return;
    try {
      var res = await fetch('/api/admin/courses/' + id, { method: 'DELETE' });
      var r = await res.json();
      if (r.success) { showToast(name + ' 과정을 삭제했습니다'); loadCourses(); }
      else showToast('삭제 실패: ' + (r.error || ''), true);
    } catch (e) { showToast('삭제 실패: ' + e.message, true); }
  }

  function editCourse(id) {
    var c = allCourses.filter(function(x) { return String(x.course_id) === String(id); })[0];
    if (!c) { showToast('과정 정보를 찾을 수 없습니다', true); return; }

    var roomOpts = '<option value="">선택</option>' + allClassrooms.map(function(r) {
      var sel = String(r.classroom_id) === String(c.default_classroom_id) ? ' selected' : '';
      return '<option value="' + esc(r.classroom_id) + '"' + sel + '>' + esc(r.classroom_name) + ' (' + esc(r.classroom_code) + ')</option>';
    }).join('');
    var typeOpts = '<option value="">선택</option>' + ['모집과정','위탁과정','산교연과정'].map(function(t) {
      return '<option value="' + t + '"' + (c.course_type === t ? ' selected' : '') + '>' + t + '</option>';
    }).join('');

    document.getElementById('courseEditArea').innerHTML =
        '<div class="cs-editbox">'
      +   '<div class="cs-title">과정 수정</div>'
      +   '<div class="cs-mut" style="margin-top:5px;">회차 일정과 출결 기록은 변경되지 않습니다.</div>'
      +   '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:14px;">'
      +     '<div class="cs-field" style="grid-column:span 2;"><label>과정명 *</label>'
      +       '<input class="cs-input" type="text" id="ec_name" value="' + esc(c.course_name || '') + '"></div>'
      +     '<div class="cs-field"><label>약칭</label>'
      +       '<input class="cs-input" type="text" id="ec_code" value="' + esc(c.course_code || '') + '"></div>'
      +     '<div class="cs-field"><label>종류</label><select class="cs-select" id="ec_type">' + typeOpts + '</select></div>'
      +     '<div class="cs-field"><label>기수</label>'
      +       '<input class="cs-input" type="text" id="ec_cohort" value="' + esc(c.cohort || '') + '"></div>'
      +     '<div class="cs-field"><label>기본 강의실</label><select class="cs-select" id="ec_room">' + roomOpts + '</select></div>'
      +     '<div class="cs-field"><label>총 회차</label>'
      +       '<input class="cs-input" type="number" id="ec_total" value="' + esc(c.total_sessions === null || c.total_sessions === undefined ? '' : c.total_sessions) + '"></div>'
      +   '</div>'
      +   '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">'
      +     '<button type="button" class="sn-btn sn-btn-primary" style="height:44px;" id="btnSaveCourse">저장</button>'
      +     '<button type="button" class="sn-btn sn-btn-secondary" style="height:44px;" id="btnCancelCourse">취소</button>'
      +   '</div>'
      + '</div>';

    document.getElementById('btnCancelCourse').addEventListener('click', function() {
      document.getElementById('courseEditArea').innerHTML = '';
    });
    document.getElementById('btnSaveCourse').addEventListener('click', function() { saveCourse(id); });
    document.getElementById('ec_name').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function saveCourse(id) {
    var name = document.getElementById('ec_name').value.trim();
    if (!name) { showToast('과정명을 입력하세요', true); return; }
    var data = {
      course_name: name,
      course_code: document.getElementById('ec_code').value.trim() || null,
      course_type: document.getElementById('ec_type').value || null,
      cohort: document.getElementById('ec_cohort').value.trim() || null,
      default_classroom_id: document.getElementById('ec_room').value || null,
      total_sessions: parseInt(document.getElementById('ec_total').value, 10) || null
    };
    try {
      var res = await fetch('/api/admin/courses/' + id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      var r = await res.json();
      if (r.success) {
        showToast('과정을 수정했습니다');
        document.getElementById('courseEditArea').innerHTML = '';
        loadCourses();
      } else showToast('수정 실패: ' + (r.error || ''), true);
    } catch (e) { showToast('수정 실패: ' + e.message, true); }
  }

  /* ── 회차 목록 ── */
  var sessSel = document.getElementById('sessionCourseSelect');
  sessSel.addEventListener('change', loadSessionsForCourse);

  async function loadSessionsForCourse() {
    var courseId = sessSel.value;
    var el = document.getElementById('sessionList');
    var addArea = document.getElementById('sessionAddArea');
    document.getElementById('editFormArea').innerHTML = '';
    if (!courseId) {
      el.innerHTML = '';
      addArea.style.display = 'none';
      document.getElementById('sessionCount').textContent = '';
      return;
    }
    addArea.style.display = '';
    el.innerHTML = '<div class="cs-empty">불러오는 중…</div>';
    var sessions;
    try {
      var res = await fetch('/api/admin/sessions/' + courseId);
      sessions = await res.json();
    } catch (e) {
      el.innerHTML = '<div class="cs-empty">회차를 불러오지 못했습니다.</div>';
      return;
    }
    sessionMap = {};
    sessions.forEach(function(s) { sessionMap[s.session_id] = s; });
    document.getElementById('sessionCount').textContent = sessions.length + '개 회차';
    if (!sessions.length) {
      el.innerHTML = '<div class="cs-empty">등록된 회차가 없습니다. 아래에서 추가하세요.</div>';
      return;
    }
    var rows = sessions.map(function(s) {
      return '<tr>'
        + '<td class="cs-num" style="font-weight:800;">' + esc(s.session_number) + '회</td>'
        + '<td class="cs-num">' + dOnly(s.session_date) + '</td>'
        + '<td class="cs-num">' + hhmm(s.start_time) + '~' + hhmm(s.end_time) + '</td>'
        + '<td class="cs-num cs-mut">' + hhmm(s.late_cutoff) + '</td>'
        + '<td class="cs-num cs-mut">' + hhmm(s.early_leave_cutoff) + '</td>'
        + '<td>' + (s.is_workshop ? '<span class="cs-tag tg-산교연과정">워크샵</span>' : '<span class="cs-mut">—</span>') + '</td>'
        + '<td class="cs-mut" style="max-width:160px;">' + esc(s.note || '') + '</td>'
        + '<td class="cs-num">' + esc(s.attendance_count) + '명</td>'
        + '<td style="white-space:nowrap;">'
        +   '<button type="button" class="cs-mini" data-sact="edit" data-id="' + esc(s.session_id) + '">수정</button> '
        +   '<button type="button" class="cs-mini red" data-sact="del" data-id="' + esc(s.session_id) + '" data-num="' + esc(s.session_number) + '">삭제</button>'
        + '</td></tr>';
    }).join('');
    el.innerHTML = '<div class="cs-tablewrap"><table class="cs-table" style="min-width:900px;">'
      + '<thead><tr><th style="width:64px;">회차</th><th>날짜</th><th>수업시간</th><th>지각 기준</th>'
      + '<th>조퇴 기준</th><th>워크샵</th><th>비고</th><th>출결</th><th style="width:150px;">관리</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>';
  }

  document.getElementById('sessionList').addEventListener('click', function(ev) {
    var b = ev.target.closest('[data-sact]');
    if (!b) return;
    if (b.getAttribute('data-sact') === 'edit') editSession(b.getAttribute('data-id'));
    else deleteSession(b.getAttribute('data-id'), b.getAttribute('data-num'));
  });

  function editSession(sid) {
    var s = sessionMap[sid];
    if (!s) return;
    document.getElementById('editFormArea').innerHTML =
        '<div class="cs-editbox">'
      +   '<div class="cs-title">' + esc(s.session_number) + '회차 수정</div>'
      +   '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-top:14px;">'
      +     '<div class="cs-field"><label>날짜</label><input class="cs-input" type="date" id="ed_date" value="' + (dOnly(s.session_date) === '—' ? '' : dOnly(s.session_date)) + '"></div>'
      +     '<div class="cs-field"><label>시작</label><input class="cs-input" type="time" id="ed_start" value="' + (s.start_time ? String(s.start_time).slice(0,5) : '') + '"></div>'
      +     '<div class="cs-field"><label>종료</label><input class="cs-input" type="time" id="ed_end" value="' + (s.end_time ? String(s.end_time).slice(0,5) : '') + '"></div>'
      +     '<div class="cs-field"><label>지각 기준</label><input class="cs-input" type="time" id="ed_late" value="' + (s.late_cutoff ? String(s.late_cutoff).slice(0,5) : '') + '"></div>'
      +     '<div class="cs-field"><label>조퇴 기준</label><input class="cs-input" type="time" id="ed_early" value="' + (s.early_leave_cutoff ? String(s.early_leave_cutoff).slice(0,5) : '') + '"></div>'
      +     '<div class="cs-field"><label>워크샵</label><select class="cs-select" id="ed_ws">'
      +       '<option value="false"' + (!s.is_workshop ? ' selected' : '') + '>아니오</option>'
      +       '<option value="true"' + (s.is_workshop ? ' selected' : '') + '>예</option></select></div>'
      +     '<div class="cs-field" style="grid-column:span 2;"><label>비고</label>'
      +       '<input class="cs-input" type="text" id="ed_note" value="' + esc(s.note || '') + '" placeholder="공휴일, 단체식사, 외부행사 등"></div>'
      +   '</div>'
      +   '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">'
      +     '<button type="button" class="sn-btn sn-btn-primary" style="height:44px;" id="btnSaveSession">저장</button>'
      +     '<button type="button" class="sn-btn sn-btn-secondary" style="height:44px;" id="btnCancelSession">취소</button>'
      +   '</div>'
      + '</div>';
    document.getElementById('btnCancelSession').addEventListener('click', function() {
      document.getElementById('editFormArea').innerHTML = '';
    });
    document.getElementById('btnSaveSession').addEventListener('click', function() { saveSession(sid); });
    document.getElementById('ed_date').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function saveSession(sid) {
    var data = {
      session_date: document.getElementById('ed_date').value,
      start_time: document.getElementById('ed_start').value,
      end_time: document.getElementById('ed_end').value,
      late_cutoff: document.getElementById('ed_late').value,
      early_leave_cutoff: document.getElementById('ed_early').value,
      is_workshop: document.getElementById('ed_ws').value === 'true',
      note: document.getElementById('ed_note').value.trim() || null
    };
    try {
      var res = await fetch('/api/admin/sessions/' + sid, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      var r = await res.json();
      if (r.success) { showToast('회차를 수정했습니다'); loadSessionsForCourse(); }
      else showToast('수정 실패: ' + (r.error || ''), true);
    } catch (e) { showToast('수정 실패: ' + e.message, true); }
  }

  async function deleteSession(sid, num) {
    if (!confirm(num + '회차를 삭제합니다.\\n해당 회차의 출결 데이터도 함께 삭제됩니다.')) return;
    try {
      var res = await fetch('/api/admin/sessions/' + sid, { method: 'DELETE' });
      var r = await res.json();
      if (r.success) { showToast(num + '회차를 삭제했습니다'); loadSessionsForCourse(); loadCourses(); }
      else showToast('삭제 실패: ' + (r.error || ''), true);
    } catch (e) { showToast('삭제 실패: ' + e.message, true); }
  }

  /* ── 요일 칩 ── */
  document.querySelectorAll('.cs-day').forEach(function(lb) {
    var cb = lb.querySelector('input');
    lb.addEventListener('click', function(ev) {
      ev.preventDefault();
      cb.checked = !cb.checked;
      lb.classList.toggle('on', cb.checked);
    });
  });

  /* ── 회차 일괄 추가 ── */
  document.getElementById('btnBulkSession').addEventListener('click', async function() {
    var courseId = sessSel.value;
    if (!courseId) { showToast('과정을 먼저 선택하세요', true); return; }
    var startDate = document.getElementById('sStartDate').value;
    var count = parseInt(document.getElementById('sCount').value, 10);
    var weekInterval = parseInt(document.getElementById('sWeekInterval').value, 10);
    var startTime = document.getElementById('sStart').value;
    var endTime = document.getElementById('sEnd').value;
    var lateCutoff = document.getElementById('sLate').value;
    var earlyCutoff = document.getElementById('sEarly').value;

    var selectedDays = [];
    document.querySelectorAll('.dayCheck:checked').forEach(function(cb) { selectedDays.push(parseInt(cb.value, 10)); });
    if (!startDate || !count) { showToast('시작일과 회차 수를 입력하세요', true); return; }
    if (!selectedDays.length) { showToast('수업 요일을 하나 이상 선택하세요', true); return; }

    var dayNames = ['일','월','화','수','목','금','토'];
    var sessions = [];
    var d = new Date(startDate + 'T00:00:00');
    var weekCount = 0, lastWeekNum = -1;
    for (var safety = 0; safety < 365 && sessions.length < count; safety++) {
      var jsDay = d.getDay();
      var ourDay = jsDay === 0 ? 7 : jsDay;
      var weekNum = Math.floor(safety / 7);
      if (weekNum !== lastWeekNum) { lastWeekNum = weekNum; weekCount++; }
      var isActiveWeek = weekInterval === 1 || (weekCount % 2 === 1);
      if (isActiveWeek && selectedDays.indexOf(ourDay) >= 0) {
        sessions.push({
          session_number: sessions.length + 1,
          session_date: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
          start_time: startTime, end_time: endTime,
          late_cutoff: lateCutoff, early_leave_cutoff: earlyCutoff
        });
      }
      d.setDate(d.getDate() + 1);
    }
    if (!sessions.length) { showToast('생성된 회차가 없습니다. 시작일과 요일을 확인하세요', true); return; }

    try {
      var ex = await fetch('/api/admin/sessions/' + courseId);
      var existing = await ex.json();
      var maxNum = existing.length ? Math.max.apply(null, existing.map(function(s) { return s.session_number; })) : 0;
      sessions.forEach(function(s, i) { s.session_number = maxNum + i + 1; });
    } catch (e) { /* 번호는 1부터 유지 */ }

    var names = selectedDays.map(function(x) { return dayNames[x]; }).join(',');
    if (!confirm(sessions.length + '개 회차를 추가합니다.\\n요일: ' + names + (weekInterval > 1 ? ' (격주)' : '')
      + '\\n기간: ' + sessions[0].session_date + ' ~ ' + sessions[sessions.length - 1].session_date)) return;

    try {
      var res = await fetch('/api/admin/sessions/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ course_id: courseId, sessions: sessions })
      });
      var r = await res.json();
      if (r.success) { showToast(r.added + '개 회차를 추가했습니다'); loadSessionsForCourse(); loadCourses(); }
      else showToast('추가 실패: ' + (r.error || ''), true);
    } catch (e) { showToast('추가 실패: ' + e.message, true); }
  });

  /* ── 회차 자유 입력 ── */
  function parseFree(text) {
    var out = [], errors = [];
    text.split('\\n').forEach(function(line, i) {
      if (!line.trim()) return;
      var p = line.trim().split(/\\s+/);
      if (p.length < 3) { errors.push((i + 1) + '번째 줄 — 날짜·시작·종료가 필요합니다'); return; }
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(p[0])) { errors.push((i + 1) + '번째 줄 — 날짜 형식 오류 (YYYY-MM-DD)'); return; }
      var s = {
        session_date: p[0], start_time: p[1], end_time: p[2],
        late_cutoff: p[3] || p[1], early_leave_cutoff: p[4] || p[2],
        is_workshop: false
      };
      if (p.length > 5) s.note = p.slice(5).join(' ');
      out.push(s);
    });
    return { list: out, errors: errors };
  }

  var freeEl = document.getElementById('freeSessionInput');
  freeEl.addEventListener('input', function() {
    var r = parseFree(freeEl.value);
    var el = document.getElementById('freePreview');
    if (r.errors.length) { el.textContent = '형식 오류 ' + r.errors.length + '건'; el.style.color = '#D32F2F'; }
    else { el.textContent = r.list.length ? (r.list.length + '개 회차 인식됨') : ''; el.style.color = ''; }
  });

  document.getElementById('btnFreeSession').addEventListener('click', async function() {
    var courseId = sessSel.value;
    if (!courseId) { showToast('과정을 먼저 선택하세요', true); return; }
    var parsed = parseFree(freeEl.value);
    if (parsed.errors.length) { alert('형식 오류:\\n' + parsed.errors.join('\\n')); return; }
    if (!parsed.list.length) { showToast('입력 내용이 없습니다', true); return; }

    var nextNum = 1;
    try {
      var ex = await fetch('/api/admin/sessions/' + courseId);
      var existing = await ex.json();
      nextNum = existing.length ? Math.max.apply(null, existing.map(function(s) { return s.session_number; })) + 1 : 1;
    } catch (e) { /* 1부터 */ }
    parsed.list.forEach(function(s) { s.session_number = nextNum++; });

    var preview = parsed.list.map(function(s) {
      return s.session_number + '회 ' + s.session_date + ' ' + s.start_time + '~' + s.end_time + (s.note ? ' (' + s.note + ')' : '');
    }).join('\\n');
    if (!confirm(parsed.list.length + '개 회차를 추가합니다:\\n\\n' + preview)) return;

    var added = 0;
    for (var i = 0; i < parsed.list.length; i++) {
      try {
        var body = { course_id: courseId };
        for (var k in parsed.list[i]) body[k] = parsed.list[i][k];
        var res = await fetch('/api/admin/sessions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        var r = await res.json();
        if (r.success) added++;
      } catch (e) { /* 건너뜀 */ }
    }
    showToast(added + '개 회차를 추가했습니다' + (added < parsed.list.length ? ' (' + (parsed.list.length - added) + '건 실패)' : ''),
      added < parsed.list.length);
    freeEl.value = '';
    document.getElementById('freePreview').textContent = '';
    loadSessionsForCourse();
    loadCourses();
  });

  /* ── 강의실 관리 ── */
  async function loadClassrooms() {
    try {
      var res = await fetch('/api/classrooms');
      allClassrooms = await res.json();
    } catch (e) { allClassrooms = []; }
    var el = document.getElementById('classroomList');
    if (!allClassrooms.length) {
      el.innerHTML = '<div class="cs-mut" style="padding:8px 0;">등록된 강의실이 없습니다.</div>';
      return;
    }
    el.innerHTML = '<div class="cs-tablewrap" style="padding:0;background:transparent;"><table class="cs-table" style="min-width:360px;">'
      + '<thead><tr><th style="width:150px;">코드</th><th>이름</th><th style="width:90px;">관리</th></tr></thead><tbody>'
      + allClassrooms.map(function(r) {
          return '<tr><td class="cs-num">' + esc(r.classroom_code) + '</td>'
            + '<td style="font-weight:700;">' + esc(r.classroom_name) + '</td>'
            + '<td><button type="button" class="cs-mini red" data-ract="del" data-id="' + esc(r.classroom_id) + '" data-name="' + esc(r.classroom_name) + '">삭제</button></td></tr>';
        }).join('')
      + '</tbody></table></div>';
  }

  document.getElementById('classroomList').addEventListener('click', async function(ev) {
    var b = ev.target.closest('[data-ract]');
    if (!b) return;
    var name = b.getAttribute('data-name');
    if (!confirm(name + ' 강의실을 삭제할까요?')) return;
    try {
      var res = await fetch('/api/admin/classrooms/' + b.getAttribute('data-id'), { method: 'DELETE' });
      var r = await res.json();
      if (r.success) { showToast(name + ' 강의실을 삭제했습니다'); loadClassrooms(); }
      else showToast('삭제 실패: ' + (r.error || ''), true);
    } catch (e) { showToast('삭제 실패: ' + e.message, true); }
  });

  document.getElementById('btnAddRoom').addEventListener('click', async function() {
    var code = document.getElementById('crCode').value.trim();
    var name = document.getElementById('crName').value.trim();
    if (!code || !name) { showToast('코드와 이름을 모두 입력하세요', true); return; }
    try {
      var res = await fetch('/api/admin/classrooms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classroom_code: code, classroom_name: name })
      });
      var r = await res.json();
      if (r.success) {
        showToast('강의실을 추가했습니다');
        document.getElementById('crCode').value = '';
        document.getElementById('crName').value = '';
        loadClassrooms();
      } else showToast('추가 실패: ' + (r.error || ''), true);
    } catch (e) { showToast('추가 실패: ' + e.message, true); }
  });

  loadCourses();
  loadClassrooms();
  `;

  return layout.renderShell({
    active: 'courses',
    title: '교육과정 관리',
    body: body,
    pageCss: pageCss,
    pageJs: pageJs
  });
}


function renderSyncPage(courses) {
  const esc = layout.esc;

  // 과정 드롭다운 + 클라이언트에서 쓸 과정 데이터
  const options = courses.map(function(c) {
    const label = c.course_name
      + (c.cohort ? ' ' + c.cohort + '기' : '')
      + (c.course_type ? ' [' + c.course_type + ']' : '');
    return '<option value="' + esc(c.course_id) + '">' + esc(label) + '</option>';
  }).join('');

  const courseData = JSON.stringify(courses.map(function(c) {
    return {
      id: String(c.course_id),
      name: c.course_name || '',
      cohort: c.cohort || '',
      type: c.course_type || '',
      sheet: c.spreadsheet_id || ''
    };
  })).replace(/</g, '\\u003c');

  const pageCss = `
  .sy-h1 { margin:0; font-size:32px; font-weight:800; letter-spacing:-0.025em; line-height:1.1; }
  .sy-lead { font-size:13px; font-weight:500; color:var(--sn-gray); margin-top:6px; }
  .sy-note { font-size:11.5px; color:var(--sn-gray); margin-top:10px; line-height:1.7; }
  .sy-note code { background:var(--sn-bg); padding:2px 6px; border-radius:6px; font-size:11px; }

  .sy-field { display:flex; flex-direction:column; gap:6px; margin:0; }
  .sy-field label { font-size:11.5px; font-weight:600; color:var(--sn-gray); }
  .sy-input, .sy-select {
    height:44px; width:100%; padding:0 14px;
    border:1.5px solid var(--sn-line); border-radius:12px; background:#fff;
    font-size:13px; font-weight:600; color:var(--sn-ink); outline:none;
    transition:border-color .15s ease;
  }
  .sy-input:focus, .sy-select:focus { border-color:var(--sn-navy); }
  .sy-input { font-size:12.5px; font-variant-numeric:tabular-nums; }

  .sy-chip {
    appearance:none; cursor:pointer; display:flex; flex-direction:column;
    align-items:center; justify-content:center; gap:1px;
    min-width:74px; padding:8px 12px; border-radius:14px;
    border:1.5px solid var(--sn-line); background:#fff; color:var(--sn-ink);
    transition:background .12s ease, border-color .12s ease, color .12s ease;
  }
  .sy-chip:hover { border-color:var(--sn-navy600); }
  .sy-chip.on { background:var(--sn-navy); border-color:var(--sn-navy); color:#fff; }
  .sy-chip .n { font-size:13px; font-weight:800; font-variant-numeric:tabular-nums; }
  .sy-chip .d { font-size:11px; font-weight:500; opacity:0.75; font-variant-numeric:tabular-nums; }

  .sy-btn-ghost {
    height:38px; padding:0 14px; border:none; border-radius:999px;
    background:#e8e8e8; color:#565656; font-size:12px; font-weight:700; cursor:pointer;
  }
  .sy-btn-ghost:hover { background:#dedede; }

  .sy-log-row {
    display:flex; gap:14px; padding:12px 0;
    border-bottom:1px solid var(--sn-line2); font-size:12.5px; align-items:flex-start;
  }
  .sy-log-row:last-child { border-bottom:none; }
  .sy-log-at { color:var(--sn-gray); font-variant-numeric:tabular-nums; min-width:62px; font-weight:600; }
  .sy-log-txt { font-weight:600; flex:1; }
  .sy-log-txt.ok { color:var(--sn-ink); }
  .sy-log-txt.bad { color:var(--sn-red); }
  .sy-log-txt.wait { color:var(--sn-navy600); }

  .sy-state { display:flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700; }
  .sy-state .dot { width:7px; height:7px; border-radius:50%; background:var(--sn-line); }
  .sy-state.set .dot { background:var(--sn-navy); }
  .sy-mini {
    display:flex; align-items:center; gap:8px; padding:9px 12px;
    background:var(--sn-bg); border-radius:12px; cursor:pointer; border:none;
    width:100%; text-align:left; transition:background .12s ease;
  }
  .sy-mini:hover { background:#eaebec; }
  `;

  const body =
      '<section class="sn-section">'
    +   '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;">'
    +     '<div>'
    +       '<h1 class="sy-h1">출석부 동기화</h1>'
    +       '<div class="sy-lead">과정별 출결 데이터를 구글시트로 내보내기</div>'
    +     '</div>'
    +     '<button type="button" class="sn-btn sn-btn-primary" style="height:44px;" id="btnSyncAll">모든 과정 전체 회차</button>'
    +   '</div>'

    +   '<div class="sn-card" style="padding:16px 18px;margin-top:18px;display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">'
    +     '<div class="sy-field" style="min-width:250px;flex:1;">'
    +       '<label for="courseSel">교육과정</label>'
    +       '<select class="sy-select" id="courseSel"><option value="">-- 과정 선택 --</option>' + options + '</select>'
    +     '</div>'
    +     '<div class="sy-field" style="min-width:300px;flex:2;">'
    +       '<label for="sheetId">출석부 구글시트 ID</label>'
    +       '<input class="sy-input" type="text" id="sheetId" placeholder="스프레드시트 ID 입력" autocomplete="off">'
    +     '</div>'
    +     '<button type="button" class="sn-btn sn-btn-secondary" style="height:44px;" id="btnSaveSheet">시트 ID 저장</button>'
    +   '</div>'
    +   '<div class="sy-note">'
    +     '시트 주소의 <strong>/d/</strong> 와 <strong>/edit</strong> 사이 값이 시트 ID입니다. '
    +     '<code>https://docs.google.com/spreadsheets/d/<strong>여기가_ID</strong>/edit</code><br>'
    +     '최초 1회, 서비스 계정 이메일을 해당 시트의 <strong>편집자</strong>로 공유해야 동기화됩니다.'
    +   '</div>'
    + '</section>'

    + '<section class="sn-section" style="padding-top:18px;">'
    +   '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:12px;flex-wrap:wrap;">'
    +     '<h2 class="sn-h2" style="font-size:16px;">동기화할 회차 선택</h2>'
    +     '<span class="sn-sub" id="pickCount">0개 선택</span>'
    +     '<div style="display:flex;gap:8px;margin-left:auto;flex-wrap:wrap;">'
    +       '<button type="button" class="sy-btn-ghost" id="btnSelAll">전체 선택</button>'
    +       '<button type="button" class="sy-btn-ghost" id="btnSelNone">선택 해제</button>'
    +       '<button type="button" class="sn-btn sn-btn-secondary" style="height:38px;font-size:12px;" id="btnSyncSel">선택 회차 동기화</button>'
    +       '<button type="button" class="sn-btn sn-btn-primary" style="height:38px;font-size:12px;" id="btnSyncCourse">이 과정 전체</button>'
    +     '</div>'
    +   '</div>'
    +   '<div class="sn-card" style="padding:16px 18px;">'
    +     '<div id="chips" style="display:flex;flex-wrap:wrap;gap:8px;">'
    +       '<div style="color:var(--sn-gray);font-size:13px;font-weight:600;padding:6px 2px;">위에서 과정을 먼저 선택하세요.</div>'
    +     '</div>'
    +     '<label style="display:inline-flex;align-items:center;gap:7px;margin-top:14px;font-size:12.5px;font-weight:600;color:var(--sn-gray);cursor:pointer;">'
    +       '<input type="checkbox" id="incSummary" checked style="width:16px;height:16px;accent-color:#003876;">출결요약 시트 포함'
    +     '</label>'
    +   '</div>'
    + '</section>'

    + '<section class="sn-section" style="padding-top:18px;">'
    +   '<div class="sn-grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));">'
    +     '<div class="sn-card">'
    +       '<div style="display:flex;align-items:center;gap:8px;">'
    +         '<div style="font-size:16px;font-weight:800;letter-spacing:-0.015em;">동기화 로그</div>'
    +         '<button type="button" class="sy-btn-ghost" style="height:32px;margin-left:auto;" id="btnClearLog">지우기</button>'
    +       '</div>'
    +       '<div id="log" style="margin-top:12px;display:flex;flex-direction:column;">'
    +         '<div style="color:var(--sn-gray);font-size:12.5px;font-weight:600;padding:8px 0;">아직 기록이 없습니다.</div>'
    +       '</div>'
    +     '</div>'
    +     '<div class="sn-card">'
    +       '<div style="font-size:16px;font-weight:800;letter-spacing:-0.015em;">과정별 시트 등록 현황</div>'
    +       '<div class="sy-note" style="margin-top:6px;">항목을 누르면 위에서 해당 과정이 선택됩니다.</div>'
    +       '<div id="sheetList" style="display:flex;flex-direction:column;gap:6px;margin-top:12px;"></div>'
    +     '</div>'
    +   '</div>'
    + '</section>'

    + '<div id="snToast" style="position:fixed;left:50%;bottom:28px;transform:translateX(-50%);'
    +   'background:var(--sn-navy);color:#fff;font-size:13px;font-weight:700;padding:12px 20px;'
    +   'border-radius:999px;box-shadow:0 8px 24px rgba(0,56,118,0.25);opacity:0;pointer-events:none;'
    +   'transition:opacity .2s ease;z-index:50;max-width:88vw;text-align:center;"></div>';

  const pageJs = `
  var COURSES = ${courseData};
  var picked = {};        // session_number -> true
  var sessions = [];      // 현재 과정의 회차 목록

  var selEl = document.getElementById('courseSel');
  var sheetEl = document.getElementById('sheetId');
  var chipsEl = document.getElementById('chips');
  var logEl = document.getElementById('log');

  /* ── 토스트 ── */
  var toastTimer = null;
  function showToast(msg, bad) {
    var t = document.getElementById('snToast');
    if (!t) return;
    t.textContent = msg;
    t.style.background = bad ? '#D32F2F' : 'var(--sn-navy)';
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.style.opacity = '0'; }, 2600);
  }

  /* ── 로그 ── */
  var logCount = 0;
  function addLog(text, kind) {
    if (logCount === 0) logEl.innerHTML = '';
    logCount++;
    var now = new Date();
    var at = String(now.getHours()).padStart(2, '0') + ':'
           + String(now.getMinutes()).padStart(2, '0') + ':'
           + String(now.getSeconds()).padStart(2, '0');
    var row = document.createElement('div');
    row.className = 'sy-log-row';
    var a = document.createElement('span'); a.className = 'sy-log-at'; a.textContent = at;
    var b = document.createElement('span'); b.className = 'sy-log-txt ' + (kind || 'ok'); b.textContent = text;
    row.appendChild(a); row.appendChild(b);
    logEl.insertBefore(row, logEl.firstChild);
    while (logEl.children.length > 40) logEl.removeChild(logEl.lastChild);
  }
  document.getElementById('btnClearLog').addEventListener('click', function() {
    logCount = 0;
    logEl.innerHTML = '<div style="color:var(--sn-gray);font-size:12.5px;font-weight:600;padding:8px 0;">아직 기록이 없습니다.</div>';
  });

  /* ── 과정별 시트 등록 현황 ── */
  function renderSheetList() {
    var wrap = document.getElementById('sheetList');
    wrap.innerHTML = '';
    COURSES.forEach(function(c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sy-mini';
      var label = c.name + (c.cohort ? ' ' + c.cohort + '기' : '');
      b.innerHTML = '<span style="font-size:12.5px;font-weight:700;">' + label.replace(/</g, '&lt;') + '</span>'
        + '<span class="sy-state' + (c.sheet ? ' set' : '') + '" style="margin-left:auto;color:'
        + (c.sheet ? 'var(--sn-navy)' : 'var(--sn-gray)') + ';"><span class="dot"></span>'
        + (c.sheet ? '등록됨' : '미등록') + '</span>';
      b.addEventListener('click', function() { selEl.value = c.id; onCourseChange(); });
      wrap.appendChild(b);
    });
  }

  function currentCourse() {
    var id = selEl.value;
    for (var i = 0; i < COURSES.length; i++) if (COURSES[i].id === id) return COURSES[i];
    return null;
  }
  function courseLabel(c) {
    return c ? (c.name + (c.cohort ? ' ' + c.cohort + '기' : '')) : '';
  }

  /* ── 회차 칩 ── */
  function updateCount() {
    var n = Object.keys(picked).length;
    document.getElementById('pickCount').textContent = n + '개 선택';
  }
  function renderChips() {
    chipsEl.innerHTML = '';
    if (!sessions.length) {
      chipsEl.innerHTML = '<div style="color:var(--sn-gray);font-size:13px;font-weight:600;padding:6px 2px;">등록된 회차가 없습니다.</div>';
      updateCount();
      return;
    }
    sessions.forEach(function(s) {
      var n = s.session_number;
      var d = s.session_date ? String(s.session_date).split('T')[0].slice(5).replace('-', '/') : '';
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sy-chip' + (picked[n] ? ' on' : '');
      b.innerHTML = '<span class="n">' + n + '회</span><span class="d">' + d + '</span>';
      b.addEventListener('click', function() {
        if (picked[n]) delete picked[n]; else picked[n] = true;
        b.classList.toggle('on');
        updateCount();
      });
      chipsEl.appendChild(b);
    });
    updateCount();
  }

  async function loadSessions() {
    var c = currentCourse();
    picked = {};
    if (!c) {
      sessions = [];
      chipsEl.innerHTML = '<div style="color:var(--sn-gray);font-size:13px;font-weight:600;padding:6px 2px;">위에서 과정을 먼저 선택하세요.</div>';
      updateCount();
      return;
    }
    chipsEl.innerHTML = '<div style="color:var(--sn-gray);font-size:13px;font-weight:600;padding:6px 2px;">불러오는 중…</div>';
    try {
      var res = await fetch('/api/admin/sessions/' + c.id);
      sessions = await res.json();
      renderChips();
    } catch (e) {
      sessions = [];
      chipsEl.innerHTML = '<div style="color:var(--sn-red);font-size:13px;font-weight:600;padding:6px 2px;">회차를 불러오지 못했습니다.</div>';
      updateCount();
    }
  }

  function onCourseChange() {
    var c = currentCourse();
    sheetEl.value = c ? c.sheet : '';
    loadSessions();
  }
  selEl.addEventListener('change', onCourseChange);

  document.getElementById('btnSelAll').addEventListener('click', function() {
    sessions.forEach(function(s) { picked[s.session_number] = true; });
    renderChips();
  });
  document.getElementById('btnSelNone').addEventListener('click', function() {
    picked = {};
    renderChips();
  });

  /* ── 시트 ID 저장 ── */
  document.getElementById('btnSaveSheet').addEventListener('click', async function() {
    var c = currentCourse();
    if (!c) { showToast('과정을 먼저 선택하세요', true); return; }
    var val = sheetEl.value.trim();
    try {
      var res = await fetch('/api/admin/course-sheet/' + c.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheetId: val })
      });
      if (res.ok) {
        c.sheet = val;
        renderSheetList();
        showToast(val ? '시트 ID 저장 완료' : '시트 ID를 비웠습니다');
        addLog(courseLabel(c) + ' — 시트 ID ' + (val ? '저장' : '삭제'), 'ok');
      } else {
        showToast('시트 ID 저장 실패', true);
        addLog(courseLabel(c) + ' — 시트 ID 저장 실패', 'bad');
      }
    } catch (e) {
      showToast('저장 실패: ' + e.message, true);
      addLog(courseLabel(c) + ' — 저장 오류: ' + e.message, 'bad');
    }
  });

  /* ── 동기화 ── */
  async function runSync(courseId, payload, label) {
    addLog(label + ' — 동기화 중…', 'wait');
    var opt = { method: 'POST' };
    if (payload) {
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(payload);
    }
    try {
      var res = await fetch('/api/admin/sync/' + courseId, opt);
      var data = await res.json();
      if (data.success) {
        var msg = label + ' — 완료 (' + (data.sheetsUpdated || 0) + '개 시트'
                + (data.studentsCount ? ', ' + data.studentsCount + '명' : '') + ')';
        if (data.formatResult && data.formatResult !== 'success') msg += ' · 색상 적용 경고: ' + data.formatResult;
        addLog(msg, 'ok');
        showToast('동기화 완료');
      } else {
        addLog(label + ' — 실패: ' + (data.error || '알 수 없는 오류'), 'bad');
        showToast('동기화 실패', true);
      }
    } catch (e) {
      addLog(label + ' — 오류: ' + e.message, 'bad');
      showToast('동기화 오류', true);
    }
  }

  document.getElementById('btnSyncCourse').addEventListener('click', function() {
    var c = currentCourse();
    if (!c) { showToast('과정을 먼저 선택하세요', true); return; }
    if (!c.sheet) { showToast('이 과정의 시트 ID가 없습니다', true); return; }
    runSync(c.id, null, courseLabel(c) + ' 전체');
  });

  document.getElementById('btnSyncSel').addEventListener('click', function() {
    var c = currentCourse();
    if (!c) { showToast('과정을 먼저 선택하세요', true); return; }
    if (!c.sheet) { showToast('이 과정의 시트 ID가 없습니다', true); return; }
    var nums = Object.keys(picked).map(Number).sort(function(a, b) { return a - b; });
    var inc = document.getElementById('incSummary').checked;
    if (!nums.length && !inc) { showToast('회차를 선택하거나 출결요약을 포함하세요', true); return; }
    runSync(c.id, { sessionNumbers: nums, includeSummary: inc },
      courseLabel(c) + ' ' + nums.length + '개 회차' + (inc ? ' + 요약' : ''));
  });

  document.getElementById('btnSyncAll').addEventListener('click', async function() {
    var withSheet = COURSES.filter(function(c) { return c.sheet; });
    if (!withSheet.length) { showToast('시트 ID가 등록된 과정이 없습니다', true); return; }
    if (!confirm('시트 ID가 등록된 ' + withSheet.length + '개 과정을 전체 동기화합니다. 진행할까요?')) return;
    addLog('전체 동기화 시작 (' + withSheet.length + '개 과정)', 'wait');
    try {
      var res = await fetch('/api/admin/sync-all', { method: 'POST' });
      var results = await res.json();
      var ok = 0, bad = 0;
      (results || []).forEach(function(r) {
        if (r.status === 'success') { ok++; addLog(r.courseName + ' — 완료', 'ok'); }
        else { bad++; addLog(r.courseName + ' — 실패: ' + (r.error || ''), 'bad'); }
      });
      addLog('전체 동기화 종료 · 성공 ' + ok + ' / 실패 ' + bad, bad ? 'bad' : 'ok');
      showToast('전체 동기화 완료 (성공 ' + ok + ', 실패 ' + bad + ')', bad > 0);
    } catch (e) {
      addLog('전체 동기화 오류: ' + e.message, 'bad');
      showToast('전체 동기화 오류', true);
    }
  });

  renderSheetList();
  `;

  return layout.renderShell({
    active: 'sync',
    title: '출석부 동기화',
    body: body,
    pageCss: pageCss,
    pageJs: pageJs
  });
}

// ═════════════════════════════════════════════════════════════
// 등록 QR 인쇄 페이지 HTML
// ═════════════════════════════════════════════════════════════
function renderRegPrintPage(course, cards) {
  const title = course.course_name + (course.cohort ? ' ' + course.cohort : '');
  const today = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>생체인증 등록 QR - ${title}</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Malgun Gothic', sans-serif; background: #f5f5f7; padding: 20px; }
    .header { text-align: center; margin-bottom: 24px; }
    .header h1 { font-size: 20px; }
    .header p { font-size: 13px; color: #555; margin-top: 4px; }
    .print-btn { display: inline-block; margin-top: 12px; padding: 10px 24px; background: #1a73e8; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
    .card { background: #fff; border: 1.5px solid #e5e5e7; border-radius: 12px; padding: 14px 10px; text-align: center; }
    .card .name { font-size: 15px; font-weight: 700; margin-bottom: 8px; word-break: keep-all; }
    .card canvas { border-radius: 4px; }
    .card .hint { font-size: 10px; color: #86868b; margin-top: 6px; line-height: 1.4; }
    @media print {
      body { background: #fff; padding: 0; }
      .header .print-btn { display: none; }
      .header { margin-bottom: 12px; }
      .grid { grid-template-columns: repeat(4, 1fr); gap: 8px; }
      .card { border: 1px solid #ccc; border-radius: 8px; padding: 10px 8px; break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="container"><div style="padding:14px 0 10px 0;"><img src="/logo.png" alt="연세대학교 상남경영원" style="height:52px;display:block;"></div>
  <div class="header">
    <h1>🔐 생체인증 등록 QR — ${title}</h1>
    <p>발급일: ${today} · 유효기간: 24시간 · 1회 사용 후 만료</p>
    <button class="print-btn" onclick="window.print()">🖨️ 인쇄하기</button>
  </div>
  <div class="grid" id="grid"></div>

  <script>
    const cards = ${JSON.stringify(cards)};
    const grid = document.getElementById('grid');

    cards.forEach(function(card) {
      const div = document.createElement('div');
      div.className = 'card';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = card.name;

      const canvas = document.createElement('canvas');
      canvas.id = 'qr-' + Math.random().toString(36).slice(2);

      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'QR 스캔 후 지문/Face ID 등록';

      div.appendChild(name);
      div.appendChild(canvas);
      div.appendChild(hint);
      grid.appendChild(div);

      new QRious({ element: canvas, value: card.url, size: 140, level: 'M', background: '#fff', foreground: '#000' });
    });
  </script>
</body>
</html>`;
}

module.exports = { registerAdminRoutes };
