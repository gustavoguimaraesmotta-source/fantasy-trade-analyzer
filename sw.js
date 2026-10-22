// Service worker: deixa o app instalável e abre a "casca" do app mesmo com internet ruim.
// Os dados (Sleeper/FantasyCalc) sempre vêm da rede, e os arquivos do site também (o cache só
// entra quando está offline), então uma nova versão publicada chega sozinha aos celulares.
const CACHE = "fta-v1";
const APP_SHELL = [
  "./",
  "index.html",
  "css/styles.css",
  "js/app.js",
  "js/api.js",
  "js/engine.js",
  "js/sleeper.js",
  "js/values.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

// Arquivos do próprio site: rede primeiro (pega atualizações), cache se estiver offline.
// Outros domínios (APIs) passam direto.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return resp;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("index.html"))),
  );
});
