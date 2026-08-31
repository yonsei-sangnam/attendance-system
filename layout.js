// ════════════════════════════════════════════════════════════
// layout.js — 관리자 화면 공통 셸 (헤더 + 탭 + 기본 스타일)
//
// 사용법:
//   const layout = require('./layout');
//   res.send(layout.renderShell({
//     active: 'dashboard',          // 탭 키
//     title: '대시보드',             // 브라우저 탭 제목
//     serverTime: <Date>,           // DB 서버 시각 (없으면 시계 숨김)
//     body: '<section>...</section>',
//     pageCss: '.foo { ... }',      // 화면 전용 CSS (선택)
//     pageJs:  'console.log(1);'    // 화면 전용 JS (선택)
//   }));
//
// CSS 클래스는 전부 sn- 접두사를 쓴다.
// 기존 관리자 화면의 .card / .btn / .table 과 이름이 겹치지 않으므로
// 아직 전환하지 않은 화면에 셸을 씌워도 스타일이 깨지지 않는다.
// ════════════════════════════════════════════════════════════

const TABS = [
  { key: 'dashboard',  label: '대시보드',      href: '/admin' },
  { key: 'attendance', label: '출결 현황',     href: '/admin/attendance' },
  { key: 'sync',       label: '출석부 동기화', href: '/admin/sync' },
  { key: 'students',   label: '수강생 관리',   href: '/admin/students' },
  { key: 'courses',    label: '교육과정 관리', href: '/admin/courses' },
  { key: 'settings',   label: '시스템 설정',   href: '/admin/settings' },
];

// HTML 특수문자 이스케이프 (과정명 등에 <, >, & 가 있어도 깨지지 않게)
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shellCss() {
  return `
  :root {
    --sn-bg:#f4f5f6; --sn-surface:#ffffff; --sn-ink:#202223;
    --sn-navy:#003876; --sn-navy600:#005bab; --sn-navy700:#002a58;
    --sn-gray:#656668; --sn-line:#e4e5e6; --sn-line2:#eff0f1;
    --sn-amber:#fdba30; --sn-red:#D32F2F; --sn-red-bg:#fadedd;
    --sn-green:#1E8E3E;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { background:var(--sn-bg); }
  body {
    font-family:"Archivo","Noto Sans KR",-apple-system,BlinkMacSystemFont,"Malgun Gothic",system-ui,sans-serif;
    color:var(--sn-ink); -webkit-font-smoothing:antialiased;
  }
  button, select, input, textarea { font-family:inherit; }
  a { color:var(--sn-navy); text-decoration:none; }
  a:hover { color:var(--sn-navy600); text-decoration:underline; }
  ::selection { background:#dce8f5; }

  .sn-page { min-height:100vh; background:var(--sn-bg); padding-bottom:96px; }

  /* ── 헤더 ── */
  .sn-header { background:#fff; border-bottom:1px solid var(--sn-line); position:sticky; top:0; z-index:20; }
  .sn-header-in {
    max-width:1460px; margin:0 auto; padding:14px 28px;
    display:flex; align-items:center; gap:22px; flex-wrap:wrap;
  }
  .sn-logo { height:64px; width:auto; display:block; }
  .sn-vline { width:1px; height:44px; background:var(--sn-line); }
  .sn-brand { margin-right:auto; }
  .sn-brand-title { font-size:25px; font-weight:800; letter-spacing:-0.02em; color:var(--sn-navy); }
  .sn-meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .sn-pill {
    display:flex; align-items:center; gap:7px; height:38px; padding:0 13px;
    background:var(--sn-bg); border-radius:999px;
    font-size:12px; font-weight:700; color:var(--sn-gray); white-space:nowrap;
  }
  .sn-dot { width:8px; height:8px; border-radius:50%; background:var(--sn-green); display:inline-block; }
  .sn-dot.off { background:var(--sn-red); }
  .sn-clock { font-size:12.5px; font-weight:600; color:var(--sn-gray); font-variant-numeric:tabular-nums; white-space:nowrap; }

  /* ── 탭 ── */
  .sn-tabs {
    max-width:1460px; margin:0 auto; padding:0 22px 12px;
    display:flex; gap:6px; overflow-x:auto;
  }
  .sn-tab {
    height:38px; padding:0 16px; border:none; border-radius:999px;
    background:transparent; color:var(--sn-gray);
    font-size:13px; font-weight:700; white-space:nowrap; cursor:pointer;
    text-decoration:none; display:inline-flex; align-items:center;
    transition:background .12s ease, color .12s ease;
  }
  .sn-tab:hover { background:var(--sn-bg); color:var(--sn-ink); text-decoration:none; }
  .sn-tab.on { background:var(--sn-navy); color:#fff; }
  .sn-tab.on:hover { background:var(--sn-navy600); color:#fff; }

  /* ── 본문 공통 ── */
  .sn-shell { max-width:1460px; margin:0 auto; }
  .sn-section { padding:26px 28px 0; }
  .sn-h2 { margin:0; font-size:18px; font-weight:800; letter-spacing:-0.015em; }
  .sn-h2-lg { margin:0; font-size:22px; font-weight:800; letter-spacing:-0.02em; line-height:1.1; }
  .sn-sub { font-size:12px; font-weight:500; color:var(--sn-gray); }
  .sn-head-row { display:flex; align-items:baseline; gap:10px; margin-bottom:14px; }
  .sn-card { background:#fff; border-radius:20px; padding:20px; }
  .sn-grid { display:grid; gap:14px; }

  /* ── 버튼 ── */
  .sn-btn {
    display:inline-flex; align-items:center; justify-content:center;
    height:42px; padding:0 18px; border-radius:999px; border:1px solid transparent;
    font-size:12.5px; font-weight:700; cursor:pointer; white-space:nowrap;
    text-decoration:none; transition:background .12s ease, border-color .12s ease;
  }
  .sn-btn:hover { text-decoration:none; }
  .sn-btn-primary { background:var(--sn-navy); color:#fff; }
  .sn-btn-primary:hover { background:var(--sn-navy600); color:#fff; }
  .sn-btn-secondary { background:#fff; color:var(--sn-navy); border-color:var(--sn-line); }
  .sn-btn-secondary:hover { background:var(--sn-bg); color:var(--sn-navy); }
  .sn-btn-sm { height:36px; padding:0 14px; font-size:11.5px; }

  /* ── 반응형 ── */
  @media (max-width:820px) {
    .sn-header-in { padding:12px 16px; gap:14px; }
    .sn-logo { height:44px; }
    .sn-vline { display:none; }
    .sn-brand-title { font-size:19px; }
    .sn-clock { display:none; }
    .sn-tabs { padding:0 12px 10px; }
    .sn-section { padding:20px 16px 0; }
  }
  `;
}

function renderShell(opts) {
  const o = opts || {};
  const active = o.active || '';
  const title = o.title || '관리자';

  const tabsHtml = TABS.map(function(t) {
    const on = (t.key === active) ? ' on' : '';
    return '<a class="sn-tab' + on + '" href="' + t.href + '">' + esc(t.label) + '</a>';
  }).join('');

  const dbOk = (o.dbOk === undefined) ? true : !!o.dbOk;
  const dbDot = dbOk ? '' : ' off';
  const dbLabel = dbOk ? '연결됨' : '오류';

  // 서버 시각: 최초값은 서버에서, 이후 1초마다 브라우저가 갱신
  const startMs = o.serverTime ? new Date(o.serverTime).getTime() : Date.now();

  return '<!DOCTYPE html><html lang="ko"><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<title>' + esc(title) + ' · 상남경영원 출결관리시스템</title>'
    + '<link rel="preconnect" href="https://fonts.googleapis.com">'
    + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Noto+Sans+KR:wght@400;500;700;900&display=swap" rel="stylesheet">'
    + '<style>' + shellCss() + (o.pageCss || '') + '</style>'
    + '</head><body>'
    + '<div class="sn-page">'
    +   '<header class="sn-header">'
    +     '<div class="sn-header-in">'
    +       '<img class="sn-logo" src="/logo.png" alt="연세대학교 상남경영원">'
    +       '<div class="sn-vline"></div>'
    +       '<div class="sn-brand"><div class="sn-brand-title">출결 관리 시스템</div></div>'
    +       '<div class="sn-meta">'
    +         '<div class="sn-pill"><span class="sn-dot"></span><span>서버 정상</span></div>'
    +         '<div class="sn-pill"><span class="sn-dot' + dbDot + '"></span><span>DB ' + dbLabel + '</span></div>'
    +         '<div class="sn-clock" id="snClock"></div>'
    +         '<a class="sn-btn sn-btn-secondary" style="height:38px;font-size:12.5px;" href="/admin/logout">로그아웃</a>'
    +       '</div>'
    +     '</div>'
    +     '<nav class="sn-tabs">' + tabsHtml + '</nav>'
    +   '</header>'
    +   '<div class="sn-shell">' + (o.body || '') + '</div>'
    + '</div>'
    + '<script>'
    +   '(function(){'
    +     'var el=document.getElementById("snClock"); if(!el) return;'
    +     'var base=' + startMs + ', t0=Date.now();'
    +     'function tick(){'
    +       'var d=new Date(base + (Date.now()-t0));'
    +       'el.textContent=d.toLocaleString("ko-KR",{timeZone:"Asia/Seoul",dateStyle:"medium",timeStyle:"medium"});'
    +     '}'
    +     'tick(); setInterval(tick,1000);'
    +   '})();'
    + '</script>'
    + (o.pageJs ? '<script>' + o.pageJs + '</script>' : '')
    + '</body></html>';
}

module.exports = { renderShell, shellCss, esc, TABS };
