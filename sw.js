/* Paradox of Acceptance — Service Worker
 * essays-v1: cache-first for essay pages (20-essay LRU)
 * shell-v1:  stale-while-revalidate for shared assets
 */

const ESSAY_CACHE = 'essays-v1';
const SHELL_CACHE = 'shell-v1';
const OFFLINE_URL = '/offline.html';
const ESSAY_LIMIT = 20;

const SHELL_ASSETS = [
  '/offline.html',
  '/shared/design-tokens.css',
  '/shared/theme-mono.css',
  '/shared/pwa.js',
];

// ─── Install: pre-cache shell assets ───────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: clean up old caches ─────────────────────────────────────────

self.addEventListener('activate', event => {
  const valid = new Set([ESSAY_CACHE, SHELL_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !valid.has(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch ──────────────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  const isEssayPage = url.pathname.startsWith('/mindfulness-essays/') &&
    (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'));

  const isShellAsset = SHELL_ASSETS.some(a => url.pathname === a) ||
    url.pathname.startsWith('/shared/');

  if (isEssayPage) {
    event.respondWith(essayCacheFirst(request));
  } else if (isShellAsset) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  } else if (request.mode === 'navigate') {
    event.respondWith(networkFirstWithOfflineFallback(request));
  }
  // All other requests (scripts, images not in essays, API calls): pass through
});

// ─── Cache strategies ───────────────────────────────────────────────────────

async function essayCacheFirst(request) {
  const cache = await caches.open(ESSAY_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      await enforceCacheLimit(cache, ESSAY_LIMIT);
    }
    return response;
  } catch {
    return caches.match(OFFLINE_URL);
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached || caches.match(OFFLINE_URL));

  return cached || fetchPromise;
}

async function networkFirstWithOfflineFallback(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    return caches.match(OFFLINE_URL);
  }
}

// ─── LRU eviction: keep only the N most recently accessed entries ───────────

async function enforceCacheLimit(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  // keys() returns entries in insertion order; delete oldest first
  const toDelete = keys.slice(0, keys.length - limit);
  await Promise.all(toDelete.map(k => cache.delete(k)));
}

// ─── Message: force-cache an essay page on demand ──────────────────────────

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'CACHE_ESSAY') {
    const { url } = event.data;
    event.waitUntil(
      caches.open(ESSAY_CACHE).then(async cache => {
        const response = await fetch(url);
        if (response.ok) {
          await cache.put(url, response.clone());
          await enforceCacheLimit(cache, ESSAY_LIMIT);
        }
        // Notify the page
        if (event.source) {
          event.source.postMessage({ type: 'ESSAY_CACHED', url, ok: response.ok });
        }
      }).catch(() => {
        if (event.source) {
          event.source.postMessage({ type: 'ESSAY_CACHED', url, ok: false });
        }
      })
    );
  }

  if (event.data && event.data.type === 'GET_CACHED_ESSAYS') {
    event.waitUntil(
      caches.open(ESSAY_CACHE).then(async cache => {
        const keys = await cache.keys();
        const urls = keys.map(k => k.url);
        if (event.source) {
          event.source.postMessage({ type: 'CACHED_ESSAYS', urls });
        }
      })
    );
  }
});
