// Decodificação, rotação e filtros de imagem. Tudo em <canvas>, tudo local.
// Redesenhar a foto num canvas também descarta os metadados EXIF (GPS, modelo do celular etc.).
import { applyFilter } from './filters.js';

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

// Desenha a imagem reduzida (maxSide) e girada (0/90/180/270) num canvas novo, ainda sem filtro.
function drawPage(source, width, height, { rotation = 0, filter = 'original', maxSide = Infinity }) {
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
  return { canvas, ctx };
}

// Versão síncrona, na thread principal: usada nas miniaturas (no máximo 480 px, rápido).
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
    worker = new Worker(new URL('./filter-worker.js', import.meta.url), { type: 'module' });
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
