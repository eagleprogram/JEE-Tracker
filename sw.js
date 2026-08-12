// IMPORTANT: bump this version string on every deploy that changes any file
// listed in APP_SHELL below (i.e. basically every deploy). The fetch handler
// is cache-first, so returning visitors keep getting served whatever was
// cached under CACHE_NAME until the string itself changes — that's the only
// thing that makes the activate handler below delete the old cache and let
// the new files be fetched fresh. Forgetting this step means fixes silently
// never reach anyone who doesn't manually hard-refresh.
const CACHE_NAME = "jee-tracker-v2.4.0";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/variables.css",
  "./css/base.css",
  "./css/components.css",
  "./css/charts.css",
  "./js/utils.js",
  "./js/storage.js",
  "./js/timer.js",
  "./js/notifications.js",
  "./js/planner.js",
  "./js/history.js",
  "./js/sleep.js",
  "./js/syllabus.js",
  "./js/mocktest.js",
  "./js/youtube.js",
  "./js/charts.js",
  "./js/reports.js",
  "./js/backup.js",
  "./js/firebase-sync.js",
  "./js/ui.js",
  "./js/main.js",
  "./icon-192.png",
  "./icon-512.png",
  "./target-icon.png"
];

self.addEventListener("install", (event) => {
  // cache.addAll(urls) fetches each URL with the browser's DEFAULT cache
  // mode, which is allowed to reuse the browser's own HTTP disk cache — so
  // a "fresh" install under a new CACHE_NAME could still populate itself
  // with stale files if they were disk-cached, silently defeating the
  // whole point of bumping the version above. Requesting each file with
  // {cache: "reload"} forces a real network round-trip, bypassing the disk
  // cache, so the new cache is guaranteed to hold what's actually deployed.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        APP_SHELL.map((url) =>
          fetch(new Request(url, { cache: "reload" }))
            .then((res) => cache.put(url, res))
        )
      ))
      .then(() => self.skipWaiting())
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

  // Only handle same-origin GET requests. Everything else (Firebase,
  // YouTube API, Google Fonts, the Cloudflare email Worker) goes straight
  // to the network untouched.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => {
          if (req.mode === "navigate") return caches.match("./index.html");
        });
    })
  );
});
