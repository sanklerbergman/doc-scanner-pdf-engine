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

// Libera a memória dos PDFs (ao limpar a lista).
export function releaseAll() {
  for (const promise of documents.values()) promise.then((doc) => doc.destroy()).catch(() => {});
  documents.clear();
}
