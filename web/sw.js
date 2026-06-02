/**
 * Service worker — app-shell cache only.
 *
 * Strategy: cache-first for our own static files so the app installs and
 * launches offline. NEVER intercept the Apps Script /exec calls — those
 * must always hit the network (the IndexedDB queue handles offline POSTs
 * at the application layer in build step 4).
 */

const CACHE = 'siopao-shell-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache cross-origin (esp. Apps Script). Let the browser handle it.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        })
        .catch(() => caches.match('./'));
    })
  );
});
