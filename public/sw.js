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
    requireInteraction: true,
    data: {
      url: data.url || '/',
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

  const action = event.action;
  const data = event.notification.data || {};

  // ── 퇴실 처리 함수 (재사용) ────────────────────────────
  function doCheckout() {
    return fetch('/api/push/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: data.studentId,
        attendanceId: data.attendanceId,
      }),
    }).then(function(res) { return res.json(); });
  }

  function openApp() {
    return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.includes(self.registration.scope) && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      return clients.openWindow(data.url || '/');
    });
  }

  // ── "퇴실 확인" 액션 버튼 클릭 → 서버 API 호출 ──
  if (action === 'checkout' && data.studentId && data.attendanceId) {
    event.waitUntil(
      doCheckout().then(function(result) {
        if (result.success) {
          return self.registration.showNotification('퇴실 완료', {
            body: result.message || '퇴실이 정상 처리되었습니다.',
            icon: '/icon-192.png',
            tag: 'checkout-confirm',
          });
        } else {
          return self.registration.showNotification('퇴실 처리 실패', {
            body: result.error || '관리자에게 문의하세요.',
            icon: '/icon-192.png',
            tag: 'checkout-error',
          });
        }
      }).catch(function() {
        return self.registration.showNotification('네트워크 오류', {
          body: '퇴실 처리 중 오류 발생. QR 스캔으로 퇴실해주세요.',
          icon: '/icon-192.png',
          tag: 'checkout-error',
        });
      })
    );
    return;
  }

  // ── 일반 클릭 (알림 본문 탭) → 퇴실 처리 + 앱 열기 ──
  if (data.studentId && data.attendanceId) {
    event.waitUntil(
      doCheckout()
        .then(function() { return openApp(); })
        .catch(function() { return openApp(); })
    );
    return;
  }

  // ── studentId 없는 일반 알림 클릭 → 앱 열기만 ──
  event.waitUntil(openApp());
});
