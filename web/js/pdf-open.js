// PDFs que já existem, no app: abre o arquivo, avisa o que muda e desenha cada página.
// Carregado só quando aparece o primeiro .pdf (app.js), junto com o pdf-reader.js.
// O desenho usa o PDF.js da Mozilla (pdf-render.js, ~1,7 MB, carregado na primeira vez). Se ele falhar,
// a página aparece como um cartão com o formato da folha e o número. No PDF novo, ela sai igual ao original.
import { openPdf, copyPages, PdfError } from './pdf-reader.js';
import { compressObjects, compressibleBytes } from './pdf-compress.js';
import { buildPdf } from './pdf.js';

// PDF "pesado": imagens que dá para recomprimir somando 1 MB ou mais, e pelo menos 40% do arquivo.
// Aí o app já liga a compressão e avisa (dá para desligar com um toque).
const HEAVY_IMAGES = 1024 * 1024;
const HEAVY_SHARE = 0.4;

export { copyPages, PdfError };

const MAX_FILE = 200 * 1024 * 1024;

let renderer; // pdf-render.js, com o PDF.js

/**
 * Desenha uma página do PDF. Devolve {canvas, real}: real = false quando saiu só o cartão.
 * Página com valores no formulário sai como vai ficar no PDF novo (filledPage).
 * @param {object} doc documento do pdf-reader
 * @param {{index: number, width: number, height: number}} page
 * @param {{maxSide: number, rotation?: number, number: number}} options
 */
export async function drawPdfPage(doc, page, options) {
  try {
    renderer ??= import('./pdf-render.js');
    const { renderPdfPage } = await renderer;
    const filled = filledPage(doc, page.index);
    const canvas = filled
      ? await renderPdfPage(filled, filled.bytes, 0, options)
      : await renderPdfPage(doc, doc.previewBytes ?? doc.bytes, page.index, options);
    return { canvas, real: true };
  } catch (err) {
    console.warn('Página de PDF sem desenho:', err);
    renderer = undefined; // tenta de novo na próxima (ex.: sem rede e sem cache na primeira vez)
    return { canvas: drawPdfCard(page, options), real: false };
  }
}

// Página com valores no formulário (preenchidos no app, ou desenhados de novo quando outro programa não desenhou, #16):
// o PDF.js desenha um PDF só com ela, montado como o PDF novo (copyPages com fill). Assim a miniatura, a tela cheia, a
// tarja (que vira imagem) e o OCR mostram o que vai sair. A cópia é refeita quando os valores da página mudam.
const filledCopies = new WeakMap(); // doc → Map(página → {version, key}); key: {bytes}, a chave do PDF.js
const RELEASE_MS = 10000; // a cópia velha sai da memória do PDF.js depois disto (um desenho dela pode estar no meio)

function filledPage(doc, index) {
  const form = doc.form;
  if (!form?.fillable) return null;
  // Com senha, a cópia decifrada da prévia já leva os campos desenhados de novo: só os preenchidos no app pedem outra.
  if (doc.previewBytes && !form.hasValues(index)) return null;
  if (!filledCopies.has(doc)) filledCopies.set(doc, new Map());
  const copies = filledCopies.get(doc);
  const version = form.pageVersion(index);
  const cached = copies.get(index);
  if (cached?.version === version) return cached.key;
  const fill = form.fill([index]);
  let key = null;
  if (fill.size) {
    const copy = copyPages(doc, [index], { fill });
    key = { bytes: buildPdf([{ copy: { source: copy, page: copy.pages.get(index) } }]) };
  }
  if (cached?.key) {
    const old = cached.key;
    setTimeout(() => renderer?.then((module) => module.release(old)).catch(() => {}), RELEASE_MS);
  }
  copies.set(index, { version, key });
  return key;
}

/**
 * Comprimir: versões menores das imagens e streams que as páginas usam (ver pdf-compress.js).
 * @param {object} doc documento do pdf-reader
 * @param {number[]} indices páginas que vão para o PDF novo
 * @param {{maxSide: number, jpeg: number}} quality nível de qualidade do app (lado maior e qualidade do JPEG)
 * @param {(done: number, total: number) => void} [onProgress]
 */
export function compressPdf(doc, indices, quality, onProgress) {
  return compressObjects(doc, indices, { encode: (input) => encodeJpeg(input, quality), onProgress });
}

// Recodifica uma imagem em JPEG pelo canvas, reduzindo o lado maior para quality.maxSide.
async function encodeJpeg({ jpeg, pixels }, { maxSide, jpeg: level }) {
  let source;
  let release = () => {};
  if (jpeg) {
    // imageOrientation 'none': dentro do PDF, a orientação EXIF do JPEG não vale.
    const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }), { imageOrientation: 'none' });
    source = bitmap;
    release = () => bitmap.close();
  } else {
    source = document.createElement('canvas');
    source.width = pixels.width;
    source.height = pixels.height;
    source.getContext('2d').putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);
    release = () => { source.width = source.height = 0; };
  }
  try {
    const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', level));
    const result = blob && { data: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
    canvas.width = canvas.height = 0;
    return result;
  } finally {
    release();
  }
}

/**
 * Texto das páginas de um PDF gerado, lido pelo PDF.js: a conferência das tarjas. Sem o PDF.js (sem rede e sem
 * cache), dá erro, e quem chama não entrega o PDF.
 * @param {Uint8Array} bytes
 * @param {number[]} indices
 */
export async function pdfTextBoxes(bytes, indices) {
  renderer ??= import('./pdf-render.js');
  try {
    const { pageTexts } = await renderer;
    return await pageTexts(bytes, indices);
  } catch (err) {
    renderer = undefined;
    throw err;
  }
}

/**
 * Texto de uma página de um PDF aberto, pelo PDF.js: a busca de dados para tarjar. Sem o PDF.js, dá erro.
 * @param {object} doc documento do pdf-reader
 * @param {number} index
 */
export async function pdfPageTextItems(doc, index) {
  renderer ??= import('./pdf-render.js');
  try {
    const { pageTextItems } = await renderer;
    return await pageTextItems(doc, doc.previewBytes ?? doc.bytes, index);
  } catch (err) {
    renderer = undefined;
    throw err;
  }
}

// Libera a memória dos PDFs abertos no PDF.js (ao limpar a lista).
export async function releasePdfPreviews() {
  if (renderer) (await renderer.catch(() => null))?.releaseAll();
}

/**
 * @param {File} file
 * @param {string | null} [password] senha do PDF protegido. Sem ela (ou errada), um PDF que precisa de senha é
 *   recusado com PdfPasswordError (pdf-crypt.js), e quem chama pede a senha
 * @returns {Promise<{doc: object, pages: Array<{index: number, width: number, height: number}>, notes: string[],
 *   heavy: boolean}>} heavy: PDF pesado por causa de imagens que a compressão consegue diminuir
 */
export async function openPdfFile(file, password = null) {
  if (file.size > MAX_FILE) throw new PdfError('O PDF passa de 200 MB.');
  const doc = await openPdf(new Uint8Array(await file.arrayBuffer()), { password });
  // Formulário: os campos e os valores (pdf-form.js), carregado só quando o PDF tem campos ou é um formulário XFA.
  if (doc.formFields().some((node) => node.terminal) || doc.acroForm()?.has('XFA')) {
    const { readForm } = await import('./pdf-form.js');
    doc.form = await readForm(doc);
  }
  const notes = [];
  if (doc.security?.hadPassword) {
    notes.push('Este PDF tinha senha: o PDF novo sai sem ela, a não ser que você ligue "Proteger o PDF com senha".');
  } else if (doc.security?.restricted) {
    notes.push('Este PDF tinha restrições do autor (como não permitir imprimir ou alterar): o PDF novo sai sem elas.');
  }
  if (doc.security) {
    // O PDF.js desenha uma cópia já decifrada, com as mesmas páginas que vão para o PDF novo: assim a senha não
    // precisa ficar guardada para as miniaturas.
    const all = doc.pages.map((_, index) => index);
    const copy = copyPages(doc, all, { fill: doc.form?.fill() });
    doc.previewBytes = buildPdf(all.map((index) => ({ copy: { source: copy, page: copy.pages.get(index) } })));
  }
  if (doc.isSigned()) {
    // Com senha, o app sempre monta um PDF novo (pdf-append.js não acrescenta em arquivo cifrado).
    notes.push(doc.security
      ? 'Este PDF tem assinatura digital: no PDF novo a assinatura deixa de valer (ela só vale no arquivo original).'
      : 'Este PDF tem assinatura digital. Se você só assinar, sem mudar nada, ela continua valendo; se juntar, separar ou mudar as páginas, ela deixa de valer no PDF novo.');
  }
  if (doc.layers?.removed) {
    notes.push('Este PDF tem camadas ocultas: o conteúdo delas não vai para o PDF novo, como já estava escondido na tela.');
  }
  if (doc.form) notes.push(...formNotes(doc.form));
  if (doc.hasAnnotations()) {
    notes.push('No PDF novo, links e campos de formulário viram parte da página: o que estava preenchido continua visível, mas não dá mais para clicar nem editar.');
  }
  const pages = doc.pages.map((page, index) => ({ index, width: page.width, height: page.height }));
  const images = compressibleBytes(doc);
  const heavy = images >= HEAVY_IMAGES && images >= file.size * HEAVY_SHARE;
  return { doc, pages, notes, heavy };
}

// Notas do formulário ao abrir: quantos campos ele tem, o XFA puro (que o app não preenche) e, no formulário preenchido
// em outro programa sem desenhar os valores (#16), o que o app não consegue desenhar igual. O resto ele desenha de
// novo, e o PDF novo sai como a tela.
function formNotes(form) {
  const count = form.fields.length;
  if (form.xfa === 'pure') {
    return ['Este PDF é um formulário XFA, que só o Adobe Reader mostra e preenche: aqui não dá para preencher, e as páginas podem aparecer vazias ou só com um aviso do Adobe.'];
  }
  const notes = [];
  if (count) notes.push(count === 1 ? 'Este PDF tem um formulário com 1 campo.' : `Este PDF tem um formulário com ${count} campos.`);
  const { clipped, missing } = form.redrawn();
  const letters = [...missing];
  const quoted = letters.slice(0, 8).map((char) => `“${char}”`).join(', ');
  const problems = [
    letters.length && (letters.length === 1 ? `a letra ${quoted} não existe nas fontes do PDF e fica de fora` : `as letras ${quoted} não existem nas fontes do PDF e ficam de fora`),
    clipped && (clipped === 1 ? 'um dos valores não cabe no campo e sai cortado' : `${clipped} valores não cabem no campo e saem cortados`),
  ].filter(Boolean);
  if (problems.length) {
    notes.push(`Este formulário foi preenchido em outro programa, que não desenhou os valores nos campos. O app desenha de novo, mas ${problems.join('; e ')}.`);
  }
  return notes;
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
