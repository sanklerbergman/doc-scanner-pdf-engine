// Documentos do Word no app: abre o .docx, distribui em páginas e desenha as miniaturas.
// Carregado só quando aparece o primeiro .docx (app.js), junto com docx.js, layout.js e o resto.
import { readDocx, DocxError } from './docx.js';
import { layoutDocument } from './layout.js';
import { textWidth } from './fonts.js';

// Erros com mensagem pronta para mostrar (arquivo antigo, corrompido, com senha, grande demais).
export { DocxError };

/**
 * @param {File} file
 * @returns {Promise<{pages: Array<{width: number, height: number, items: Array}>, notes: string[]}>}
 */
export async function openDocument(file) {
  const doc = await readDocx(new Uint8Array(await file.arrayBuffer()));
  try {
    const { pages, missing } = layoutDocument(doc);
    return { pages, notes: describeNotes(doc.notes, missing) };
  } catch (err) {
    if (err instanceof RangeError) throw new DocxError(err.message); // documento com páginas demais
    throw err;
  }
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
  if (notes.headerFooter) left.push('o cabeçalho e o rodapé');
  if (left.length) out.push(`Ficou de fora do PDF: ${list(left)}.`);
  if (notes.tables) out.push('As tabelas aparecem como texto corrido, sem as linhas.');
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

  for (const item of page.items) {
    ctx.fillStyle = cssColor(item.color);
    if (item.type === 'line') {
      ctx.fillRect(item.x1, item.y - item.width / 2, item.x2 - item.x1, item.width);
      continue;
    }
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
