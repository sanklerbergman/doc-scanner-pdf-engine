// Service worker: guarda só os arquivos do próprio app para funcionar offline.
// Rede primeiro (pega atualizações), cache como reserva. Imagens do usuário nunca passam por aqui.
const CACHE = 'scanner-doc-v4';
const APP_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/pdf.js',
  './js/imaging.js',
  './js/pix.js',
  './js/config.js',
  './icon.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })),
  );
});
