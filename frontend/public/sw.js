// NightWay service worker: keep working with no signal (UI_SPEC §7.4).
//  * app shell + built assets: cache first (hashed file names)
//  * GET /api/* (config, last plans, places, streets): network first, cached copy when offline
//  * OpenStreetMap tiles already seen: cache first (bounded)
//  * the live plan stream (SSE) is never cached
const SHELL = "nw-shell-v2";
const API = "nw-api-v2";
const TILES = "nw-tiles-v2";
const MAX_TILES = 600;

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(Promise.all([
    caches.open(SHELL).then((c) => c.addAll(["/", "/index.html", "/moon.svg", "/manifest.webmanifest"])),
    // what a cold start with no signal needs: settings and the offline street layer
    caches.open(API).then((c) => c.addAll(["/api/config", "/api/map/streets?main=1"])).catch(() => {}),
  ]));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, API, TILES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = (await cache.match(req)) || (fallbackUrl && (await caches.match(fallbackUrl)));
    if (hit) return hit;
    return new Response(JSON.stringify({ offline: true }), { status: 503, headers: { "content-type": "application/json" } });
  }
}

async function cacheFirst(req, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === "opaque") {
      cache.put(req, res.clone());
      if (limit) cache.keys().then((keys) => { if (keys.length > limit) cache.delete(keys[0]); });
    }
    return res;
  } catch {
    return new Response("", { status: 504 });
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname.endsWith("/stream") || url.pathname.startsWith("/api/sim/") || url.pathname === "/api/status") return;
      e.respondWith(networkFirst(req, API));
    } else if (req.mode === "navigate") {
      e.respondWith(networkFirst(req, SHELL, "/index.html"));
    } else {
      e.respondWith(cacheFirst(req, SHELL));
    }
  } else if (url.hostname.endsWith("tile.openstreetmap.org")) {
    e.respondWith(cacheFirst(req, TILES, MAX_TILES));
  }
});
