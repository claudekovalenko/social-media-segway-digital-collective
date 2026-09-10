// This site is served from a Cloudflare Worker at the edge, so it is already
// fast everywhere and does not need an offline cache. The cache it used to
// keep caused the opposite problem: a phone would hold old files and show a
// half-updated page long after a deploy.
//
// So this worker now does one job. It deletes every cache it finds, then
// unregisters itself. Only a device that actually held a cache is reloaded,
// because only that device is looking at stale files; everyone else sees
// nothing happen at all.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    for (const key of keys) await caches.delete(key);
    await self.registration.unregister();
    if (!keys.length) return;
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.navigate(client.url);
    }
  })());
});
