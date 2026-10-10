// Documentos do Word no app: abre o .docx, distribui em páginas e desenha as miniaturas.
// Carregado só quando aparece o primeiro .docx (app.js), junto com docx.js, layout.js e o resto.
import { readDocx, DocxError } from './docx.js';
import { layoutDocument } from './layout.js';
import { textWidth } from './fonts.js';
import { readJpegInfo } from './pdf.js';

// Erros com mensagem pronta para mostrar (arquivo antigo, corrompido, com senha, grande demais).
export { DocxError };

/**
 * @param {File} file
 * @returns {Promise<{pages: Array<{width: number, height: number, items: Array}>, notes: string[]}>}
 */
export async function openDocument(file) {
  const doc = await readDocx(new Uint8Array(await file.arrayBuffer()));
  let layout;
  try {
    layout = layoutDocument(doc);
  } catch (err) {
    if (err instanceof RangeError) throw new DocxError(err.message); // documento com páginas demais
    throw err;
  }
  const images = await prepareImages(doc.images);
  // Cada imagem da página leva os bytes do JPEG (para o PDF) e a imagem pronta para desenhar (miniatura).
  // A que não deu para abrir sai da página e entra no aviso.
  const failed = new Set();
  for (const page of layout.pages) {
    page.items = page.items.filter((item) => {
      if (item.type !== 'image') return true;
      const image = images.get(item.image);
      if (!image) { failed.add(item.image); return false; }
      item.jpeg = image.jpeg;
      item.bitmap = image.bitmap;
      return true;
    });
  }
  doc.notes.images += failed.size;
  return { pages: layout.pages, notes: describeNotes(doc.notes, layout.missing) };
}

const MAX_IMAGE_SIDE = 2400; // imagens convertidas (PNG, GIF…) não precisam passar disso no PDF

// JPEG em RGB ou cinza entra no PDF como está; o resto (PNG, GIF, WebP, BMP, JPEG em CMYK) é convertido
// em JPEG pelo canvas, com fundo branco no lugar da transparência.
async function prepareImages(images) {
  const out = new Map();
  for (const [path, { bytes, type }] of images) {
    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type }));
      let jpeg = null;
      if (type === 'image/jpeg') {
        const { components } = readJpegInfo(bytes);
        if (components === 1 || components === 3) jpeg = bytes;
      }
      if (!jpeg) {
        const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        canvas.width = canvas.height = 0;
        if (!blob) throw new Error('falha ao converter');
        jpeg = new Uint8Array(await blob.arrayBuffer());
      }
      out.set(path, { jpeg, bitmap });
    } catch (err) {
      console.warn(`Imagem ${path} ficou de fora:`, err.message);
    }
  }
  return out;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function list(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

// Frases curtas sobre o que não aparece igual no PDF.
export function describeNotes(notes, missing = []) {
  const out = [];
  const left = [];
  if (notes.images) left.push(plural(notes.images, 'imagem', 'imagens'));
  if (notes.charts) left.push(plural(notes.charts, 'gráfico', 'gráficos'));
  if (notes.shapes) left.push(plural(notes.shapes, 'forma ou caixa de texto', 'formas ou caixas de texto'));
  if (notes.equations) left.push(plural(notes.equations, 'equação', 'equações'));
  if (notes.footnotes) left.push(plural(notes.footnotes, 'nota de rodapé', 'notas de rodapé'));
  if (notes.embedded) left.push(plural(notes.embedded, 'conteúdo embutido', 'conteúdos embutidos'));
  if (left.length) out.push(`Ficou de fora do PDF: ${list(left)}.`);
  if (notes.columns) out.push('O texto em colunas aparece numa coluna só.');
  if (missing.length) {
    const shown = missing.filter((char) => !/\p{Co}/u.test(char)).slice(0, 5);
    out.push(shown.length
      ? `Alguns caracteres (${shown.join(' ')}) não existem nas fontes do PDF e viraram "?".`
      : 'Alguns símbolos não existem nas fontes do PDF e viraram "?".');
  }
  return out;
}

// Fontes do sistema mais parecidas com as do PDF. A miniatura usa as larguras do PDF (maxWidth),
// então a diferença entre as fontes só aparece no desenho das letras, nunca no lugar das palavras.
const CSS_FAMILIES = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", monospace',
};

function cssFont(font, size) {
  const [family, variant = ''] = font.split('-');
  const italic = /Italic|Oblique/.test(variant) ? 'italic ' : '';
  const bold = /Bold/.test(variant) ? 'bold ' : '';
  return `${italic}${bold}${size}px ${CSS_FAMILIES[family]}`;
}

const cssColor = (color) => (color ? `rgb(${color.map((c) => Math.round(c * 255)).join(' ')})` : '#000');

/**
 * Desenha uma página de documento num canvas, do jeito que vai sair no PDF.
 * @param {{width: number, height: number, items: Array}} page
 * @param {{maxSide: number, rotation?: number}} options
 */
export function drawDocumentPage(page, { maxSide, rotation = 0 }) {
  const scale = maxSide / Math.max(page.width, page.height);
  const w = Math.max(1, Math.round(page.width * scale));
  const h = Math.max(1, Math.round(page.height * scale));
  const sideways = rotation % 180 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = sideways ? h : w;
  canvas.height = sideways ? w : h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.translate(-w / 2, -h / 2);
  ctx.scale(w / page.width, h / page.height);

  // Fundos e imagens por baixo, como no PDF; depois texto, linhas e bordas.
  for (const item of page.items) {
    if (item.type === 'rect') {
      ctx.fillStyle = cssColor(item.color);
      ctx.fillRect(item.x, item.y, item.w, item.h);
    } else if (item.type === 'image' && item.bitmap) {
      ctx.drawImage(item.bitmap, item.x, item.y, item.w, item.h);
    }
  }
  for (const item of page.items) {
    if (item.type === 'rect' || item.type === 'image') continue;
    if (item.type === 'line') {
      ctx.strokeStyle = cssColor(item.color);
      ctx.lineWidth = item.width;
      ctx.beginPath();
      ctx.moveTo(item.x1, item.y1 ?? item.y);
      ctx.lineTo(item.x2, item.y2 ?? item.y);
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = cssColor(item.color);
    ctx.font = cssFont(item.font, item.size);
    const y = item.y - item.rise;
    const draw = (text, x) => {
      const width = textWidth(text, item.font, item.size);
      if (width > 0) ctx.fillText(text, x, y, width);
      return width;
    };
    if (!item.wordSpacing) {
      draw(item.text, item.x);
      continue;
    }
    // Texto justificado: palavra por palavra, com o espaço extra entre elas.
    const space = textWidth(' ', item.font, item.size) + item.wordSpacing;
    let x = item.x;
    for (const word of item.text.split(' ')) x += draw(word, x) + space;
  }
  return canvas;
}
