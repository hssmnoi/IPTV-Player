const CACHE_NAME = "bkl-play-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css?v=3",
  "./js/app.js?v=4",
  "./images/logo/logo.png",
  "./images/logo/logo-dark.png",
  "./images/apple-touch-icon.png",
  "./images/favicon-16x16.png",
  "./images/favicon-32x32.png",
  "./images/android-chrome-192x192.png",
  "./images/android-chrome-512x512.png",
  "./images/covers/cover-anime.png",
  "./images/covers/cover-anime-series.png",
  "./images/covers/cover-anime-movie.png",
  "./images/covers/cover-movie.png",
  "./images/covers/cover-series.png",
  "../playlist/main.txt",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return;

  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", resClone));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Always prefer latest playlist data, then fallback to cache.
  if (url.pathname.includes("https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/playlist/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (!res || res.status !== 200 || res.type !== "basic") return res;
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return res;
      });
    })
  );
});
