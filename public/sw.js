// Service Worker: PWA 오프라인 + 푸시 알림 처리

const CACHE_NAME = 'attendance-v2';

// ─── 설치: 기본 파일 캐시 ────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(['/manifest.json']);
    })
  );
  self.skipWaiting();
});

// ─── 활성화: 이전 캐시 삭제 ─────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      );
    })
  );
  self.clients.claim();
});

// ─── 푸시 알림 수신 ──────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = { title: '출결 알림', body: '퇴실 확인을 해주세요.', url: '/app' };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: 'attendance-' + Date.now(),
    renotify: true,
    requireInteraction: true,
    data: {
      url: data.url || '/app',
      studentId: data.studentId || null,
      attendanceId: data.attendanceId || null,
    },
    actions: [
      { action: 'checkout', title: '퇴실 확인' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ─── 알림 클릭 처리 ──────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  var action = event.action;
  var data = event.notification.data || {};

  // 퇴실 처리용 URL 생성 (앱 페이지에서 처리하도록)
  var checkoutUrl = '/app';
  if (data.studentId && data.attendanceId) {
    checkoutUrl = '/app?checkout=true&sid=' + encodeURIComponent(data.studentId) + '&aid=' + encodeURIComponent(data.attendanceId);
  }

  // ── "퇴실 확인" 액션 버튼 (안드로이드) ──
  // 안드로이드: SW에서 직접 API 호출 시도 → 실패 시 앱 페이지로 이동
  if (action === 'checkout' && data.studentId && data.attendanceId) {
    event.waitUntil(
      fetch('/api/push/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: data.studentId,
          attendanceId: data.attendanceId,
        }),
      })
      .then(function(res) { return res.json(); })
      .then(function(result) {
        if (result.success) {
          return self.registration.showNotification('퇴실 완료', {
            body: result.message || '퇴실이 정상 처리되었습니다.',
            icon: '/icon-192.png',
            tag: 'checkout-confirm',
          });
        } else {
          // API 실패 → 앱 페이지에서 재시도하도록 열기
          return clients.openWindow(checkoutUrl);
        }
      })
      .catch(function() {
        // 네트워크 오류 → 앱 페이지에서 재시도
        return clients.openWindow(checkoutUrl);
      })
    );
    return;
  }

  // ── 일반 클릭 (알림 본문 탭) ──
  // iOS + Android 공통: 앱 페이지를 URL 파라미터와 함께 열어서 퇴실 처리
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // 이미 열린 앱 창이 있으면 URL 변경 + 포커스
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.includes('/app') && 'navigate' in client) {
          return client.navigate(checkoutUrl).then(function(c) { return c.focus(); });
        }
      }
      // 없으면 새 창 열기
      return clients.openWindow(checkoutUrl);
    })
  );
});
