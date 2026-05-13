const db = require('./db');

// ─── 출결 처리 (입실/퇴실 자동 판단) ─────────────────────────
// 설계 문서 기준:
//   입실 기록 없음          → 입실 처리
//   입실 O, 퇴실 없음       → 퇴실 처리
//   입실 O, 퇴실 O          → "오늘 출결 완료" 안내
//   입실 후 10분 이내 재스캔  → 무시 (오조작 방지)
// ─────────────────────────────────────────────────────────────
async function recordAttendance(studentId, classroomCode) {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. 해당 강의실의 오늘 세션 조회
    const sessionRes = await client.query(`
      SELECT cs.session_id, cs.session_date, cs.start_time, cs.end_time,
             cs.late_cutoff, cs.early_leave_cutoff,
             c.course_name,
             cr.classroom_name
      FROM course_sessions cs
      JOIN courses c ON c.course_id = cs.course_id
      JOIN enrollments e ON e.course_id = cs.course_id
      LEFT JOIN classrooms cr ON cr.classroom_id = COALESCE(cs.classroom_id, c.default_classroom_id)
      WHERE e.student_id = $1
        AND COALESCE(cs.classroom_id, c.default_classroom_id) = (
          SELECT classroom_id FROM classrooms WHERE classroom_code = $2
        )
        AND cs.session_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE
    `, [studentId, classroomCode]);

    if (sessionRes.rows.length === 0) {
      // 오늘 이 강의실에서 해당 수강생의 수업이 없음
      // → 다른 강의실의 수업이 있는지 확인
      const otherSession = await client.query(`
        SELECT c.course_name, cr.classroom_name
        FROM course_sessions cs
        JOIN courses c ON c.course_id = cs.course_id
        JOIN enrollments e ON e.course_id = cs.course_id
        LEFT JOIN classrooms cr ON cr.classroom_id = COALESCE(cs.classroom_id, c.default_classroom_id)
        WHERE e.student_id = $1
          AND cs.session_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE
      `, [studentId]);

      if (otherSession.rows.length > 0) {
        const s = otherSession.rows[0];
        await client.query('COMMIT');
        return {
          success: false,
          type: 'wrong_room',
          message: `오늘 수업은 "${s.classroom_name}"에서 진행됩니다.`,
          courseName: s.course_name,
          classroomName: s.classroom_name,
        };
      }

      await client.query('COMMIT');
      return {
        success: false,
        type: 'no_session',
        message: '오늘은 예정된 수업이 없습니다.',
      };
    }

    const session = sessionRes.rows[0];

    // 2. 오늘 기존 출결 기록 조회
    const existingRes = await client.query(`
      SELECT attendance_id, check_in_at, check_out_at, status, exit_type
      FROM attendance
      WHERE student_id = $1 AND session_id = $2
    `, [studentId, session.session_id]);

    const now = new Date();
    const nowKST = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));

    // 3. 상태별 처리
    if (existingRes.rows.length === 0) {
      // ─── 입실 처리 ─────────────────────────────────────
      const classroomId = await getClassroomId(client, classroomCode);

      await client.query(`
        INSERT INTO attendance (student_id, session_id, classroom_id, check_in_at, exit_type, is_manual_override)
        VALUES ($1, $2, $3, NOW(), NULL, FALSE)
      `, [studentId, session.session_id, classroomId]);

      // 지각 여부 판정 (트리거에서 자동 처리되지만 응답용으로 미리 계산)
      const checkInTime = nowKST.toTimeString().slice(0, 5); // HH:MM
      const isLate = checkInTime > session.late_cutoff.slice(0, 5);

      await client.query('COMMIT');
      return {
        success: true,
        type: 'check_in',
        message: isLate ? '입실 완료 (지각)' : '입실 완료',
        courseName: session.course_name,
        classroomName: session.classroom_name,
        checkInTime: now.toISOString(),
        isLate,
      };
    }

    const record = existingRes.rows[0];

    if (record.check_in_at && !record.check_out_at) {
      // 입실 후 재스캔 → 시간 차이 확인
      const checkInTime = new Date(record.check_in_at);
      const minutesSinceCheckIn = (now - checkInTime) / (1000 * 60);

      if (minutesSinceCheckIn < 10) {
        // ─── 10분 이내 재스캔 → 무시 ─────────────────────
        await client.query('COMMIT');
        return {
          success: true,
          type: 'duplicate',
          message: `이미 입실 처리되었습니다. (${Math.floor(minutesSinceCheckIn)}분 전)`,
          courseName: session.course_name,
          classroomName: session.classroom_name,
          checkInTime: record.check_in_at,
        };
      }

      // ─── 퇴실 처리 ─────────────────────────────────────
      const checkOutTime = nowKST.toTimeString().slice(0, 5);
      const isEarlyLeave = checkOutTime < session.early_leave_cutoff.slice(0, 5);

      await client.query(`
        UPDATE attendance
        SET check_out_at = NOW(), exit_type = '정상', is_manual_override = FALSE
        WHERE attendance_id = $1
      `, [record.attendance_id]);

      await client.query('COMMIT');
      return {
        success: true,
        type: 'check_out',
        message: isEarlyLeave ? '퇴실 완료 (조퇴)' : '퇴실 완료',
        courseName: session.course_name,
        classroomName: session.classroom_name,
        checkOutTime: now.toISOString(),
        isEarlyLeave,
      };
    }

    if (record.check_in_at && record.check_out_at) {
      // ─── 이미 입퇴실 모두 완료 ─────────────────────────
      await client.query('COMMIT');
      return {
        success: true,
        type: 'already_done',
        message: '오늘 출결이 이미 완료되었습니다.',
        courseName: session.course_name,
        classroomName: session.classroom_name,
        checkInTime: record.check_in_at,
        checkOutTime: record.check_out_at,
        status: record.status,
      };
    }

    await client.query('COMMIT');
    return { success: false, type: 'unknown', message: '알 수 없는 상태입니다. 관리자에게 문의하세요.' };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


// ─── 강의실 ID 조회 헬퍼 ─────────────────────────────────────
async function getClassroomId(client, classroomCode) {
  const res = await client.query(
    'SELECT classroom_id FROM classrooms WHERE classroom_code = $1',
    [classroomCode]
  );
  return res.rows.length > 0 ? res.rows[0].classroom_id : null;
}


// ─── 수강생의 오늘 출결 상태 조회 ────────────────────────────
async function getTodayStatus(studentId) {
  const res = await db.query(`
    SELECT a.check_in_at, a.check_out_at, a.status, a.exit_type,
           c.course_name, cr.classroom_name,
           cs.session_number, cs.start_time, cs.end_time
    FROM attendance a
    JOIN course_sessions cs ON cs.session_id = a.session_id
    JOIN courses c ON c.course_id = cs.course_id
    LEFT JOIN classrooms cr ON cr.classroom_id = a.classroom_id
    WHERE a.student_id = $1
      AND cs.session_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE
    ORDER BY a.check_in_at DESC
    LIMIT 1
  `, [studentId]);

  if (res.rows.length === 0) return null;
  return res.rows[0];
}


module.exports = { recordAttendance, getTodayStatus };
