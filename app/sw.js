// Offline shell for the home-screen app. App files are network-first so
// updates show up right away; GitHub API calls are never cached.
const CACHE = 'grab-v46';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'study.js', 'manifest.webmanifest', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Downloaded videos (files/…) go straight to the network, never the cache.
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/files/')) return;
  // cache: 'no-cache' skips Safari's 10-minute HTTP cache, so a reload always
  // gets the newest app files (a quick "not modified" check when unchanged).
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
