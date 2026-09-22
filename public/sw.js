// public/sw.js
// Minimal app-shell cache. Does NOT cache /api/* calls — those must always
// hit the network since they talk to a live AI backend and a live database.
const CACHE_NAME = 'fakkakha-shell-v2';
const SHELL_FILES = ['/', '/index.html', '/style.css', '/app.js', '/lib/i18n.js', '/push.js', '/manifest.json', '/features.json', '/icon-192.png', '/icon-512.png', '/policy.css', '/offline-engine.js', '/local-ai.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache API calls or Supabase calls — always live.
  if (url.pathname.startsWith('/api/') || url.hostname.includes('supabase.co')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
