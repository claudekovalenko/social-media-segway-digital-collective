// Service worker: network-first, so a fresh deploy shows up on the very next
// open instead of one load later. The cache is a fallback for slow or absent
// connections, not the default source.
const CACHE_VERSION = 'v104-open';
const CACHE_NAME = `faith-journey-${CACHE_VERSION}`;
const NETWORK_TIMEOUT = 2500;
// Clean URLs, not the .html paths: the Worker answers /journey.html with a
// 307 to /journey, and a redirected response cannot be cached.
const SHELL = [
  './',
  'journey',
  'creators',
  'login',
  'dashboard',
  'admin',
  'creator',
  'beliefs',
  'privacy',
  'styles.css',
  'app.js',
  'i18n.js',
  'crm.js',
  'reveal.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // Cache each file on its own and swallow individual failures. cache.addAll
  // is atomic: one redirect or 404 rejects the whole install, the worker never
  // activates, stale caches are never cleared, and the installed app quietly
  // serves a mismatched mixture of old and new files.
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { redirect: 'follow', cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch { /* a missing asset must not break the install */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Race the network against a short timer: whatever answers first wins, and a
// successful response always refreshes the cache.
function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT);
    fetch(request)
      .then((res) => {
        clearTimeout(timer);
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, copy));
        }
        resolve(res);
      })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;          // form posts always hit the network
  if (url.pathname.startsWith('/api/')) return;    // live data, never cached
  if (url.pathname.startsWith('/c/')) return;      // creator redirects need the server
  if (url.origin !== location.origin) return;      // fonts etc. use their own rules

  e.respondWith(
    fromNetwork(e.request).catch(() =>
      caches.match(e.request).then((cached) => cached || caches.match('./'))
    )
  );
});
