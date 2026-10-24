// Service worker: guarda só os arquivos do próprio app para funcionar offline.
// Rede primeiro (pega atualizações), cache como reserva. Imagens do usuário nunca passam por aqui.
// A política de segurança dele vem do cabeçalho (web/_headers): só consegue buscar arquivos do próprio site.
const CACHE = 'scanner-doc-v33';
const APP_FILES = [
  './',
  './css/style.css',
  './js/app.js',
  './js/pdf.js',
  './js/imaging.js',
  './js/geometry.js',
  './js/viewer.js',
  './js/camera.js',
  './js/filters.js',
  './js/filter-worker.js',
  './js/pix.js',
  './js/document.js',
  './js/docx.js',
  './js/layout.js',
  './js/fonts.js',
  './js/zip.js',
  './js/xml.js',
  './js/inflate.js',
  './js/ranges.js',
  './js/reorder.js',
  './js/pdf-reader.js',
  './js/pdf-layers.js',
  './js/pdf-open.js',
  './js/pdf-render.js',
  './js/pdf-compress.js',
  './js/config.js',
  './js/ocr.js',
  './js/ocr-plan.js',
  './js/sign.js',
  './js/asn1.js',
  './js/pkcs12.js',
  './js/legacy-ciphers.js',
  './js/x509.js',
  './js/cms.js',
  './js/pdf-crypt.js',
  './js/redact.js',
  './js/find-data.js',
  './js/icc.js',
  './js/md5.js',
  './js/stamp.js',
  './js/pdf-append.js',
  './js/ocr-layer.js',
  './js/ttf.js',
  './js/pdfa-fonts.js',
  './js/page-text.js',
  './js/edits.js',
  './js/edit-shapes.js',
  './js/edit-types.js',
  './js/editor.js',
  './js/all-pages.js',
  './js/edit-text.js',
  './js/edit-text-tool.js',
  './js/keyboard-panel.js',
  './js/all-pages-text.js',
  './icon.svg',
  './sankler-logo-reduzido-fundo-claro.svg',
  './sankler-logo-reduzido-fundo-escuro.svg',
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
  // Fora a navegação, busca pela URL. O WebKit confere a política deste arquivo pela finalidade do pedido original:
  // o import feito de dentro de um Worker (o do PDF.js) cai em worker-src, que aqui é 'none', e a leitura do PDF
  // travava. Pela URL vale o connect-src 'self', que é a regra deste arquivo: só arquivos do próprio site.
  event.respondWith(
    fetch(request.mode === 'navigate' ? request : request.url)
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
