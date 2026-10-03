// Decodificação, rotação e filtros de imagem. Tudo em <canvas>, tudo local.
// Redesenhar a foto num canvas também descarta os metadados EXIF (GPS, modelo do celular etc.).
import { applyFilter } from './filters.js';
import { detectDocument, quadSize, warpPixels } from './geometry.js';

export { applyFilter };

export const FILTERS = {
  document: 'Documento',
  enhance: 'Cor realçada',
  bw: 'Preto e branco',
  original: 'Original',
};

// Retorna algo desenhável num canvas. Respeita a orientação EXIF da foto.
export async function decodeFile(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // navegadores antigos ou formatos que só o <img> entende: tenta abaixo
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => {} };
  } catch (err) {
    // Só o Safari abre HEIC sozinho; nos outros, usa o decodificador embutido.
    if (await isHeif(file)) return decodeHeif(file);
    throw err;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Arquivos HEIC/HEIF começam com uma caixa "ftyp" (bytes 4 a 7).
async function isHeif(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  return String.fromCharCode(...head.subarray(4, 8)) === 'ftyp';
}

let libheif; // carregado só quando aparece o primeiro HEIC (o arquivo tem ~2 MB)

async function decodeHeif(file) {
  libheif ??= import('../vendor/libheif/libheif-bundle.js').then((module) => module.default());
  const { HeifDecoder } = await libheif;
  const images = new HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()));
  if (!images.length) throw new Error('Arquivo HEIC sem imagem');
  try {
    const [image] = images;
    const width = image.get_width();
    const height = image.get_height();
    const pixels = new ImageData(width, height);
    await new Promise((resolve, reject) => {
      image.display(pixels, (result) => (result ? resolve() : reject(new Error('Falha ao decodificar o HEIC'))));
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(pixels, 0, 0);
    return { source: canvas, width, height, release: () => { canvas.width = canvas.height = 0; } };
  } finally {
    for (const image of images) image.free();
  }
}

// Procura o papel na foto. Devolve os cantos normalizados (0 a 1) ou null.
export function detectQuad(source, width, height) {
  const scale = Math.min(1, 256 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  const quad = detectDocument(gray, w, h);
  if (!quad) return null;
  // Puxa os cantos um tiquinho para dentro: melhor perder um fio da margem do que deixar uma tira do fundo.
  const cx = quad.reduce((sum, [x]) => sum + x, 0) / 4;
  const cy = quad.reduce((sum, [, y]) => sum + y, 0) / 4;
  return quad.map(([x, y]) => [x + (cx - x) * 0.012, y + (cy - y) * 0.012]);
}

// Recorta o quad (cantos normalizados) e desfaz a perspectiva. O lado maior do resultado não passa de maxSide.
function cropToQuad(source, width, height, quad, maxSide) {
  const size = quadSize(quad.map(([x, y]) => [x * width, y * height]), width, height);
  const scale = Math.min(1, maxSide / Math.max(size.width, size.height));
  // Reduz a foto antes, para o recorte amostrar perto de 1 pixel por pixel (sem serrilhado).
  const sw = Math.max(1, Math.round(width * scale));
  const sh = Math.max(1, Math.round(height * scale));
  const scaled = document.createElement('canvas');
  scaled.width = sw;
  scaled.height = sh;
  const ctx = scaled.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, sw, sh);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, sw, sh);

  const outW = Math.max(1, Math.round(size.width * scale));
  const outH = Math.max(1, Math.round(size.height * scale));
  const pixels = warpPixels(ctx.getImageData(0, 0, sw, sh).data, sw, sh, quad.map(([x, y]) => [x * sw, y * sh]), outW, outH);
  scaled.width = scaled.height = 0;

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  out.getContext('2d').putImageData(new ImageData(pixels, outW, outH), 0, 0);
  return out;
}

// Desenha a imagem recortada (quad), reduzida (maxSide) e girada (0/90/180/270) num canvas novo, ainda sem filtro.
function drawPage(source, width, height, { rotation = 0, filter = 'original', maxSide = Infinity, quad = null }) {
  let cropped = null;
  if (quad) {
    cropped = cropToQuad(source, width, height, quad, maxSide);
    source = cropped;
    width = cropped.width;
    height = cropped.height;
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const sideways = rotation % 180 !== 0;

  const canvas = document.createElement('canvas');
  canvas.width = sideways ? h : w;
  canvas.height = sideways ? w : h;
  const ctx = canvas.getContext('2d', { willReadFrequently: filter !== 'original' });
  ctx.fillStyle = '#fff'; // PNG transparente viraria preto no JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (cropped) cropped.width = cropped.height = 0;
  return { canvas, ctx };
}

// Versão síncrona, na thread principal: usada nas miniaturas (imagem pequena, rápido).
export function renderPage(source, width, height, options = {}) {
  const { canvas, ctx } = drawPage(source, width, height, options);
  const filter = options.filter ?? 'original';
  if (filter !== 'original') {
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyFilter(pixels, filter);
    ctx.putImageData(pixels, 0, 0);
  }
  return canvas;
}

// Versão para a página em tamanho cheio: o filtro roda no Web Worker e a interface não trava.
// Mesmo resultado da versão síncrona (é o mesmo código de filtro).
export async function renderPageAsync(source, width, height, options = {}) {
  const { canvas, ctx } = drawPage(source, width, height, options);
  const filter = options.filter ?? 'original';
  if (filter === 'original') return canvas;

  const { width: w, height: h } = canvas;
  let pixels;
  try {
    const buffer = await filterInWorker(ctx.getImageData(0, 0, w, h), filter);
    pixels = new ImageData(new Uint8ClampedArray(buffer), w, h);
  } catch (err) {
    // Sem Worker (navegador antigo, falha ao carregar): filtra aqui mesmo.
    // O canvas ainda guarda a imagem sem filtro, então é só ler de novo.
    console.warn('Filtro na thread principal:', err.message);
    pixels = ctx.getImageData(0, 0, w, h);
    applyFilter(pixels, filter);
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

// ---------- Web Worker dos filtros ----------

let worker; // criado no primeiro uso; null = indisponível neste navegador
let nextJob = 1;
const jobs = new Map();

function getWorker() {
  if (worker !== undefined) return worker;
  try {
    // O Worker nasce de um blob de uma linha que importa o arquivo de verdade. Motivo: um Worker carregado
    // direto de um arquivo só obedece à política de segurança enviada pelo servidor (e o GitHub Pages não
    // envia nenhuma); um Worker de blob herda a da página, incluindo o connect-src 'none'.
    const entry = new Blob([`import ${JSON.stringify(new URL('./filter-worker.js', import.meta.url).href)};`], { type: 'text/javascript' });
    worker = new Worker(URL.createObjectURL(entry), { type: 'module' });
  } catch {
    return (worker = null);
  }
  worker.addEventListener('message', ({ data }) => {
    const job = jobs.get(data.id);
    if (!job) return;
    jobs.delete(data.id);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data.buffer);
  });
  // Erro ao carregar o módulo (ou erro fora do try do worker): desiste do Worker de vez.
  worker.addEventListener('error', (event) => {
    event.preventDefault();
    worker.terminate();
    worker = null;
    for (const job of jobs.values()) job.reject(new Error('Worker indisponível'));
    jobs.clear();
  });
  return worker;
}

// Transfere o buffer dos pixels para o Worker (sem cópia) e recebe de volta o buffer filtrado.
function filterInWorker(imageData, filter) {
  const target = getWorker();
  if (!target) return Promise.reject(new Error('Worker indisponível'));
  const id = nextJob++;
  const { buffer } = imageData.data;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    target.postMessage({ id, buffer, width: imageData.width, height: imageData.height, filter }, [buffer]);
  });
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Falha ao codificar a imagem'))), type, quality);
  });
}
