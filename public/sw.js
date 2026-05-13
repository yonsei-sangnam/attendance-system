// Service Worker: PWA 오프라인 + 푸시 알림 처리

const CACHE_NAME = 'attendance-v1';

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
  let data = { title: '출결 알림', body: '퇴실 확인을 해주세요.', url: '/' };

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
    requireInteraction: true,  // 사용자가 탭할 때까지 유지
    data: { url: data.url || '/' },
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

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 이미 열린 탭이 있으면 포커스
      for (const client of clientList) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      // 없으면 새 탭
      return clients.openWindow(url);
    })
  );
});
