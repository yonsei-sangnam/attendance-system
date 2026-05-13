const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const db = require('./db');

// ─── RP(Relying Party) 설정 ──────────────────────────────────
// 서버 도메인에서 자동 추출 (Render 배포 시 자동 적용)
// ─────────────────────────────────────────────────────────────
function getRPConfig(req) {
  const host = req.get('host');                        // 예: attendance-system-xxxx.onrender.com
  const rpID = host.split(':')[0];                     // 포트 제거
  const origin = `https://${host}`;          // 예: https://attendance-system-xxxx.onrender.com
  return {
    rpName: '출결 관리 시스템',
    rpID,
    origin,
  };
}

// ─── 1. 등록 옵션 생성 ───────────────────────────────────────
// 수강생이 이름+전화번호로 본인확인 후 호출
// 브라우저에 "지문/Face ID 등록하시겠습니까?" 프롬프트를 띄울 데이터 생성
// ─────────────────────────────────────────────────────────────
async function createRegistrationOptions(req, studentId, studentName) {
  const rp = getRPConfig(req);

  // 이미 등록된 크레덴셜 조회 (중복 방지)
  const existing = await db.query(
    'SELECT webauthn_cred_id FROM credentials WHERE student_id = $1',
    [studentId]
  );
  const excludeCredentials = existing.rows.map(row => ({
    id: row.webauthn_cred_id,
    type: 'public-key',
  }));

  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userID: new TextEncoder().encode(studentId),
    userName: studentName,
    userDisplayName: studentName,
    attestationType: 'none',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',      // 기기 내장 생체인증만 (USB키 등 제외)
      userVerification: 'required',             // 반드시 생체인증 수행
      residentKey: 'preferred',
    },
    excludeCredentials,
  });

  // 챌린지를 DB에 임시 저장 (검증 시 비교용)
  await db.query(`
    INSERT INTO auth_challenges (student_id, challenge, type, expires_at)
    VALUES ($1, $2, 'registration', NOW() + INTERVAL '5 minutes')
    ON CONFLICT (student_id, type) DO UPDATE SET challenge = $2, expires_at = NOW() + INTERVAL '5 minutes'
  `, [studentId, options.challenge]);

  return options;
}

// ─── 2. 등록 검증 ────────────────────────────────────────────
// 브라우저에서 생체인증 완료 후 보내온 응답을 검증하고 DB에 저장
// ─────────────────────────────────────────────────────────────
async function verifyRegistration(req, studentId, response) {
  const rp = getRPConfig(req);

  // 저장된 챌린지 조회
  const challengeRes = await db.query(
    "SELECT challenge FROM auth_challenges WHERE student_id = $1 AND type = 'registration' AND expires_at > NOW()",
    [studentId]
  );
  if (challengeRes.rows.length === 0) {
    throw new Error('등록 세션이 만료되었습니다. 다시 시도해주세요.');
  }
  const expectedChallenge = challengeRes.rows[0].challenge;

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('생체인증 등록에 실패했습니다.');
  }

  const { credential } = verification.registrationInfo;

  // 크레덴셜 DB 저장
  await db.query(`
    INSERT INTO credentials (student_id, webauthn_cred_id, public_key, counter, transports)
    VALUES ($1, $2, $3, $4, $5)
  `, [
    studentId,
    credential.id,
    Buffer.from(credential.publicKey).toString('base64url'),
    credential.counter,
    response.response.transports || [],
  ]);

  // 챌린지 삭제
  await db.query(
    "DELETE FROM auth_challenges WHERE student_id = $1 AND type = 'registration'",
    [studentId]
  );

  return { verified: true };
}

// ─── 3. 인증 옵션 생성 ───────────────────────────────────────
// QR 스캔 후 "지문/Face ID를 인증해주세요" 프롬프트를 띄울 데이터 생성
// ─────────────────────────────────────────────────────────────
async function createAuthenticationOptions(req, studentId) {
  const rp = getRPConfig(req);

  // 등록된 크레덴셜 조회
  const creds = await db.query(
    'SELECT webauthn_cred_id, transports FROM credentials WHERE student_id = $1',
    [studentId]
  );

  if (creds.rows.length === 0) {
    throw new Error('등록된 생체인증 정보가 없습니다. 먼저 등록을 완료해주세요.');
  }

  const allowCredentials = creds.rows.map(row => ({
    id: row.webauthn_cred_id,
    type: 'public-key',
    transports: row.transports || [],
  }));

  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'required',
    allowCredentials,
  });

  // 챌린지 임시 저장
  await db.query(`
    INSERT INTO auth_challenges (student_id, challenge, type, expires_at)
    VALUES ($1, $2, 'authentication', NOW() + INTERVAL '5 minutes')
    ON CONFLICT (student_id, type) DO UPDATE SET challenge = $2, expires_at = NOW() + INTERVAL '5 minutes'
  `, [studentId, options.challenge]);

  return options;
}

// ─── 4. 인증 검증 ────────────────────────────────────────────
// 브라우저에서 생체인증 완료 후 보내온 응답을 검증
// ─────────────────────────────────────────────────────────────
async function verifyAuthentication(req, studentId, response) {
  const rp = getRPConfig(req);

  // 챌린지 조회
  const challengeRes = await db.query(
    "SELECT challenge FROM auth_challenges WHERE student_id = $1 AND type = 'authentication' AND expires_at > NOW()",
    [studentId]
  );
  if (challengeRes.rows.length === 0) {
    throw new Error('인증 세션이 만료되었습니다. QR을 다시 스캔해주세요.');
  }
  const expectedChallenge = challengeRes.rows[0].challenge;

  // 해당 크레덴셜 조회
  const credRes = await db.query(
    'SELECT webauthn_cred_id, public_key, counter FROM credentials WHERE student_id = $1 AND webauthn_cred_id = $2',
    [studentId, response.id]
  );
  if (credRes.rows.length === 0) {
    throw new Error('등록되지 않은 기기입니다.');
  }
  const cred = credRes.rows[0];

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: {
      id: cred.webauthn_cred_id,
      publicKey: Buffer.from(cred.public_key, 'base64url'),
      counter: parseInt(cred.counter),
    },
  });

  if (!verification.verified) {
    throw new Error('생체인증에 실패했습니다.');
  }

  // 카운터 업데이트 + 마지막 사용 시각
  await db.query(
    'UPDATE credentials SET counter = $1, last_used_at = NOW() WHERE webauthn_cred_id = $2',
    [verification.authenticationInfo.newCounter, response.id]
  );

  // 챌린지 삭제
  await db.query(
    "DELETE FROM auth_challenges WHERE student_id = $1 AND type = 'authentication'",
    [studentId]
  );

  return { verified: true };
}

// ─── 5. 수강생 등록 여부 확인 ────────────────────────────────
async function hasCredential(studentId) {
  const res = await db.query(
    'SELECT COUNT(*) AS cnt FROM credentials WHERE student_id = $1',
    [studentId]
  );
  return parseInt(res.rows[0].cnt) > 0;
}

module.exports = {
  createRegistrationOptions,
  verifyRegistration,
  createAuthenticationOptions,
  verifyAuthentication,
  hasCredential,
};
