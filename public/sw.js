// Service Worker: PWA 오프라인 + 푸시 알림 처리

const CACHE_NAME = 'attendance-v4';

// ─── 설치 ────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(['/manifest.json']);
    })
  );
  self.skipWaiting();
});

// ─── 활성화 ──────────────────────────────────────────────────
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
  var data = { title: '출결 알림', body: '퇴실 확인을 해주세요.', url: '/app' };

  if (event.data) {
    try {
      var json = event.data.json();
      // FCM data-only 메시지 형식 처리
      if (json.data && json.data.title) {
        data = json.data;
      } else {
        data = json;
      }
    } catch (e) {
      data.body = event.data.text();
    }
  }

  var options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: 'checkout-' + Date.now(),
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
// 모든 퇴실 처리는 앱 페이지에서 (위치확인 + 생체인증) 진행
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  var data = event.notification.data || {};

  // 퇴실 처리용 URL (앱 페이지에서 위치확인 + 생체인증 수행)
  var baseUrl = 'https://attendance-system-naaw.onrender.com';
  var targetUrl = baseUrl + '/app';
  if (data.studentId && data.attendanceId) {
    targetUrl = baseUrl + '/app?checkout=true&sid=' + encodeURIComponent(data.studentId) + '&aid=' + encodeURIComponent(data.attendanceId);
  }

  // 앱 페이지 열기 (이미 열려있으면 이동 + 포커스)
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.includes('/app') && 'navigate' in client) {
          return client.navigate(targetUrl).then(function(c) { return c.focus(); });
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
