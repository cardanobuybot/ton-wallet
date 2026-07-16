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
