const webpush = require('web-push');
const db = require('./db');

// ─── VAPID 설정 ──────────────────────────────────────────────
function initPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!publicKey || !privateKey) {
    console.warn('[Push] VAPID 키가 설정되지 않았습니다. 푸시 알림 비활성.');
    return false;
  }

  webpush.setVapidDetails(
    'mailto:admin@attendance.local',
    publicKey,
    privateKey
  );

  console.log('[Push] VAPID 설정 완료. 푸시 알림 활성.');
  return true;
}

// ─── 구독 저장 ───────────────────────────────────────────────
async function saveSubscription(studentId, subscription) {
  await db.query(`
    INSERT INTO push_subscriptions (student_id, endpoint, keys_p256dh, keys_auth)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (student_id, endpoint) DO UPDATE SET
      keys_p256dh = EXCLUDED.keys_p256dh,
      keys_auth = EXCLUDED.keys_auth,
      updated_at = NOW()
  `, [
    studentId,
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth,
  ]);
}

// ─── 구독 삭제 ───────────────────────────────────────────────
async function removeSubscription(endpoint) {
  await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

// ─── 개별 푸시 발송 ──────────────────────────────────────────
async function sendPush(studentId, payload) {
  const subs = await db.query(
    'SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE student_id = $1',
    [studentId]
  );

  const results = [];
  for (const sub of subs.rows) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
    };

    try {
      // 10초 타임아웃 (Apple Push 무응답 방지)
      const timeoutMs = 10000;
      const sendPromise = webpush.sendNotification(subscription, JSON.stringify(payload));
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Push timeout (10s)')), timeoutMs)
      );
      await Promise.race([sendPromise, timeoutPromise]);
      results.push({ endpoint: sub.endpoint, status: 'sent' });
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // 구독 만료 → 삭제
        await removeSubscription(sub.endpoint);
        results.push({ endpoint: sub.endpoint, status: 'expired', detail: 'subscription removed' });
      } else if (err.message && err.message.includes('timeout')) {
        // 타임아웃 → 만료된 구독일 가능성 높음 → 삭제
        await removeSubscription(sub.endpoint);
        results.push({ endpoint: sub.endpoint, status: 'timeout', detail: 'subscription removed (no response)' });
      } else {
        results.push({ endpoint: sub.endpoint, status: 'error', error: err.message });
      }
    }
  }
  return results;
}


// ─── 퇴실 리마인더 발송 (수업 종료 10분 전) ─────────────────
async function sendExitReminders() {
  // 현재 KST 시간 기준, 10분 후에 종료되는 수업 찾기
  const sessions = await db.query(`
    SELECT cs.session_id, cs.end_time, c.course_name,
           COALESCE(cr.classroom_name, dcr.classroom_name) AS classroom_name
    FROM course_sessions cs
    JOIN courses c ON c.course_id = cs.course_id
    LEFT JOIN classrooms cr ON cr.classroom_id = cs.classroom_id
    LEFT JOIN classrooms dcr ON dcr.classroom_id = c.default_classroom_id
    WHERE cs.session_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE
      AND cs.end_time BETWEEN 
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::TIME + INTERVAL '9 minutes'
        AND (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::TIME + INTERVAL '11 minutes'
  `);

  if (sessions.rows.length === 0) return { sent: 0 };

  let totalSent = 0;

  for (const session of sessions.rows) {
    // 이 세션에 입실했지만 퇴실 안 한 수강생 조회
    const students = await db.query(`
      SELECT a.attendance_id, a.student_id, s.name
      FROM attendance a
      JOIN students s ON s.student_id = a.student_id
      WHERE a.session_id = $1
        AND a.check_in_at IS NOT NULL
        AND a.check_out_at IS NULL
    `, [session.session_id]);

    for (const student of students.rows) {
      const payload = {
        title: '수업이 곧 종료됩니다',
        body: `${session.course_name} - 퇴실 확인을 해주세요.`,
        url: '/',
        studentId: student.student_id,
        attendanceId: student.attendance_id,
      };

      try {
        await sendPush(student.student_id, payload);
        totalSent++;
      } catch (err) {
        console.error(`[Push] ${student.name} 발송 실패:`, err.message);
      }
    }
  }

  return { sent: totalSent, sessions: sessions.rows.length };
}


// ─── 퇴실 미확인 알림 (수업 종료 후 10분) ───────────────────
async function sendMissedExitAlerts() {
  // 종료 후 10분 경과한 세션에서 퇴실 미확인자 찾기
  const students = await db.query(`
    SELECT a.attendance_id, a.student_id, s.name, 
           cs.session_id, cs.end_time, c.course_name
    FROM attendance a
    JOIN students s ON s.student_id = a.student_id
    JOIN course_sessions cs ON cs.session_id = a.session_id
    JOIN courses c ON c.course_id = cs.course_id
    WHERE cs.session_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE
      AND a.check_in_at IS NOT NULL
      AND a.check_out_at IS NULL
      AND a.exit_type IS NULL
      AND cs.end_time < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::TIME - INTERVAL '10 minutes'
  `);

  for (const row of students.rows) {
    // 퇴실미확인 자동 처리: 수업 종료 시각으로 기록
    await db.query(`
      UPDATE attendance 
      SET check_out_at = (session_date || ' ' || $2)::TIMESTAMP AT TIME ZONE 'Asia/Seoul',
          exit_type = '퇴실미확인',
          is_manual_override = FALSE,
          updated_at = NOW()
      FROM (SELECT session_date FROM course_sessions WHERE session_id = $3) sub
      WHERE attendance_id = $1
    `, [row.attendance_id, row.end_time, row.session_id]);

    // 알림 발송
    const payload = {
      title: '퇴실 확인이 되지 않았습니다',
      body: `${row.course_name} - 관리자에게 문의하세요.`,
      url: '/',
    };

    try {
      await sendPush(row.student_id, payload);
    } catch (err) { /* 무시 */ }
  }

  return { processed: students.rows.length };
}


// ─── 스케줄러 시작 (1분마다 체크) ────────────────────────────
function startScheduler() {
  console.log('[Scheduler] 퇴실 리마인더 스케줄러 시작 (1분 간격)');

  setInterval(async () => {
    try {
      const reminders = await sendExitReminders();
      if (reminders.sent > 0) {
        console.log(`[Scheduler] 퇴실 리마인더 ${reminders.sent}건 발송`);
      }

      const missed = await sendMissedExitAlerts();
      if (missed.processed > 0) {
        console.log(`[Scheduler] 퇴실미확인 ${missed.processed}건 자동 처리`);
      }
    } catch (err) {
      console.error('[Scheduler] 오류:', err.message);
    }
  }, 60 * 1000); // 1분마다
}


module.exports = { initPush, saveSubscription, removeSubscription, sendPush, startScheduler };
