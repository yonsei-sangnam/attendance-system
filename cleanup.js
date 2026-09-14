// ════════════════════════════════════════════════════════════
// cleanup.js — 출결 시도 로그 자동 파기
//
// 개인정보처리방침 고지 내용: "해당 교육 과정 종료 후 1개월이 경과한 시점에
// 시스템이 자동으로 파기합니다."
//
// 파기 기준:
//   각 시도 기록의 주체(수강생)가 수강한 과정들 중 가장 늦은 회차 날짜를 찾아,
//   그 날짜 + 보관기간(일)이 지났으면 삭제한다.
//   수강 과정이 없는 기록(등록 시도 등)은 기록 생성일 + 보관기간 기준.
//
// 컴퓨트 절약: 하루 1회 지정 시각에만 DB에 접속한다.
//   중간 점검을 위한 주기적 폴링을 하지 않으므로 Neon 컴퓨트를 깨우지 않는다.
// ════════════════════════════════════════════════════════════

const db = require('./db');

const DEFAULTS = {
  enabled: true,
  retentionDays: 30,   // 과정 종료 후 보관 일수
  hour: 4,             // 매일 실행 시각 (0~23, 한국시간)
};

let timer = null;

// ─── 설정 조회 ───────────────────────────────────────────────
async function getCleanupSettings() {
  try {
    const r = await db.query(
      "SELECT key, value FROM system_settings WHERE key IN " +
      "('log_cleanup_enabled','log_retention_days','log_cleanup_hour')"
    );
    const m = {};
    r.rows.forEach(function (row) { m[row.key] = row.value; });

    const days = parseInt(m.log_retention_days, 10);
    const hour = parseInt(m.log_cleanup_hour, 10);

    return {
      enabled: m.log_cleanup_enabled === undefined
        ? DEFAULTS.enabled
        : String(m.log_cleanup_enabled) === 'true',
      retentionDays: (isFinite(days) && days >= 0 && days <= 3650) ? days : DEFAULTS.retentionDays,
      hour: (isFinite(hour) && hour >= 0 && hour <= 23) ? hour : DEFAULTS.hour,
    };
  } catch (err) {
    console.error('[Cleanup] 설정 조회 실패, 기본값 사용:', err.message);
    return Object.assign({}, DEFAULTS);
  }
}

// ─── 삭제 대상 건수 미리보기 (실제 삭제 없음) ────────────────
async function previewCleanup(retentionDays) {
  const r = await db.query(`
    SELECT COUNT(*)::int AS cnt
    FROM attendance_attempts a
    WHERE COALESCE(
            (SELECT MAX(cs.session_date)
             FROM enrollments e
             JOIN course_sessions cs ON cs.course_id = e.course_id
             WHERE e.student_id::text = a.student_id),
            a.created_at::date
          ) < (CURRENT_DATE - ($1::int || ' days')::interval)
  `, [retentionDays]);
  return r.rows[0].cnt;
}

// ─── 실제 파기 ───────────────────────────────────────────────
async function runCleanup(retentionDays) {
  const r = await db.query(`
    DELETE FROM attendance_attempts a
    WHERE COALESCE(
            (SELECT MAX(cs.session_date)
             FROM enrollments e
             JOIN course_sessions cs ON cs.course_id = e.course_id
             WHERE e.student_id::text = a.student_id),
            a.created_at::date
          ) < (CURRENT_DATE - ($1::int || ' days')::interval)
  `, [retentionDays]);
  return r.rowCount;
}

// ─── 현황 조회 (관리자 화면용) ───────────────────────────────
async function getLogStats() {
  const r = await db.query(`
    SELECT COUNT(*)::int AS total,
           MIN(created_at) AS oldest,
           MAX(created_at) AS newest,
           COUNT(*) FILTER (WHERE result = 'fail')::int AS fail_count
    FROM attendance_attempts
  `);
  return r.rows[0];
}

// ─── 다음 실행까지 남은 밀리초 ───────────────────────────────
// 한국시간(UTC+9) 기준 지정 시각으로 계산한다.
function msUntilNextRun(hour) {
  const KST_OFFSET_MIN = 9 * 60;
  const now = new Date();
  const nowKstMin = now.getUTCHours() * 60 + now.getUTCMinutes() + KST_OFFSET_MIN;
  const targetMin = hour * 60;

  let diff = targetMin - (nowKstMin % (24 * 60));
  if (diff <= 0) diff += 24 * 60;

  // 분 단위 오차 보정
  return (diff * 60 - now.getUTCSeconds()) * 1000;
}

// ─── 스케줄러 ────────────────────────────────────────────────
async function cycle() {
  let cfg;
  try {
    cfg = await getCleanupSettings();

    if (cfg.enabled) {
      const deleted = await runCleanup(cfg.retentionDays);
      if (deleted > 0) {
        console.log('[Cleanup] 시도 로그 ' + deleted + '건 파기 (보관기간: 과정 종료 후 ' + cfg.retentionDays + '일)');
      } else {
        console.log('[Cleanup] 파기 대상 없음');
      }
    } else {
      console.log('[Cleanup] 자동 파기가 꺼져 있어 건너뜀');
    }
  } catch (err) {
    console.error('[Cleanup] 실행 오류:', err.message);
    cfg = cfg || Object.assign({}, DEFAULTS);
  }

  timer = setTimeout(cycle, msUntilNextRun(cfg.hour));
}

async function startCleanupScheduler() {
  if (timer) clearTimeout(timer);
  const cfg = await getCleanupSettings();
  const wait = msUntilNextRun(cfg.hour);
  timer = setTimeout(cycle, wait);
  console.log('[Cleanup] 자동 파기 스케줄러 시작 (매일 ' + cfg.hour + '시, 보관기간 ' + cfg.retentionDays +
    '일, 다음 실행까지 ' + Math.round(wait / 60000) + '분)');
}

// 설정 변경 후 스케줄을 다시 잡을 때 사용
function restartCleanupScheduler() {
  return startCleanupScheduler();
}

module.exports = {
  startCleanupScheduler,
  restartCleanupScheduler,
  runCleanup,
  previewCleanup,
  getCleanupSettings,
  getLogStats,
};
