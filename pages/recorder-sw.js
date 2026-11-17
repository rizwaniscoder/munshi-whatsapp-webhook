const CACHE = "munshi-shell-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([
      "/recorder/icon-192.png",
      "/recorder/icon-512.png",
    ])).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;
  if (url.pathname.startsWith("/recorder/icon-")) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }
  if (url.pathname.startsWith("/r/") || url.pathname === "/recorder/sw.js") {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
