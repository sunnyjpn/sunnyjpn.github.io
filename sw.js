const CACHE_NAME = 'reaction-time-test-cache-v7';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './og-image.png',
  './go-sound.mp3'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) { return key !== CACHE_NAME; })
          .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Cloudflare Beacon 等の外部リクエストはキャッシュ対象外（ネットワークにそのまま流す）
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then(function (cached) {
      const network = fetch(req).then(function (res) {
        // status 206（Rangeリクエストへの部分レスポンス）はCache APIでput不可のため、
        // ここで弾かないと "Failed to execute 'put' on 'Cache'" が毎回投げられる
        if (res && res.ok && res.status !== 206) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(req, clone).catch(function () {});
          });
        }
        return res;
      }).catch(function () {
        return cached;
      });
      return cached || network;
    })
  );
});


function notifyClients(type) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    clients.forEach(function (client) {
      client.postMessage({ type: type });
    });
  });
}

self.addEventListener('sync', function (event) {
  if (event.tag !== 'reaction-time-stats-sync') return;
  event.waitUntil(notifyClients('RT_FLUSH_SYNC'));
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (!event.data || event.data.type !== 'RT_REQUEST_SYNC') return;
  event.waitUntil(notifyClients('RT_FLUSH_SYNC'));
});
