// Service worker: cache-first for the app shell, network-only for the API.
// Bump CACHE_VERSION whenever static files change.
const CACHE_VERSION = 'v17';
const CACHE_NAME = `faith-journey-${CACHE_VERSION}`;
const SHELL = [
  './',
  'index.html',
  'creator.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;               // form posts always hit the network
  if (url.pathname.startsWith('/api/')) return;         // live data, never cached
  if (url.pathname.startsWith('/c/')) return;           // creator redirects need the server

  // Stale-while-revalidate for everything else.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetched = fetch(e.request)
        .then((res) => {
          if (res.ok && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
