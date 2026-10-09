// PDFs que já existem, no app: abre o arquivo, avisa o que muda e desenha cada página.
// Carregado só quando aparece o primeiro .pdf (app.js), junto com o pdf-reader.js.
// O desenho usa o PDF.js da Mozilla (pdf-render.js, ~1,7 MB, carregado na primeira vez). Se ele falhar,
// a página aparece como um cartão com o formato da folha e o número. No PDF novo, ela sai igual ao original.
import { openPdf, copyPages, PdfError } from './pdf-reader.js';

export { copyPages, PdfError };

const MAX_FILE = 200 * 1024 * 1024;

let renderer; // pdf-render.js, com o PDF.js

/**
 * Desenha uma página do PDF. Devolve {canvas, real}: real = false quando saiu só o cartão.
 * @param {object} doc documento do pdf-reader
 * @param {{index: number, width: number, height: number}} page
 * @param {{maxSide: number, rotation?: number, number: number}} options
 */
export async function drawPdfPage(doc, page, options) {
  try {
    renderer ??= import('./pdf-render.js');
    const { renderPdfPage } = await renderer;
    return { canvas: await renderPdfPage(doc, doc.bytes, page.index, options), real: true };
  } catch (err) {
    console.warn('Página de PDF sem desenho:', err);
    renderer = undefined; // tenta de novo na próxima (ex.: sem rede e sem cache na primeira vez)
    return { canvas: drawPdfCard(page, options), real: false };
  }
}

// Libera a memória dos PDFs abertos no PDF.js (ao limpar a lista).
export async function releasePdfPreviews() {
  if (renderer) (await renderer.catch(() => null))?.releaseAll();
}

/**
 * @param {File} file
 * @returns {Promise<{doc: object, pages: Array<{index: number, width: number, height: number}>, notes: string[]}>}
 */
export async function openPdfFile(file) {
  if (file.size > MAX_FILE) throw new PdfError('O PDF passa de 200 MB.');
  const doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
  const notes = [];
  if (doc.isSigned()) {
    notes.push('Este PDF tem assinatura digital: no PDF novo a assinatura deixa de valer (ela só vale no arquivo original).');
  }
  if (doc.hasAnnotations()) {
    notes.push('Links e campos de formulário viram parte da página: o que estava preenchido continua visível, mas não dá mais para clicar nem editar.');
  }
  const pages = doc.pages.map((page, index) => ({ index, width: page.width, height: page.height }));
  return { doc, pages, notes };
}

// Nome do formato, quando é um dos comuns (tolerância de 2 pt).
function paperName(width, height) {
  const [short, long] = [Math.min(width, height), Math.max(width, height)];
  const sizes = { A4: [595, 842], A3: [842, 1191], A5: [420, 595], Carta: [612, 792], Ofício: [612, 1008] };
  for (const [name, [w, h]] of Object.entries(sizes)) if (Math.abs(short - w) < 2 && Math.abs(long - h) < 2) return name;
  return `${Math.round(short / 72 * 25.4)} × ${Math.round(long / 72 * 25.4)} mm`;
}

/**
 * Cartão de uma página de PDF: a folha no formato e na orientação certos, com o número da página.
 * @param {{width: number, height: number}} page tamanho em pontos, já com o giro do próprio PDF
 * @param {{maxSide: number, rotation?: number, number: number}} options
 */
export function drawPdfCard(page, { maxSide, rotation = 0, number }) {
  const sideways = rotation % 180 !== 0;
  const width = sideways ? page.height : page.width;
  const height = sideways ? page.width : page.height;
  const scale = maxSide / Math.max(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  const unit = Math.min(canvas.width, canvas.height);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Linhas cinza de "texto", só para a folha não parecer em branco.
  ctx.fillStyle = '#e4e7eb';
  const margin = unit * 0.12;
  const line = unit * 0.035;
  for (let y = margin, i = 0; y < canvas.height - margin; y += line * 2.2, i++) {
    const w = (canvas.width - margin * 2) * (i % 5 === 4 ? 0.6 : 1);
    ctx.fillRect(margin, y, w, line);
  }
  // Selo central: "PDF", número da página e formato.
  const boxW = unit * 0.62;
  const boxH = unit * 0.42;
  const x = (canvas.width - boxW) / 2;
  const y = (canvas.height - boxH) / 2;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#0f766e';
  ctx.lineWidth = Math.max(2, unit * 0.012);
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, unit * 0.04);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#0f766e';
  ctx.font = `bold ${unit * 0.09}px system-ui, sans-serif`;
  ctx.fillText('PDF', canvas.width / 2, y + boxH * 0.24);
  ctx.fillStyle = '#16191d';
  ctx.font = `bold ${unit * 0.12}px system-ui, sans-serif`;
  ctx.fillText(`pág. ${number}`, canvas.width / 2, y + boxH * 0.55);
  ctx.fillStyle = '#5b6470';
  ctx.font = `${unit * 0.055}px system-ui, sans-serif`;
  ctx.fillText(paperName(width, height), canvas.width / 2, y + boxH * 0.82);
  return canvas;
}
