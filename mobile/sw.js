/*
 * Service worker of the phone app (docs/SYNC.md § 6.5). Source only: the build prepends
 * `const BUILD = "<hash>"; const PRECACHE = [...];` (vite.mobile.config.ts) and emits it as
 * dist/sw.js, so its bytes change with every deploy and the browser sees an update.
 *
 * - install: pre-caches PRECACHE in `todo-<BUILD>` (no skipWaiting: the page asks for it);
 * - activate: deletes every other cache, then claims the open pages;
 * - navigations: network first with a 3 s timeout, else the cached /index.html; an error
 *   status (a 502 of nginx, a 52x page of Cloudflare while the server is down) also falls
 *   back to the cached app, which works offline;
 * - /assets/*: cache first, caching only ok responses that are not HTML;
 * - /api/*: never cached (passes through);
 * - message {type: "SKIP_WAITING"}: activates this worker (« Recharger »);
 * - message {type: "SKIP_WAITING_IF_SAME_BUILD", path}: activates this worker only when it
 *   pre-caches `path`, a script of the page that asks (V2.7 bis): that page already runs this
 *   build, and until this worker is active an offline opening would get the previous build's
 *   cached app. Answers {skipping} on the message's port.
 */

/* global BUILD, PRECACHE */
const CACHE = `todo-${BUILD}`;
const NAVIGATION_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "SKIP_WAITING_IF_SAME_BUILD") {
    const same = typeof data.path === "string" && PRECACHE.includes(data.path);
    if (same) self.skipWaiting();
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ skipping: same });
  }
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function cachedApp() {
  return caches.match("/index.html", { cacheName: CACHE });
}

async function navigation(request) {
  let response;
  try {
    response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
  } catch {
    return (await cachedApp()) || Response.error();
  }
  if (response.ok) return response;
  // The server answered with an error page: the cached app is better than that.
  return (await cachedApp()) || response;
}

async function asset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  const type = response.headers.get("Content-Type") || "";
  if (response.ok && !type.includes("text/html")) {
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(navigation(request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(asset(request));
    return;
  }
  // Other files (manifest, icons): the pre-cache, else the network.
  event.respondWith(
    caches
      .match(request, { cacheName: CACHE })
      .then((cached) => cached || fetch(request)),
  );
});
