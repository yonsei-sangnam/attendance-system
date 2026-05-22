const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const db = require('./db');

// ─── 패스키 전용 챌린지 저장소 (서버 메모리) ─────────────────
const passkeyChallengStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of passkeyChallengStore) {
    if (val.expires < now) passkeyChallengStore.delete(key);
  }
}, 60000);

// ─── RP(Relying Party) 설정 ──────────────────────────────────
// 서버 도메인에서 자동 추출 (Render 배포 시 자동 적용)
// ─────────────────────────────────────────────────────────────
function getRPConfig(req) {
  const host = req.get('host');                        // 예: attendance-system-xxxx.onrender.com
  const rpID = host.split(':')[0];                     // 포트 제거
  const origin = `${req.protocol}://${host}`;          // 예: https://attendance-system-xxxx.onrender.com
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
      residentKey: 'required',
    },
    // excludeCredentials 제거: 재등록 허용 (기존 크레덴셜은 검증 시 삭제됨)
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

  // 기존 크레덴셜 삭제 (1인 1기기 정책: 새 기기 등록 시 기존 전부 삭제)
  await db.query('DELETE FROM credentials WHERE student_id = $1', [studentId]);

  // 기존 푸시 구독도 삭제 (구 기기 구독은 무의미)
  await db.query('DELETE FROM push_subscriptions WHERE student_id = $1', [studentId]);

  // 새 크레덴셜 저장
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

// ─── 6. 패스키 직접 인증 옵션 ────────────────────────────────
// studentId 지정 시: 해당 수강생의 크레덴셜만 허용 (퇴실 본인 인증)
// studentId 없을 시: 기기의 모든 패스키 표시 (QR 스캔 후 본인 선택)
async function createPasskeyAuthOptions(req, studentId) {
  const rp = getRPConfig(req);

  let allowCredentials = undefined;
  if (studentId) {
    const creds = await db.query(
      'SELECT webauthn_cred_id, transports FROM credentials WHERE student_id = $1',
      [studentId]
    );
    if (creds.rows.length === 0) throw new Error('등록된 생체인증 정보가 없습니다.');
    allowCredentials = creds.rows.map(row => ({
      id: row.webauthn_cred_id,
      type: 'public-key',
      transports: row.transports || [],
    }));
  }

  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'required',
    ...(allowCredentials ? { allowCredentials } : {}),
  });

  // 챌린지를 메모리에 저장 (5분 만료), studentId도 함께 저장
  passkeyChallengStore.set(options.challenge, {
    expires: Date.now() + 5 * 60 * 1000,
    studentId: studentId || null,
  });

  return options;
}

// ─── 7. 패스키 직접 인증 검증 (credential ID로 수강생 조회) ──
async function verifyPasskeyAuth(req, response) {
  const rp = getRPConfig(req);

  // credential ID로 수강생 조회
  const credRes = await db.query(
    'SELECT student_id, webauthn_cred_id, public_key, counter FROM credentials WHERE webauthn_cred_id = $1',
    [response.id]
  );
  if (credRes.rows.length === 0) {
    throw new Error('NOT_FOUND');
  }
  const cred = credRes.rows[0];

  // 챌린지 검증: response.clientDataJSON에서 challenge 추출
  // verifyAuthenticationResponse가 내부적으로 처리하므로, expectedChallenge를 찾아서 전달
  // clientDataJSON을 디코딩하여 challenge 추출
  const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString());
  const challenge = clientData.challenge;

  // 챌린지 저장 시 기록된 studentId와 교차 검증
  const storedData = passkeyChallengStore.get(challenge);
  if (!storedData) {
    throw new Error('인증 세션이 만료되었습니다. 다시 시도해주세요.');
  }
  passkeyChallengStore.delete(challenge);

  // studentId가 지정된 경우 인증한 크레덴셜이 해당 수강생의 것인지 확인
  if (storedData.studentId && cred.student_id !== storedData.studentId) {
    throw new Error('WRONG_STUDENT');
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: {
      id: cred.webauthn_cred_id,
      publicKey: Buffer.from(cred.public_key, 'base64url'),
      counter: parseInt(cred.counter),
    },
  });

  if (!verification.verified) {
    throw new Error('인증에 실패했습니다.');
  }

  // 카운터 업데이트
  await db.query(
    'UPDATE credentials SET counter = $1, last_used_at = NOW() WHERE webauthn_cred_id = $2',
    [verification.authenticationInfo.newCounter, response.id]
  );

  // 수강생 정보 조회
  const studentRes = await db.query('SELECT name, phone FROM students WHERE student_id = $1', [cred.student_id]);
  const student = studentRes.rows[0];

  return {
    verified: true,
    studentId: cred.student_id,
    studentName: student ? student.name : 'unknown',
  };
}

module.exports = {
  createRegistrationOptions,
  verifyRegistration,
  createAuthenticationOptions,
  verifyAuthentication,
  hasCredential,
  createPasskeyAuthOptions,
  verifyPasskeyAuth,
};
