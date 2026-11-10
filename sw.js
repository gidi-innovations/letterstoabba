// Letters to Abba — service worker: keeps the app working offline.
// Bump VERSION whenever any file changes so phones pick up the update.
const VERSION = 'abba-v1.0.0';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './verses.js',
  './manifest.webmanifest',
  './fonts/great-vibes.woff2',
  './fonts/parisienne.woff2',
  './fonts/cormorant-500.woff2',
  './fonts/cormorant-500i.woff2',
  './fonts/cormorant-600.woff2',
  './fonts/inter-400.woff2',
  './fonts/inter-600.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

// Cache first (works offline); refresh the cache in the background when online.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (cached) return cached;
      const res = await network;
      if (res) return res;
      if (req.mode === 'navigate') return cache.match('./index.html');
      return new Response('', { status: 504 });
    })
  );
});
