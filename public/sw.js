// This site is served from a Cloudflare Worker at the edge, so it is already
// fast everywhere and does not need an offline cache. The cache it used to
// keep caused the opposite problem: a phone would hold old files and show a
// half-updated page long after a deploy.
//
// So this worker now does one job. It deletes every cache it finds, then
// unregisters itself. Any device that still has the old worker installed
// picks this file up on the next visit and cleans itself out for good.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.navigate(client.url);
    }
  })());
});
