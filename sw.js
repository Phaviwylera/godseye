/* God's Eye service worker — offline shell; network-first so feeds stay fresh. */
const CACHE = 'godseye-shell-v4';
const CORE = ['./', './index.html', './css/style.css', './js/app.js', './js/players.js',
              './js/intel.js', './js/sources.js', './vendor/maplibre-gl.js', './vendor/maplibre-gl.css',
              './vendor/hls.min.js', './manifest.json', './icon.svg', './assets/gods-eye-emblem.svg', './img/godseye-icon.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  /* never intercept relays, tiles, or cross-origin data */
  if (e.request.method !== 'GET' || u.origin !== location.origin ||
      !['document', 'script', 'style', 'image', 'font'].includes(e.request.destination) ||
      u.pathname.startsWith('/api/') || u.pathname.startsWith('/data/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const cp = r.clone();
        if (r.ok && CORE.some((path) => new URL(path, self.registration.scope).href === e.request.url)) {
          caches.open(CACHE).then((c) => c.put(e.request, cp)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(e.request).then((m) => m ||
        (e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
