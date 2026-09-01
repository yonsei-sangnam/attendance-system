require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const db = require('./db');
const qr = require('./qr');
const auth = require('./auth');
const attend = require('./attendance');
const admin = require('./admin');
const sync = require('./sync');
const push = require('./push');
const layout = require('./layout');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══ 관리자 인증 (로그인/로그아웃) ════════════════════════════
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'sangnam-attendance-secret-key-2026';

function makeAdminToken() {
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(String(expires)).digest('hex');
  return expires + '.' + sig;
}

function verifyAdminToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const expires = parseInt(parts[0], 10);
  if (Date.now() > expires) return false;
  const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(String(expires)).digest('hex');
  return parts[1] === expected;
}

function parseCookies(req) {
  var obj = {};
  var header = req.headers.cookie || '';
  header.split(';').forEach(function(pair) {
    var idx = pair.indexOf('=');
    if (idx < 0) return;
    obj[pair.substring(0, idx).trim()] = pair.substring(idx + 1).trim();
  });
  return obj;
}

app.get('/admin/login', (req, res) => {
  const errMsg = req.query.error === '1'
    ? '비밀번호가 올바르지 않습니다.'
    : (req.query.expired === '1' ? '세션이 만료되었습니다. 다시 로그인해 주세요.' : '');
  const errCls = errMsg ? ' err' : '';

  res.send(`<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>관리자 로그인 · 상남경영원 출결관리시스템</title>
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/admin-manifest.json">
<meta name="theme-color" content="#003876">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="출결 관리자">
<meta name="application-name" content="출결 관리자">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Noto+Sans+KR:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  :root {
    --navy:#003876; --blue2:#005bab; --dgray:#656668;
    --lgray:#e4e5e6; --bg:#f4f5f6; --ink:#202223;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { background:var(--bg); }
  body {
    font-family:"Archivo","Noto Sans KR",-apple-system,BlinkMacSystemFont,"Malgun Gothic",system-ui,sans-serif;
    color:var(--ink); -webkit-font-smoothing:antialiased;
  }
  input, button { font-family:inherit; }
  input::placeholder { color:#7c7c7f; }
  ::selection { background:#dce8f5; }

  @keyframes drift {
    0%   { transform:translate3d(0,0,0) scale(1); }
    50%  { transform:translate3d(2%,-3%,0) scale(1.06); }
    100% { transform:translate3d(0,0,0) scale(1); }
  }

  .wrap { display:flex; flex-wrap:wrap; min-height:100vh; background:var(--bg); }

  /* ── 좌측 히어로 (PC 전용) ── */
  .hero { display:none; }
  .hero-glow-a {
    position:absolute; inset:-20% -10%;
    background:radial-gradient(42% 42% at 38% 34%, #0b47b8 0%, rgba(0,56,118,0.92) 38%, rgba(0,91,171,0.45) 62%, rgba(244,245,246,0) 82%);
    filter:blur(28px); animation:drift 18s ease-in-out infinite;
  }
  .hero-glow-b {
    position:absolute; inset:0;
    background:radial-gradient(64% 54% at 76% 26%, rgba(119,169,232,0.42) 0%, rgba(0,56,118,0) 72%);
  }
  .hero-inner {
    position:relative; z-index:2; height:100%;
    display:flex; flex-direction:column; padding:44px 48px;
  }
  .logo-chip {
    align-self:flex-start; background:#fff; border-radius:16px;
    padding:16px 22px; box-shadow:0 6px 18px rgba(0,20,50,0.18);
  }
  .logo-chip img { height:58px; width:auto; display:block; }
  .hero-body { margin-top:auto; }
  .eyebrow { font-size:12px; font-weight:700; letter-spacing:0.22em; color:rgba(255,255,255,0.72); }
  .hero-title { font-size:44px; font-weight:800; letter-spacing:-0.03em; line-height:1.1; color:#fff; margin-top:14px; }
  .hero-desc { font-size:14px; font-weight:500; line-height:1.7; color:rgba(255,255,255,0.78); margin-top:16px; max-width:400px; }
  .hero-foot { display:flex; gap:16px; margin-top:36px; font-size:12px; font-weight:700; color:#fff; }
  .hero-foot .ver { margin-left:auto; }

  /* ── 우측 로그인 영역 ── */
  .pane {
    flex:1 1 380px; min-width:0; display:flex;
    align-items:center; justify-content:center;
    padding:40px 20px; position:relative;
  }
  .soft-glow {
    position:absolute; inset:auto -10% -30% 20%; height:70%;
    background:radial-gradient(50% 50% at 50% 50%, rgba(0,91,171,0.14) 0%, rgba(244,245,246,0) 72%);
    filter:blur(10px); pointer-events:none;
  }
  .card {
    position:relative; z-index:2; width:100%; max-width:420px;
    background:#fff; border-radius:26px; padding:40px 36px 34px;
    box-shadow:0 18px 50px rgba(0,56,118,0.10), 0 2px 6px rgba(0,56,118,0.05);
  }
  .card-logo { display:block; height:72px; width:auto; margin-bottom:24px; }
  .card-title { font-size:26px; font-weight:800; letter-spacing:-0.025em; color:var(--ink); }
  .card-sub { font-size:13.5px; font-weight:500; color:var(--dgray); margin-top:8px; }

  .field-label { font-size:12px; font-weight:700; color:var(--dgray); display:block; margin-bottom:8px; }
  .field {
    display:flex; align-items:center; gap:6px; padding:0 8px 0 14px;
    background:#f7f8f9; border-radius:16px; border:1.5px solid #eceded;
    transition:border-color .15s ease;
  }
  .field:focus-within { border-color:var(--navy); }
  .field.err { border-color:#f0b3b2; }
  .field input {
    flex:1; height:54px; border:none; outline:none; background:transparent;
    font-size:15px; font-weight:600; letter-spacing:0.02em; padding:0 4px; color:var(--ink);
  }
  .eye {
    appearance:none; border:none; background:transparent; cursor:pointer;
    padding:0 10px; height:40px; font-size:12px; font-weight:700; color:var(--dgray);
  }
  .msg { min-height:18px; margin-top:8px; font-size:12px; font-weight:600; color:#D32F2F; }

  .submit {
    appearance:none; border:none; cursor:pointer; display:block;
    width:100%; height:56px; margin-top:6px; border-radius:16px;
    background:var(--navy); color:#fff;
    font-size:15.5px; font-weight:800; letter-spacing:-0.01em;
    box-shadow:0 8px 20px rgba(0,56,118,0.22);
    transition:background .15s ease;
  }
  .submit:hover { background:var(--blue2); }

  .divider { display:flex; align-items:center; gap:10px; margin-top:22px; }
  .divider .line { flex:1; height:1px; background:var(--lgray); }
  .divider span { font-size:11px; font-weight:700; color:var(--dgray); letter-spacing:0.06em; }

  .ghost {
    appearance:none; cursor:pointer; display:block; width:100%; height:48px;
    margin-top:18px; border-radius:16px; border:1px solid var(--lgray);
    background:#fff; font-size:13.5px; font-weight:700; color:var(--navy);
    transition:background .15s ease;
  }
  .ghost:hover { background:#f7f8f9; }

  .note { font-size:11.5px; font-weight:500; color:var(--dgray); line-height:1.7; margin-top:26px; }
  .help { display:none; font-size:12px; font-weight:600; color:var(--navy); background:#dce8f5;
          border-radius:12px; padding:12px 14px; line-height:1.6; margin-top:12px; }
  .help.on { display:block; }

  /* ── PC(900px 이상): 분할형 ── */
  @media (min-width:900px) {
    .hero {
      display:block; position:relative; flex:1 1 420px; max-width:720px;
      margin:16px 0 16px 16px; border-radius:28px; overflow:hidden;
      background:linear-gradient(140deg, #003876 0%, #004a8c 55%, #2a63a8 100%);
    }
    .card-logo { display:none; }
    .soft-glow { display:none; }
  }
</style></head>
<body>
<div class="wrap">

  <div class="hero">
    <div class="hero-glow-a"></div>
    <div class="hero-glow-b"></div>
    <div class="hero-inner">
      <div class="logo-chip">
        <img src="/logo.png" alt="연세대학교 상남경영원">
      </div>
      <div class="hero-body">
        <div class="eyebrow">SANGNAM &middot; ATTENDANCE</div>
        <div class="hero-title">출결 관리<br>시스템</div>
        <div class="hero-desc">동적 QR과 생체인증으로 입&middot;퇴실을 확인하고,<br>출석부를 자동으로 정리합니다.</div>
      </div>
      <div class="hero-foot">
        <span>교육 담당자 &middot; 관리자 전용</span>
        <span class="ver">v2026.08</span>
      </div>
    </div>
  </div>

  <div class="pane">
    <div class="soft-glow"></div>
    <div class="card">
      <img class="card-logo" src="/logo.png" alt="연세대학교 상남경영원">
      <div class="card-title">관리자 로그인</div>
      <div class="card-sub">상남경영원 출결관리시스템</div>

      <form method="POST" action="/admin/login" style="margin-top:28px;">
        <label class="field-label" for="pw">관리자 비밀번호</label>
        <div class="field${errCls}" id="field">
          <input type="password" id="pw" name="password" placeholder="비밀번호 입력" autocomplete="current-password" autofocus required>
          <button type="button" class="eye" id="eye">표시</button>
        </div>
        <div class="msg">${errMsg}</div>
        <button type="submit" class="submit">로그인</button>
      </form>

      <div class="divider"><div class="line"></div><span>또는</span><div class="line"></div></div>
      <button type="button" class="ghost" id="helpBtn">비밀번호를 잊으셨나요?</button>
      <div class="help" id="help">시스템 담당자에게 문의해 주세요.<br>비밀번호는 서버 환경변수로 관리됩니다.</div>

      <div class="note">이 페이지는 교육 담당자 전용입니다.<br>수강생은 안내받은 앱 또는 등록 주소로 접속해 주세요.</div>
    </div>
  </div>

</div>
<script>
  (function() {
    var pw = document.getElementById('pw');
    var eye = document.getElementById('eye');
    var field = document.getElementById('field');
    eye.addEventListener('click', function() {
      var showing = pw.type === 'text';
      pw.type = showing ? 'password' : 'text';
      eye.textContent = showing ? '표시' : '숨기기';
      pw.focus();
    });
    pw.addEventListener('input', function() { field.classList.remove('err'); });

    var helpBtn = document.getElementById('helpBtn');
    var help = document.getElementById('help');
    helpBtn.addEventListener('click', function() { help.classList.toggle('on'); });
  })();
</script>
</body></html>`);
});

app.post('/admin/login', (req, res) => {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return res.status(500).send('ADMIN_PASSWORD 환경변수가 설정되지 않았습니다.');
  if (req.body.password === pw) {
    const token = makeAdminToken();
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', [
      'admin_token=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400' + secure,
      'admin_token=deleted; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0'
    ]);
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', [
    'admin_token=deleted; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    'admin_token=deleted; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0'
  ]);
  res.redirect('/admin/login');
});

// 관리자 인증 미들웨어
app.use('/admin', (req, res, next) => {
  const cookies = parseCookies(req);
  if (verifyAdminToken(cookies.admin_token)) return next();
  res.redirect('/admin/login' + (cookies.admin_token ? '?expired=1' : ''));
});

// /api/admin 경로도 인증 보호
app.use('/api/admin', (req, res, next) => {
  const cookies = parseCookies(req);
  if (verifyAdminToken(cookies.admin_token)) return next();
  res.status(401).json({ error: '관리자 인증이 필요합니다.' });
});

// 관리자 출결 현황 라우트 등록
admin.registerAdminRoutes(app);


// ════════════════════════════════════════════════════════════
// 기본 라우트
// ════════════════════════════════════════════════════════════

// ─── iOS 패스키 공유 설정 ────────────────────────────────────
app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    webcredentials: {
      apps: ['J453F5677M.com.soulstaryonsei.sangnamapp']
    }
  });
});

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ─── 개인정보처리방침 ────────────────────────────────────────
app.get('/privacy', (req, res) => {
  var html = '<!DOCTYPE html>'
    + '<html lang="ko"><head>'
    + '<meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>개인정보처리방침 - 상남경영원 출결 관리 시스템</title>'
    + '<style>'
    + 'body { font-family:-apple-system,sans-serif; max-width:720px;'
    + '  margin:0 auto; padding:24px; color:#333; line-height:1.8; }'
    + 'h1 { font-size:22px; color:#003876; border-bottom:2px solid #003876;'
    + '  padding-bottom:12px; margin-bottom:24px; }'
    + 'h2 { font-size:17px; color:#003876; margin-top:32px; margin-bottom:8px; }'
    + 'p, li { font-size:15px; }'
    + 'ul { padding-left:20px; }'
    + '.updated { color:#888; font-size:13px; margin-top:40px;'
    + '  border-top:1px solid #eee; padding-top:16px; }'
    + '</style>'
    + '</head><body>'
    + '<h1>개인정보처리방침</h1>'
    + '<p>연세대학교 상남경영원(이하 "기관")은 출결 관리 시스템(이하 "서비스") 운영에 있어 '
    + '이용자의 개인정보를 중요시하며, 개인정보 보호법 등 관련 법령을 준수합니다.</p>'
    + ''
    + '<h2>1. 수집하는 개인정보 항목</h2>'
    + '<p>서비스는 출결 관리 목적으로 다음 정보를 수집합니다.</p>'
    + '<ul>'
    + '<li><strong>전화번호:</strong> 수강생 식별 및 로그인에 사용</li>'
    + '<li><strong>이름:</strong> 출결 기록 관리에 사용</li>'
    + '<li><strong>위치 정보:</strong> 출결 확인 시 강의실 위치 검증에 사용 (대략적 위치)</li>'
    + '<li><strong>생체인식 정보:</strong> 본인 확인을 위한 FIDO2 공개키 (생체 데이터 자체는 기기에만 저장되며 서버로 전송되지 않음)</li>'
    + '<li><strong>기기 식별 토큰:</strong> 푸시 알림 발송에 사용 (FCM 토큰)</li>'
    + '</ul>'
    + ''
    + '<h2>2. 개인정보의 수집 및 이용 목적</h2>'
    + '<ul>'
    + '<li>수강생 출결(입실/퇴실) 확인 및 기록</li>'
    + '<li>출결 현황 조회 제공</li>'
    + '<li>퇴실 알림 푸시 발송</li>'
    + '<li>부정 출결 방지를 위한 위치 및 생체 인증</li>'
    + '</ul>'
    + ''
    + '<h2>3. 개인정보의 보유 및 이용 기간</h2>'
    + '<p>수집된 개인정보는 해당 교육 과정 종료 후 지체 없이 파기합니다. '
    + '단, 관련 법령에 의한 보존 의무가 있는 경우 해당 기간 동안 보관합니다.</p>'
    + ''
    + '<h2>4. 개인정보의 제3자 제공</h2>'
    + '<p>기관은 이용자의 개인정보를 제3자에게 제공하지 않습니다. '
    + '다만, 법령에 의한 요청이 있는 경우에는 관련 법령에 따라 제공할 수 있습니다.</p>'
    + ''
    + '<h2>5. 개인정보의 안전성 확보 조치</h2>'
    + '<ul>'
    + '<li>모든 통신은 HTTPS를 통한 암호화 전송</li>'
    + '<li>생체인증은 FIDO2/WebAuthn 표준을 사용하여 생체 데이터가 서버에 저장되지 않음</li>'
    + '<li>비밀번호는 단방향 해시(bcrypt)로 암호화 저장</li>'
    + '<li>데이터베이스 접근 권한 제한</li>'
    + '</ul>'
    + ''
    + '<h2>6. 이용자의 권리</h2>'
    + '<p>이용자는 언제든지 다음의 권리를 행사할 수 있습니다.</p>'
    + '<ul>'
    + '<li>개인정보 열람 요청</li>'
    + '<li>개인정보 수정 요청</li>'
    + '<li>개인정보 삭제 요청</li>'
    + '<li>개인정보 처리 정지 요청</li>'
    + '</ul>'
    + '<p>위 요청은 기관 담당자에게 연락하여 처리할 수 있습니다.</p>'
    + ''
    + '<h2>7. 개인정보 보호 책임자</h2>'
    + '<p>연세대학교 상남경영원<br>'
    + '문의: 상남경영원 행정팀</p>'
    + ''
    + '<p class="updated">최종 수정일: 2026년 8월 11일</p>'
    + '</body></html>';

  res.send(html);
});

// ═══ 지원 페이지 (App Store 심사용 지원 URL) ═════════════════════
app.get('/support', (req, res) => {
  var html = '<!DOCTYPE html><html lang="ko"><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<title>고객지원 · 상남경영원 출결관리시스템</title>'
    + '<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">'
    + '<link rel="apple-touch-icon" href="/apple-touch-icon.png">'
    + '<style>'
    + '* { margin:0; padding:0; box-sizing:border-box; }'
    + 'body { font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic",system-ui,sans-serif;'
    + '  background:#f4f5f6; color:#202223; -webkit-font-smoothing:antialiased; }'
    + '.wrap { max-width:640px; margin:0 auto; padding:56px 24px 80px; }'
    + '.logo { height:56px; width:auto; display:block; margin-bottom:28px; }'
    + 'h1 { font-size:28px; font-weight:800; letter-spacing:-0.02em; }'
    + '.lead { font-size:14px; font-weight:500; color:#656668; margin-top:8px; line-height:1.7; }'
    + '.card { background:#fff; border-radius:20px; padding:24px; margin-top:24px;'
    + '  box-shadow:0 2px 12px rgba(0,0,0,0.05); }'
    + '.card h2 { font-size:16px; font-weight:800; letter-spacing:-0.01em; }'
    + '.card p, .card li { font-size:14px; line-height:1.8; color:#333; margin-top:10px; }'
    + '.card ul { padding-left:20px; }'
    + '.row { display:flex; gap:10px; align-items:flex-start; margin-top:14px; }'
    + '.row .k { flex:0 0 88px; font-size:13px; font-weight:700; color:#656668; }'
    + '.row .v { font-size:14px; font-weight:600; }'
    + '.row a { color:#003876; text-decoration:none; font-weight:700; }'
    + '.row a:hover { text-decoration:underline; }'
    + '.foot { margin-top:32px; font-size:12px; color:#9a9b9d; text-align:center; }'
    + '</style></head><body>'
    + '<div class="wrap">'
    + '  <img class="logo" src="/logo.png" alt="연세대학교 상남경영원">'
    + '  <h1>고객지원</h1>'
    + '  <div class="lead">상남경영원 출결 관리 앱 관련 문의 및 지원 안내입니다.</div>'

    + '  <div class="card">'
    + '    <h2>앱 소개</h2>'
    + '    <p>본 앱은 연세대학교 상남경영원 교육과정 수강생을 위한 출결 관리 앱입니다. '
    + 'QR코드와 생체인증(Face ID·지문)을 통해 입실·퇴실을 기록하며, 사전에 등록된 수강생만 이용할 수 있습니다.</p>'
    + '  </div>'

    + '  <div class="card">'
    + '    <h2>문의하기</h2>'
    + '    <div class="row"><div class="k">담당자</div><div class="v">상남경영원 출결관리시스템 담당자</div></div>'
    + '    <div class="row"><div class="k">이메일</div><div class="v"><a href="mailto:soulstaryonsei@gmail.com">soulstaryonsei@gmail.com</a></div></div>'
    + '    <div class="row"><div class="k">운영시간</div><div class="v">평일 09:00 ~ 18:00</div></div>'
    + '  </div>'

    + '  <div class="card">'
    + '    <h2>자주 묻는 질문</h2>'
    + '    <ul>'
    + '      <li><strong>로그인이 안 돼요.</strong> 등록된 전화번호와 일치하는지 확인해 주세요. 문의처로 연락 주시면 확인해 드립니다.</li>'
    + '      <li><strong>생체인증이 안 돼요.</strong> 설정 &gt; 얼굴 인식 및 암호(또는 Touch ID)에서 앱 권한이 허용되어 있는지 확인해 주세요.</li>'
    + '      <li><strong>QR 인식이 안 돼요.</strong> 카메라 권한이 허용되어 있는지, QR코드가 화면에 선명하게 보이는지 확인해 주세요.</li>'
    + '      <li><strong>퇴실 처리가 안 돼요.</strong> 지정된 강의실 반경 안에 있는지 확인해 주세요. 위치 권한이 꺼져 있으면 설정에서 허용해 주세요.</li>'
    + '    </ul>'
    + '  </div>'

    + '  <div class="foot">연세대학교 상남경영원 &middot; Sangnam Institute of Management, Yonsei University</div>'
    + '</div>'
    + '</body></html>';

  res.send(html);
});

// ═══ 루트: 수강생 앱으로 안내 ═════════════════════════════════
app.get('/', (req, res) => {
  res.redirect('/app');
});

// ═══ 관리자 대시보드 ═════════════════════════════════════════
app.get('/admin', async (req, res) => {
  try {
    const KST = "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE";

    const dbCheck = await db.query('SELECT NOW() AS server_time');
    const classrooms = await db.query('SELECT classroom_code, classroom_name FROM classrooms ORDER BY classroom_code');

    // ── 오늘 진행 중인 수업 ──────────────────────────────
    const todayRows = await db.query(`
      SELECT cs.session_id, cs.session_number, cs.start_time, cs.end_time,
             c.course_id, c.course_name, c.course_code, c.cohort,
             COALESCE(cr.classroom_name, dcr.classroom_name) AS room_name,
             (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.course_id) AS enrolled,
             (SELECT COUNT(*) FROM attendance a
               WHERE a.session_id = cs.session_id AND a.check_in_at IS NOT NULL) AS checked_in
      FROM course_sessions cs
      JOIN courses c ON c.course_id = cs.course_id
      LEFT JOIN classrooms cr ON cr.classroom_id = cs.classroom_id
      LEFT JOIN classrooms dcr ON dcr.classroom_id = c.default_classroom_id
      WHERE cs.session_date = ${KST}
      ORDER BY cs.start_time, c.course_name
    `);

    // ── 오늘의 출결 집계 ─────────────────────────────────
    const kpi = await db.query(`
      SELECT
        (SELECT COUNT(DISTINCT cs.course_id) FROM course_sessions cs
          WHERE cs.session_date = ${KST}) AS courses_today,
        (SELECT COUNT(*) FROM course_sessions cs
          JOIN enrollments e ON e.course_id = cs.course_id
          WHERE cs.session_date = ${KST}) AS expected,
        (SELECT COUNT(*) FROM attendance a
          JOIN course_sessions cs ON cs.session_id = a.session_id
          WHERE cs.session_date = ${KST} AND a.check_in_at IS NOT NULL) AS checked_in,
        (SELECT COUNT(*) FROM attendance a
          JOIN course_sessions cs ON cs.session_id = a.session_id
          WHERE cs.session_date = ${KST} AND a.exit_type = '퇴실미확인') AS no_checkout
    `);

    // ── 전체 누적 현황 ───────────────────────────────────
    const totals = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM courses) AS courses,
        (SELECT COUNT(*) FROM classrooms) AS classrooms,
        (SELECT COUNT(*) FROM students) AS students,
        (SELECT COUNT(DISTINCT student_id) FROM credentials) AS creds,
        (SELECT COUNT(*) FROM course_sessions) AS sessions,
        (SELECT COUNT(*) FROM attendance) AS attendance
    `);

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    res.send(renderAdminPage({
      serverTime: dbCheck.rows[0].server_time,
      baseUrl,
      classrooms: classrooms.rows,
      today: todayRows.rows,
      kpi: kpi.rows[0],
      totals: totals.rows[0],
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

// ─── API: 앱용 QR 토큰 검증 (JSON 응답) ─────────────────────
app.post('/api/app/validate-scan', async (req, res) => {
  try {
    const { token, room } = req.body;
    if (!token || !room) {
      return res.json({ valid: false, reason: 'QR 코드를 다시 스캔해주세요.' });
    }
    const result = await qr.validateToken(token, room);
    if (!result.valid) {
      return res.json({ valid: false, reason: result.reason });
    }
    res.json({
      valid: true,
      classroomCode: result.classroomCode,
      classroomName: result.classroomName
    });
  } catch (err) {
    res.status(500).json({ valid: false, reason: err.message });
  }
});

// ─── 앱 전용: Chrome 생체인증 페이지 ─────────────────────────
app.get('/app-auth', async (req, res) => {
  var action = req.query.action || '';
  var studentId = req.query.studentId || '';
  var phone = req.query.phone || '';
  var classroomCode = req.query.classroomCode || '';
  var attendanceId = req.query.attendanceId || '';
  var returnUrl = req.query.returnUrl || '';
  if (!action || !studentId || !returnUrl) {
    return res.status(400).send('Missing parameters');
  }

  // ── 앱(expo-location)이 넘겨준 좌표. 숫자로만 통과시켜 주입을 차단한다 ──
  var latNum = parseFloat(req.query.lat);
  var lngNum = parseFloat(req.query.lng);
  var accNum = parseFloat(req.query.acc);
  var appLat = isFinite(latNum) ? String(latNum) : '';
  var appLng = isFinite(lngNum) ? String(lngNum) : '';
  var appAcc = isFinite(accNum) ? String(accNum) : '';

  var html = '<!DOCTYPE html>'
    + '<html><head>'
    + '<meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>생체인증</title>'
    + '<style>'
    + '* { margin:0; padding:0; box-sizing:border-box; }'
    + 'body { font-family:-apple-system,sans-serif; background:#f5f5f5;'
    + '  display:flex; align-items:center; justify-content:center;'
    + '  min-height:100vh; padding:20px; }'
    + '.card { background:#fff; border-radius:16px; padding:32px;'
    + '  text-align:center; max-width:360px; width:100%;'
    + '  box-shadow:0 2px 12px rgba(0,0,0,0.1); }'
    + '.status { font-size:18px; color:#003876; font-weight:bold; margin-bottom:16px; }'
    + '.sub { font-size:14px; color:#666; margin-bottom:24px; }'
    + '.spinner { width:40px; height:40px; border:4px solid #e0e0e0;'
    + '  border-top-color:#003876; border-radius:50%;'
    + '  animation:spin 1s linear infinite; margin:0 auto 16px; }'
    + '@keyframes spin { to { transform:rotate(360deg); } }'
    + '.error { color:#d32f2f; font-size:14px; margin-top:12px; }'
    + '.retry-btn { background:#003876; color:#fff; border:none;'
    + '  padding:14px 32px; border-radius:8px; font-size:16px;'
    + '  font-weight:bold; cursor:pointer; margin-top:16px; }'
    + '.done-btn { background:#4caf50; color:#fff; border:none;'
    + '  padding:16px 40px; border-radius:8px; font-size:18px;'
    + '  font-weight:bold; cursor:pointer; margin-top:20px; }'
    + '.done-msg { font-size:48px; margin-bottom:12px; }'
    + '.loc-error { font-size:15px; color:#ff3b30; font-weight:600; margin-bottom:8px; }'
    + '.loc-sub { font-size:13px; color:#86868b; }'
    + '</style>'
    + '</head><body>'
    + '<div class="card">'
    + '  <div class="spinner" id="spinner"></div>'
    + '  <div class="status" id="status">준비 중...</div>'
    + '  <div class="sub" id="sub">잠시만 기다려주세요</div>'
    + '  <div id="errorArea"></div>'
    + '</div>'
    + '<script>'
    + 'var ACTION = "' + action + '";'
    + 'var STUDENT_ID = "' + studentId + '";'
    + 'var PHONE = "' + phone + '";'
    + 'var CLASSROOM_CODE = "' + classroomCode + '";'
    + 'var ATTENDANCE_ID = "' + attendanceId + '";'
    + 'var RETURN_URL = decodeURIComponent("' + encodeURIComponent(returnUrl) + '");'
    + 'var APP_LAT = "' + appLat + '";'
    + 'var APP_LNG = "' + appLng + '";'
    + 'var APP_ACC = "' + appAcc + '";'
    + 'var MAX_ACCURACY = 500;'
    + ''
    + 'function goBack(success, msg) {'
    + '  var sep = RETURN_URL.indexOf("?") >= 0 ? "&" : "?";'
    + '  var url = RETURN_URL + sep + "success=" + success + "&message=" + encodeURIComponent(msg || "");'
    + '  window.location.href = url;'
    + '}'
    + ''
    + 'function showDone(msg) {'
    + '  document.querySelector(".card").innerHTML ='
    + '    \'<div class="done-msg">\\u2705</div>\''
    + '    + \'<div class="status">\' + msg + \'</div>\''
    + '    + \'<div class="sub">아래 버튼을 눌러 앱으로 돌아가세요</div>\''
    + '    + \'<button class="done-btn" onclick="goBack(\\\'true\\\', \\\'\' + msg + \'\\\')">\''
    + '    + \'앱으로 돌아가기</button>\';'
    + '}'
    + ''
    + 'function showError(text) {'
    + '  document.getElementById("spinner").style.display = "none";'
    + '  document.getElementById("status").textContent = "오류 발생";'
    + '  document.getElementById("sub").textContent = "";'
    + '  document.getElementById("errorArea").innerHTML ='
    + '    \'<div class="error">\' + text + \'</div>\''
    + '    + \'<button class="retry-btn" onclick="location.reload()">다시 시도</button>\';'
    + '}'
    + ''
    + 'function showLocationError(title, sub) {'
    + '  document.getElementById("spinner").style.display = "none";'
    + '  document.getElementById("status").textContent = "";'
    + '  document.getElementById("sub").textContent = "";'
    + '  document.getElementById("errorArea").innerHTML ='
    + '    \'<div style="font-size:48px;margin-bottom:12px;">\\ud83d\\udea8</div>\''
    + '    + \'<div class="loc-error">\' + title + \'</div>\''
    + '    + \'<div class="loc-sub">\' + sub + \'</div>\''
    + '    + \'<button class="retry-btn" onclick="location.reload()">다시 시도</button>\';'
    + '}'
    + ''
    + 'function getDistanceMeters(lat1, lon1, lat2, lon2) {'
    + '  var R = 6371000;'
    + '  var dLat = (lat2 - lat1) * Math.PI / 180;'
    + '  var dLon = (lon2 - lon1) * Math.PI / 180;'
    + '  var a = Math.sin(dLat/2) * Math.sin(dLat/2)'
    + '    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)'
    + '    * Math.sin(dLon/2) * Math.sin(dLon/2);'
    + '  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));'
    + '  return R * c;'
    + '}'
    + ''
    + 'async function checkLocation() {'
    + '  try {'
    + '    var bldgRes = await fetch("/api/settings/building");'
    + '    var bldg = await bldgRes.json();'
    + ''
    + '    if (!bldg.enabled || !bldg.lat || !bldg.lng) {'
    + '      return true;'
    + '    }'
    + ''
    + '    var myLat, myLng;'
    + ''
    + '    if (APP_LAT !== "" && APP_LNG !== "") {'
    + '      if (APP_ACC !== "" && parseFloat(APP_ACC) > MAX_ACCURACY) {'
    + '        showLocationError("위치 정확도 부족", "설정에서 정확한 위치를 켜고 다시 시도해주세요.");'
    + '        return false;'
    + '      }'
    + '      myLat = parseFloat(APP_LAT);'
    + '      myLng = parseFloat(APP_LNG);'
    + '    } else {'
    + '      document.getElementById("status").textContent = "위치 확인 중...";'
    + '      document.getElementById("sub").textContent = "GPS 정보를 가져오고 있습니다";'
    + '      var pos;'
    + '      try {'
    + '        pos = await new Promise(function(resolve, reject) {'
    + '          navigator.geolocation.getCurrentPosition(resolve, reject,'
    + '            { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });'
    + '        });'
    + '      } catch (firstErr) {'
    + '        pos = await new Promise(function(resolve, reject) {'
    + '          navigator.geolocation.getCurrentPosition(resolve, reject,'
    + '            { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 });'
    + '        });'
    + '      }'
    + '      myLat = pos.coords.latitude;'
    + '      myLng = pos.coords.longitude;'
    + '    }'
    + ''
    + '    var dist = getDistanceMeters(myLat, myLng, bldg.lat, bldg.lng);'
    + ''
    + '    if (dist > (bldg.radius || 200)) {'
    + '      showLocationError("건물 외부 감지", "강의실 근처에서 다시 시도해주세요.");'
    + '      return false;'
    + '    }'
    + ''
    + '    return true;'
    + '  } catch (locErr) {'
    + '    showLocationError("위치 확인 실패", "위치 정보를 가져올 수 없습니다. 담당자에게 문의하세요.");'
    + '    return false;'
    + '  }'
    + '}'
    + ''
    + 'function bufferToBase64url(buffer) {'
    + '  var bytes = new Uint8Array(buffer);'
    + '  var str = "";'
    + '  bytes.forEach(function(b) { str += String.fromCharCode(b); });'
    + '  return btoa(str).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");'
    + '}'
    + ''
    + 'function base64urlToBuffer(base64url) {'
    + '  var base64 = base64url.replace(/-/g,"+").replace(/_/g,"/");'
    + '  var pad = base64.length % 4;'
    + '  var padded = pad ? base64 + "=".repeat(4 - pad) : base64;'
    + '  var binary = atob(padded);'
    + '  var bytes = new Uint8Array(binary.length);'
    + '  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);'
    + '  return bytes.buffer;'
    + '}'
    + ''
    + 'async function doRegister() {'
    + '  try {'
    + '    document.getElementById("status").textContent = "서버 연결 중...";'
    + ''
    + '    var lookupRes = await fetch("/api/register/phone-lookup", {'
    + '      method:"POST", headers:{"Content-Type":"application/json"},'
    + '      body: JSON.stringify({ phone: PHONE })'
    + '    });'
    + '    var lookupData = await lookupRes.json();'
    + '    if (!lookupData.found || !lookupData.hasToken) {'
    + '      showError("수강생 정보를 찾을 수 없습니다."); return;'
    + '    }'
    + '    var freshToken = lookupData.token;'
    + ''
    + '    var optRes = await fetch("/api/register/options", {'
    + '      method:"POST", headers:{"Content-Type":"application/json"},'
    + '      body: JSON.stringify({ studentId: STUDENT_ID, token: freshToken })'
    + '    });'
    + '    var options = await optRes.json();'
    + '    if (options.error) { showError(options.error); return; }'
    + ''
    + '    options.challenge = base64urlToBuffer(options.challenge);'
    + '    options.user.id = base64urlToBuffer(options.user.id);'
    + '    if (options.excludeCredentials) {'
    + '      options.excludeCredentials = options.excludeCredentials.map(function(c) {'
    + '        return Object.assign({}, c, { id: base64urlToBuffer(c.id) });'
    + '      });'
    + '    }'
    + ''
    + '    document.getElementById("status").textContent = "생체인증을 진행해주세요";'
    + '    document.getElementById("sub").textContent = "얼굴인식 또는 지문을 사용합니다";'
    + ''
    + '    var credential = await navigator.credentials.create({ publicKey: options });'
    + ''
    + '    document.getElementById("status").textContent = "등록 확인 중...";'
    + '    document.getElementById("sub").textContent = "";'
    + ''
    + '    var response = {'
    + '      id: credential.id,'
    + '      rawId: bufferToBase64url(credential.rawId),'
    + '      type: credential.type,'
    + '      response: {'
    + '        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),'
    + '        attestationObject: bufferToBase64url(credential.response.attestationObject)'
    + '      }'
    + '    };'
    + ''
    + '    var verRes = await fetch("/api/register/verify", {'
    + '      method:"POST", headers:{"Content-Type":"application/json"},'
    + '      body: JSON.stringify({ studentId: STUDENT_ID, token: freshToken, response: response })'
    + '    });'
    + '    var verResult = await verRes.json();'
    + ''
    + '    if (verResult.verified) {'
    + '      showDone("등록 완료!");'
    + '    } else {'
    + '      showError(verResult.error || "등록 검증 실패");'
    + '    }'
    + '  } catch(e) {'
    + '    if (e.name === "NotAllowedError" || e.name === "AbortError") {'
    + '      showError("인증이 취소되었습니다.");'
    + '    } else {'
    + '      showError(e.message || "알 수 없는 오류");'
    + '    }'
    + '  }'
    + '}'
    + ''
    + 'async function doAuthenticate() {'
    + '  try {'
    + '    var locOk = await checkLocation();'
    + '    if (!locOk) return;'
    + ''
    + '    document.getElementById("status").textContent = "서버 연결 중...";'
    + '    document.getElementById("sub").textContent = "";'
    + '    document.getElementById("spinner").style.display = "block";'
    + ''
    + '    var optRes = await fetch("/api/auth/passkey-start", {'
    + '      method:"POST", headers:{"Content-Type":"application/json"},'
    + '      body: JSON.stringify({ studentId: STUDENT_ID })'
    + '    });'
    + '    var options = await optRes.json();'
    + '    if (options.error) { showError(options.error); return; }'
    + ''
    + '    options.challenge = base64urlToBuffer(options.challenge);'
    + '    if (options.allowCredentials) {'
    + '      options.allowCredentials = options.allowCredentials.map(function(c) {'
    + '        return Object.assign({}, c, { id: base64urlToBuffer(c.id) });'
    + '      });'
    + '    }'
    + ''
    + '    document.getElementById("status").textContent = "생체인증을 진행해주세요";'
    + '    document.getElementById("sub").textContent = "얼굴인식 또는 지문을 사용합니다";'
    + ''
    + '    var credential = await navigator.credentials.get({ publicKey: options });'
    + ''
    + '    document.getElementById("status").textContent = "인증 확인 중...";'
    + '    document.getElementById("sub").textContent = "";'
    + ''
    + '    var response = {'
    + '      id: credential.id,'
    + '      rawId: bufferToBase64url(credential.rawId),'
    + '      type: credential.type,'
    + '      response: {'
    + '        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),'
    + '        authenticatorData: bufferToBase64url(credential.response.authenticatorData),'
    + '        signature: bufferToBase64url(credential.response.signature),'
    + '        userHandle: credential.response.userHandle'
    + '          ? bufferToBase64url(credential.response.userHandle) : null'
    + '      }'
    + '    };'
    + ''
    + '    var verRes;'
    + '    if (ATTENDANCE_ID) {'
    + '      verRes = await fetch("/api/auth/checkout", {'
    + '        method:"POST", headers:{"Content-Type":"application/json"},'
    + '        body: JSON.stringify({ response: response, studentId: STUDENT_ID, attendanceId: ATTENDANCE_ID })'
    + '      });'
    + '    } else if (CLASSROOM_CODE) {'
    + '      verRes = await fetch("/api/auth/passkey-verify", {'
    + '        method:"POST", headers:{"Content-Type":"application/json"},'
    + '        body: JSON.stringify({ response: response, classroomCode: CLASSROOM_CODE })'
    + '      });'
    + '    } else {'
    + '      showError("인증 파라미터 부족");'
    + '      return;'
    + '    }'
    + ''
    + '    var verResult = await verRes.json();'
    + ''
    + '    if (verResult.verified || verResult.success) {'
    + '      showDone(verResult.message || "인증 완료!");'
    + '    } else {'
    + '      showError(verResult.error || verResult.message || "인증 실패");'
    + '    }'
    + '  } catch(e) {'
    + '    if (e.name === "NotAllowedError" || e.name === "AbortError") {'
    + '      showError("인증이 취소되었습니다.");'
    + '    } else {'
    + '      showError(e.message || "알 수 없는 오류");'
    + '    }'
    + '  }'
    + '}'
    + ''
    + 'if (ACTION === "register") doRegister();'
    + 'else doAuthenticate();'
    + '</script>'
    + '</body></html>';

  res.send(html);
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
      ORDER BY cs.start_time ASC
    `, [req.params.studentId]);
    if (r.rows.length === 0) return res.json({ hasRecord: false });
    res.json({ hasRecord: true, records: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── 전체 출결 기록 조회 (앱 기록 탭용) ──────────────────────
// ─── 전체 출결 기록 조회 (앱 기록 탭용) ──────────────────────
app.get('/api/my/history/:studentId', async (req, res) => {
  try {
    var sid = req.params.studentId;

    // enrollments 기준으로 전체 세션 조회, 출결 기록이 없으면 결석 처리
    var records = await db.query(
      "SELECT a.attendance_id, a.check_in_at, a.check_out_at," +
      " COALESCE(a.status, '결석') AS status," +
      " COALESCE(a.exit_type, '정상') AS exit_type," +
      " cs.session_number, cs.session_date, cs.start_time, cs.end_time," +
      " c.course_name," +
      " COALESCE(cr.classroom_name, dcr.classroom_name) AS classroom_name" +
      " FROM enrollments e" +
      " JOIN courses c ON c.course_id = e.course_id" +
      " JOIN course_sessions cs ON cs.course_id = e.course_id" +
      " LEFT JOIN attendance a ON a.student_id = e.student_id AND a.session_id = cs.session_id" +
      " LEFT JOIN classrooms cr ON cr.classroom_id = cs.classroom_id" +
      " LEFT JOIN classrooms dcr ON dcr.classroom_id = c.default_classroom_id" +
      " WHERE e.student_id = $1" +
      " AND (" +
      "   cs.session_date < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE" +
      "   OR (" +
      "     cs.session_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE" +
      "     AND cs.end_time < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::TIME" +
      "   )" +
      " )" +
      " ORDER BY cs.session_date DESC, cs.start_time DESC",
      [sid]
    );

    // 통계 계산 (enrollments 기준)
    var statsResult = await db.query(
      "SELECT COUNT(*) as total," +
      " COUNT(CASE WHEN a.status = '출석' THEN 1 END) as attended," +
      " COUNT(CASE WHEN a.status = '지각' THEN 1 END) as late," +
      " COUNT(CASE WHEN a.status = '조퇴' THEN 1 END) as early_leave," +
      " COUNT(CASE WHEN a.status IS NULL THEN 1 END) as absent" +
      " FROM enrollments e" +
      " JOIN course_sessions cs ON cs.course_id = e.course_id" +
      " LEFT JOIN attendance a ON a.student_id = e.student_id AND a.session_id = cs.session_id" +
      " WHERE e.student_id = $1" +
      " AND (" +
      "   cs.session_date < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE" +
      "   OR (" +
      "     cs.session_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::DATE" +
      "     AND cs.end_time < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::TIME" +
      "   )" +
      " )",
      [sid]
    );

    var row = statsResult.rows[0];
    var total = parseInt(row.total) || 0;
    var attended = parseInt(row.attended) || 0;
    var late = parseInt(row.late) || 0;
    var earlyLeave = parseInt(row.early_leave) || 0;
    var absent = parseInt(row.absent) || 0;
    var rate = total > 0 ? Math.round((attended / total) * 100) : 0;

    res.json({
      records: records.rows,
      stats: { total: total, attended: attended, late: late, earlyLeave: earlyLeave, absent: absent, rate: rate }
    });
  } catch (err) {
    console.error('[History] 조회 오류:', err.message);
    res.status(500).json({ error: '출결 기록 조회 실패' });
  }
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
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
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

      // ─── 거리 계산 (Haversine) ────────────────────────────
      function getDistanceMeters(lat1, lon1, lat2, lon2) {
        var R = 6371000;
        var p1 = lat1 * Math.PI / 180;
        var p2 = lat2 * Math.PI / 180;
        var dp = (lat2 - lat1) * Math.PI / 180;
        var dl = (lon2 - lon1) * Math.PI / 180;
        var a = Math.sin(dp/2)*Math.sin(dp/2) + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      }

      // ─── 위치 확인 (입실용) ───────────────────────────────
      async function checkLocationForCheckin(msgEl) {
        var buildingSettings = { enabled: false };
        try { var sRes = await fetch('/api/settings/building'); buildingSettings = await sRes.json(); } catch (e) {}
        if (!buildingSettings.enabled || !buildingSettings.lat || !buildingSettings.lng) return true;
        msgEl.innerHTML = '<div class="msg msg-info" style="display:flex;align-items:center;justify-content:center;gap:8px;"><span class="spinner"></span> 위치 확인 중...</div>';
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
            msgEl.innerHTML = '<div class="msg msg-error" style="text-align:center;"><div style="font-size:24px;margin-bottom:6px;">\ud83d\udeab</div><div style="font-weight:600;">건물 외부 감지</div><div style="font-size:13px;color:#86868b;margin-top:4px;">강의실 근처에서 다시 시도해주세요.</div></div>';
            return false;
          }
          msgEl.innerHTML = '';
          return true;
        } catch (locErr) {
          msgEl.innerHTML = '<div class="msg msg-error" style="text-align:center;"><div style="font-size:24px;margin-bottom:6px;">\ud83d\udccd</div><div style="font-weight:600;">위치 확인 실패</div><div style="font-size:13px;color:#86868b;margin-top:4px;">위치 정보를 가져올 수 없습니다.<br>담당자에게 문의하세요.</div></div>';
          return false;
        }
      }

      // ─── 0. 패스키 직접 인증 (전화번호 불필요) ───────────
      async function passkeyAuth() {
        const btn = document.getElementById('passkeyBtn');
        const msgEl = document.getElementById('passkeyMsg');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 위치 확인 중...';
        msgEl.innerHTML = '';

        var locOk = await checkLocationForCheckin(msgEl);
        if (!locOk) { btn.disabled = false; btn.innerHTML = '인증하기'; btn.style.fontSize = '18px'; return; }

        btn.innerHTML = '<span class="spinner"></span> 인증 중...';

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

        // 출결 완료 후 5초 뒤 /app으로 자동 이동
        if (a && a.success && (a.type === 'check_in' || a.type === 'check_out' || a.type === 'already_done')) {
          var countEl = document.getElementById('doneTime');
          var sec = 5;
          var origText = countEl.textContent;
          var autoTimer = setInterval(function() {
            sec--;
            countEl.textContent = origText + ' (' + sec + '초 후 앱으로 이동)';
            if (sec <= 0) { clearInterval(autoTimer); var pv = document.getElementById('phoneInput').value.trim(); if (pv && pv.length >= 7) { localStorage.setItem('app_phone', pv); } location.href = '/app'; }
          }, 1000);
        }
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
        btn.innerHTML = '<span class="spinner"></span> 위치 확인 중...';
        msgEl.innerHTML = '';

        var locOk = await checkLocationForCheckin(msgEl);
        if (!locOk) { btn.disabled = false; btn.textContent = '지문 / Face ID 인증'; return; }

        btn.innerHTML = '<span class="spinner"></span> 인증 중...';

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
          // 등록 옵션 요청 (토큰 포함)
          const optRes = await fetch('/api/register/options', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: currentStudentId, token: currentRegToken })
          });
          const options = await optRes.json();
          if (options.error) throw new Error(options.error);

          // 브라우저 생체인증 등록
          const regResp = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });

          // 서버 검증 (토큰 포함)
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

      async function prefetchOptions() {
        try {
          const optRes = await fetch('/api/register/options', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: STUDENT_ID, token: REG_TOKEN })
          });
          const options = await optRes.json();
          if (!options.error) { prefetchedOptions = options; }
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
            var optRes = await fetch('/api/register/options', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ studentId: STUDENT_ID, token: REG_TOKEN })
            });
            options = await optRes.json();
            if (options.error) throw new Error(options.error);
          }

          const regResp = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
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
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
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
    .install-guide { background:#fff3e0; border:1px solid #ffcc80; border-radius:14px; padding:20px; margin-top:20px; font-size:14px; color:#1d1d1f; line-height:1.7; }
    .install-guide .ig-title { font-size:16px; font-weight:700; color:#e65100; margin-bottom:14px; display:flex; align-items:center; gap:8px; }
    .install-guide .ig-step { display:flex; align-items:flex-start; gap:10px; margin-bottom:10px; }
    .install-guide .ig-num { flex-shrink:0; width:24px; height:24px; background:#e65100; color:#fff; border-radius:50%; font-size:13px; font-weight:700; display:flex; align-items:center; justify-content:center; }
    .install-guide .ig-text { font-size:13px; color:#333; }
    .install-guide .ig-text b { color:#e65100; }
    .install-guide .ig-note { background:#fff8e1; border-radius:8px; padding:10px 12px; margin-top:12px; font-size:12px; color:#e65100; line-height:1.6; }
    .install-guide .ig-dismiss { display:block; margin:14px auto 0; padding:8px 20px; background:none; border:1.5px solid #e65100; border-radius:8px; color:#e65100; font-size:13px; font-weight:600; cursor:pointer; }
    .install-guide .ig-samsung { background:#ff5252; color:#fff; border-radius:10px; padding:14px 16px; margin-bottom:14px; font-size:13px; line-height:1.7; }
    .install-guide .ig-samsung b { color:#fff; }
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
        var el = document.getElementById('todayStatus');
        try {
          var res = await fetch('/api/my/status/' + appStudentId);
          var data = await res.json();

          if (!data.hasRecord) {
            el.innerHTML = '<div class="msg msg-info">오늘 출결 기록이 없습니다.</div>';
            return;
          }

          var records = data.records || [];
          window._checkoutData = null;

          var html = '<div style="font-size:13px;font-weight:600;margin-bottom:10px;">오늘 출결 현황</div>';

          for (var i = 0; i < records.length; i++) {
            var r = records[i];
            html += '<div style="background:#f5f5f7;border-radius:10px;padding:14px;margin-bottom:10px;">';
            html += '<div class="status-row"><span class="status-label2">과정</span><span class="status-value2">' + (r.course_name || '-') + '</span></div>';
            html += '<div class="status-row"><span class="status-label2">수업</span><span class="status-value2">' + (r.start_time ? r.start_time.slice(0,5) : '') + ' ~ ' + (r.end_time ? r.end_time.slice(0,5) : '') + '</span></div>';
            html += '<div class="status-row"><span class="status-label2">입실</span><span class="status-value2">' + (r.check_in_at ? new Date(r.check_in_at).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit'}) : '-') + '</span></div>';
            html += '<div class="status-row"><span class="status-label2">퇴실</span><span class="status-value2">' + (r.check_out_at ? new Date(r.check_out_at).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit'}) : '-') + '</span></div>';
            html += '<div class="status-row"><span class="status-label2">상태</span><span class="status-value2">' + (r.status || '-') + '</span></div>';

            if (r.check_in_at && !r.check_out_at && r.attendance_id) {
              if (!window._checkoutData) {
                window._checkoutData = { sid: appStudentId, aid: r.attendance_id };
              }
              html += '<div style="margin-top:12px;text-align:center;">';
              html += '<button onclick="setCheckoutTarget(' + r.attendance_id + ')" style="width:100%;padding:14px;background:#1a73e8;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;">🔐 퇴실하기</button>';
              html += '<div style="font-size:11px;color:#86868b;margin-top:4px;">위치 확인 + 생체인증 후 퇴실 처리됩니다</div>';
              html += '</div>';
            }

            html += '</div>';
          }

          el.innerHTML = html;
        } catch (err) {
          el.innerHTML = '<div class="msg msg-error">현황 조회 실패</div>';
        }
      }

      function setCheckoutTarget(aid) {
        window._checkoutData = { sid: appStudentId, aid: aid };
        manualCheckout();
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
        // 사용자가 직접 버튼을 터치한 경우(hasGesture=true)는 중복 방지 통과
        if (!hasGesture && checkoutFromPushHandled) return;

        // URL 파라미터 처리는 자동 호출 시에만 (버튼 터치 재시도 시 생략)
        if (!hasGesture) {
          var params = new URLSearchParams(window.location.search);
          if (params.get('checkout')) checkoutFromPushHandled = true;
          if (params.get('checkout') === 'true') {
            window._pendingCheckout = { sid: params.get('sid'), aid: params.get('aid') };
            window.history.replaceState({}, '', '/app');
          }
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
          // [비활성화] 위치 실패 시 건너뛰기 버튼 - 부정출석 방지를 위해 비활성화
          // locationPassed = await new Promise(function(resolve) {
          //   showMsg(... 생략 ...);
          //   document.getElementById('locSkipBtn').onclick = function() { resolve(true); };
          //   document.getElementById('locCancelBtn').onclick = function() { resolve(false); };
          // });
          showMsg('<div style="font-size:24px;margin-bottom:8px;">📍</div>'
            + '<div style="font-size:15px;font-weight:600;color:#ff3b30;">위치 확인 실패</div>'
            + '<div style="font-size:13px;color:#86868b;margin:8px 0;">위치 정보를 가져올 수 없습니다.<br>담당자에게 문의하세요.</div>');
          locationPassed = false;
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
        var el = document.getElementById('installGuide');
        if (!el) return;
        var isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
        if (isStandalone) { el.innerHTML = ''; return; }
        if (localStorage.getItem('install_guide_dismissed')) { el.innerHTML = ''; return; }

        var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
        var isAndroid = /android/i.test(navigator.userAgent);
        var isSamsung = /SamsungBrowser/i.test(navigator.userAgent);
        var html = '';

        if (isIOS) {
          html = '<div class="install-guide">'
            + '<div class="ig-title">📲 앱 설치 안내 (필수)</div>'
            + '<div class="ig-step"><span class="ig-num">1</span><span class="ig-text">화면 하단의 <b>공유 버튼 □↑</b> 을 누르세요</span></div>'
            + '<div class="ig-step"><span class="ig-num">2</span><span class="ig-text">목록에서 <b>"홈 화면에 추가"</b> 를 선택하세요</span></div>'
            + '<div class="ig-step"><span class="ig-num">3</span><span class="ig-text">오른쪽 상단 <b>"추가"</b> 를 누르면 완료!</span></div>'
            + '<div class="ig-note">⚠️ <b>반드시 Safari</b>에서 진행해야 합니다.<br>Chrome/네이버 등 다른 브라우저에서는 알림이 작동하지 않습니다.<br><br>💡 홈 화면에 추가해야 <b>퇴실 알림</b>을 받을 수 있습니다.</div>'
            + '<button class="ig-dismiss" onclick="dismissInstallGuide()">이미 설치했어요</button>'
            + '</div>';
        } else if (isAndroid) {
          var samsungWarning = '';
          if (isSamsung) {
            samsungWarning = '<div class="ig-samsung">⚠️ <b>삼성 인터넷 브라우저</b>에서는 알림이 작동하지 않습니다.<br><b>Chrome 브라우저</b>로 이 페이지를 열어서 설치해주세요.<br><br>📋 주소 복사: 주소창을 길게 눌러 복사 → Chrome에 붙여넣기</div>';
          }
          html = '<div class="install-guide">'
            + samsungWarning
            + '<div class="ig-title">📲 앱 설치 안내</div>'
            + '<div class="ig-step"><span class="ig-num">1</span><span class="ig-text"><b>Chrome</b> 브라우저에서 이 페이지를 여세요</span></div>'
            + '<div class="ig-step"><span class="ig-num">2</span><span class="ig-text">주소창 오른쪽 <b>메뉴(⋮)</b> 를 누르세요</span></div>'
            + '<div class="ig-step"><span class="ig-num">3</span><span class="ig-text"><b>"홈 화면에 추가"</b> 또는 <b>"앱 설치"</b> 를 선택하세요</span></div>'
            + '<div class="ig-note">💡 홈 화면에 앱으로 추가한 뒤, 위의 <b>퇴실 알림</b> 토글을 켜주세요.</div>'
            + '<button class="ig-dismiss" onclick="dismissInstallGuide()">이미 설치했어요</button>'
            + '</div>';
        }

        el.innerHTML = html;
      }

      function dismissInstallGuide() {
        localStorage.setItem('install_guide_dismissed', '1');
        var el = document.getElementById('installGuide');
        if (el) el.innerHTML = '';
      }

      document.getElementById('phoneInput').addEventListener('keypress', function(e) { if (e.key === 'Enter') appLogin(); });
      document.getElementById('phoneInput').focus();
    </script>
  </body></html>`;
}


// ─── 관리자 대시보드 ─────────────────────────────────────────
function renderAdminPage(data) {
  const esc = layout.esc;

  function fmtTime(t) {
    if (!t) return '—';
    return String(t).slice(0, 5);
  }
  function pct(a, b) {
    const n = Number(a) || 0, d = Number(b) || 0;
    if (!d) return 0;
    return Math.round((n / d) * 100);
  }

  // ── 1. 오늘 진행 중인 수업 ──────────────────────────
  let todayHtml;
  if (!data.today.length) {
    todayHtml = '<div class="sn-card" style="text-align:center;padding:40px 20px;color:var(--sn-gray);font-size:13.5px;font-weight:600;">'
              + '오늘 예정된 수업이 없습니다.</div>';
  } else {
    todayHtml = '<div class="sn-grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));">'
      + data.today.map(function(r) {
          const rate = pct(r.checked_in, r.enrolled);
          const barW = Math.min(100, rate);
          const barColor = rate >= 80 ? 'var(--sn-navy)' : (rate >= 50 ? '#2a63a8' : 'var(--sn-amber)');
          const abbr = r.course_code || '과정';
          return '<div class="sn-card" style="display:flex;flex-direction:column;gap:16px;">'
            + '<div>'
            +   '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">'
            +     '<span style="font-size:11.5px;font-weight:700;color:#fff;background:var(--sn-navy);padding:3px 9px;border-radius:999px;">' + esc(abbr) + '</span>'
            +     '<span style="font-size:11.5px;font-weight:600;color:var(--sn-gray);">' + esc(r.room_name || '강의실 미지정') + '</span>'
            +   '</div>'
            +   '<div style="font-size:17px;font-weight:800;letter-spacing:-0.015em;margin-top:9px;line-height:1.3;">'
            +     esc(r.course_name) + (r.cohort ? ' <span style="font-size:13px;font-weight:600;color:var(--sn-gray);">' + esc(r.cohort) + '기</span>' : '')
            +   '</div>'
            + '</div>'
            + '<div style="display:grid;grid-template-columns:repeat(3,1fr);background:var(--sn-bg);border-radius:14px;padding:12px 14px;">'
            +   '<div><div style="font-size:11px;font-weight:600;color:var(--sn-gray);">회차</div>'
            +     '<div style="font-size:15px;font-weight:800;margin-top:3px;font-variant-numeric:tabular-nums;">' + esc(r.session_number) + '회</div></div>'
            +   '<div><div style="font-size:11px;font-weight:600;color:var(--sn-gray);">수업시간</div>'
            +     '<div style="font-size:15px;font-weight:800;margin-top:3px;font-variant-numeric:tabular-nums;letter-spacing:-0.02em;">' + fmtTime(r.start_time) + '~' + fmtTime(r.end_time) + '</div></div>'
            +   '<div><div style="font-size:11px;font-weight:600;color:var(--sn-gray);">입실</div>'
            +     '<div style="font-size:15px;font-weight:800;margin-top:3px;font-variant-numeric:tabular-nums;">' + esc(r.checked_in) + '/' + esc(r.enrolled) + '</div></div>'
            + '</div>'
            + '<div style="display:flex;align-items:center;gap:12px;">'
            +   '<div style="flex:1;height:8px;background:var(--sn-line);border-radius:999px;overflow:hidden;">'
            +     '<div style="height:100%;width:' + barW + '%;background:' + barColor + ';border-radius:999px;"></div>'
            +   '</div>'
            +   '<span style="font-size:13px;font-weight:800;font-variant-numeric:tabular-nums;min-width:44px;text-align:right;">' + rate + '%</span>'
            + '</div>'
            + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
            +   '<a class="sn-btn sn-btn-primary" href="/admin/attendance">출결 조회·수정</a>'
            +   '<a class="sn-btn sn-btn-secondary" href="/admin/sync">시트 동기화</a>'
            + '</div>'
            + '</div>';
        }).join('')
      + '</div>';
  }

  // ── 2. 배포용 주소 · 강의실 QR ───────────────────────
  const appUrl = data.baseUrl + '/app';
  const regUrl = data.baseUrl + '/register';

  const roomTiles = data.classrooms.map(function(c) {
    return '<div style="display:flex;align-items:center;gap:10px;background:var(--sn-bg);border-radius:14px;padding:12px 14px;">'
      + '<div>'
      +   '<div style="font-size:13.5px;font-weight:800;">' + esc(c.classroom_name) + '</div>'
      +   '<div style="font-size:11.5px;font-weight:600;color:var(--sn-gray);font-variant-numeric:tabular-nums;margin-top:2px;">' + esc(c.classroom_code) + '</div>'
      + '</div>'
      + '<a class="sn-btn sn-btn-primary sn-btn-sm" style="margin-left:auto;" href="/qr/' + encodeURIComponent(c.classroom_code) + '" target="_blank" rel="noopener">QR 열기</a>'
      + '</div>';
  }).join('');

  // ── 3. 오늘의 출결 KPI ───────────────────────────────
  const k = data.kpi || {};
  const expected = Number(k.expected) || 0;
  const checkedIn = Number(k.checked_in) || 0;
  const missing = Math.max(0, expected - checkedIn);
  const rateAll = pct(checkedIn, expected);

  function kpiCard(label, value, bg, labelColor, valueColor) {
    return '<div class="sn-card" style="background:' + bg + ';">'
      + '<div style="font-size:12px;font-weight:700;color:' + labelColor + ';">' + esc(label) + '</div>'
      + '<div style="font-size:40px;font-weight:800;line-height:1;margin-top:12px;letter-spacing:-0.03em;color:' + valueColor + ';font-variant-numeric:tabular-nums;">' + esc(value) + '</div>'
      + '</div>';
  }

  const kpiHtml = '<div class="sn-grid" style="grid-template-columns:repeat(auto-fit,minmax(178px,1fr));margin-top:16px;">'
    + kpiCard('진행 중 과정', (k.courses_today || 0) + '개', '#fff', 'var(--sn-gray)', 'var(--sn-ink)')
    + kpiCard('오늘 수업 수강생', expected + '명', '#fff', 'var(--sn-gray)', 'var(--sn-ink)')
    + kpiCard('미입실', missing + '명', 'var(--sn-amber)', '#4a3505', '#2b1f03')
    + kpiCard('퇴실 미확인', (k.no_checkout || 0) + '명', '#fff', 'var(--sn-gray)', 'var(--sn-ink)')
    + kpiCard('오늘 출석률', rateAll + '%', 'var(--sn-navy)', '#a9c3dd', '#fff')
    + '</div>';

  // ── 4. 전체 누적 현황 ────────────────────────────────
  const t = data.totals || {};
  function totCell(label, value) {
    return '<div style="text-align:center;padding:6px 4px;">'
      + '<div style="font-size:24px;font-weight:800;color:var(--sn-navy);font-variant-numeric:tabular-nums;">' + esc(value) + '</div>'
      + '<div style="font-size:11.5px;font-weight:600;color:var(--sn-gray);margin-top:4px;">' + esc(label) + '</div>'
      + '</div>';
  }
  const totalsHtml = '<div class="sn-card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;">'
    + totCell('교육과정', t.courses || 0)
    + totCell('강의실', t.classrooms || 0)
    + totCell('수강생', t.students || 0)
    + totCell('생체인증 등록', t.creds || 0)
    + totCell('회차 스케줄', t.sessions || 0)
    + totCell('출결 기록', t.attendance || 0)
    + '</div>';

  // ── 본문 조립 ────────────────────────────────────────
  const body =
      '<section class="sn-section">'
    +   '<div class="sn-head-row">'
    +     '<h2 class="sn-h2">오늘 진행 중인 수업</h2>'
    +     '<span class="sn-sub">' + data.today.length + '개 회차</span>'
    +   '</div>'
    +   todayHtml
    + '</section>'

    + '<section class="sn-section">'
    +   '<div class="sn-head-row"><h2 class="sn-h2">배포용 주소 · 강의실 QR</h2></div>'
    +   '<div class="sn-grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));">'
    +     '<div class="sn-card">'
    +       '<div style="font-size:13.5px;font-weight:800;">수강생용 앱 (홈 화면 추가)</div>'
    +       '<div style="font-size:12px;color:var(--sn-gray);margin-top:8px;word-break:break-all;line-height:1.6;" id="urlApp">' + esc(appUrl) + '</div>'
    +       '<button type="button" class="sn-btn sn-btn-secondary" style="height:40px;font-size:12px;margin-top:14px;" data-copy="urlApp">주소 복사</button>'
    +     '</div>'
    +     '<div class="sn-card">'
    +       '<div style="font-size:13.5px;font-weight:800;">생체인증 등록 페이지</div>'
    +       '<div style="font-size:12px;color:var(--sn-gray);margin-top:8px;word-break:break-all;line-height:1.6;" id="urlReg">' + esc(regUrl) + '</div>'
    +       '<button type="button" class="sn-btn sn-btn-secondary" style="height:40px;font-size:12px;margin-top:14px;" data-copy="urlReg">주소 복사</button>'
    +     '</div>'
    +   '</div>'
    +   '<div class="sn-card" style="margin-top:14px;">'
    +     '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
    +       '<div style="font-size:15px;font-weight:800;letter-spacing:-0.015em;">강의실 QR</div>'
    +       '<span style="font-size:11px;font-weight:700;color:var(--sn-red);background:var(--sn-red-bg);padding:3px 9px;border-radius:999px;">주소 공유 금지</span>'
    +       '<span style="font-size:12px;color:var(--sn-gray);margin-left:auto;">각 강의실 태블릿·노트북에서 열어 두세요</span>'
    +     '</div>'
    +     '<div class="sn-grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-top:14px;">' + roomTiles + '</div>'
    +   '</div>'
    + '</section>'

    + '<section class="sn-section">'
    +   '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;">'
    +     '<div>'
    +       '<h2 class="sn-h2-lg">오늘의 출결</h2>'
    +       '<div style="font-size:13px;font-weight:500;color:var(--sn-gray);margin-top:6px;">진행 중인 수업 ' + (k.courses_today || 0) + '개 · 미입실 ' + missing + '명</div>'
    +     '</div>'
    +     '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    +       '<button type="button" class="sn-btn sn-btn-secondary" style="height:44px;" onclick="location.reload()">새로고침</button>'
    +       '<a class="sn-btn sn-btn-primary" style="height:44px;" href="/admin/attendance">출결 현황 열기</a>'
    +     '</div>'
    +   '</div>'
    +   kpiHtml
    + '</section>'

    + '<section class="sn-section">'
    +   '<div class="sn-head-row"><h2 class="sn-h2">전체 현황</h2></div>'
    +   totalsHtml
    + '</section>'

    + '<div id="snToast" style="position:fixed;left:50%;bottom:28px;transform:translateX(-50%);'
    +   'background:var(--sn-navy);color:#fff;font-size:13px;font-weight:700;padding:12px 20px;'
    +   'border-radius:999px;box-shadow:0 8px 24px rgba(0,56,118,0.25);opacity:0;pointer-events:none;'
    +   'transition:opacity .2s ease;z-index:50;"></div>';

  const pageJs =
      'document.querySelectorAll("[data-copy]").forEach(function(b){'
    +   'b.addEventListener("click", function(){'
    +     'var src=document.getElementById(b.getAttribute("data-copy"));'
    +     'if(!src) return;'
    +     'var text=src.textContent.trim();'
    +     'function done(){ showToast("주소를 복사했습니다"); }'
    +     'if(navigator.clipboard && window.isSecureContext){'
    +       'navigator.clipboard.writeText(text).then(done).catch(fallback);'
    +     '} else { fallback(); }'
    +     'function fallback(){'
    +       'var ta=document.createElement("textarea"); ta.value=text;'
    +       'ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta);'
    +       'ta.select(); try{ document.execCommand("copy"); done(); }catch(e){ showToast("복사에 실패했습니다"); }'
    +       'document.body.removeChild(ta);'
    +     '}'
    +   '});'
    + '});'
    + 'var toastTimer=null;'
    + 'function showToast(msg){'
    +   'var t=document.getElementById("snToast"); if(!t) return;'
    +   't.textContent=msg; t.style.opacity="1";'
    +   'clearTimeout(toastTimer); toastTimer=setTimeout(function(){ t.style.opacity="0"; },1800);'
    + '}';

  return layout.renderShell({
    active: 'dashboard',
    title: '대시보드',
    serverTime: data.serverTime,
    dbOk: true,
    body: body,
    pageJs: pageJs,
  });
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
      async function wl(){try{if('wakeLock' in navigator)await navigator.wakeLock.request('screen');}catch(e){}}wl();document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){wl();refresh();cd=60;}});
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
