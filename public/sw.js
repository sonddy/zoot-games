var CACHE_NAME = 'zg-v6-2026-06-07d';
var ASSETS = [
  '/',
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
  '/zootcoin.png',
  '/sports-bg.jpg'
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
  if (e.request.url.indexOf('/socket.io') !== -1) return;
  if (e.request.url.indexOf('cdn.socket.io') !== -1) return;
  if (e.request.method !== 'GET') return;

  var url = e.request.url;
  // Never cache the main HTML — always pull from network so APK users get
  // updates immediately after a deploy.
  if (url.endsWith('/') || url.endsWith('/index.html') || url.indexOf('/index.html?') !== -1) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(function(){ return caches.match(e.request); }));
    return;
  }

  e.respondWith(
    fetch(e.request).then(function(response) {
      var clone = response.clone();
      caches.open(CACHE_NAME).then(function(cache) {
        cache.put(e.request, clone);
      });
      return response;
    }).catch(function() {
      return caches.match(e.request);
    })
  );
});
