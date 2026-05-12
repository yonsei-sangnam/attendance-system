const crypto = require('crypto');
const db = require('./db');

// ─── 토큰 생성 ───────────────────────────────────────────────
// 60초마다 새 토큰 생성, 그레이스 30초 추가 허용
// ─────────────────────────────────────────────────────────────
async function generateToken(classroomCode) {
  // 1. 강의실 확인
  const crRes = await db.query(
    'SELECT classroom_id FROM classrooms WHERE classroom_code = $1',
    [classroomCode]
  );
  if (crRes.rows.length === 0) {
    throw new Error('존재하지 않는 강의실: ' + classroomCode);
  }
  const classroomId = crRes.rows[0].classroom_id;

  // 2. 랜덤 토큰 생성 (URL-safe 16자)
  const tokenValue = crypto.randomBytes(24).toString('base64url');

  // 3. 시간 계산
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 1000);       // 60초 후
  const graceUntil = new Date(expiresAt.getTime() + 30 * 1000); // +30초 그레이스

  // 4. DB 저장
  await db.query(`
    INSERT INTO qr_tokens (classroom_id, token_value, issued_at, expires_at, grace_until)
    VALUES ($1, $2, $3, $4, $5)
  `, [classroomId, tokenValue, now, expiresAt, graceUntil]);

  // 5. 오래된 토큰 정리 (5분 이상 지난 것)
  await db.query(`
    DELETE FROM qr_tokens WHERE grace_until < NOW() - INTERVAL '5 minutes'
  `);

  return {
    token: tokenValue,
    classroomCode,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    graceUntil: graceUntil.toISOString(),
  };
}

// ─── 토큰 검증 ───────────────────────────────────────────────
// 수강생이 QR 스캔 후 서버로 보낸 토큰이 유효한지 확인
// ─────────────────────────────────────────────────────────────
async function validateToken(tokenValue, classroomCode) {
  const result = await db.query(`
    SELECT qt.token_id, qt.classroom_id, qt.expires_at, qt.grace_until,
           c.classroom_code, c.classroom_name
    FROM qr_tokens qt
    JOIN classrooms c ON c.classroom_id = qt.classroom_id
    WHERE qt.token_value = $1 AND c.classroom_code = $2
  `, [tokenValue, classroomCode]);

  if (result.rows.length === 0) {
    return { valid: false, reason: '유효하지 않은 QR 코드입니다. 새 QR을 스캔해주세요.' };
  }

  const row = result.rows[0];
  const now = new Date();

  // 그레이스 피리어드까지 허용
  if (now > new Date(row.grace_until)) {
    return { valid: false, reason: 'QR 코드가 만료되었습니다. 새 QR을 스캔해주세요.' };
  }

  return {
    valid: true,
    classroomId: row.classroom_id,
    classroomCode: row.classroom_code,
    classroomName: row.classroom_name,
  };
}

module.exports = { generateToken, validateToken };
