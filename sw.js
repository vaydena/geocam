/* GeoCam – Service Worker (installierbar + offline-fähig)
   Marker: geocam-appbtn-sw-1
   WICHTIG: Bei JEDEM Deploy, der HTML/JS/CSS/Icons ändert, CACHE-Version erhöhen
   (sonst liefert der Offline-Cache alte Inhalte aus).

   - Nur GET, nur gleiche Herkunft; Kartenkacheln, Adress- und Wetterdienst gehen direkt ins Netz.
   - Dokumente (HTML): Netz zuerst, offline Rückfall auf den Cache.
   - Statische Assets: Cache zuerst, sonst Netz + nachlegen. */

const CACHE = "geocam-app-v9";   // <-- bei jedem Asset-/Code-Deploy die Zahl erhöhen (v2, v3, ...) UND ?v= an app.js/app.css/Bild in app.html, app.js, SHELL
const SHELL = [
  "./index.html",
  "./app.html",
  "./landing.css",
  "./app.css?v=9",
  "./app.js?v=9",
  "./exif.js",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
  "./vendor/qrcode/qrcode.js",
  "./preview-freising.jpg?v=9",
  "./hero-freising.jpg",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // best effort: ein einzelner Fehlschlag (z. B. 404) darf die Installation nicht kippen
      // cache:"reload" umgeht den Browser-HTTP-Cache (Hoster liefert JS/CSS mit max-age 7 Tage)
      Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: "reload" }))))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;  // OSM/Open-Meteo -> direkt ins Netz

  const accept = req.headers.get("accept") || "";
  const isDoc = req.mode === "navigate" || accept.includes("text/html");

  if (isDoc) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true }).then((m) => m || caches.match("./app.html"))
        )
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((m) => {
      if (m) return m;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});

// Parkuhr-Mitteilung angetippt: offenes GeoCam-Fenster nach vorn holen, sonst die App beim Parkplatz öffnen
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data || "./app.html?go=park";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.includes("app.html"));
      return open ? open.focus() : self.clients.openWindow(url);
    })
  );
});
