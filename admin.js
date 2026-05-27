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
        "SELECT key, value FROM system_settings WHERE key IN ('building_lat','building_lng','building_radius','location_check_enabled')"
      );
      const s = {};
      for (const row of r.rows) s[row.key] = row.value;
      res.json({
        enabled:  s.location_check_enabled === 'true',
        lat:      s.building_lat  ? parseFloat(s.building_lat)  : null,
        lng:      s.building_lng  ? parseFloat(s.building_lng)  : null,
        radius:   s.building_radius ? parseInt(s.building_radius) : 200,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ API: 설정 저장 ═════════════════════════════════════════
  app.put('/api/admin/settings', async (req, res) => {
    try {
      const { lat, lng, radius, enabled } = req.body;
      const upsert = async (key, value) => db.query(`
        INSERT INTO system_settings (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
      `, [key, value == null ? null : String(value)]);

      await upsert('building_lat',           lat);
      await upsert('building_lng',           lng);
      await upsert('building_radius',        radius || 200);
      await upsert('location_check_enabled', enabled ? 'true' : 'false');
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}


// ═════════════════════════════════════════════════════════════
// 시스템 설정 페이지 HTML
// ═════════════════════════════════════════════════════════════
function renderSettingsPage() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>시스템 설정 - 관리자</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:-apple-system,'Malgun Gothic',sans-serif; background:#e4e5e6; color:#1d1d1f; padding:16px; }
    .container { max-width:700px; margin:0 auto; }
    h1 { font-size:22px; margin-bottom:4px; }
    .subtitle { color:#86868b; font-size:13px; margin-bottom:20px; }
    .card { background:#fff; border-radius:12px; padding:20px; margin-bottom:16px; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
    .card h2 { font-size:16px; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid #e5e5e7; }
    .form-row { display:flex; gap:8px; flex-wrap:wrap; align-items:end; margin-bottom:10px; }
    .form-group { display:flex; flex-direction:column; }
    .form-group label { font-size:11px; color:#86868b; margin-bottom:3px; }
    .form-group input { padding:8px 10px; border:1.5px solid #d2d2d7; border-radius:8px; font-size:13px; }
    .form-group input:focus { border-color:#1a73e8; outline:none; }
    .btn { padding:8px 16px; border:none; border-radius:8px; font-size:13px; cursor:pointer; background:#1a73e8; color:#fff; }
    .btn:hover { background:#1557b0; }
    .btn-outline { background:#fff; color:#1a73e8; border:1.5px solid #1a73e8; }
    .btn-success { background:#34c759; }
    .back-link { font-size:13px; color:#1a73e8; text-decoration:none; }
    .toggle-row { display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid #e5e5e7; margin-bottom:12px; }
    .toggle-switch { position:relative; width:51px; height:31px; }
    .toggle-switch input { opacity:0; width:0; height:0; }
    .toggle-slider { position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:#e5e5e7; border-radius:31px; transition:.3s; }
    .toggle-slider:before { content:""; position:absolute; height:27px; width:27px; left:2px; bottom:2px; background:#fff; border-radius:50%; transition:.3s; box-shadow:0 1px 3px rgba(0,0,0,0.2); }
    .toggle-switch input:checked + .toggle-slider { background:#34c759; }
    .toggle-switch input:checked + .toggle-slider:before { transform:translateX(20px); }
    .info-box { background:#e8f0fe; border-radius:8px; padding:14px 16px; font-size:13px; color:#1a73e8; line-height:1.8; margin-bottom:12px; }
    .warn-box { background:#fff3e0; border-radius:8px; padding:14px 16px; font-size:13px; color:#e65100; line-height:1.8; margin-top:12px; }
    #mapPreview { width:100%; height:200px; border-radius:10px; background:#e4e5e6; border:1.5px solid #e5e5e7; display:flex; align-items:center; justify-content:center; font-size:13px; color:#86868b; margin-top:10px; }
    #msg { font-size:13px; margin-top:8px; min-height:20px; }
  </style>
</head>
<body>
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:52px;display:block;"></div>
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALgAAAAwCAYAAACi0LByAAAp8klEQVR4nO18Z2BdxbXut2Z2OU3dcu82Fsi4yg1wLEwLLTZgjikGDDauwZjmEALcY6VBuNwQWmjBQKiRIHCJwQQMRhTbYORuuclyL7K6dNpus96PI9mygZDcmNy89/T9OVuzp62Zby+tWbNmgHa0ox3taEc72tGOdrSjHe1oRzva0Y52tKMd7fjfBTNTcXGxXLZsmbZs2TKNmWVxcbFkZvrf7ls72vE/QiQSEcuWLdMAfBeJqYX07WRvx78/UtqaZevfPp3AzF3ZbhpbVVV12Y6de64+dKjmUub4GczcxdSP8rq4mNu1ejv+YfzLCMPMgohUy3OPTdt3Xv3+yoqJX205cGpjwk2rizmIJx0ETAOZAYmcoN40NK/rhnPG9H9ryIA+rxLR/uPr+TtbphYxuSWBEA4LlJSoNmmp9JYCR/MUK2BhS3qRSuXhlqytv2CEwxIl+S11lRNQ4h1TZyRCKAKAoqPthcMiVaZIHZP3bwjyLel0TF9SDQqEywklbfvBAOjrdYTDKYVTclyfv6n9r+dtyR9pO0bfVm+qX4UQAIBSqCP5v7neE4J/CcGZWRKRx8zpayt23/VE8RezP193IHNvbQPyemTBsl11sLaJLzvzVGzaWYWyzfvF0AHdaPehRvTslI0xeZ3qr5047InheX3uI6JoMbOcTPQdgxERwM/VkTkPh2WKsN8wye34OxARxxD4m9IiEYGPIXAmFIq+I++3pp1YfO8EX7ZsmTZ+/HiXmc+47/kPnn1h8fq83EwTn62pdA1Do1mXjxaV++upcn8t+nXPRp8u2Vi2eieGndyVK/bWqlN6d+AlpZu1Tjk5mH7Z8M03hX9wAxF90Vrv35ArReSCmR1Q9nRN64vg4Gs6WqE+/fTmyr2JDS/vAwD0P9/0y8wc6TU40Yr3atPzw5nxDifnac07Dnh6p0wkGz1n/aKN6HtORsBIC8TtqAf2ERzLQXqGrWX0GSztQ1VMAU25Xrq79plVCIclPmnwBbNFbytj0H8JK/ZphlX+cLXtd/zBtA7K330QrOoKa81LFQCoV+FU07OyvzYflmlJ06r29q0sSXyToKH+4VxlQOrRg1bjns/qAUAbes3pTIF0z4t/ivX9Ejh1dW5AZVM8d1cNSkvbjpmQw6aOBwDPin+K8mKnoGCWdgDQpR5kq2mfRG4ucqs/tsvLy23f0GsLHSbTW7f7I+BoPXrBjwcJx4pa6/+wszVNDr3+XAJi7trnl7fOhz542qnsyzpTsWuZyT1LEhve3IdehT6Z1Ws8Kdnsrn/us7+HU/8IxImusC1aSejEai6f/sviD5eW7cqLxRvdnBw/TzhroGYfqJcvLVlLh2qa4LoKlfvrsfjTzbBsG29/tJ4amhKyoSmphdL9fPG4Pu6tv1tyyvRfl3zMyfpLxo8f77YsVI9DRABgbegNhWL0HeuFDFWK0bfvEMNnTQkOvqajAxqlNLncMdJuAACEi2WWcn1WeofFiaxTKgL54Y6ekDq7znJHZNzmsXrXM4JPAICW1vHUZFqvLSJn4G7R8aT9svOAsozoQV2x+sBFMOKS+YjSAksBwLezw1jZZ/DuROjkDz0j44eOmfbL2vRRFVpm39e9xqaQo6cvcWXmzSiMaACwLx5aeoCMmgMKhw8wag4wag4oVNU6mZUHuccfUn0NH1m/tDyTFQhdkMzKq2jOHfxsi+xgPWMKQp2XhIQeAIqUZnSdlszqVhGI5g0+UjbCAgBDZvwCWuZSKi+xAeK1jEiVL6f6gMLh2rQe22udzO3bgmc/b+b/qL+jpT3I/k5/xclaBgAYA689RYy5fa3SfCtdf8YWMeqWN8SwG+dpw2bexkb2u0pPf6Glt6wVzPmJCuauU3BnQ4j/sEMDNhpDp18I9AZkxiLlS3/jBNMPAPANBDkxKGaW44lcTjZeOO/xZcUv/3kFRgzv491y3Xjt/ueWoUtmAJdMGoNJ5w7F0AFd0bdbNgI+E/GkhV0H6/HVpr14q3QD/vz2V5h1fSF9teWA1jXL9LbtPuyb8dCHrzM3X0CU9kFxcbGcPHlyG/uxiIOnXtkp4ctdDPa2imT9ucqXficCuS8lLH8zBCmlXIb01QEAmj/V6iuXNooOgxqZRDBeXnKIANCo2xMMUgBZIJEEADOQvj1BvnThJl6DlL+HR17jns/qqeuYOoaKgr0QpK8GAGSyfotr0nr2ZY0XsUMvKi1wOsA9hNP4pGm7Na5reSCqQ2mRCzCRO/1nUJwFzwZkC4+VYkXyOSbR42sDXJklAHgkzRg0XxDMS1P/7iOCZbyClfIsX84FxrDpq6AFN3vSDNpk+lAY0dBcJ/HFIwAiDmTjLoYs0EfNnUhWbJ1y4695trleOfF6ksadbKSfTbaa6AR7h1n6GMqth/ITALjB7JdBsocW2zfINfwns6/zOyT0y5SX2MfScOFxEwAgvzDkmem/ISfx32rVI5cQABq9oNY10n+B3Q+9y7k37QSJrt8HD78XgrcuBJm57x2PvP3KU2+swL1zz+UPVu6QL73xBQb26YSfXHsmLjxjYNtS+GB5Oc49PR/5fTojv09nXHfxSHw4eSzuffJdbNhRhQduvkjurapT9z3ygcxJM15j5qFEtO/IwrMwIlFa5CbNrHEwAiGjcef85PoXvjAHh2+39QE/AtvFmpv4kPXQKwClzIG0Q25+fr6xhWgYlPeWMfT6ia6vwwwmacJjBwSCSplyKmlr8ANgbHSX/+enR7tOUcjgRRDCBPMhAOiSbGioDHYZxHbTq6rs8eu0IdeNUqGen3v+bE/ENnpQjmBhXCNHzTvJ82bNdcsWffJNY0mjbqkDtOPXDYSypx0A5Br+e8AeJIne/r7ndoxVFh0G32YCkIrkHwTjcQFnCcCOcO3q1AeFo2aKN1+yYeqeEsUkkz9xV7/wMICN+qCpBW6w02nCatiixWtvVcHsHM+z5rLQRqDRSqDXVB9L3zDY0UesDa9UAqikkbdsBSGeZlVNaoL4EEL6AADlHRM0IvkhdN/ZYvTN8wmiE0stW1hNb4mC2W97WnAQKXvvP8O5b8P3psFNXfKzb37yVMlHmzN65IbcVz7YoHXMDqJfn054/YEbjuRrjiWxdNU2/OKZ97Hm8y0YMS4f9954Hs4acRJCARNnjxyAs0eehKvvfQkvv7cGh+ui4uKz890PVu/LzvvvT58yNHFhSUlJytTqWM4AQJ67ixlwjLSLAHzu6FlnQ+gaCeNqj8yLUj6HFqVfUuJtHXr9xezLyhANFY+RMH0C0FJvidBmnUIiRTSGCCAclmjurOG9R61UTgKDgBZXZh1ggmQHkEpNsoAPmqmxrTpJGVNgUiC09arIr3kRwmGJ3XT8HBEQIf+wrV0so9sfAeSJ5n3zlBG6NdF5xK1GVt/LXRJJgCCSNSOc+opteqehkyEM3TF8z9HI+TUEYhgBIZNVf1JCOOQmyKz8pHc8GKo3Bl87wDMz5nq+nPnCie3TojU/cv2Zt7KecT17TgDsxZFh+rHthTrqNH8bjOAkf374PsufdgrrZh4DaPZ138F6iMhpXpvqcj77696/Opk59F5IbQ7YU8KquiU9uuONpqzBCwkqATrqPj6ROOE2eIvHREUbqieUfFZ5Tn5uwJ0xaYwmFYM9xs/nXIAln23Ew3/6BFOLXsWwa/4Ll934OPZUN+HsH43CjgP1mDjtUQy75re44Rev4rHiz/DXzzfjrqnjIQWhd5dMnHRSV23D6i3unz/fdYGVaDp/8uTJHjOnCBKJCHftM6sofvhh1tPukqNu3k5GxjNk1b6pe4mJ0k3eQ0p5bbSiyXrmg3DiNpvZT1jxyvXeygfPJ+V6ADTwN7jnjicmkMlu9B24yRUgCgFAXcV7TcJqvo2k71I58uYVyshdjGTdCrVvd0kiJy+NDL8kL/G69+WjU3Bxl+b8TZukNmreIlEw5ydGwdyJYvStJYUlJQSQC2rj/w8XC6BIuZT5UxCF9Oi+Qe6aZx7zvnion/CSfybXaYLiWiJA0wN12F2alF5yB6zGp8DYAqJ6Jq5hUJ3w7MNgtwbKa4rXlFWjN1ylB37HWmAKEnU/Uysf7GGVv1QRqt54j6qtHCi9xB8FKRearQAomai+GqyUldZjPcuM14STeNVoqDzJqNneWzhNqwRSDhLfyOqxydwzKlloYWZ0ZIapjPQ5DR1P2yYSDZvhJr4AKO1EcxH4HjT4woUL2dQlnlq89o6ln2/li8b1p2WrKlDflMCni+bhzDlPYv2X24GAmXJROw4W3HwRHrh5wpE6bn3oTfzumaWo2HYQz1ulgFIYVTgQbz94A0Ze/zBqapoxZ8oP6IMvd/PDxSsXGBq9t3DhwhTpiooUwOSV0S368Btf9KT/dLKjW1XZE+9bAPyDpnR3Q10k7Gg6EJbayC6LmWS2v7liRCLQ/TmRVbDNP6zr6QmiOMDHKgChMRguwYu3aNuUxh19uwuSARCZAB/xRbtrih7SB4U/YX+3cdKL7Zn41ZNvlQBex1691IFozlRmZwsKIxpKykX5wIUe7fp8LJHo7wpDQg9cvq1Ll6k44uSOCKAcKEmtNxxSt2Plg05mp8HB2hHzF3jCGA22DNeXeYVw45uMeM2IeDJ+GOGwTJY89Xlo6LVaMtB1sFK2D8wG7Ca4vpwzCaqzdKzFHbuP0feVlibc7tYk7FuZCPUfm5sYdcsvCaKgmeBIYItMVL/io6b5jeWnNQHvk7PhlTICeorhNy6ADEwEOMNN6/FrTnc3GYnqW9McZ101QElhbRUKN8G1bAkJ10z7I0FthZuYzSQ3Qug/PDKWJxgnlOBtbO9TLv/pC2cUDusBv67JTz7ZjF/cMRFZaUF4igFdBzQJ2B5GjOqPB26egBeXrMITz32Em2eci4duvRRLV+1Axe4aTDxrBN5Ysg6266FTdjrmTDoNJe+vRcmycplsjvNXWw+OsxzVn4gqWtpngDgnb0JavZ52D3nuHq/siUfBTCAAYipLu/kD8qKVqqBSAJ1rpF33g9iGkvJgnx9dlMztUwypWjaBjvWZK+UaEEJTSvupGHXbBBAEwC40Xyd243GItm7XIqUNn3WH58u6GZ5drbSA743Rtz8sALGXYEGYjcKqeRGlRV+m+kaMkfOqwKgGowZu0jl08GAcPeACsFILyFYvSkSgrMgxhl17SrXZ6R2C6CiU9Y6n+ACRN4CNjGmWq/0JsV0zUJnHAKukNucMZWb9CtGDOwCOAkKwp1yWRp4SxIlE/WyAgH0rE3LYjAlxf85r8JxqKPtDVmSDxHlOsNvtnpV+D1B0Hwpm6ijr4smCwz9WZubdcBNblfL2C8/RIbWpdqDnglqrfhqAEnzxbNXJwCtbRsx7g73kSmK1F8AW9eXDf1QARMFNXSE1/URysRUnlOAff/yxAKA+W7X5hzVRR0hBbk1zQut9UhdccfZQMDOUp3DVpaPwo3Gn4KEXSzFyYE94SmH6L0vgHGrEuqrXET57GEbm90A0lsSjt03A1p3VsCwXzIxZl56G/3yxFGMG9cTgAZ29VVuqteVrtp4HoKKlfRdgqt1KzTTyliEgGg30/wlohALKOLEOBwGc19pnF2VXpZ4iIrazqAo7UXhhOCzf2EM6GC1amj0AMG3Z7KDm54qMEAgmmAmsFAnfqSlrj9ss4JiEmPMXRbQHALXY5kwMRXaskxcMPMrC/xEAmCOm9nVG3TSKIXuCKBtsCxYh3Rx643UWoSNI+LRh08a5+T0+A0AohEAplJKB8zjYuY+sK7/OWbPoRSCl7rWRN7+lAp2uMTI6/8Iue3ob8DQUZh+CHUvK2opLnMp3NrbKL0fMe4VJTjRqm45oUNZ8s1kL+NMOLzurqWLZjiMTPGbBIaUb94SBB0rKnnIJxErMv5PBxvAvfze2DHA8AKEuAzrE+11RDem/A0AxIizKXz6JiLTzPc2fZUb3FZLu91od+5pdNYmhG9/Hjs8JJfjCjz8GAGw7WDt6865qDO6dhWRjHCf16IDcrDQwA7pG+OHpJ2HiuIFYVb4XayuqIIXApWeeipI3VuCy8QMhBWHv4UYcrG7C8vW7sLeqAd07Z4GIkJ0exEVjT0Hp8q34dHUlevTsgi17akYB+P3Cj4/tD7FKsC+9jxh50QEmSGAswPBI8xnSjT3prHpsAc6fZ+K9bKdlR00ApFbshUFSBNlFiIBsENcwgMb1v28AUeR4uWn0bdcLqA4MGYJye3NL6/ZX2Apg6/H5s7L6ZjQOnPIoSPkBQHlyFBnBJ6HcRkiZBWhnwHP32mb6owQ0gAwfhG8uioo+SS1GF3rAQjJ4VnEyun+KZ+a8IEbOn8nsNRCJ/koLnkyxg8/YesXOlKZ92oFS6dBMn5dz0irR4RaV+uBYsR4KkhNz7Jx0idqDAEDCS9yn7NiQWM7wtSLr1BXMcEjI4SDKFk7s5hLAQ8Esncvgak7sZ57m//2aMbfvFZ69GkQiTtpp8OxazYlFbIBQBAYqGCO9KPTAGXao21IwNDFyvgFB7JJMwLMaMKTwPKwrbUDbjbp/EieU4KVFRZ5PJ1Tuq+/To0MQfbpm0pKle3H++MFgAAwFKSXufvQ9PPKnz3GwNoba6iYs/XIr/vSr6/C7+T9Cl45ZeHdFOT75YjuULvD+lxWorY+hT/ecI+3065aNUtvC7Emn0ydr92LXwfp+hgRKi8a3KIGUaUHCnkewcpikRqJloaYUQwjSWGx3AGB0toP32sSIQNG+lZNtc0x0hqeSm0iKj8l1m20AWLiQUBhJmQnRg6n6Ql1YJurmCth7weQjxR2TRzwvkZS2jR4khLrwkd+95dDdptnE1noPICejsqQguv71mtCpErt2Qdf9nOyQJjo5WW5j4x7hOJ2od+9dbimYUAKVqj5C8bKnD/YHflA5Ys4lLM2xkvUQw9tE9qEZbtlznwFMCE8WKAM0TvxVRQ/NVgwJUtqRcbKijvBiTbW1g+PAVgIi5K4u+jTY99xhiZyTJxHJYUTQifCwaNz5tl1eUt5iIrkA4Kz9wx/N/PByL9TtEiaZD4Iidu/Wa7a+mdj+zv7U2oEYgKep+Fz2KBPwfAAECCpFDE9COUnVgGTLJJywcIoTvlWflebDtF+8uvHT9XsH9u2SqVau2SEicy/E9ReNAoMx8KoHsXnldsCnA0IAggBTw42XjcHoU3thxfqdWPTmSsBWqfeSgOYkhozuj7Uv3Q4AeOq/l+O3z3+EU/O6qa276sSEcQPWPrZg0rDmuPMPfvltYyG+/7iI/2vwTS7LVkQi4utxJv++OOFeFMUMn6HTl+v24Ms1O4CYBVNvaYaBggFd0cFvoGuXTPh9BkxDgxACTbEk3vx4A7LTA5hz5VgoxUgmHUQTNg4dqsdJfTuDmUFEMDUN2zbuw7bdtSDdxKRzBh5P6xTR+59vGhn9+9iJqkrk5iuUFikgAhQc9PndZFZiXdH+QH64s1Q+p3lLUa1ZcF0/obREQqyr9iG/S7LsxT2Bk6d0YdMWiXUl+9s2EBoazo3WIIp9+RbyywNBIYOxU7ya4FYzB4iB7YCMb3n5EHoVmr5gz47J8hf3mKNu6mOhvtbnBTOhXGKQrrNqjLoJEUQQrqAAea4LPyDiMScudQuJOs/v96dDy1JsK5n0GRQAnLh1UJmhHmmW4zagb309Skq8wMlTunihdL/11ROVof7hXDctNwAkkVyzaHfGkImZjVpAQ1+3HpVZwh9tyk2E0qtxcRcPRUUAwBmDLspsRAZQ8kq9b9jVvZJKb4RmxlBWr1CYTyhd6KGIlDlsen+dVWM0erDJH+zYwdN8abY0DwSa6oLxTLsBTpaL6CFfiJUZ9enC9PUN6l5zs4pV6/Gg04iaHGVmxLsI8ttK8/ngKEVSqeSaRbtPNB9PNMHJStps6iJOhg5NSjgJB4fqmlP/iZhxzqj+KKluwt6qRtQ0JRBN2EgmHTAzLj/rVPxp6XroUoPp0xDy68jNCCIz6MM5o/sDSPG4qi4K6BJ6wGRXSfglJyzbObYnY8J+3cq4l9zmbbo0Ak5p0Wp9+MwnHVV3L5ydcVvr86Y+YsZvXSvW6Eql68OndVLMjR6jQ0a0w7uxoP9hUTD7Q5Ws/4oRGAjgGW3EzB+Tq+qctX94zZLpE2Un41pvX1Gh5p/1fNJztqBk0T3W4GlXCM2fJURyt1Yw5zqzvuIqR8Pl5vAbLNgJZUI6xMlaRwauAewPSSVqND39EmU3v8p62lBP8/WXduMrtplxuYC+1NAbVir2zxB2wxeer9MFklWT5zZ+rBldrmam/w5Y9cl4Sck7WsGsM1zXHkW25erDb6hKQnYFqZDhJNeiV2FVwqKOmkz/0D3cuY/AoavcUOYUlD15gV/e2NUdPvNOZ/XT85IwszQ99JEYOP0CZUUnBDT1frzshTX68NmPak1770uEJ1fp268vYsVfOax6BAMdllkyeLfwEi+GrBokfFnTNCct1y178gZZMGuF4zTdrZNvgvKa1yAe2+r4MrtLMud7cscExV1ukMpZqaRxOnQ9l7zGpSiYWY2yp+MnkpAndKMnHC4WSZfRLSdtt2Ga0KXk9IwAVm/el/LQCQGlgHfeXY3la3Zh244qHDjYhLr9tfiPG8/G0z+7AvdMOxu1+2tw4FAjtu04jM/LduKdd1ennMGU8vSt2bofPr8JTRL7Aya6dsjcZXtAuLi4RZ4IYWW+xULP9aS/l5Oo3WQOu6Y/AWfomnsW1n8QI9jPM8tLlTR7e7qhFPnGOaufKzZk/ZswchpJJV8TrH7g6qFCZejLARC5zniWciIAllZ8O7GXKQumnQfl+Jl8ewGAiOuV5qtllfwE7Byws/r8TKjkCkcGoq5mjoed+Dix7o9vsjR3u7Ljn5La9jdBAolNr/5FKZQy8QFr/at/ZWlUkS+9Orn53d1uKOezxKY//8UTooJZrbXWv/YeG8FqVlq20tNaPCI0jyn4kbV+0aOe8IUVGcRE2cqNN2B3qWWbGYcJXoXWfGimdOIDmfkwAMXJ2FgwXYCCm3v+9LJBu6RKvqR8+t2CHfbFG3b4B03pTlDjPRKjtZ0dhivp72ivW/SW5reKEQwdZiE99pK50Vp7DwStYCDPHHzNWYKVx0bGLjKD+1loHRyvaZ8w01cI5a7TM/vdK4y0j+IbX31XudpKJrXLXvtKCQDna6T6J3FCCT53bi4BwOABnVZlZwTQp0smnzd+IN5ZvgVJO6WlJ501BJ3yu0PTJXSfCdgWfrfwCtxy5ZmoaYphwTVn4bf/EQaSNgy/AU2X6DaoJy4dNxjMjHjSwjufbcFZhadgRF5XZIb8GNI3twwA5ubmtgbeM0ZVhKRT82sIytMz+4eVMkZLzXiMGZeg11QfQWvUksk7WJo/BQuXINJz8qal2dzh/qg0zybpa3Jt7yaW+jxWIqQNmT6SGJ+DhDBGzM9zyWOw9wzgiwD620IaqZ04Ej6w5/N0XzfdSdzFTNmunjndd3jnX4n5U8+f8wDABEImRCINel8NhBAAYoE0QKQBEUHgBnKaTvYPmtJd2ImcFg9jOojTACYoTiNGFXG0IwAQ4TA072QUhDOkUnUQEABiSogaAKx73BNe4lkW8loSxn4PqEfetDQlAn1IN56UcGc/uqQixIpXsscveL6cO+qGpcWUMCaSlI8p6JfC85hAnTAm7Le9jCeTNucDgCLsTevg76GxaCLGYk8P/oSBtzzX6cdQAVKqRpMIsJvMF1bzA4pU0iM1EwCxVJlMlJIp1OWEx+qfUIKfeeaZCgBGDDxp6agBudi0frd8s3Qz6qsa8VbpBhAR0oM+zAufBrc+BieWwIN3XYb5k8fhr19sxpjL78fSr7bi1ivPxP0LJsBuTsBtiGH+FWMR9JsgIrz+0TpEa5qw9KtKfLp8mxydl8tDBvb/oE37Kfs7mqGYAhOJE38VqrGavHjnxJePPSXd+IFAqHEc2fGeSd+GQ/C86bqwyxmJhxoDYoZQVCYdd5NwYoNyVUWMlD2JhLI0LzrWX7/9eXJiryNx+HyNjK7CiVcC1t3Cbq4mqzYEAFLZzdKK2TIRPYnh9HWTdXMFvLfdzKzTJBxHwnkCBSM0YTfHjdhhXzDuppGy96FXoal5ni295GGgCAY3vUyu1dUT4nLNSZQCBGnH41LZUWCyEHZzAzsNnZRHAwHAsKO/JNfubnppU0y76SHpRBs1p2mfvfHPWwCAvFgfYSX9mmPdJThRpiu3xi8az5JeosI+8Ojj0kmkxZuTQwA1wFv71AfEPNfYZOSRckLWqieeJJU8RMnahPCsl0wnczorb6m0mg4J16oSrPdwSRvATtNAzWn6DOz9ipRVLbxER0o0J9hLBh0zM184TR0YnO+Ftt5FTvx9ACxV0pau1QBQyymff3cwEzOLB1/4YI0Y/VOljb3TxZD53PXChZywbPY8xfGkxUOvfoB/9fz7zMz83vJNLApuYQyYw7LgVn5vZTkzM0eeeZcLrn2Qk7bDSiluiiW4wzn3Mobfytrpd7ritLvU7175cAUzUyQS+e6P9WielKZvicX+VhTMPHZ3rW089t+H4/tEx/0e//yP4gQpqCNy0TE/rSgs/I612neOy4mS938frYcQGhrqrj5j7jOMAbOdHhN+yadd91sO3/U8MzMrpbg+GmVm5rc/Wc8df/gfPPq6B7lwzuN82tSHuNP5EX7n803MzNzQHGWlmJmZr4m8xGfOeJgDZ/6MkTfHKbzpD9zccHhy23bbgI4QslehD4WFGvLDRioA5ijSRv4452vlCgu1I5NaMFNHwUw9VRZoU56yCmZmHCkDEPqfbwIABl2dhcKpvqPvIqLlnTj60bT5ICMRARToKCjQgUgqT//zzdZDDakyBalyrX3r1ab+VJ2EXoW+I3W3vi8s1BAOSxQU6CmZIuKYMmOmZ6dkapUrIgBI5IdDxw5Lm3EruDiAgpmBY+RIjY9o0wbQf56J06elTLchUzPR9gPvPy81Vq1yto7dCcYJjyYcP368G2EWGRlZxdecNeCr9I4dtMKhPbzbry9ELGnjpvuLQUTIDAYRS1i4+4klqK6NYWh+Dwzsk4sB/TqiqqoRkafeQ8KykREKggiYdV8xvty0F8MH9sL9c8/1evXtpl05rv/KUEbu65EIi2OPr6Um0diRdadWMGtRbrxcM5r6P29KrztAKU08JuzXhk6/y3Xtq/ThNz7qG3h9j9Sh2IjM3p8IaM15f5Qj5j2Msqcd3fPuN/TAham6F5Jv4PU9jCFTF8QZC4zhN16KFieloVEvbcSPF+tm+qVGVN6RkzctLfWqSOnpXS/XCua8nhPd6EuRpWVzKRIRhUUfC33YsIelN+SXhSgSPtf7iR7qfCVKShTCxSLD3h/SRoz6ExX8+D6Ulrp6NO9+I53HtwjLvnhNV23kvMX+UPdBqaQi5Q81DdJG3vSReahz9+w1zUEDBY8Ha9NzWtpl3bGu1Ebe9IrpmpeYQ2+YAxAjXCxRsFhqw258Uvpzf6EXzPy1PuTGoQAIhWdKAKQNv3GM4WbeZnjOb/QhNw5slcPQfBdrBXMWp1eb6UCRQsFM3Qg23aFZ5lyt4Mdv+EibrQ+ZenVLl2GE6vppo2/5KNO1Omtbg/PNUOfpbebuhOF7ObI2sKSEiMidPWncjKmXFbiHG5P4cuNebo5aePy5jzDhtmewZVcVgn4Tq164FbMuG4WnXvoMv3/yA7zw+kr8+IozsHzRfPhNA2u378e5c3+Pp1/9HLt31+BwXVTtr47jh4V51uxw4QwiUgMHlhz3by81iba0FjHpJzf2mDgHil+3Nvy5EvkRHSUlnmZnL2Dd7JRY88xjTPo21x94BChSqIaoq/iyCU5yFUGF5fDZPyQvsZI1syUmo0g5hhzq6WnXWLs3/gYSm9Bi99tbDu9kcKeA1fRmIN7wYm3osIdI6lS+Yl+tEkKr3bq8GeGS1HExAPgYohSlrmtkHGYzs6oUcG0yK5mMbQAYlUtF44Z36uFayyXxdG3EvNNJuSsQ8Fe0SpvsWLufgVzZoVPqTGRhREtsenMVGHDTcvsngmlpSrkbYhv/UoX8sA4Aisw6QPisr37/HHuxDwEQKpcKlJU5nhawII2lTHqzktosAAxruA6AWfov8/TsXr6aLyKCk/FWMWwjc6fSfF5T+ft1raagzzn4hFDRtxVRx+TaZ+83PG1pqn8Lpb325XJ2rS3NHfLvhCS2lPtCahxP7CbS90Lw1vhsIlo7/9KhM7vm5sj/er5UfbqqQsnsDCxZsQ0Tb3sWNz/wOtZvP4An7pqM5a/cgp/MPR9fvnYHHrvzcqwu34NbH3wDc35djA07qqAFTTiC1CuLy3jf4WYZuXb0dCLayMxtj6y1glEYkVj1wiEm9YYnfFfY6xa9hXCxRG5qIaOEPhbk/wzhsHSlXKyE3g8AUA4XABEoSlbsYgjxc0/ooyTJBgBAOCy9Nc/+BfCWyn4Fy+G43DLJhP65glk4ST10b8KfeR7KFsdRUt5iOrkAw8K32qAKYI4BAJGy4SFlXqU8C0REtZobv4ShHmJWw4RnJY8U3QUN4Dgn3WNsYaXUkwDPYPadJVi9BwDIPZwiELHFrDrrw6b9Svmy0gAwGk2Rat/YRSRvgXLP8gznbiAisDLdApg8qUWY0Dva5exnLdeqbv2AdS3gElP0iHxlT7lN5e/Xsef4wBQDmGIbn60CAJQWeQDIi+6/E6ArIMTnWP9SDAifcD5+b4eOichbtmyZ1r9Pn+fuuXbkLZdfOEJCkdA8z73rhvFYOPtcbKg8hFGTfoPuF/8cv3ruI9RYDu55Ygm6XfxzjJn8n2iIJXHzVWMx7ZIRcONJV1meuPLikfK+GWNu6tat58vLli3T6Nuuj0id7iFS+g6QKAcAVC49Ii+xs5y8xBSUlHhCWWOFcrYAAAq6SgDMQmQ5659bA9e5G3r6LUlXSxGqpET5h1w1Ku+rJ37Knvui0oO/A4gRiRCMPQxiw/K5EXbrSs3B4T4I57cxnciHbwklkMquJeWMA0ASXj+SXlOb10zgjsm1zy+H5/xGacG7kk5985G3veGCECQ9mCJv6UIPYFLkvgnQ6Z4MDLfXPr8d4bBEx47cUqOphDjsrFn0My3RrOfkTUjDsENu6pWXpZS7REkZl5Y8AyhSCJcTQGzGDpyuVj1yriBhaL6cOUe27T1PMnHoqHwLU+sSGfRACKTiUY6YH6nQpK1vN8Oz9ko7UQOAgPx/bzfh8Rg/frwbiSzT+vfq9fBr9140+e5Z59TlZGVpz/3lK87JDLgH6+NKZgSx/0ADXFbQBNC9UwYO7DwMPSuE1dsOqrIt+9xN2/ajd/+e2k9nnF39ctHES3t27/145G9fGwHk5zMAJrepGylL9upV6ENZFy+lPZi8xt33EdvbtBGzF5Djnqxx8x1ARKDvUpWTNyGNJPUwB195lrf2maXkJBYYqMlsqZlZmub2oTc8SG4sxGw/BIBQVMQmDeghoOr0pHYVa5nTWQS1VgIIz80V7Fjdx4zxoyTc6s48os1canhBKKdJH3XTfUx82FnTtAkIS5QWeRlDJmayED39g6aM8dY8/Wep7Dv9IifQKqrvcE43waLaa9jZK5WysCXI6mlHKutBFpw6sV5ylECCnHTpOcIcPmuGpwfPr/V62SgpVoWFhZq0o7nCa5aGcucJQdNCQ6fkt4wnlJ7W1xgxO0JWrEzYib+0kpasQ/2ka3HGoIuyUFTEqQuQwMKzugp4jen54eyjlyelZA/khzuT1A+R9DrjBAZY/csRiaQ8HMzc563S9a9cec+L6pyb/sAYfCtjyHzGqfPci+Y/6Tzy2ofOPU8tdtB3pouh8xlDbuVuF93HkxY85/51RfkfmbknAES+8bqIb0FBgY7Uh/zNH/Ogq7O+nhiWRz0n37Lo6VXow+Brgse21eIhyZuQdtTrckw/6DsXUUe9L226E5YojGhHvCzHo7XdgoK//9BAq5eo1ctxFARAHOPVON7DkfKIHNuP1vqOd6W29umbXKytZb7TDfk/x7/MJ1lczHLy5JQ5wcwj3/hw9fVrNu87f31lVd+DDTZiMQs9u+eAAFRXN6F7bgCD+3bccebIfkvOGpW/iIjWHF/PP4nWK9w84G9cbQbg65GGTEfz/s0oxH8kupFSV7ylrn7424utfyTy8WtX1/0D+KaybWVv+/zviX+p0z0SiYjUFX1FrXcU+gDk7z2wN29vdaxrQ7NnSLh2ft/cAz26dt0CoJyILAAIh4tlcXFYpY6knVCcsOD6drQDQOrsZqvZ8l2IRJZpzPy9rhXa8f8u/le3TVuuQ6aWs5THoCWuhL8Hjd2OdrSjHe1oRzva0Y52tKMd7WhHO9rRjna0ox3t+P8H/wcB9lRrjAibfQAAAABJRU5ErkJggg==" alt="연세대학교 상남경영원" style="height:44px;display:block;"></div>
  <div style="padding:14px 20px 10px 20px;margin:-16px -16px 20px -16px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:46px;display:block;"></div>
  
<div class="container">
  <a href="/admin" class="back-link">← 대시보드로 돌아가기</a>
  <h1 style="margin-top:12px;">⚙️ 시스템 설정</h1>
  <p class="subtitle">퇴실 위치 검증 및 인증 설정</p>

  <div class="card">
    <h2>📍 건물 위치 설정</h2>
    <div class="info-box">
      퇴실 알림 탭 시 수강생의 위치를 확인합니다.<br>
      수강생이 지정한 건물 반경 안에 있을 때만 퇴실 처리됩니다.<br>
      <b>퇴실 처리 순서: 위치 확인 → 생체인증 → 퇴실 완료</b>
    </div>

    <div class="toggle-row">
      <div>
        <div style="font-size:15px;font-weight:500;">위치 검증 사용</div>
        <div style="font-size:12px;color:#86868b;">OFF 시 위치 확인 없이 생체인증만으로 퇴실 처리</div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="locationEnabled">
        <span class="toggle-slider"></span>
      </label>
    </div>

    <div class="form-row">
      <div class="form-group"><label>위도 (Latitude)</label><input type="number" id="lat" placeholder="37.123456" step="0.000001" style="width:150px;"></div>
      <div class="form-group"><label>경도 (Longitude)</label><input type="number" id="lng" placeholder="127.123456" step="0.000001" style="width:150px;"></div>
      <div class="form-group"><label>허용 반경 (미터)</label><input type="number" id="radius" placeholder="200" style="width:100px;" min="50" max="2000"></div>
    </div>

    <div class="form-row" style="gap:6px;">
      <button class="btn btn-outline" onclick="getMyLocation()">📍 현재 위치 가져오기</button>
      <button class="btn btn-success" onclick="saveSettings()">저장</button>
    </div>

    <div id="msg"></div>

    <div class="warn-box">
      <b>⚠️ 주의사항</b><br>
      - 실내 GPS 오차: 10~50m (건물 구조에 따라 다름)<br>
      - 반경은 건물 크기 + 여유 50~100m 추가 권장<br>
      - 위치 권한을 거부한 수강생은 퇴실 처리 불가<br>
      - 테스트 후 반경을 조정하세요
    </div>
  </div>
</div>

<script>
  window.addEventListener('load', loadSettings);

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings/building');
      const data = await res.json();
      document.getElementById('locationEnabled').checked = data.enabled;
      if (data.lat) document.getElementById('lat').value = data.lat;
      if (data.lng) document.getElementById('lng').value = data.lng;
      document.getElementById('radius').value = data.radius || 200;
    } catch (e) { console.error(e); }
  }

  function getMyLocation() {
    if (!navigator.geolocation) { alert('이 브라우저는 위치를 지원하지 않습니다.'); return; }
    document.getElementById('msg').innerHTML = '<span style="color:#1a73e8;">위치 확인 중...</span>';
    navigator.geolocation.getCurrentPosition(
      function(pos) {
        document.getElementById('lat').value = pos.coords.latitude.toFixed(6);
        document.getElementById('lng').value = pos.coords.longitude.toFixed(6);
        document.getElementById('msg').innerHTML = '<span style="color:#34c759;">✅ 현재 위치 적용 완료 (정확도: ' + Math.round(pos.coords.accuracy) + 'm)</span>';
      },
      function(err) {
        document.getElementById('msg').innerHTML = '<span style="color:#ff3b30;">위치 오류: ' + err.message + '</span>';
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function saveSettings() {
    const data = {
      lat:     parseFloat(document.getElementById('lat').value) || null,
      lng:     parseFloat(document.getElementById('lng').value) || null,
      radius:  parseInt(document.getElementById('radius').value) || 200,
      enabled: document.getElementById('locationEnabled').checked,
    };
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data)
      });
      const r = await res.json();
      document.getElementById('msg').innerHTML = r.success
        ? '<span style="color:#34c759;">✅ 저장 완료</span>'
        : '<span style="color:#ff3b30;">❌ 저장 실패</span>';
    } catch (e) {
      document.getElementById('msg').innerHTML = '<span style="color:#ff3b30;">❌ ' + e.message + '</span>';
    }
  }
</script>
</body>
</html>`;
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
    body { font-family: -apple-system, 'Malgun Gothic', sans-serif; background: #e4e5e6; color: #1d1d1f; padding: 16px; }
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
    .stat { background: #e4e5e6; border-radius: 8px; padding: 12px 16px; text-align: center; min-width: 80px; }
    .stat-num { font-size: 24px; font-weight: 700; }
    .stat-num.blue { color: #1a73e8; }
    .stat-num.green { color: #34c759; }
    .stat-num.orange { color: #ff9500; }
    .stat-num.red { color: #ff3b30; }
    .stat-label { font-size: 11px; color: #86868b; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 10px; background: #e4e5e6; color: #86868b; font-weight: 500; font-size: 12px; position: sticky; top: 0; }
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
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:52px;display:block;"></div>
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:44px;display:block;"></div>
  <div style="padding:14px 20px 10px 20px;margin:-16px -16px 20px -16px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:46px;display:block;"></div>
  
<div class="container">
  <a href="/admin" class="back-link">← 대시보드로 돌아가기</a>
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
      html += '</select> <button style="background:none;border:none;cursor:pointer;font-size:12px;color:#ff3b30;" onclick="resetAttendance(\\'' + s.attendance_id + '\\', \\'' + s.name + '\\', \\'' + sessionId + '\\')" title="출결 초기화">🗑</button></td>';
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

// ─── 출결 기록 초기화 ────────────────────────────────────
async function resetAttendance(attendanceId, name, sessionId) {
  if (!confirm(name + '의 출결 기록을 초기화하시겠습니까?\\n(입실/퇴실 기록이 삭제되고 다시 QR 스캔으로 입실할 수 있습니다)')) return;
  try {
    const res = await fetch('/api/admin/attendance/' + attendanceId, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      loadAttendance(sessionId);
    } else {
      alert('초기화 실패: ' + (data.error || ''));
    }
  } catch (err) {
    alert('오류: ' + err.message);
  }
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
// 수강생 관리 페이지 HTML
// ═════════════════════════════════════════════════════════════
function renderStudentsPage(courses) {
  const courseOptions = courses.map(c =>
    `<option value="${c.course_id}">${c.course_name} ${c.cohort || ''} [${c.course_type || ''}]</option>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>수강생 관리 - 관리자</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Malgun Gothic', sans-serif; background: #e4e5e6; color: #1d1d1f; padding: 16px; }
    .container { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .subtitle { color: #86868b; font-size: 13px; margin-bottom: 20px; }
    .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card h2 { font-size: 16px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #e5e5e7; }
    select { padding: 10px 14px; border: 1.5px solid #d2d2d7; border-radius: 10px; font-size: 14px; background: #fff; min-width: 250px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 10px; background: #e4e5e6; color: #86868b; font-weight: 500; font-size: 12px; }
    td { padding: 8px 10px; border-top: 1px solid #f0f0f0; }
    tr:hover { background: #fafafa; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
    .b-ok { background: #e6f4ea; color: #137333; }
    .b-no { background: #fce8e6; color: #c5221f; }
    .b-push { background: #e8f0fe; color: #1a73e8; }
    .btn { padding: 6px 12px; border: none; border-radius: 6px; font-size: 12px; cursor: pointer; background: #1a73e8; color: #fff; }
    .btn:hover { background: #1557b0; }
    .btn-small { padding: 4px 8px; font-size: 11px; }
    .btn-outline { background: #fff; color: #1a73e8; border: 1px solid #1a73e8; }
    .btn-danger { background: #ff3b30; color: #fff; }
    .btn-danger:hover { background: #d62d22; }
    textarea { width: 100%; min-height: 150px; padding: 12px; border: 1.5px solid #d2d2d7; border-radius: 10px; font-size: 13px; font-family: monospace; resize: vertical; }
    textarea:focus { border-color: #1a73e8; outline: none; }
    .back-link { font-size: 13px; color: #1a73e8; text-decoration: none; }
    .info-box { background: #e8f0fe; border-radius: 8px; padding: 14px 18px; margin-bottom: 16px; font-size: 13px; color: #1a73e8; line-height: 1.8; }
    .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
    .stat { background: #e4e5e6; border-radius: 8px; padding: 10px 14px; text-align: center; min-width: 70px; }
    .stat-num { font-size: 20px; font-weight: 700; }
    .stat-label { font-size: 11px; color: #86868b; margin-top: 2px; }
    #loading { text-align: center; padding: 20px; color: #86868b; }
    .mgmt-section { margin-top: 16px; }
    .mgmt-section input { padding: 8px 12px; border: 1.5px solid #d2d2d7; border-radius: 8px; font-size: 13px; font-family: monospace; width: 360px; }
  </style>
</head>
<body>
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:52px;display:block;"></div>
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:44px;display:block;"></div>
  <div style="padding:14px 20px 10px 20px;margin:-16px -16px 20px -16px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:46px;display:block;"></div>
  
<div class="container">
  <a href="/admin" class="back-link">← 대시보드로 돌아가기</a>
  <h1 style="margin-top:12px;">👥 수강생 관리</h1>
  <p class="subtitle">수강생 조회, 일괄 등록, 생체인증 현황</p>

  <div class="card" id="pendingCard" style="display:none;">
    <h2>⚠️ 재등록 승인 대기</h2>
    <p style="font-size:13px;color:#86868b;margin-bottom:12px;">이미 등록된 수강생이 재등록을 시도했습니다. 본인 확인 후 승인하세요.</p>
    <div id="pendingList"></div>
  </div>

  <div class="card">
    <h2>📋 수강생 조회</h2>
    <select id="courseSelect" onchange="loadStudents()">
      <option value="">-- 과정 선택 --</option>
      ${courseOptions}
    </select>
    <div id="studentList" style="margin-top:16px;"></div>
  </div>

  <div class="card">
    <h2>🕐 실시간 등록 현황 <span style="font-size:12px;color:#86868b;font-weight:400;">(최근 24시간 · 5초 자동 갱신)</span></h2>
    <div id="regLog" style="font-size:13px;min-height:40px;"></div>
  </div>

  <div class="card">
    <h2>📝 수강생 일괄 등록</h2>
    <div class="info-box">
      아래 텍스트 영역에 수강생 정보를 붙여넣거나 직접 입력하세요.<br>
      <b>형식: 이름[탭 또는 공백]전화번호</b> (한 줄에 한 명)<br>
      예시: 홍길동 01012345678 또는 홍길동 010-1234-5678<br>
      엑셀에서 이름/전화번호 열을 선택 → 복사(Ctrl+C) → 아래에 붙여넣기(Ctrl+V)도 가능
    </div>
    <select id="bulkCourseSelect" style="margin-bottom:12px;">
      <option value="">-- 등록할 과정 선택 --</option>
      ${courseOptions}
    </select><br>
    <textarea id="bulkInput" placeholder="홍길동 01012345678&#10;김철수 010-9876-5432&#10;..."></textarea>
    <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
      <button class="btn" onclick="bulkRegister()">일괄 등록</button>
      <span id="bulkResult" style="font-size:13px;"></span>
    </div>
  </div>

  <div class="card">
    <h2>📊 통합 관리 시트 (구글시트)</h2>
    <div class="info-box">
      전체 과정의 수강생 명단 + 생체인증 등록 여부 + 푸시 구독 여부를 하나의 구글시트로 내보냅니다.
    </div>
    <div class="mgmt-section">
      <input type="text" id="mgmtSheetId" placeholder="통합 관리용 스프레드시트 ID 입력">
      <button class="btn" onclick="syncManagement()" style="margin-left:8px;">동기화</button>
      <span id="mgmtResult" style="font-size:13px; margin-left:8px;"></span>
    </div>
  </div>
</div>

<script>
// ─── 수강생 목록 로드 ────────────────────────────────────
async function loadStudents() {
  const courseId = document.getElementById('courseSelect').value;
  const el = document.getElementById('studentList');
  if (!courseId) { el.innerHTML = ''; return; }

  el.innerHTML = '<div id="loading">불러오는 중...</div>';
  try {
    const res = await fetch('/api/admin/students/' + courseId);
    const students = await res.json();
    if (!Array.isArray(students)) { el.innerHTML = '<div class="msg msg-error">조회 실패: ' + (students.error || '알 수 없는 오류') + '</div>'; return; }

  const total = students.length;
  const bioOk = students.filter(s => s.has_credential).length;
  const bioNo = total - bioOk;
  const pushOk = students.filter(s => s.has_push).length;

  let html = '<div class="stats">';
  html += '<div class="stat"><div class="stat-num">' + total + '</div><div class="stat-label">전체</div></div>';
  html += '<div class="stat"><div class="stat-num" style="color:#34c759;">' + bioOk + '</div><div class="stat-label">생체인증 등록</div></div>';
  html += '<div class="stat"><div class="stat-num" style="color:#ff3b30;">' + bioNo + '</div><div class="stat-label">생체인증 미등록</div></div>';
  html += '<div class="stat"><div class="stat-num" style="color:#1a73e8;">' + pushOk + '</div><div class="stat-label">푸시 구독</div></div>';
  html += '</div>';

  html += '<div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;">';
  html += '<button class="btn btn-small" onclick="loadStudents()">🔄 새로고침</button>';
  html += '<button class="btn btn-small" style="background:#ff9500;" onclick="openRegPrint()">🖨️ 전체 등록링크 발급·인쇄</button>';
  html += '</div>';

  html += '<div style="overflow-x:auto;"><table>';
  html += '<tr><th>#</th><th>이름</th><th>전화번호</th><th>생체인증</th><th>마지막 인증</th><th>푸시</th><th>관리</th></tr>';

  students.forEach((s, i) => {
    const lastUsed = s.last_used_at ? new Date(s.last_used_at).toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul'}) : '-';
    html += '<tr>';
    html += '<td>' + (i + 1) + '</td>';
    html += '<td><b>' + s.name + '</b></td>';
    html += '<td style="font-size:12px;">' + s.phone + '</td>';
    html += '<td><span class="badge ' + (s.has_credential ? 'b-ok' : 'b-no') + '">' + (s.has_credential ? '등록(' + s.cred_count + ')' : '미등록') + '</span></td>';
    html += '<td style="font-size:12px;color:#86868b;">' + lastUsed + '</td>';
    html += '<td>' + (s.has_push ? '<span class="badge b-push">구독중</span>' : '<span style="color:#86868b;font-size:12px;">미구독</span>') + '</td>';
    html += '<td>';
    if (s.has_credential) {
      html += '<button class="btn btn-small btn-outline" onclick="resetCred(\\'' + s.student_id + '\\', \\'' + s.name + '\\')">인증초기화</button> ';
    }
    html += '<button class="btn btn-small" style="background:#34c759;color:#fff;" onclick="issueRegToken(\\'' + s.student_id + '\\', \\'' + s.name + '\\')">등록링크</button> ';
    html += '<button class="btn btn-small btn-danger" onclick="deactivateStudent(\\'' + s.student_id + '\\', \\'' + s.name + '\\')">삭제</button>';
    html += '</td>';
    html += '</tr>';
  });

  html += '</table></div>';
  el.innerHTML = html;
  } catch (err) {
    el.innerHTML = '<div class="msg msg-error">수강생 조회 오류: ' + err.message + '</div>';
  }
}

// ─── 일괄 등록 ───────────────────────────────────────────
async function bulkRegister() {
  const courseId = document.getElementById('bulkCourseSelect').value;
  const input = document.getElementById('bulkInput').value.trim();
  const resultEl = document.getElementById('bulkResult');

  if (!courseId) { resultEl.innerHTML = '<span style="color:#ff3b30;">과정을 선택하세요.</span>'; return; }
  if (!input) { resultEl.innerHTML = '<span style="color:#ff3b30;">수강생 정보를 입력하세요.</span>'; return; }

  const lines = input.split('\\n').filter(l => l.trim());
  const students = [];
  for (const line of lines) {
    // 전화번호 패턴 감지: 010으로 시작하는 숫자(하이픈 포함)
    const phoneMatch = line.match(/(01[016789][-\\s]?\\d{3,4}[-\\s]?\\d{4})/);
    if (phoneMatch) {
      const phone = phoneMatch[1].trim();
      const name = line.replace(phone, '').replace(/[,\\t]/g, '').trim();
      if (name) students.push({ name, phone });
    } else {
      // 전화번호 패턴 없으면 탭/쉼표/공백으로 분리 시도
      const parts = line.split(/\\t|,|\\s+/);
      if (parts.length >= 2) {
        students.push({ name: parts[0].trim(), phone: parts.slice(1).join('').trim() });
      }
    }
  }

  if (students.length === 0) { resultEl.innerHTML = '<span style="color:#ff3b30;">파싱 가능한 데이터가 없습니다.</span>'; return; }

  if (!confirm(students.length + '명을 등록하시겠습니까?')) return;

  resultEl.innerHTML = '<span style="color:#1a73e8;">등록 중...</span>';

  try {
    const res = await fetch('/api/admin/students/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId, students }),
    });
    const data = await res.json();
    if (data.success) {
      resultEl.innerHTML = '<span style="color:#34c759;">✅ ' + data.added + '명 등록 완료' + (data.skipped > 0 ? ' (' + data.skipped + '명 건너뜀)' : '') + '</span>';
      document.getElementById('bulkInput').value = '';
      // 같은 과정이 조회 중이면 자동 새로고침
      if (document.getElementById('courseSelect').value === courseId) {
        await loadStudents();
      }
    } else {
      resultEl.innerHTML = '<span style="color:#ff3b30;">❌ ' + (data.error || '실패') + '</span>';
    }
  } catch (err) {
    resultEl.innerHTML = '<span style="color:#ff3b30;">❌ ' + err.message + '</span>';
  }
}

// ─── 생체인증 초기화 ─────────────────────────────────────
async function resetCred(studentId, name) {
  if (!confirm(name + '의 생체인증 등록을 초기화하시겠습니까?\\n(재등록 링크가 자동 발급됩니다)')) return;
  try {
    const res = await fetch('/api/admin/credentials/' + studentId, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      alert('✅ 초기화 완료.\\n' + name + '님이 /register 에서 전화번호를 입력하면 바로 재등록할 수 있습니다. (24시간 유효)');
    } else {
      alert('초기화 실패: ' + (data.error || '알 수 없는 오류'));
    }
  } catch (err) { alert('초기화 오류: ' + err.message); }
  await loadStudents();
}

// ─── 실시간 등록 로그 폴링 ───────────────────────────────────
async function loadRegLog() {
  try {
    const res = await fetch('/api/admin/reg-log');
    const rows = await res.json();
    const el = document.getElementById('regLog');
    if (!el) return;
    if (!rows.length) { el.innerHTML = '<span style="color:#86868b;">최근 등록 내역이 없습니다.</span>'; return; }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<tr><th style="text-align:left;padding:6px 8px;background:#e4e5e6;font-size:12px;">이름</th><th style="text-align:left;padding:6px 8px;background:#e4e5e6;font-size:12px;">전화번호</th><th style="text-align:left;padding:6px 8px;background:#e4e5e6;font-size:12px;">등록 시각</th><th style="text-align:left;padding:6px 8px;background:#e4e5e6;font-size:12px;">상태</th></tr>';
    rows.forEach(function(r) {
      const t = new Date(r.registered_at).toLocaleTimeString('ko-KR', { timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', second:'2-digit' });
      const badge = r.type === 'pending'
        ? '<span style="background:#fff3cd;color:#856404;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">⚠️ 승인대기</span>'
        : '<span style="background:#e6f4ea;color:#137333;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">✅ 등록완료</span>';
      html += '<tr style="border-top:1px solid #f0f0f0;"><td style="padding:7px 8px;font-weight:600;">' + r.name + '</td><td style="padding:7px 8px;color:#86868b;">' + r.phone + '</td><td style="padding:7px 8px;">' + t + '</td><td style="padding:7px 8px;">' + badge + '</td></tr>';
    });
    html += '</table>';
    el.innerHTML = html;
  } catch(e) {}
}

// ─── 보류 등록 목록 로드 ─────────────────────────────────────
async function loadPending() {
  try {
    const res = await fetch('/api/admin/pending-creds');
    const rows = await res.json();
    const card = document.getElementById('pendingCard');
    const el = document.getElementById('pendingList');
    if (!card || !el) return;
    if (!rows.length) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<tr><th style="text-align:left;padding:6px 8px;background:#fff8e1;font-size:12px;">이름</th><th style="text-align:left;padding:6px 8px;background:#fff8e1;font-size:12px;">전화번호</th><th style="text-align:left;padding:6px 8px;background:#fff8e1;font-size:12px;">수강과정</th><th style="text-align:left;padding:6px 8px;background:#fff8e1;font-size:12px;">요청 시각</th><th style="padding:6px 8px;background:#fff8e1;font-size:12px;">처리</th></tr>';
    rows.forEach(function(r) {
      const t = new Date(r.requested_at).toLocaleTimeString('ko-KR', { timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit' });
      html += '<tr style="border-top:1px solid #f0f0f0;">';
      html += '<td style="padding:7px 8px;font-weight:600;">' + r.name + '</td>';
      html += '<td style="padding:7px 8px;color:#86868b;font-size:12px;">' + r.phone + '</td>';
      html += '<td style="padding:7px 8px;font-size:12px;">' + (r.courses || '-') + '</td>';
      html += '<td style="padding:7px 8px;">' + t + '</td>';
      html += '<td style="padding:7px 8px;white-space:nowrap;">';
      html += '<button class="btn btn-small" style="background:#34c759;margin-right:4px;" onclick="approvePending(\\'' + r.student_id + '\\', \\'' + r.name + '\\')">✅ 승인</button>';
      html += '<button class="btn btn-small btn-danger" onclick="rejectPending(\\'' + r.student_id + '\\', \\'' + r.name + '\\')">❌ 거부</button>';
      html += '</td></tr>';
    });
    html += '</table>';
    el.innerHTML = html;
  } catch(e) {}
}

async function approvePending(pendingId, name) {
  if (!confirm(name + '님의 재등록을 승인하시겠습니까?\\n기존 기기 인증이 해제되고 새 기기로 변경됩니다.')) return;
  const res = await fetch('/api/admin/pending-creds/' + pendingId + '/approve', { method: 'POST' });
  const data = await res.json();
  if (data.success) { alert('✅ ' + name + '님 재등록이 승인되었습니다.'); loadPending(); loadRegLog(); }
  else alert('오류: ' + data.error);
}

async function rejectPending(pendingId, name) {
  if (!confirm(name + '님의 재등록 요청을 거부하시겠습니까?\\n기존 등록이 유지됩니다.')) return;
  const res = await fetch('/api/admin/pending-creds/' + pendingId + '/reject', { method: 'POST' });
  const data = await res.json();
  if (data.success) { alert('❌ ' + name + '님 재등록이 거부되었습니다.'); loadPending(); }
  else alert('오류: ' + data.error);
}

// ─── 페이지 로드 시 폴링 시작 ────────────────────────────────
loadRegLog();
loadPending();
setInterval(function() { loadRegLog(); loadPending(); }, 5000);


// ─── 전체 등록링크 인쇄 페이지 열기 ─────────────────────────
function openRegPrint() {
  const courseId = document.getElementById('courseSelect').value;
  if (!courseId) { alert('먼저 과정을 선택하세요.'); return; }
  window.open('/admin/reg-print/' + courseId, '_blank');
}

// ─── 등록 링크 발급 ──────────────────────────────────────
async function issueRegToken(studentId, name) {
  try {
    const res = await fetch('/api/admin/reg-token/' + studentId, { method: 'POST' });
    const data = await res.json();
    if (data.error) { alert('발급 실패: ' + data.error); return; }

    const baseUrl = location.origin;
    const regUrl = baseUrl + '/register?token=' + data.token;

    // 모달 표시
    document.getElementById('regTokenName').textContent = name + '님 등록 링크';
    document.getElementById('regTokenUrl').value = regUrl;
    document.getElementById('regTokenModal').style.display = 'flex';

    // QR 코드 생성 (qrious 라이브러리 사용)
    if (window.QRious) {
      const qr = new QRious({ element: document.getElementById('regTokenQR'), value: regUrl, size: 200, level: 'M', background: '#fff', foreground: '#000' });
    } else {
      // qrious 없으면 동적 로드
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js';
      script.onload = () => {
        new QRious({ element: document.getElementById('regTokenQR'), value: regUrl, size: 200, level: 'M', background: '#fff', foreground: '#000' });
      };
      document.head.appendChild(script);
    }
  } catch (err) { alert('오류: ' + err.message); }
}

function copyRegUrl() {
  const url = document.getElementById('regTokenUrl').value;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.textContent = '✅ 복사됨';
    setTimeout(() => { btn.textContent = '복사'; }, 2000);
  });
}

// ─── 수강생 비활성화 ─────────────────────────────────────
async function deactivateStudent(studentId, name) {
  if (!confirm(name + '을(를) 이 과정에서 삭제하시겠습니까?')) return;
  const courseId = document.getElementById('courseSelect').value;
  if (!courseId) { alert('과정을 선택하세요.'); return; }
  try {
    const res = await fetch('/api/admin/students/' + studentId + '/' + courseId, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) { alert('삭제 실패: ' + (data.error || '')); }
  } catch (err) { alert('삭제 오류: ' + err.message); }
  await loadStudents();
}

// ─── 통합 관리 시트 동기화 ───────────────────────────────
async function syncManagement() {
  const sheetId = document.getElementById('mgmtSheetId').value.trim();
  const resultEl = document.getElementById('mgmtResult');
  if (!sheetId) { resultEl.innerHTML = '<span style="color:#ff3b30;">스프레드시트 ID를 입력하세요.</span>'; return; }

  resultEl.innerHTML = '<span style="color:#1a73e8;">동기화 중...</span>';
  try {
    const res = await fetch('/api/admin/sync-management', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spreadsheetId: sheetId }),
    });
    const data = await res.json();
    if (data.success) {
      resultEl.innerHTML = '<span style="color:#34c759;">✅ ' + data.count + '명 동기화 완료</span>';
    } else {
      resultEl.innerHTML = '<span style="color:#ff3b30;">❌ ' + (data.error || '실패') + '</span>';
    }
  } catch (err) {
    resultEl.innerHTML = '<span style="color:#ff3b30;">❌ ' + err.message + '</span>';
  }
}
</script>

<!-- 등록 링크 모달 -->
<div id="regTokenModal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center;">
  <div style="background:#fff;border-radius:16px;padding:28px 24px;max-width:420px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
    <div style="font-size:18px;font-weight:700;margin-bottom:4px;" id="regTokenName"></div>
    <div style="font-size:13px;color:#86868b;margin-bottom:16px;">24시간 유효 · 1회 사용 가능</div>
    <canvas id="regTokenQR" style="border-radius:8px;border:1px solid #e5e5e7;"></canvas>
    <div style="margin-top:14px;display:flex;gap:8px;">
      <input id="regTokenUrl" type="text" readonly style="flex:1;padding:10px;border:1px solid #d2d2d7;border-radius:8px;font-size:12px;color:#444;background:#e4e5e6;">
      <button id="copyBtn" onclick="copyRegUrl()" style="padding:10px 16px;background:#1a73e8;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;">복사</button>
    </div>
    <div style="font-size:12px;color:#86868b;margin-top:10px;line-height:1.6;">
      수강생이 이 QR을 스캔하거나 링크를 열면<br>본인 생체인증만 등록 가능합니다.
    </div>
    <button onclick="document.getElementById('regTokenModal').style.display='none'" style="margin-top:16px;width:100%;padding:12px;background:#e4e5e6;color:#1d1d1f;border:none;border-radius:8px;font-size:14px;cursor:pointer;">닫기</button>
  </div>
</div>
</body>
</html>`;
}

// ═════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════
// 교육과정 관리 페이지 HTML
// ═════════════════════════════════════════════════════════════
function renderCoursesPage(classrooms) {
  const classroomOptions = classrooms.map(c =>
    `<option value="${c.classroom_id}">${c.classroom_name} (${c.classroom_code})</option>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>교육과정 관리 - 관리자</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:-apple-system,'Malgun Gothic',sans-serif; background:#e4e5e6; color:#1d1d1f; padding:16px; }
    .container { max-width:1100px; margin:0 auto; }
    h1 { font-size:22px; margin-bottom:4px; }
    .subtitle { color:#86868b; font-size:13px; margin-bottom:20px; }
    .card { background:#fff; border-radius:12px; padding:20px; margin-bottom:16px; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
    .card h2 { font-size:16px; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid #e5e5e7; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th { text-align:left; padding:8px 10px; background:#e4e5e6; color:#86868b; font-weight:500; font-size:12px; }
    td { padding:8px 10px; border-top:1px solid #f0f0f0; }
    tr:hover { background:#fafafa; }
    .btn { padding:6px 12px; border:none; border-radius:6px; font-size:12px; cursor:pointer; background:#1a73e8; color:#fff; }
    .btn:hover { background:#1557b0; }
    .btn-small { padding:4px 8px; font-size:11px; }
    .btn-outline { background:#fff; color:#1a73e8; border:1px solid #1a73e8; }
    .btn-danger { background:#ff3b30; color:#fff; }
    .btn-success { background:#34c759; color:#fff; }
    .back-link { font-size:13px; color:#1a73e8; text-decoration:none; }
    .form-row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; align-items:end; }
    .form-group { display:flex; flex-direction:column; }
    .form-group label { font-size:11px; color:#86868b; margin-bottom:3px; }
    .form-group input, .form-group select { padding:8px 10px; border:1.5px solid #d2d2d7; border-radius:8px; font-size:13px; }
    .form-group input:focus, .form-group select:focus { border-color:#1a73e8; outline:none; }
    .badge { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; }
    .badge.blue { background:#e8f0fe; color:#1a73e8; }
    .badge.green { background:#e6f4ea; color:#137333; }
    .badge.orange { background:#fef3e0; color:#e37400; }
    .msg { font-size:13px; margin-top:6px; }
    .msg-ok { color:#34c759; } .msg-err { color:#ff3b30; }
    #loading { text-align:center; padding:20px; color:#86868b; }
    .session-row { display:flex; gap:6px; align-items:center; padding:6px 0; border-bottom:1px solid #f0f0f0; font-size:13px; }
    .session-row:last-child { border-bottom:none; }
  </style>
</head>
<body>
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:52px;display:block;"></div>
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:44px;display:block;"></div>
  <div style="padding:14px 20px 10px 20px;margin:-16px -16px 20px -16px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:46px;display:block;"></div>
  
<div class="container">
  <a href="/admin" class="back-link">← 대시보드로 돌아가기</a>
  <h1 style="margin-top:12px;">🏫 교육과정 관리</h1>
  <p class="subtitle">교육과정 추가/수정/삭제, 회차 관리, 강의실 관리</p>

  <!-- 과정 목록 -->
  <div class="card">
    <h2>📋 과정 목록 <button class="btn btn-small" onclick="loadCourses()" style="margin-left:8px;">🔄</button></h2>
    <div id="courseList"><div id="loading">불러오는 중...</div></div>
  </div>

  <!-- 과정 추가 -->
  <div class="card">
    <h2>➕ 과정 추가</h2>
    <div class="form-row">
      <div class="form-group"><label>과정명 *</label><input type="text" id="cName" placeholder="영 오너스 최고경영자과정" style="width:220px;"></div>
      <div class="form-group"><label>약칭</label><input type="text" id="cCode" placeholder="영오너스" style="width:100px;"></div>
      <div class="form-group"><label>종류</label>
        <select id="cType" style="width:120px;">
          <option value="">선택</option><option value="모집과정">모집과정</option><option value="위탁과정">위탁과정</option><option value="산교연과정">산교연과정</option>
        </select>
      </div>
      <div class="form-group"><label>기수</label><input type="text" id="cCohort" placeholder="10기" style="width:80px;"></div>
      <div class="form-group"><label>기본 강의실</label>
        <select id="cRoom" style="width:180px;"><option value="">선택</option>${classroomOptions}</select>
      </div>
      <div class="form-group"><label>총 회차</label><input type="number" id="cTotal" placeholder="15" style="width:70px;"></div>
      <button class="btn" onclick="addCourse()">추가</button>
    </div>
    <div id="addCourseMsg"></div>
  </div>

  <!-- 회차 관리 -->
  <div class="card">
    <h2>📅 회차 관리</h2>
    <div class="form-row">
      <div class="form-group"><label>과정 선택</label>
        <select id="sessionCourseSelect" onchange="loadSessionsForCourse()" style="width:300px;">
          <option value="">-- 선택 --</option>
        </select>
      </div>
    </div>
    <div id="sessionList"></div>

    <div id="sessionAddArea" style="display:none; margin-top:16px; padding-top:12px; border-top:1px solid #e5e5e7;">
      <b style="font-size:13px;">회차 일괄 추가</b>
      <div class="form-row" style="margin-top:8px;">
        <div class="form-group"><label>시작일</label><input type="date" id="sStartDate" style="width:140px;"></div>
        <div class="form-group"><label>회차 수</label><input type="number" id="sCount" value="15" style="width:70px;"></div>
        <div class="form-group"><label>주 간격</label>
          <select id="sWeekInterval" style="width:80px;"><option value="1" selected>매주</option><option value="2">격주</option></select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>수업 요일 (복수 선택)</label>
          <div style="display:flex;gap:4px;margin-top:2px;">
            <label style="font-size:13px;cursor:pointer;padding:4px 10px;border:1.5px solid #d2d2d7;border-radius:6px;"><input type="checkbox" class="dayCheck" value="1" style="margin-right:2px;">월</label>
            <label style="font-size:13px;cursor:pointer;padding:4px 10px;border:1.5px solid #d2d2d7;border-radius:6px;"><input type="checkbox" class="dayCheck" value="2" style="margin-right:2px;">화</label>
            <label style="font-size:13px;cursor:pointer;padding:4px 10px;border:1.5px solid #d2d2d7;border-radius:6px;"><input type="checkbox" class="dayCheck" value="3" style="margin-right:2px;">수</label>
            <label style="font-size:13px;cursor:pointer;padding:4px 10px;border:1.5px solid #d2d2d7;border-radius:6px;"><input type="checkbox" class="dayCheck" value="4" style="margin-right:2px;">목</label>
            <label style="font-size:13px;cursor:pointer;padding:4px 10px;border:1.5px solid #d2d2d7;border-radius:6px;"><input type="checkbox" class="dayCheck" value="5" checked style="margin-right:2px;">금</label>
            <label style="font-size:13px;cursor:pointer;padding:4px 10px;border:1.5px solid #d2d2d7;border-radius:6px;"><input type="checkbox" class="dayCheck" value="6" style="margin-right:2px;">토</label>
          </div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>시작 시각</label><input type="time" id="sStart" value="09:00" style="width:110px;"></div>
        <div class="form-group"><label>종료 시각</label><input type="time" id="sEnd" value="18:00" style="width:110px;"></div>
        <div class="form-group"><label>지각 기준</label><input type="time" id="sLate" value="09:20" style="width:110px;"></div>
        <div class="form-group"><label>조퇴 기준</label><input type="time" id="sEarly" value="17:00" style="width:110px;"></div>
        <button class="btn btn-success" onclick="bulkAddSessions()">일괄 추가</button>
      </div>
      <div id="sessionAddMsg"></div>

      <div style="margin-top:20px; padding-top:12px; border-top:1px solid #e5e5e7;">
        <b style="font-size:13px;">📝 자유 입력 (불규칙 일정용)</b>
        <div style="font-size:12px;color:#86868b;margin:6px 0 8px;">한 줄에 하나씩 입력. 형식: <code>날짜 시작시간 종료시간 [지각기준 조퇴기준] [비고]</code><br>
        예시:<br>
        <code>2026-03-02 09:00 18:00</code><br>
        <code>2026-03-11 13:00 18:00 13:20 17:00</code><br>
        <code>2026-03-17 10:00 15:00 10:20 14:00 외부워크샵</code></div>
        <textarea id="freeSessionInput" style="width:100%;min-height:100px;padding:10px;border:1.5px solid #d2d2d7;border-radius:8px;font-size:13px;font-family:monospace;" placeholder="2026-03-02 09:00 18:00&#10;2026-03-03 09:00 18:00&#10;2026-03-11 13:00 18:00 13:20 17:00 오후수업&#10;..."></textarea>
        <div style="margin-top:6px;"><button class="btn btn-success" onclick="freeAddSessions()">자유 입력 추가</button></div>
        <div id="freeSessionMsg"></div>
      </div>
    </div>
  </div>

  <!-- 강의실 관리 -->
  <div class="card">
    <h2>🚪 강의실 관리</h2>
    <div id="classroomList"></div>
    <div class="form-row" style="margin-top:12px;">
      <div class="form-group"><label>강의실 코드</label><input type="text" id="crCode" placeholder="R101" style="width:100px;"></div>
      <div class="form-group"><label>강의실 이름</label><input type="text" id="crName" placeholder="101호" style="width:150px;"></div>
      <button class="btn" onclick="addClassroom()">추가</button>
    </div>
    <div id="crMsg"></div>
  </div>
</div>

<script>
let allCourses = [];

window.addEventListener('load', function() { loadCourses(); loadClassrooms(); });

// ─── 과정 목록 ──────────────────────────────────────────
async function loadCourses() {
  const el = document.getElementById('courseList');
  el.innerHTML = '<div id="loading">불러오는 중...</div>';
  const res = await fetch('/api/admin/courses');
  allCourses = await res.json();

  if (allCourses.length === 0) { el.innerHTML = '<div style="color:#86868b;text-align:center;padding:20px;">등록된 과정이 없습니다.</div>'; updateCourseSelect(); return; }

  let html = '<table><tr><th>과정명</th><th>약칭</th><th>종류</th><th>기수</th><th>강의실</th><th>수강생</th><th>회차</th><th>관리</th></tr>';
  for (const c of allCourses) {
    html += '<tr>';
    html += '<td><b>' + c.course_name + '</b></td>';
    html += '<td>' + (c.course_code || '-') + '</td>';
    html += '<td>' + (c.course_type ? '<span class="badge ' + (c.course_type==='모집과정'?'blue':c.course_type==='위탁과정'?'green':'orange') + '">' + c.course_type + '</span>' : '-') + '</td>';
    html += '<td>' + (c.cohort || '-') + '</td>';
    html += '<td>' + (c.default_room || '-') + '</td>';
    html += '<td>' + c.student_count + '명</td>';
    html += '<td>' + c.session_count + '회</td>';
    html += '<td><button class="btn btn-small btn-danger" onclick="deleteCourse(\\'' + c.course_id + '\\', \\'' + c.course_name + '\\')">삭제</button></td>';
    html += '</tr>';
  }
  html += '</table>';
  el.innerHTML = html;
  updateCourseSelect();
}

function updateCourseSelect() {
  const sel = document.getElementById('sessionCourseSelect');
  const val = sel.value;
  sel.innerHTML = '<option value="">-- 선택 --</option>';
  for (const c of allCourses) {
    sel.innerHTML += '<option value="' + c.course_id + '">' + c.course_name + ' ' + (c.cohort||'') + '</option>';
  }
  sel.value = val;
}

async function addCourse() {
  const data = {
    course_name: document.getElementById('cName').value.trim(),
    course_code: document.getElementById('cCode').value.trim(),
    course_type: document.getElementById('cType').value,
    cohort: document.getElementById('cCohort').value.trim(),
    default_classroom_id: document.getElementById('cRoom').value || null,
    total_sessions: parseInt(document.getElementById('cTotal').value) || null,
  };
  if (!data.course_name) { document.getElementById('addCourseMsg').innerHTML = '<div class="msg msg-err">과정명을 입력하세요.</div>'; return; }

  const res = await fetch('/api/admin/courses', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
  const r = await res.json();
  if (r.success) {
    document.getElementById('addCourseMsg').innerHTML = '<div class="msg msg-ok">✅ 추가 완료</div>';
    document.getElementById('cName').value = '';
    document.getElementById('cCode').value = '';
    document.getElementById('cCohort').value = '';
    document.getElementById('cTotal').value = '';
    await loadCourses();
  } else {
    document.getElementById('addCourseMsg').innerHTML = '<div class="msg msg-err">❌ ' + (r.error||'실패') + '</div>';
  }
}

async function deleteCourse(courseId, name) {
  if (!confirm(name + ' 과정을 삭제하시겠습니까?\\n관련된 모든 회차, 수강등록, 출결 데이터가 함께 삭제됩니다.')) return;
  if (!confirm('정말로 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
  const res = await fetch('/api/admin/courses/' + courseId, { method:'DELETE' });
  const r = await res.json();
  if (r.success) { await loadCourses(); } else { alert('삭제 실패: ' + (r.error||'')); }
}

// ─── 회차 관리 ──────────────────────────────────────────
async function loadSessionsForCourse() {
  const courseId = document.getElementById('sessionCourseSelect').value;
  const el = document.getElementById('sessionList');
  const addArea = document.getElementById('sessionAddArea');
  if (!courseId) { el.innerHTML = ''; addArea.style.display = 'none'; return; }

  addArea.style.display = 'block';
  el.innerHTML = '<div id="loading">불러오는 중...</div>';
  const res = await fetch('/api/admin/sessions/' + courseId);
  const sessions = await res.json();
  window._sessions = {};
  for (const s of sessions) { window._sessions[s.session_id] = s; }

  if (sessions.length === 0) { el.innerHTML = '<div style="color:#86868b;padding:10px;">등록된 회차가 없습니다.</div>'; return; }

  let html = '<div style="margin-bottom:8px;"><button class="btn btn-small" onclick="loadSessionsForCourse()">🔄 새로고침</button></div>';
  html += '<div style="overflow-x:auto;"><table><tr><th>회차</th><th>날짜</th><th>시간</th><th>지각</th><th>조퇴</th><th>워크샵</th><th>비고</th><th>출결</th><th>관리</th></tr>';
  for (const s of sessions) {
    const date = s.session_date ? s.session_date.split('T')[0] : '-';
    const start = s.start_time ? s.start_time.slice(0,5) : '-';
    const end = s.end_time ? s.end_time.slice(0,5) : '-';
    const late = s.late_cutoff ? s.late_cutoff.slice(0,5) : '-';
    const early = s.early_leave_cutoff ? s.early_leave_cutoff.slice(0,5) : '-';
    html += '<tr>';
    html += '<td style="font-weight:600;">' + s.session_number + '회</td>';
    html += '<td>' + date + '</td>';
    html += '<td>' + start + '~' + end + '</td>';
    html += '<td>' + late + '</td>';
    html += '<td>' + early + '</td>';
    html += '<td>' + (s.is_workshop ? '🏕️' : '-') + '</td>';
    html += '<td style="font-size:12px;color:#86868b;max-width:120px;">' + (s.note || '') + '</td>';
    html += '<td style="color:#1a73e8;">' + s.attendance_count + '명</td>';
    html += '<td style="white-space:nowrap;">';
    html += '<button class="btn btn-small btn-outline" onclick="editSession(\\'' + s.session_id + '\\')">수정</button> ';
    html += '<button class="btn btn-small btn-danger" onclick="deleteSession(\\'' + s.session_id + '\\', ' + s.session_number + ')">삭제</button>';
    html += '</td></tr>';
  }
  html += '</table></div>';
  html += '<div id="editFormArea"></div>';
  el.innerHTML = html;
}

function editSession(sessionId) {
  const s = window._sessions[sessionId];
  if (!s) return;
  const date = s.session_date ? s.session_date.split('T')[0] : '';
  const start = s.start_time ? s.start_time.slice(0,5) : '';
  const end = s.end_time ? s.end_time.slice(0,5) : '';
  const late = s.late_cutoff ? s.late_cutoff.slice(0,5) : '';
  const early = s.early_leave_cutoff ? s.early_leave_cutoff.slice(0,5) : '';

  let html = '<div style="background:#e4e5e6;padding:16px;border-radius:10px;margin-top:12px;">';
  html += '<b>' + s.session_number + '회차 수정</b><br><br>';
  html += '<div class="form-row">';
  html += '<div class="form-group"><label>날짜</label><input type="date" id="ed_date" value="' + date + '" style="width:140px;"></div>';
  html += '<div class="form-group"><label>시작</label><input type="time" id="ed_start" value="' + start + '" style="width:110px;"></div>';
  html += '<div class="form-group"><label>종료</label><input type="time" id="ed_end" value="' + end + '" style="width:110px;"></div>';
  html += '</div><div class="form-row">';
  html += '<div class="form-group"><label>지각 기준</label><input type="time" id="ed_late" value="' + late + '" style="width:110px;"></div>';
  html += '<div class="form-group"><label>조퇴 기준</label><input type="time" id="ed_early" value="' + early + '" style="width:110px;"></div>';
  html += '<div class="form-group"><label>워크샵</label><select id="ed_ws" style="width:80px;"><option value="false"' + (!s.is_workshop ? ' selected' : '') + '>아니오</option><option value="true"' + (s.is_workshop ? ' selected' : '') + '>예</option></select></div>';
  html += '</div><div class="form-row">';
  html += '<div class="form-group"><label>비고</label><input type="text" id="ed_note" value="' + (s.note || '').replace(/"/g, '&quot;') + '" placeholder="공휴일, 단체식사, 외부행사 등" style="width:250px;"></div>';
  html += '<button class="btn btn-success" onclick="saveSession(\\'' + sessionId + '\\')">저장</button>';
  html += '<button class="btn btn-outline" onclick="loadSessionsForCourse()">취소</button>';
  html += '</div></div>';

  document.getElementById('editFormArea').innerHTML = html;
  document.getElementById('ed_date').scrollIntoView({ behavior: 'smooth' });
}

async function saveSession(sessionId) {
  const data = {
    session_date: document.getElementById('ed_date').value,
    start_time: document.getElementById('ed_start').value,
    end_time: document.getElementById('ed_end').value,
    late_cutoff: document.getElementById('ed_late').value,
    early_leave_cutoff: document.getElementById('ed_early').value,
    is_workshop: document.getElementById('ed_ws').value === 'true',
    note: document.getElementById('ed_note').value.trim() || null,
  };
  const res = await fetch('/api/admin/sessions/' + sessionId, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
  const r = await res.json();
  if (r.success) { await loadSessionsForCourse(); } else { alert('수정 실패: ' + (r.error||'')); }
}

async function bulkAddSessions() {
  const courseId = document.getElementById('sessionCourseSelect').value;
  if (!courseId) return;
  const startDate = document.getElementById('sStartDate').value;
  const count = parseInt(document.getElementById('sCount').value);
  const weekInterval = parseInt(document.getElementById('sWeekInterval').value);
  const startTime = document.getElementById('sStart').value;
  const endTime = document.getElementById('sEnd').value;
  const lateCutoff = document.getElementById('sLate').value;
  const earlyCutoff = document.getElementById('sEarly').value;

  // 선택된 요일 (1=월 ~ 6=토, JS의 getDay()는 0=일 1=월 ... 6=토)
  const selectedDays = [];
  document.querySelectorAll('.dayCheck:checked').forEach(function(cb) { selectedDays.push(parseInt(cb.value)); });

  if (!startDate || !count) { document.getElementById('sessionAddMsg').innerHTML = '<div class="msg msg-err">시작일과 회차 수를 입력하세요.</div>'; return; }
  if (selectedDays.length === 0) { document.getElementById('sessionAddMsg').innerHTML = '<div class="msg msg-err">수업 요일을 하나 이상 선택하세요.</div>'; return; }

  const dayNames = ['일','월','화','수','목','금','토'];

  const sessions = [];
  const d = new Date(startDate);
  let weekCount = 0;
  let lastWeekNum = -1;

  // 최대 365일까지 탐색 (안전장치)
  for (let safety = 0; safety < 365 && sessions.length < count; safety++) {
    // JS getDay(): 0=일, 1=월, ..., 6=토
    const jsDay = d.getDay();
    // 우리 체크박스: 1=월, 2=화, ..., 6=토 (일요일은 없음)
    const ourDay = jsDay === 0 ? 7 : jsDay;  // 일=7로 변환 (체크박스에 없으므로 자동 제외)

    // 주 번호 계산 (격주 처리용)
    const weekNum = Math.floor(safety / 7);
    if (weekNum !== lastWeekNum) {
      lastWeekNum = weekNum;
      weekCount++;
    }

    // 격주인 경우 짝수 주만 (1주차=추가, 2주차=건너뜀, 3주차=추가...)
    const isActiveWeek = weekInterval === 1 || (weekCount % 2 === 1);

    if (isActiveWeek && selectedDays.includes(ourDay)) {
      const dateStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      sessions.push({
        session_number: sessions.length + 1,
        session_date: dateStr,
        start_time: startTime, end_time: endTime,
        late_cutoff: lateCutoff, early_leave_cutoff: earlyCutoff,
      });
    }

    d.setDate(d.getDate() + 1);
  }

  if (sessions.length === 0) { document.getElementById('sessionAddMsg').innerHTML = '<div class="msg msg-err">생성된 회차가 없습니다. 시작일과 요일을 확인하세요.</div>'; return; }

  const selectedDayNames = selectedDays.map(function(d) { return dayNames[d]; }).join(',');
  if (!confirm(sessions.length + '개 회차를 추가하시겠습니까?\\n요일: ' + selectedDayNames + (weekInterval > 1 ? ' (격주)' : '') + '\\n기간: ' + sessions[0].session_date + ' ~ ' + sessions[sessions.length-1].session_date)) return;

  const res = await fetch('/api/admin/sessions/bulk', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ course_id: courseId, sessions }) });
  const r = await res.json();
  if (r.success) {
    document.getElementById('sessionAddMsg').innerHTML = '<div class="msg msg-ok">✅ ' + r.added + '개 회차 추가 완료</div>';
    await loadSessionsForCourse();
    await loadCourses();
  } else {
    document.getElementById('sessionAddMsg').innerHTML = '<div class="msg msg-err">❌ ' + (r.error||'실패') + '</div>';
  }
}

async function deleteSession(sessionId, num) {
  if (!confirm(num + '회차를 삭제하시겠습니까? 해당 회차의 출결 데이터도 함께 삭제됩니다.')) return;
  const res = await fetch('/api/admin/sessions/' + sessionId, { method:'DELETE' });
  const r = await res.json();
  if (r.success) { await loadSessionsForCourse(); await loadCourses(); } else { alert('삭제 실패: ' + (r.error||'')); }
}

async function freeAddSessions() {
  const courseId = document.getElementById('sessionCourseSelect').value;
  if (!courseId) { alert('과정을 선택하세요.'); return; }
  const input = document.getElementById('freeSessionInput').value.trim();
  const msgEl = document.getElementById('freeSessionMsg');
  if (!input) { msgEl.innerHTML = '<div class="msg msg-err">입력 내용이 없습니다.</div>'; return; }

  // 기존 회차 수 조회 (session_number 이어서 부여)
  const existRes = await fetch('/api/admin/sessions/' + courseId);
  const existing = await existRes.json();
  let nextNum = existing.length > 0 ? Math.max(...existing.map(s => s.session_number)) + 1 : 1;

  const lines = input.split('\\n').filter(l => l.trim());
  const sessions = [];
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\\s+/);
    if (parts.length < 3) { errors.push((i+1) + '번째 줄: 최소 날짜, 시작, 종료 필요'); continue; }

    const dateMatch = parts[0].match(/^\\d{4}-\\d{2}-\\d{2}$/);
    if (!dateMatch) { errors.push((i+1) + '번째 줄: 날짜 형식 오류 (YYYY-MM-DD)'); continue; }

    const session = {
      session_number: nextNum++,
      session_date: parts[0],
      start_time: parts[1],
      end_time: parts[2],
      late_cutoff: parts[3] || parts[1],  // 지각 기준 없으면 시작시간
      early_leave_cutoff: parts[4] || parts[2],  // 조퇴 기준 없으면 종료시간
      is_workshop: false,
    };

    // 5번째 이후는 비고 (note) - 서버에서 별도 처리
    if (parts.length > 5) {
      session.note = parts.slice(5).join(' ');
    }

    sessions.push(session);
  }

  if (errors.length > 0) {
    msgEl.innerHTML = '<div class="msg msg-err">⚠️ 형식 오류:\\n' + errors.join('\\n') + '</div>';
    return;
  }

  if (sessions.length === 0) { msgEl.innerHTML = '<div class="msg msg-err">유효한 입력이 없습니다.</div>'; return; }

  // 미리보기
  let preview = sessions.map(s => s.session_number + '회 ' + s.session_date + ' ' + s.start_time + '~' + s.end_time + (s.note ? ' (' + s.note + ')' : '')).join('\\n');
  if (!confirm(sessions.length + '개 회차를 추가합니다:\\n\\n' + preview)) return;

  // note 포함 회차는 개별 추가 (bulk API에 note 지원 추가)
  let added = 0;
  for (const s of sessions) {
    try {
      const res = await fetch('/api/admin/sessions', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ course_id: courseId, ...s })
      });
      const r = await res.json();
      if (r.success) added++;
    } catch (e) { /* skip */ }
  }

  msgEl.innerHTML = '<div class="msg msg-ok">✅ ' + added + '개 회차 추가 완료</div>';
  document.getElementById('freeSessionInput').value = '';
  await loadSessionsForCourse();
  await loadCourses();
}

// ─── 강의실 관리 ────────────────────────────────────────
async function loadClassrooms() {
  const res = await fetch('/api/classrooms');
  const rooms = await res.json();
  let html = '<table><tr><th>코드</th><th>이름</th><th>관리</th></tr>';
  for (const r of rooms) {
    html += '<tr><td>' + r.classroom_code + '</td><td>' + r.classroom_name + '</td>';
    html += '<td><button class="btn btn-small btn-danger" onclick="deleteClassroom(\\'' + r.classroom_id + '\\', \\'' + r.classroom_name + '\\')">삭제</button></td></tr>';
  }
  html += '</table>';
  document.getElementById('classroomList').innerHTML = html;
}

async function addClassroom() {
  const code = document.getElementById('crCode').value.trim();
  const name = document.getElementById('crName').value.trim();
  if (!code || !name) { document.getElementById('crMsg').innerHTML = '<div class="msg msg-err">코드와 이름을 입력하세요.</div>'; return; }
  const res = await fetch('/api/admin/classrooms', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ classroom_code:code, classroom_name:name }) });
  const r = await res.json();
  if (r.success) {
    document.getElementById('crCode').value = '';
    document.getElementById('crName').value = '';
    document.getElementById('crMsg').innerHTML = '<div class="msg msg-ok">✅ 추가 완료</div>';
    await loadClassrooms();
  } else {
    document.getElementById('crMsg').innerHTML = '<div class="msg msg-err">❌ ' + (r.error||'실패') + '</div>';
  }
}

async function deleteClassroom(id, name) {
  if (!confirm(name + ' 강의실을 삭제하시겠습니까?')) return;
  const res = await fetch('/api/admin/classrooms/' + id, { method:'DELETE' });
  const r = await res.json();
  if (r.success) { await loadClassrooms(); } else { alert('삭제 실패: ' + (r.error||'')); }
}
</script>
</body>
</html>`;
}


function renderSyncPage(courses) {
  const rows = courses.map(c => `
    <tr id="row-${c.course_id}">
      <td><b>${c.course_name}</b><br><span style="font-size:11px;color:#86868b;">${c.course_type || ''} ${c.cohort || ''}</span></td>
      <td><input type="text" class="sheet-input" id="sheet-${c.course_id}" value="${c.spreadsheet_id || ''}" placeholder="스프레드시트 ID 입력"></td>
      <td>
        <button class="btn btn-small" onclick="saveSheetId('${c.course_id}')">저장</button>
        <button class="btn btn-small btn-sync" onclick="syncCourse('${c.course_id}')" ${c.spreadsheet_id ? '' : 'disabled'}>전체 동기화</button>
        <button class="btn btn-small" onclick="showSessionPicker('${c.course_id}')" ${c.spreadsheet_id ? '' : 'disabled'} style="margin-left:2px;">회차 선택</button>
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
    body { font-family: -apple-system, 'Malgun Gothic', sans-serif; background: #e4e5e6; color: #1d1d1f; padding: 16px; }
    .container { max-width: 1000px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .subtitle { color: #86868b; font-size: 13px; margin-bottom: 20px; }
    .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card h2 { font-size: 16px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #e5e5e7; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 10px; background: #e4e5e6; color: #86868b; font-weight: 500; font-size: 12px; }
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
    .step-box { background: #e4e5e6; border-radius: 8px; padding: 12px 16px; margin: 8px 0; font-size: 13px; line-height: 1.8; }
    code { background: #e8e8e8; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  </style>
</head>
<body>
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:52px;display:block;"></div>
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:44px;display:block;"></div>
  <div style="padding:14px 20px 10px 20px;margin:-16px -16px 20px -16px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:46px;display:block;"></div>
  
<div class="container">
  <a href="/admin" class="back-link">← 대시보드로 돌아가기</a>
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

  <!-- 회차 선택 모달 -->
  <div id="sessionPickerCard" class="card" style="display:none;">
    <h2 id="pickerTitle">회차 선택</h2>
    <div id="pickerContent"></div>
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
        statusEl.innerHTML = '<span style="color:#34c759;">✅ 완료 (' + data.studentsCount + '명, ' + data.sheetsUpdated + '탭)' + (data.formatResult && data.formatResult !== 'success' ? ' ⚠️색상: ' + data.formatResult : '') + '</span>';
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

  // ─── 회차 선택 동기화 ──────────────────────────────────
  async function showSessionPicker(courseId) {
    const card = document.getElementById('sessionPickerCard');
    const content = document.getElementById('pickerContent');
    card.style.display = 'block';
    content.innerHTML = '<div style="color:#86868b;text-align:center;padding:12px;">불러오는 중...</div>';
    card.scrollIntoView({ behavior: 'smooth' });

    try {
      const res = await fetch('/api/admin/sessions/' + courseId);
      const sessions = await res.json();

      if (sessions.length === 0) {
        content.innerHTML = '<div style="color:#86868b;">등록된 회차가 없습니다.</div>';
        return;
      }

      let html = '<div style="margin-bottom:10px;">';
      html += '<button class="btn btn-small" onclick="pickerSelectAll(true)" style="margin-right:4px;">전체 선택</button>';
      html += '<button class="btn btn-small" style="background:#86868b;" onclick="pickerSelectAll(false)">선택 해제</button>';
      html += '</div>';
      html += '<div style="max-height:300px;overflow-y:auto;border:1px solid #e5e5e7;border-radius:8px;padding:8px;">';

      for (const s of sessions) {
        const date = s.session_date ? s.session_date.split('T')[0] : '-';
        html += '<label style="display:flex;align-items:center;padding:6px 4px;cursor:pointer;border-bottom:1px solid #f5f5f7;">';
        html += '<input type="checkbox" class="session-pick" value="' + s.session_number + '" style="margin-right:8px;">';
        html += '<span style="font-weight:600;width:45px;">' + s.session_number + '회</span>';
        html += '<span style="color:#86868b;font-size:12px;">' + date + '</span>';
        html += '<span style="color:#1a73e8;font-size:12px;margin-left:auto;">' + s.attendance_count + '명</span>';
        html += '</label>';
      }

      html += '</div>';
      html += '<div style="margin-top:12px;display:flex;gap:8px;align-items:center;">';
      html += '<label style="font-size:13px;cursor:pointer;"><input type="checkbox" id="pickSummary" checked style="margin-right:4px;">출결요약 포함</label>';
      html += '<button class="btn btn-sync" onclick="syncSelected(\\''+courseId+'\\')" style="margin-left:auto;">선택 회차 동기화</button>';
      html += '<button class="btn btn-small" style="background:#86868b;" onclick="document.getElementById(\\'sessionPickerCard\\').style.display=\\'none\\'">닫기</button>';
      html += '</div>';
      html += '<div id="pickerStatus" style="margin-top:8px;font-size:12px;"></div>';

      document.getElementById('pickerTitle').textContent = '회차 선택 동기화';
      content.innerHTML = html;
    } catch (err) {
      content.innerHTML = '<div style="color:#ff3b30;">로드 실패: ' + err.message + '</div>';
    }
  }

  function pickerSelectAll(checked) {
    document.querySelectorAll('.session-pick').forEach(function(cb) { cb.checked = checked; });
  }

  async function syncSelected(courseId) {
    var selected = [];
    document.querySelectorAll('.session-pick:checked').forEach(function(cb) { selected.push(parseInt(cb.value)); });
    var includeSummary = document.getElementById('pickSummary').checked;

    if (selected.length === 0 && !includeSummary) {
      alert('동기화할 회차를 선택하거나 출결요약을 포함하세요.');
      return;
    }

    var statusEl = document.getElementById('pickerStatus');
    var mainStatus = document.getElementById('status-' + courseId);
    var totalSheets = selected.length + (includeSummary ? 1 : 0);
    statusEl.innerHTML = '<span style="color:#1a73e8;">⏳ 동기화 중... (' + totalSheets + '개 시트)</span>';
    if (mainStatus) mainStatus.innerHTML = '<span style="color:#1a73e8;">⏳ 동기화 중...</span>';

    try {
      var res = await fetch('/api/admin/sync/' + courseId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionNumbers: selected, includeSummary: includeSummary })
      });
      var data = await res.json();

      if (data.success) {
        var msg = '✅ 완료 (' + data.sheetsUpdated + '탭)' + (data.formatResult && data.formatResult !== 'success' ? ' ⚠️색상: ' + data.formatResult : '');
        statusEl.innerHTML = '<span style="color:#34c759;">' + msg + '</span>';
        if (mainStatus) mainStatus.innerHTML = '<span style="color:#34c759;">' + msg + '</span>';
      } else {
        statusEl.innerHTML = '<span style="color:#ff3b30;">❌ ' + (data.error || '실패') + '</span>';
        if (mainStatus) mainStatus.innerHTML = '<span style="color:#ff3b30;">❌ ' + (data.error || '실패') + '</span>';
      }
    } catch (err) {
      statusEl.innerHTML = '<span style="color:#ff3b30;">❌ ' + err.message + '</span>';
    }
  }
</script>
</body>
</html>`;
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
    body { font-family: -apple-system, 'Malgun Gothic', sans-serif; background: #e4e5e6; padding: 20px; }
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
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:52px;display:block;"></div>
  <div style="padding:14px 20px 10px 20px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:44px;display:block;"></div>
  <div style="padding:14px 20px 10px 20px;margin:-16px -16px 20px -16px;"><img src="data:image/png;base64,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" alt="연세대학교 상남경영원" style="height:46px;display:block;"></div>
  
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
