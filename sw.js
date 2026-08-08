/* =========================================================
   Service Worker - the defining feature of a PWA.
   Handles the three lifecycle states (install / activate / fetch),
   app-shell caching via the Cache API (with a versioned cache),
   and notification (push) receive + click handling.
   ========================================================= */

// Cache version constant -> bump this string whenever the app shell changes.
const CACHE_NAME = "static-shell-cache-v12";

// Only the STATIC app-shell files are cached (not the dynamic food data).
const APP_SHELL = [
    "./",
    "./index.html",
    "./index.css",
    "./app.js",
    "./manifest.json",
    "./img/back_white.png",
    "./img/icon-192.png",
    "./img/icon-512.png",
];

/* ---------- 1. INSTALL: first time the worker is installed ---------- */
self.addEventListener("install", event => {
    console.log("[SW] install - caching app shell:", CACHE_NAME);
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => {
                console.log("[SW] app shell cached, skipping waiting");
                return self.skipWaiting();
            })
    );
});

/* ---------- 2. ACTIVATE: compare cache versions, drop old ones ---------- */
self.addEventListener("activate", event => {
    console.log("[SW] activate - checking cache versions");
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.map(key => {
                if (key !== CACHE_NAME) {
                    console.log("[SW] deleting outdated cache:", key);
                    return caches.delete(key);
                }
            }))
        ).then(() => self.clients.claim())
    );
});

/* ---------- 3. FETCH: intercept every resource request ---------- */
self.addEventListener("fetch", event => {
    const url = event.request.url;
    console.log("[SW] fetch:", url);

    // Live product data must bypass the cache (dynamic content),
    // so app.js can handle the network call + CORS fallback itself.
    if (url.includes("retrieve_records") ||
        url.includes("allorigins") ||
        url.includes("corsproxy")) {
        return;
    }

    // App shell: serve from cache if present, otherwise fetch from server.
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) {
                console.log("[SW] served from cache:", url);
                return cached;
            }
            return fetch(event.request);
        })
    );
});

/* ---------- Notification: RECEIVE a push and display it ---------- */
self.addEventListener("push", event => {
    console.log("[SW] push received");
    let payload = { title: "Food Items", body: "You have a new update." };
    if (event.data) {
        try { payload = event.data.json(); }
        catch (e) { payload.body = event.data.text(); }
    }
    event.waitUntil(
        self.registration.showNotification(payload.title || "Food Items", {
            body: payload.body || "",
            icon: "img/icon-192.png",
            badge: "img/icon-192.png",
            data: { url: payload.url || "./" }
        })
    );
});

/* ---------- Notification: handle the CLICK on the popup ---------- */
self.addEventListener("notificationclick", event => {
    console.log("[SW] notification clicked");
    event.notification.close();
    const target = (event.notification.data && event.notification.data.url) || "./";
    event.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
            for (const client of list) {
                if ("focus" in client) return client.focus();
            }
            return clients.openWindow(target);
        })
    );
});
