// Desenho das páginas de PDFs abertos (miniatura e tela cheia), com o PDF.js da Mozilla (web/vendor/pdfjs).
// Só desenha: o PDF novo é montado pelo pdf-reader.js, copiando as páginas como estão.
//
// Segurança: o worker do PDF.js nasce de um blob que importa o arquivo de verdade, então herda a política
// da página, incluindo connect-src 'none' (mesmo truque do Worker dos filtros, em imaging.js). WebAssembly e
// XFA ficam desligados e os scripts do PDF nunca rodam.
import * as pdfjs from '../vendor/pdfjs/pdf.min.js';

let started = false;
let failed; // rejeita se o módulo do worker não carregar
function startWorker() {
  if (started) return;
  started = true;
  const url = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
  const entry = new Blob([`import ${JSON.stringify(url)};`], { type: 'text/javascript' });
  const worker = new Worker(URL.createObjectURL(entry), { type: 'module' });
  // Se o módulo não carregar (sem rede e sem cache, por exemplo), o PDF.js esperaria o worker para sempre e a
  // leitura do PDF não terminaria. Assim, as leituras pendentes falham (a página aparece como cartão) e a
  // próxima tenta um worker novo. Depois da primeira mensagem, o worker carregou e o PDF.js cuida dos erros.
  failed = new Promise((_, reject) => {
    const onError = (event) => {
      event.preventDefault();
      worker.terminate();
      started = false;
      documents.clear();
      reject(new Error('O worker do PDF.js não carregou.'));
    };
    worker.addEventListener('error', onError, { once: true });
    worker.addEventListener('message', () => worker.removeEventListener('error', onError), { once: true });
  });
  failed.catch(() => {});
  pdfjs.GlobalWorkerOptions.workerPort = worker;
}

const documents = new Map(); // chave (documento do pdf-reader) → promessa do documento do PDF.js

function load(key, bytes) {
  if (!documents.has(key)) {
    startWorker();
    const task = pdfjs.getDocument({
      data: bytes.slice(), // o PDF.js transfere o buffer para o worker: manda uma cópia
      useWasm: false,
      enableXfa: false,
      useSystemFonts: true,
      stopAtErrors: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    const promise = Promise.race([task.promise, failed]);
    documents.set(key, promise);
    promise.catch(() => {
      documents.delete(key);
      task.destroy().catch(() => {});
    });
  }
  return documents.get(key);
}

/**
 * Desenha uma página num canvas novo, com o lado maior em maxSide pixels.
 * @param {object} key identifica o PDF (o documento do pdf-reader)
 * @param {Uint8Array} bytes o arquivo inteiro
 * @param {number} index página, a partir de 0
 * @param {{maxSide: number, rotation?: number}} options rotation: giro extra pedido no app
 */
export async function renderPdfPage(key, bytes, index, { maxSide, rotation = 0 }) {
  const doc = await load(key, bytes);
  const page = await doc.getPage(index + 1);
  try {
    const angle = (page.rotate + rotation) % 360;
    const natural = page.getViewport({ scale: 1, rotation: angle });
    const viewport = page.getViewport({ scale: maxSide / Math.max(natural.width, natural.height), rotation: angle });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Anotações com aparência (campo preenchido, carimbo) entram no desenho, como no PDF novo.
    await page.render({ canvasContext: ctx, canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    return canvas;
  } finally {
    page.cleanup();
  }
}

// Caixa de um trecho de texto do PDF.js na página (de 0 a 1, origem no canto superior esquerdo), pelo viewport:
// da linha de base um pouco para baixo até perto do tamanho da letra para cima.
function itemBox(item, viewport) {
  const [, b, c, d, e, f] = item.transform;
  const height = item.height || Math.hypot(c, d);
  if (b || c) return tiltedBox(item, viewport, height);
  const corners = [[e, f - height * 0.2], [e + item.width, f + height * 0.8]].map(([x, y]) => viewport.convertToViewportPoint(x, y));
  const xs = corners.map(([x]) => x / viewport.width);
  const ys = corners.map(([, y]) => y / viewport.height);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// Trecho inclinado (a camada do OCR numa página torta, texto girado de outro PDF): os quatro cantos, ao longo da
// linha de base e na direção do alto das letras, em quad; a caixa é a reta que envolve os quatro. A conferência das
// tarjas usa os cantos (redact.js): a caixa reta de uma linha inclinada inteira passa por cima das linhas vizinhas.
function tiltedBox(item, viewport, height) {
  const [a, b, c, d, e, f] = item.transform;
  const along = Math.hypot(a, b) || 1;
  const up = Math.hypot(c, d) || 1;
  const quad = [[0, -0.2], [1, -0.2], [1, 0.8], [0, 0.8]].map(([s, t]) => {
    const [x, y] = viewport.convertToViewportPoint(e + (a / along) * item.width * s + (c / up) * height * t,
      f + (b / along) * item.width * s + (d / up) * height * t);
    return [x / viewport.width, y / viewport.height];
  });
  const xs = quad.map(([x]) => x);
  const ys = quad.map(([, y]) => y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), quad };
}

/**
 * Texto de uma página de um PDF aberto no app, para a busca de dados a tarjar: cada trecho com a caixa (de 0 a 1,
 * com o /Rotate do próprio PDF, sem o giro feito no app) e a família da fonte, para estimar onde fica cada letra.
 * @param {object} key identifica o PDF (o documento do pdf-reader)
 * @returns {Promise<{items: Array<{str: string, x0: number, y0: number, x1: number, y1: number, family: string}>,
 *   width: number, height: number}>}
 */
export async function pageTextItems(key, bytes, index) {
  const doc = await load(key, bytes);
  const page = await doc.getPage(index + 1);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const { items, styles } = await page.getTextContent();
    return {
      width: viewport.width,
      height: viewport.height,
      items: items.filter((item) => item.str?.trim()).map((item) => ({
        str: item.str, ...itemBox(item, viewport), family: styles[item.fontName]?.fontFamily ?? 'sans-serif',
      })),
    };
  } finally {
    page.cleanup();
  }
}

/**
 * Texto de páginas de um PDF, lido pelo PDF.js, com a posição como a página aparece na tela (de 0 a 1, origem no
 * canto superior esquerdo, já com o /Rotate): a conferência das tarjas (redact.js). Inclui texto invisível
 * (camada do OCR).
 * Usa um worker só para isso, encerrado no fim: ao fechar um documento, o PDF.js destrói o worker dele, e o das
 * miniaturas não pode ir junto. Esse worker também nasce de um blob, com a política da página.
 * @param {Uint8Array} bytes o PDF gerado pelo app
 * @param {number[]} indices páginas, a partir de 0
 * @returns {Promise<Map<number, Array<{str: string, x0: number, y0: number, x1: number, y1: number}>>>}
 */
export async function pageTexts(bytes, indices) {
  const url = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
  const entry = URL.createObjectURL(new Blob([`import ${JSON.stringify(url)};`], { type: 'text/javascript' }));
  const port = new Worker(entry, { type: 'module' });
  const broken = new Promise((_, reject) => {
    port.addEventListener('error', (event) => {
      event.preventDefault();
      reject(new Error('O worker do PDF.js não carregou.'));
    }, { once: true });
  });
  broken.catch(() => {});
  const worker = new pdfjs.PDFWorker({ port });
  const task = pdfjs.getDocument({
    data: bytes.slice(), worker, useWasm: false, enableXfa: false, useSystemFonts: true, stopAtErrors: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const doc = await Promise.race([task.promise, broken]);
    const out = new Map();
    for (const index of indices) {
      const page = await doc.getPage(index + 1);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const { items } = await page.getTextContent();
        out.set(index, items.filter((item) => item.str?.trim()).map((item) => ({ str: item.str, ...itemBox(item, viewport) })));
      } finally {
        page.cleanup();
      }
    }
    return out;
  } finally {
    await task.destroy().catch(() => {});
    worker.destroy();
    port.terminate();
    URL.revokeObjectURL(entry);
  }
}

// Libera a memória dos PDFs (ao limpar a lista).
export function releaseAll() {
  for (const promise of documents.values()) promise.then((doc) => doc.destroy()).catch(() => {});
  documents.clear();
}
