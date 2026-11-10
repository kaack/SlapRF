/* SlapRF service worker — offline app shell + PWA support.
 *
 * This file is a TEMPLATE. `go run ./cmd/build-web` writes the deployable copy to `_site/sw.js`,
 * substituting the two placeholders below with the content-hashed precache manifest and a version
 * derived from those hashes. A deploy whose files are byte-identical produces a byte-identical
 * sw.js, so browsers see no update; any changed asset changes the version and triggers the
 * in-app "Update available" prompt (web/src/services/offline.ts).
 *
 * When served un-built (e.g. straight from web/ by the local Go server) the placeholders are left
 * intact and the worker is inert: it never intercepts fetches and removes any SlapRF caches, so
 * the dev workflow (on-the-fly rebuilt dist/app.js + wasm) is never cache-broken. It is also inert
 * on localhost / 127.0.0.1 even when built. offline.ts additionally refuses to register there.
 *
 * Strategy:
 *   - install:  precache every manifest entry into `slaprf-precache-<version>`. Entries whose
 *               content hash is unchanged are copied from the previous cache instead of being
 *               re-downloaded (the wasm + firmware image are ~9 MB).
 *   - activate: delete every other `slaprf-precache-*` cache, claim clients.
 *   - fetch:    non-GET or cross-origin → not intercepted.
 *               navigations → network-first (with timeout), falling back to cached index.html
 *               (this also serves SPA deep links offline).
 *               precached same-origin GETs → cache-first (query string such as `?v=228` ignored).
 *               anything else (e.g. /api/*) → not intercepted.
 */
"use strict";

/** @type {{url: string, rev: string}[] | null} */
const PRECACHE = /*__SLAPRF_PRECACHE__*/ null;
const VERSION = "__SLAPRF_SW_VERSION__";

const CACHE_PREFIX = "slaprf-precache-";
const CACHE_NAME = CACHE_PREFIX + VERSION;
const NAV_TIMEOUT_MS = 4000;

const host = self.location.hostname;
const IS_DEV_HOST = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
const ENABLED = Array.isArray(PRECACHE) && !VERSION.startsWith("__") && !IS_DEV_HOST;

/** pathname (absolute, no query) → cache key (absolute URL with revision). */
const keyByPath = new Map();
let indexKey = "";
if (ENABLED) {
  for (const entry of PRECACHE) {
    const u = new URL(entry.url, self.location.href);
    const key = `${u.origin}${u.pathname}?__rev=${entry.rev}`;
    keyByPath.set(u.pathname, key);
    if (entry.url === "index.html") {
      indexKey = key;
      // The app root ("/" relative to the SW scope) is the same document as index.html.
      keyByPath.set(new URL("./", self.location.href).pathname, key);
    }
  }
}

async function findInOldCaches(key) {
  const names = await caches.keys();
  for (const name of names) {
    if (!name.startsWith(CACHE_PREFIX) || name === CACHE_NAME) continue;
    const cache = await caches.open(name);
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  return undefined;
}

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    PRECACHE.map(async (entry) => {
      const url = new URL(entry.url, self.location.href);
      const key = `${url.origin}${url.pathname}?__rev=${entry.rev}`;
      if (await cache.match(key)) return;
      const reused = await findInOldCaches(key);
      if (reused) {
        await cache.put(key, reused);
        return;
      }
      // cache: "reload" bypasses the HTTP cache (GitHub Pages sends max-age=600), so we never
      // store a stale asset under a new revision.
      const res = await fetch(new Request(url.href, { cache: "reload", credentials: "same-origin" }));
      if (!res.ok) throw new Error(`precache ${entry.url}: HTTP ${res.status}`);
      await cache.put(key, res);
    }),
  );
}

self.addEventListener("install", (event) => {
  if (!ENABLED) {
    self.skipWaiting();
    return;
  }
  // Do NOT skipWaiting here: the page shows an "Update available" prompt and posts SKIP_WAITING.
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith(CACHE_PREFIX) && (!ENABLED || n !== CACHE_NAME)).map((n) => caches.delete(n)),
      );
      if (ENABLED) await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "SKIP_WAITING") self.skipWaiting();
  if (data && data.type === "GET_VERSION" && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: VERSION, enabled: ENABLED });
  }
});

async function cachedIndex() {
  if (!indexKey) return undefined;
  const cache = await caches.open(CACHE_NAME);
  return cache.match(indexKey);
}

async function handleNavigation(request) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), NAV_TIMEOUT_MS));
  try {
    const network = fetch(request);
    network.catch(() => undefined); // avoid an unhandled rejection if the cached shell wins the race
    const res = await Promise.race([network, timeout]);
    if (res && res.ok) return res;
    // Slow network (flaky field Wi-Fi) or an error status from a host without SPA fallback / an
    // outage: serve the cached shell if we have it, else keep waiting / return the network result.
    const cached = await cachedIndex();
    if (cached) return cached;
    return res || (await network);
  } catch (err) {
    const cached = await cachedIndex();
    if (cached) return cached;
    throw err;
  }
}

async function handlePrecached(request, key) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(key);
  if (hit) return hit;
  // Cache miss (e.g. evicted): go to network and repopulate.
  const res = await fetch(request);
  if (res.ok && res.type === "basic") await cache.put(key, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  if (!ENABLED) return;
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }
  const key = keyByPath.get(url.pathname) || keyBySuffix(url.pathname);
  if (key) event.respondWith(handlePrecached(request, key));
});

/**
 * index.html loads assets with relative `./` URLs, so a nested path deep link (e.g. /a/b, served
 * the shell via the navigation fallback) requests /a/styles/x.css. Those paths don't exist on the
 * server; map them to the precached asset whose site path is a suffix so the shell still works.
 */
function keyBySuffix(pathname) {
  for (const [path, key] of keyByPath) {
    if (path.length > 1 && pathname.endsWith(path)) return key;
  }
  return undefined;
}
