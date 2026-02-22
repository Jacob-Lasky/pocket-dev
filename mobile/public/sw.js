// Minimal service worker — no caching, just enables PWA install on HTTP origins
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(clients.claim()));
self.addEventListener('fetch',    e  => e.respondWith(fetch(e.request)));
