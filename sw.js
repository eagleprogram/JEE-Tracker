// IMPORTANT: bump this version string on every deploy that changes any file
// listed in APP_SHELL below (i.e. basically every deploy). The fetch handler
// is cache-first, so returning visitors keep getting served whatever was
// cached under CACHE_NAME until the string itself changes — that's the only
// thing that makes the activate handler below delete the old cache and let
// the new files be fetched fresh. Forgetting this step means fixes silently
// never reach anyone who doesn't manually hard-refresh.
const CACHE_NAME = "jee-tracker-v2.5.8";

// ----------------- BACKGROUND PUSH (Firebase Cloud Messaging) -----------------
// Handles push messages that arrive while no tab of this app is open or
// focused — the one channel that can still reach the user with the browser
// fully closed (as far as the OS/platform allows at all — see the "HONEST
// LIMIT" comment in js/push-notifications.js). Sent by the free scheduled
// job in server/send-scheduled-alarms.js — see PUSH_SETUP.md for setup.
//
// A classic (non-module) service worker can't `import` js/firebase-sync.js,
// so the Firebase compat SDK is loaded the same way that file loads it in
// index.html, and the same PUBLIC (client-side-safe) config values are
// duplicated here — there is no secret in a Firebase web config; it's
// designed to be embedded in client code. Keep this object in sync with
// FIREBASE_CONFIG in js/firebase-sync.js if that project is ever rotated.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCHvTipTo9yc19FOB-o31GfRu0El3SIqzc",
  authDomain: "jee-study-tracker-99.firebaseapp.com",
  projectId: "jee-study-tracker-99",
  storageBucket: "jee-study-tracker-99.firebasestorage.app",
  messagingSenderId: "221533539699",
  appId: "1:221533539699:web:5a68a74a33898627cb4906"
});

const messaging = firebase.messaging();

// The scheduled server script sends DATA-ONLY messages (no top-level
// "notification" field) on purpose. A "notification" payload gets
// auto-displayed by the browser with no way to control its tag, vibrate
// pattern, or action buttons from here — that would make a server-sent
// alarm look and behave differently from every in-tab one. Data-only
// messages always land in onBackgroundMessage instead, so this builds the
// exact same requireInteraction + vibrate + "Stop Alarm" action notification
// that fireOsNotification() in js/notifications.js already builds — one
// consistent alarm experience no matter which path sent it. The existing
// notificationclick handler further down already handles taps on these
// (same tag/action shape), so nothing extra is needed there.
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  const title = d.title || "JEE Tracker reminder";
  const persistent = d.persistent !== "0";
  self.registration.showNotification(title, {
    body: d.body || "",
    icon: "./assets/icon-192.png",
    badge: "./assets/icon-192.png",
    tag: "jee-alarm-" + String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    renotify: true,
    requireInteraction: persistent,
    vibrate: persistent ? [300, 100, 300, 100, 300] : [150],
    actions: persistent ? [{ action: "stop-alarm", title: "Stop Alarm" }] : []
  });
});

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
  "./js/push-notifications.js",
  "./js/planner.js",
  "./js/history.js",
  "./js/sleep.js",
  "./js/questions.js",
  "./js/week-nav.js",
  "./js/syllabus.js",
  "./js/mocktest.js",
  "./js/youtube.js",
  "./js/charts.js",
  "./js/reports.js",
  "./js/backup.js",
  "./js/firebase-sync.js",
  "./js/ui.js",
  "./js/main.js",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/target-icon.png"
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

// ----------------- ALARM NOTIFICATIONS: CLICK / ACTION HANDLING ---------
// Notifications raised via registration.showNotification() (see
// fireOsNotification() in js/notifications.js) are delivered by the
// browser's own OS-level notification system, which is what lets them
// still appear when this app's tab is minimized or another app is
// fullscreened over the browser — the OS, not this page, owns rendering
// them. Tapping either the notification body or its "Stop Alarm" action
// button needs to reach back into the actual running page to silence the
// in-page alarm loop/modal, which is what this does: find an already-open
// client (tab) for this app and postMessage it; if none is open, open one
// (there's no live page yet to message in that case — the fresh load just
// boots normally, which is the best a static, backend-less site can do).
self.addEventListener("notificationclick", (event) => {
  const isStop = event.action === "stop-alarm";
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({ type: isStop ? "STOP_ALARM" : "FOCUS_ALARM" });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
