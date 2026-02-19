var CACHE_NAME = 'zg-v1';
var ASSETS = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  // Don't cache socket.io or API calls
  if (e.request.url.indexOf('/socket.io') !== -1) return;
  if (e.request.url.indexOf('cdn.socket.io') !== -1) return;

  e.respondWith(
    fetch(e.request).catch(function() {
      return caches.match(e.request);
    })
  );
});
