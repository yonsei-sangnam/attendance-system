const webpush = require('web-push');
const admin = require('firebase-admin');
const db = require('./db');

// ─── Firebase Admin 초기화 ───────────────────────────────────
let fcmEnabled = false;

function initFirebase() {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      console.warn('[FCM] FIREBASE_SERVICE_ACCOUNT 환경변수 없음. FCM 비활성.');
      return;
    }

    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    fcmEnabled = true;
    console.log('[FCM] Firebase Admin 초기화 완료. FCM 활성.');
  } catch (err) {
    console.error('[FCM] Firebase Admin 초기화 실패:', err.message);
  }
}

// ─── VAPID 설정 ──────────────────────────────────────────────
function initPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!publicKey || !privateKey) {
    console.warn('[Push] VAPID 키가 설정되지 않았습니다. 푸시 알림 비활성.');
    return false;
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@attendance-system.com',
    publicKey,
    privateKey
  );

  console.log('[Push] VAPID 설정 완료. 푸시 알림 활성.');

  // Firebase도 함께 초기화
  initFirebase();

  return true;
}

// ─── Web Push 구독 저장 (기존과 동일) ────────────────────────
async function saveSubscription(studentId, subscription) {
  await db.query(`
    INSERT INTO push_subscriptions (student_id, endpoint, keys_p256dh, keys_auth, type)
    VALUES ($1, $2, $3, $4, 'webpush')
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

// ─── FCM 토큰 저장 (신규) ───────────────────────────────────
async function saveFcmToken(studentId, fcmToken) {
  // 기존 FCM 삭제
  await db.query(
    `DELETE FROM push_subscriptions WHERE student_id = $1 AND type = 'fcm'`,
    [studentId]
  );
  // Firebase getToken이 만든 webpush 구독도 삭제 (FCM 엔드포인트와 충돌 방지)
  await db.query(
    `DELETE FROM push_subscriptions WHERE student_id = $1 AND type = 'webpush' AND endpoint LIKE '%fcm.googleapis.com%'`,
    [studentId]
  );
  // FCM 1건 등록
  await db.query(`
    INSERT INTO push_subscriptions (student_id, endpoint, fcm_token, type)
    VALUES ($1, $2, $2, 'fcm')
  `, [studentId, fcmToken]);
}


// ─── 구독 삭제 ───────────────────────────────────────────────
async function removeSubscription(endpoint) {
  await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

// ─── 개별 푸시 발송 (webpush + fcm 분기) ─────────────────────
async function sendPush(studentId, payload) {
  const subs = await db.query(
    `SELECT id, endpoint, keys_p256dh, keys_auth, type, fcm_token
     FROM push_subscriptions WHERE student_id = $1`,
    [studentId]
  );

  const results = [];

  for (const sub of subs.rows) {

    // ── FCM 발송 ──
    if (sub.type === 'fcm') {
      if (!fcmEnabled || !sub.fcm_token) {
        results.push({ type: 'fcm', status: 'skipped', detail: 'FCM 비활성 또는 토큰 없음' });
        continue;
      }
        var clickUrl = 'https://attendance-system-naaw.onrender.com/app';
        if (payload.studentId && payload.attendanceId) {
          clickUrl += '?checkout=true&sid=' + encodeURIComponent(String(payload.studentId)) + '&aid=' + encodeURIComponent(String(payload.attendanceId));
        }

        await admin.messaging().send({
          token: sub.fcm_token,
          webpush: {
            headers: { Urgency: 'high' },
            notification: {
              title: payload.title || '출결 알림',
              body: payload.body || '',
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              vibrate: [200, 100, 200],
              tag: 'checkout-' + Date.now(),
              renotify: 'true',
              require_interaction: 'true',
            },
            fcm_options: {
              link: clickUrl,
            },
          },
        });
      
      try {

        results.push({ type: 'fcm', status: 'sent' });
      } catch (err) {
        // 토큰 만료/무효 시 삭제
        if (err.code === 'messaging/registration-token-not-registered' ||
            err.code === 'messaging/invalid-registration-token') {
          await db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
          results.push({ type: 'fcm', status: 'expired', detail: 'token removed' });
        } else {
          console.error('[FCM] 발송 실패:', err.message);
          results.push({ type: 'fcm', status: 'error', error: err.message });
        }
      }
      continue;
    }

    // ── Web Push 발송 (기존 로직 그대로) ──
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
    };

    try {
      const timeoutMs = 10000;
      const sendPromise = webpush.sendNotification(subscription, JSON.stringify(payload));
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Push timeout (10s)')), timeoutMs)
      );
      await Promise.race([sendPromise, timeoutPromise]);
      results.push({ type: 'webpush', endpoint: sub.endpoint, status: 'sent' });
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await removeSubscription(sub.endpoint);
        results.push({ type: 'webpush', endpoint: sub.endpoint, status: 'expired', detail: 'subscription removed' });
      } else if (err.message && err.message.includes('timeout')) {
        await removeSubscription(sub.endpoint);
        results.push({ type: 'webpush', endpoint: sub.endpoint, status: 'timeout', detail: 'subscription removed (no response)' });
      } else {
        console.error('[Push] 발송 실패:', { endpoint: sub.endpoint.slice(0, 60), statusCode: err.statusCode, message: err.message, body: err.body });
        results.push({ type: 'webpush', endpoint: sub.endpoint, status: 'error', statusCode: err.statusCode, error: err.message, body: err.body });
      }
    }
  }
  return results;
}


// ─── DB에서 푸시 설정 읽기 ─────────────────────────────────
async function getPushSettings() {
  var settings = { intervalMin: 2, remindBeforeMin: 10, autoCloseMin: 10 };
  try {
    const r = await db.query(
      "SELECT key, value FROM system_settings WHERE key IN ('push_interval_minutes','push_remind_before_minutes','push_auto_close_minutes')"
    );
    for (const row of r.rows) {
      var v = parseInt(row.value, 10);
      if (row.key === 'push_interval_minutes' && v >= 1 && v <= 30) settings.intervalMin = v;
      if (row.key === 'push_remind_before_minutes' && v >= 1 && v <= 30) settings.remindBeforeMin = v;
      if (row.key === 'push_auto_close_minutes' && v >= 1 && v <= 60) settings.autoCloseMin = v;
    }
  } catch (e) { /* 기본값 사용 */ }
  return settings;
}

// ─── 퇴실 리마인더 발송 ─────────────────────────────────────
async function sendExitReminders(remindBeforeMin, autoCloseMin) {
  const sessions = await db.query(`
    SELECT cs.session_id, cs.end_time, c.course_name,
           COALESCE(cr.classroom_name, dcr.classroom_name) AS classroom_name
    FROM course_sessions cs
    JOIN courses c ON c.course_id = cs.course_id
    LEFT JOIN classrooms cr ON cr.classroom_id = cs.classroom_id
    LEFT JOIN classrooms dcr ON dcr.classroom_id = c.default_classroom_id
    WHERE cs.session_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE
      AND cs.end_time BETWEEN
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::TIME - INTERVAL '${autoCloseMin} minutes'
        AND (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::TIME + INTERVAL '${remindBeforeMin + 1} minutes'
  `);

  if (sessions.rows.length === 0) return { sent: 0 };

  let totalSent = 0;

  for (const session of sessions.rows) {
    const students = await db.query(`
      SELECT a.attendance_id, a.student_id, s.name
      FROM attendance a
      JOIN students s ON s.student_id = a.student_id
      WHERE a.session_id = $1
        AND a.check_in_at IS NOT NULL
        AND a.check_out_at IS NULL
    `, [session.session_id]);

    const nowKST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const [endH, endM] = session.end_time.slice(0, 5).split(':').map(Number);
    const endMinutes = endH * 60 + endM;
    const nowMinutes = nowKST.getHours() * 60 + nowKST.getMinutes();
    const minutesLeft = endMinutes - nowMinutes;

    let body;
    if (minutesLeft > 0) {
      body = `${session.course_name} 종료 ${minutesLeft}분 전입니다. 퇴실 확인을 해주세요.`;
    } else {
      body = `${session.course_name} 수업이 종료되었습니다. 퇴실 확인을 해주세요.`;
    }

    for (const student of students.rows) {
      const payload = {
        title: '퇴실 확인 요청',
        body,
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


// ─── 퇴실 미확인 자동 처리 ────────────────────────────────
async function sendMissedExitAlerts(autoCloseMin) {
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
      AND cs.end_time < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::TIME - INTERVAL '${autoCloseMin} minutes'
  `);

  for (const row of students.rows) {
    await db.query(`
      UPDATE attendance 
      SET check_out_at = (session_date || ' ' || $2)::TIMESTAMP AT TIME ZONE 'Asia/Seoul',
          exit_type = '퇴실미확인',
          is_manual_override = FALSE,
          updated_at = NOW()
      FROM (SELECT session_date FROM course_sessions WHERE session_id = $3) sub
      WHERE attendance_id = $1
    `, [row.attendance_id, row.end_time, row.session_id]);

    const payload = {
      title: '퇴실미확인 처리',
      body: `${row.course_name} - '퇴실미확인'으로 처리되었습니다. 관리자에게 문의하세요.`,
      url: '/',
    };

    try {
      await sendPush(row.student_id, payload);
    } catch (err) { /* 무시 */ }
  }

  return { processed: students.rows.length };
}


// ─── 스케줄러 운영 시간 설정 ─────────────────────────────────
const SCHEDULE = {
  0: null,
  1: { start: 8, end: 19 },
  2: { start: 8, end: 19 },
  3: { start: 8, end: 22 },
  4: { start: 8, end: 19 },
  5: { start: 8, end: 22 },
  6: null,
};

function isWithinScheduleHours() {
  const nowKST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = nowKST.getDay();
  const hour = nowKST.getHours();
  const slot = SCHEDULE[day];
  if (!slot) return false;
  return hour >= slot.start && hour < slot.end;
}

// ─── 스케줄러 시작 ───────────────────────────────────────────
function startScheduler() {
  const days = ['일','월','화','수','목','금','토'];
  const desc = Object.entries(SCHEDULE)
    .filter(([, v]) => v)
    .map(([k, v]) => `${days[k]} ${v.start}~${v.end}시`)
    .join(', ');
  console.log(`[Scheduler] 퇴실 리마인더 스케줄러 시작 (${desc})`);

  async function runCycle() {
    var ps = await getPushSettings();

    if (isWithinScheduleHours()) {
      try {
        const reminders = await sendExitReminders(ps.remindBeforeMin, ps.autoCloseMin);
        if (reminders.sent > 0) {
          console.log(`[Scheduler] 퇴실 리마인더 ${reminders.sent}건 발송 (간격:${ps.intervalMin}분, 종료전:${ps.remindBeforeMin}분, 자동처리:${ps.autoCloseMin}분)`);
        }

        const missed = await sendMissedExitAlerts(ps.autoCloseMin);
        if (missed.processed > 0) {
          console.log(`[Scheduler] 퇴실미확인 ${missed.processed}건 자동 처리`);
        }
      } catch (err) {
        console.error('[Scheduler] 오류:', err.message);
      }
    }

    setTimeout(runCycle, ps.intervalMin * 60 * 1000);
  }

  setTimeout(runCycle, 60 * 1000);
}


module.exports = { initPush, saveSubscription, saveFcmToken, removeSubscription, sendPush, startScheduler };
