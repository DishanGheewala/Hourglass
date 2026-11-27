// Hourglass service worker: shows reminder alerts even when the app is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Hourglass', {
    body: d.body || 'Time to log your day.',
    icon: 'icon.svg',
    badge: 'icon.svg',
    tag: d.tag || 'hourglass',
    data: { url: d.url || '/app/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/app/', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if (c.url.startsWith(self.location.origin + '/app')) { await c.focus(); return; }
    await self.clients.openWindow(url);
  })());
});
