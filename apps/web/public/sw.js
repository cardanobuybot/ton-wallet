// Консервативный service worker (свойство безопасности кошелька):
// - HTML и навигация: ТОЛЬКО network-first, index.html никогда не отдаётся
//   из кэша при живой сети — обновления бандла доставляются мгновенно;
// - кэшируются только хэшированные статические ассеты (/assets/*).
const ASSET_CACHE = 'assets-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== ASSET_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// Web Push: получаем event → показываем нотификацию.
// Payload — JSON: {title, body, url?, tag?} (см. apps/api/src/push.ts).
self.addEventListener('push', (event) => {
  const data = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch {
      return {};
    }
  })();
  const title = data.title || 'grampocket';
  const body = data.body || '';
  const options = {
    body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Клик по нотификации: открываем URL (обычно хеш-маршрут, напр. #/u/<addr>).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const url = new URL(target, self.location.origin).href;
      // Если наше окно уже открыто — фокусим и роутим по хеш-части.
      for (const client of clientsList) {
        if (client.url.startsWith(self.location.origin)) {
          await client.focus();
          if (target.startsWith('#') || target.startsWith('/#')) {
            const hash = target.startsWith('/') ? target.slice(1) : target;
            client.postMessage({ type: 'navigate', hash });
          }
          return;
        }
      }
      // Иначе — новое окно.
      await self.clients.openWindow(url);
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Сеть без кэша; офлайн-фолбэка сознательно нет — устаревший бандл недопустим.
    event.respondWith(fetch(request));
    return;
  }

  // Vite кладёт хэшированные ассеты в /assets/ — только их можно кэшировать.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});
