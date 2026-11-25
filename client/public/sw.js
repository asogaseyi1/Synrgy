/*
 * Synrgy service worker: makes the app installable and lets the shell load on flaky connections.
 *
 * - Never touches /api (live data, auth, anonymous reports) or non-GET requests.
 * - Page navigations: network first, falling back to the last cached app shell when offline.
 * - /assets/* (content-hashed by Vite): cache first.
 * - Icons and manifest: stale-while-revalidate.
 * Bump VERSION to drop old caches.
 */
const VERSION = 'v1';
const SHELL = `synrgy-shell-${VERSION}`;
const ASSETS = `synrgy-assets-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.add('/')).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('synrgy-') && k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/', { cacheName: SHELL }).then((r) => r || Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(ASSETS).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest' || url.pathname === '/favicon.svg') {
    event.respondWith(
      caches.open(ASSETS).then(async (c) => {
        const hit = await c.match(req);
        const fresh = fetch(req)
          .then((res) => {
            if (res.ok) c.put(req, res.clone());
            return res;
          })
          .catch(() => hit);
        return hit || fresh;
      }),
    );
  }
});
