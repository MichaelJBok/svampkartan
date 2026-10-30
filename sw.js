// Offline support: keeps the app, its libraries, the GBIF data and the map tiles you have viewed on the
// device, so Svampkartan opens and shows your area without signal. Your spots work offline through Firestore.
// Bump VERSION whenever a file in SHELL changes, so devices fetch the new set.
const VERSION = "v8";
const SHELL_CACHE = `svampkartan-${VERSION}`;
const TILE_CACHE = "svampkartan-tiles";
const MAX_TILES = 4000;                    // roughly 60–100 MB of map images
const TILE_MAX_AGE = 14 * 24 * 3600 * 1000; // refresh viewed tiles every two weeks when online
const PAGE_TIMEOUT = 4000;                 // poor signal: fall back to the saved page after this long

const SHELL = [
  "./", "app.js?v=8", "sync.js?v=8", "data/gbif_species.js?v=5",
  "site.webmanifest", "favicon.svg", "favicon.ico", "favicon-32.png", "icon-192.png", "apple-touch-icon.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/supercluster@8.0.1/dist/supercluster.min.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js",
];
const LIBRARY_HOSTS = new Set(["unpkg.com", "www.gstatic.com"]);
const TILE_HOSTS = /(^|\.)tile\.openstreetmap\.org$|(^|\.)tile\.opentopomap\.org$|^server\.arcgisonline\.com$/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("svampkartan-v") && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate") event.respondWith(page(req));
  else if (TILE_HOSTS.test(url.hostname)) event.respondWith(tile(req));
  else if (url.origin === location.origin || LIBRARY_HOSTS.has(url.hostname)) event.respondWith(saved(req));
  // Everything else (Firebase sign-in and database, GBIF links) goes straight to the network.
});

// The page itself: network first so updates arrive, the saved copy when offline or the signal is too weak.
async function page(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PAGE_TIMEOUT)),
    ]);
    if (res.ok) cache.put("./", res.clone());
    return res;
  } catch {
    return (await cache.match("./")) || Response.error();
  }
}

// App files and libraries are versioned, so a saved copy is always right; fetch and keep anything missing.
async function saved(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(SHELL_CACHE)).put(req, res.clone());
  return res;
}

let tilePuts = 0;
async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  // Tile servers' Date header is hidden from scripts, so each saved tile carries its own save time.
  const fresh = hit && Date.now() - Number(hit.headers.get("x-saved-at") || 0) < TILE_MAX_AGE;
  if (fresh) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const headers = new Headers({ "content-type": res.headers.get("content-type") || "image/png", "x-saved-at": String(Date.now()) });
      await cache.put(req, new Response(await res.clone().blob(), { headers }));
      if (++tilePuts % 50 === 0) trimTiles(cache);
    }
    return res;
  } catch {
    return hit || Response.error();
  }
}

async function trimTiles(cache) {
  const keys = await cache.keys(); // oldest first
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await cache.delete(key);
}
