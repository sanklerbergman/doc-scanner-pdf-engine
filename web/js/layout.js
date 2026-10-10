// Distribui o texto de um documento (modelo do docx.js) em páginas: quebra de linha por palavra,
// alinhamento, recuos, tabulação, espaçamento, imagens, tabelas, cabeçalho, rodapé e paginação. Tudo medido
// com as larguras das fontes padrão do PDF (fonts.js), então o que sai aqui é exatamente o que o PDF desenha.
//
// Cada página sai como {width, height, items}, em pontos, com a origem no canto superior esquerdo:
// - {type: 'text', x, y, text, font, size, color, wordSpacing, rise}, com y na linha de base;
// - {type: 'line', x1, x2, y, width, color} (horizontal, sublinhado e tachado) ou {x1, y1, x2, y2, ...} (bordas);
// - {type: 'rect', x, y, w, h, color}, fundo de célula de tabela;
// - {type: 'image', image, x, y, w, h}, com image = caminho da imagem no .docx (document.js põe os bytes).
import { pdfFont, textWidth } from './fonts.js';
import { winAnsiCode } from './pdf.js';

const LINE_HEIGHT = 1.15; // altura da linha simples, em relação ao tamanho da fonte
const DESCENT = 0.25; // parte da linha abaixo da linha de base
const SCRIPT_SIZE = 0.65; // sobrescrito e subscrito
export const MAX_PAGES = 1000;

// Equivalentes para o que as fontes padrão do PDF não têm. O resto vira "?".
const REPLACEMENTS = new Map([
  ['­', ''], ['​', ''], ['‌', ''], ['‍', ''], ['⁠', ''], ['﻿', ''],
  ...[...'           　  '].map((c) => [c, ' ']),
  ['‐', '-'], ['‑', '-'], ['‒', '-'], ['−', '-'], ['―', '—'],
  ['′', "'"], ['″', '"'], ['⁄', '/'], ['∕', '/'],
  ['≤', '<='], ['≥', '>='], ['→', '->'], ['←', '<-'],
  ...[...'‣⁃∙▪■●◆►▶➢❖'].map((c) => [c, '•']),
  ['◦', 'o'], ['○', 'o'],
]);

/**
 * Deixa o texto só com caracteres das fontes padrão do PDF.
 * @param {string} text
 * @param {Set<string>} missing recebe o que não tem equivalente
 * @param {string} [fallback] o que pôr no lugar (marcadores de lista usam "•")
 */
export function sanitize(text, missing, fallback = '?') {
  let out = '';
  for (const char of text.normalize('NFC')) {
    const replacement = REPLACEMENTS.get(char);
    if (replacement !== undefined) { out += replacement; continue; }
    if (winAnsiCode(char) !== undefined) { out += char; continue; }
    const code = char.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || (code >= 0xfe00 && code <= 0xfe0f)) continue; // controle
    if (code >= 0xf000 && code <= 0xf0ff) { out += '•'; continue; } // símbolo de fonte (Symbol, Wingdings)
    if (fallback === '?') missing.add(char);
    out += fallback;
  }
  return out;
}

// Estilo de desenho de um trecho: fonte do PDF, tamanho e deslocamento (sobrescrito/subscrito).
function styleOf(run) {
  const script = run.vertAlign ? SCRIPT_SIZE : 1;
  return {
    font: pdfFont(run.family, run.bold, run.italic),
    size: run.size * script,
    lineSize: run.size,
    rise: run.vertAlign === 'superscript' ? run.size * 0.33 : run.vertAlign === 'subscript' ? -run.size * 0.14 : 0,
    color: run.color,
    underline: run.underline,
    strike: run.strike,
  };
}

const sameStyle = (a, b) => a.font === b.font && a.size === b.size && a.rise === b.rise && a.underline === b.underline &&
  a.strike === b.strike && String(a.color) === String(b.color);

// Peças do parágrafo: palavras (sem espaço), espaços, tabulações, quebras e imagens.
// ctx.fields: valores dos campos de página ({PAGE: '3', NUMPAGES: '7'}), usados no cabeçalho e no rodapé.
function pieces(block, columnWidth, ctx) {
  const { missing, fields = {} } = ctx;
  const out = [];
  const addText = (text, style) => {
    for (const part of text.split(/( +)/)) {
      if (part) out.push({ kind: part[0] === ' ' ? 'space' : 'word', text: part, style, width: textWidth(part, style.font, style.size) });
    }
  };
  if (block.label) {
    const style = styleOf(block.label);
    addText(sanitize(block.label.text, missing, '•'), style);
    if (block.label.suffix === 'space') addText(' ', style);
    else if (block.label.suffix !== 'nothing') out.push({ kind: 'tab', style });
  }
  // Imagem maior que a coluna encolhe para caber, sem deformar.
  const room = Math.max(1, columnWidth - block.indent.left - block.indent.right);
  for (const run of block.runs) {
    const style = styleOf(run);
    if (run.break) out.push({ kind: 'break', page: run.break === 'page', style });
    else if (run.tab) out.push({ kind: 'tab', style });
    else if (run.image) {
      const scale = Math.min(1, room / run.width);
      out.push({ kind: 'image', image: run.image, width: run.width * scale, height: run.height * scale, style });
    } else if (run.float) out.push({ kind: 'float', float: run.float });
    else if (run.field) addText(sanitize(fields[run.field] ?? run.text ?? '', missing), style);
    else addText(sanitize(run.text, missing), style);
  }
  return out;
}

// Palavras seguidas, mesmo em trechos de formatação diferente ("**neg**rito"), não se separam.
function groups(list) {
  const out = [];
  for (const piece of list) {
    const last = out[out.length - 1];
    if (piece.kind === 'word' && last?.kind === 'word') {
      last.parts.push(piece);
      last.width += piece.width;
    } else if (piece.kind === 'word' || piece.kind === 'image') {
      out.push({ kind: piece.kind, parts: [piece], width: piece.width });
    } else {
      out.push(piece);
    }
  }
  return out;
}

// Palavra maior que a linha: separa o começo que cabe em `room` (com force, pelo menos uma letra) do resto.
function cutWord(group, room, force) {
  const head = { kind: 'word', parts: [], width: 0 };
  const tail = { kind: 'word', parts: [], width: 0 };
  let full = false;
  for (const part of group.parts) {
    if (full) {
      tail.parts.push(part);
      tail.width += part.width;
      continue;
    }
    let text = '';
    let width = 0;
    const chars = [...part.text];
    let i = 0;
    for (; i < chars.length; i++) {
      const w = textWidth(chars[i], part.style.font, part.style.size);
      if (head.width + width + w > room && (head.width + width > 0 || !force)) break;
      text += chars[i];
      width += w;
    }
    if (text) {
      head.parts.push({ ...part, text, width });
      head.width += width;
    }
    if (i < chars.length) {
      full = true;
      const rest = chars.slice(i).join('');
      const restWidth = textWidth(rest, part.style.font, part.style.size);
      tail.parts.push({ ...part, text: rest, width: restWidth });
      tail.width += restWidth;
    }
  }
  return { head: head.parts.length ? head : null, tail: tail.parts.length ? tail : null };
}

function nextTab(x, stops, interval) {
  for (const stop of stops) if (stop > x + 0.5) return stop;
  return (Math.floor(x / interval + 1e-6) + 1) * interval;
}

/**
 * Quebra um parágrafo em linhas, para uma coluna de texto com a largura dada.
 * Cada linha: {height, baseline, spans: [{x, text, style, width}], images: [{x, image, width, height}],
 * floats, wordSpacing, pageBreakAfter}, com x a partir da margem esquerda.
 * @param {{missing?: Set<string>, fields?: object}} [ctx]
 */
export function breakLines(block, columnWidth, defaultTab, ctx = {}) {
  ctx.missing ??= new Set();
  const { indent } = block;
  const stops = indent.firstLine < 0 ? [...new Set([...block.tabs, indent.left])].sort((a, b) => a - b) : block.tabs;
  const lines = [];
  const startOf = (first) => indent.left + (first ? indent.firstLine : 0);
  const widthOf = (first) => Math.max(1, columnWidth - indent.right - startOf(first));

  let line;
  // Espaço no começo da linha só fica no início do parágrafo ou depois de uma quebra manual;
  // o que sobra de uma linha que quebrou sozinha some, como no Word.
  const open = (keepSpaces) => { line = { parts: [], width: 0, floats: [], first: lines.length === 0, keepSpaces }; };
  const hasContent = () => line.parts.some((part) => part.kind !== 'space');
  const fits = (width) => line.width + width <= widthOf(line.first) + 0.01;
  const close = (ending) => {
    while (line.parts[line.parts.length - 1]?.kind === 'space') line.width -= line.parts.pop().width; // espaço no fim não conta
    lines.push({ ...line, ending });
    open(ending !== 'wrap');
  };
  open(true);

  for (const item of groups(pieces(block, columnWidth, ctx))) {
    if (item.kind === 'space') {
      if (line.keepSpaces || hasContent()) { line.parts.push(item); line.width += item.width; }
    } else if (item.kind === 'float') {
      line.floats.push(item.float); // imagem flutuante: não ocupa lugar na linha
    } else if (item.kind === 'break') {
      close(item.page ? 'page' : 'line');
    } else if (item.kind === 'tab') {
      let x = startOf(line.first) + line.width;
      let width = nextTab(x, stops, defaultTab) - x;
      if (!fits(width) && hasContent()) {
        close('wrap');
        x = startOf(false);
        width = nextTab(x, stops, defaultTab) - x;
      }
      line.parts.push({ kind: 'tab', width, style: item.style });
      line.width += width;
    } else {
      if (!fits(item.width) && hasContent() && item.width <= widthOf(false) + 0.01) close('wrap');
      if (fits(item.width) || item.kind === 'image') { // imagem já encolheu para a coluna: nunca é cortada
        line.parts.push(...item.parts);
        line.width += item.width;
        continue;
      }
      // Não cabe nem numa linha inteira: corta letra a letra, enchendo esta linha e as seguintes.
      let rest = item;
      while (rest) {
        const { head, tail } = cutWord(rest, widthOf(line.first) - line.width, !hasContent());
        if (!head) { close('wrap'); continue; }
        line.parts.push(...head.parts);
        line.width += head.width;
        rest = tail;
        if (rest) close('wrap');
      }
    }
  }
  close('end');

  return lines.map((raw) => finishLine(raw, block, widthOf(raw.first), startOf(raw.first)));
}

// Altura, alinhamento e trechos de mesmo estilo de uma linha.
function finishLine(raw, block, available, start) {
  const sizes = raw.parts.filter((part) => part.style && part.kind !== 'image').map((part) => part.style.lineSize);
  const size = sizes.length ? Math.max(...sizes) : block.mark.size;
  const natural = size * LINE_HEIGHT;
  const { line, lineRule } = block.spacing;
  let height = lineRule === 'exact' ? line : lineRule === 'atLeast' ? Math.max(natural, line) : natural * line;
  let baseline = height - size * DESCENT;
  // Imagem na linha fica apoiada na linha de base e aumenta a linha, se precisar.
  const tallest = Math.max(0, ...raw.parts.filter((part) => part.kind === 'image').map((part) => part.height));
  if (tallest > baseline) {
    height += tallest - baseline;
    baseline = tallest;
  }

  const free = available - raw.width;
  let offset = 0;
  let wordSpacing = 0;
  if (block.align === 'center') offset = free / 2;
  else if (block.align === 'right') offset = free;
  else if (block.align === 'justify' && raw.ending === 'wrap' && free > 0 && !raw.parts.some((part) => part.kind === 'tab')) {
    const spaces = raw.parts.reduce((sum, part) => sum + (part.kind === 'space' ? part.text.length : 0), 0);
    if (spaces) wordSpacing = free / spaces;
  }

  const spans = [];
  const images = [];
  let x = start + Math.max(0, offset);
  let span = null;
  for (const part of raw.parts) {
    if (part.kind === 'tab' || part.kind === 'image') {
      // Tabulação sublinhada é a "linha para preencher" dos formulários: vira só o sublinhado.
      if (part.kind === 'tab' && part.style.underline) spans.push({ x, text: '', style: part.style, width: part.width });
      if (part.kind === 'image') images.push({ x, image: part.image, width: part.width, height: part.height });
      span = null;
      x += part.width;
      continue;
    }
    const width = part.width + (part.kind === 'space' ? part.text.length * wordSpacing : 0);
    if (span && sameStyle(span.style, part.style)) {
      span.text += part.text;
      span.width += width;
    } else {
      span = { x, text: part.text, style: part.style, width };
      spans.push(span);
    }
    x += width;
  }
  return { height, baseline, spans, images, floats: raw.floats, wordSpacing, pageBreakAfter: raw.ending === 'page' };
}

// ---------- Desenho ----------
// frame: a página em que a linha está ({width, height, margin}), para posicionar as imagens flutuantes.

// Posição de uma imagem flutuante, pela âncora do Word (página, margem ou parágrafo).
function floatBox(float, frame, paragraphTop, columnLeft) {
  const axis = (spec, size, pageSize, marginStart, marginEnd, near) => {
    const [origin, room] = spec.relative === 'page' ? [0, pageSize]
      : spec.relative === 'margin' ? [marginStart, pageSize - marginStart - marginEnd]
      : [near, pageSize - marginEnd - near];
    if (spec.align === 'center') return origin + (room - size) / 2;
    if (spec.align === 'right' || spec.align === 'bottom') return origin + room - size;
    return origin + (spec.offset ?? 0);
  };
  const { margin } = frame;
  return {
    x: axis(float.h, float.width, frame.width, margin.left, margin.right, columnLeft),
    y: axis(float.v, float.height, frame.height, margin.top, margin.bottom, paragraphTop),
  };
}

function emitLine(items, line, left, top, frame, paragraphTop) {
  const baseline = top + line.baseline;
  for (const { x, text, style, width } of line.spans) {
    if (text.trim()) {
      items.push({
        type: 'text', x: left + x, y: baseline, text, font: style.font, size: style.size, color: style.color,
        wordSpacing: line.wordSpacing && text.includes(' ') ? line.wordSpacing : 0, rise: style.rise,
      });
    }
    const rule = (offset) => items.push({
      type: 'line', x1: left + x, x2: left + x + width, y: baseline - style.rise + offset * style.size,
      width: Math.max(0.5, style.size * 0.05), color: style.color,
    });
    if (style.underline && width > 0) rule(0.12);
    if (style.strike && text.trim()) rule(-0.3);
  }
  for (const image of line.images) {
    items.push({ type: 'image', image: image.image, x: left + image.x, y: baseline - image.height, w: image.width, h: image.height });
  }
  for (const float of line.floats) {
    const { x, y } = floatBox(float, frame, paragraphTop, left);
    items.push({ type: 'image', image: float.image, x, y, w: float.width, h: float.height });
  }
}

// ---------- Blocos (parágrafos e tabelas) sem paginação: células, cabeçalho e rodapé ----------

function measureBlocks(blocks, width, ctx) {
  const entries = [];
  let height = 0;
  blocks.forEach((block, i) => {
    if (block.type === 'table') {
      const table = measureTable(block, width, ctx);
      entries.push({ kind: 'table', table, top: height });
      height += table.height;
      return;
    }
    const joined = (a, b) => a?.type === 'paragraph' && b?.type === 'paragraph' && a.styleId === b.styleId;
    const before = block.contextualSpacing && joined(blocks[i - 1], block) ? 0 : block.spacing.before;
    const after = block.contextualSpacing && joined(block, blocks[i + 1]) ? 0 : block.spacing.after;
    const lines = breakLines(block, width, ctx.defaultTab, ctx);
    const top = height + (i === 0 ? 0 : before); // o primeiro parágrafo da célula começa encostado no topo
    entries.push({ kind: 'paragraph', lines, top });
    height = top + lines.reduce((sum, line) => sum + line.height, 0) + (i === blocks.length - 1 ? 0 : after);
  });
  return { entries, height };
}

function drawBlocks(measured, items, left, top, frame) {
  for (const entry of measured.entries) {
    if (entry.kind === 'table') {
      let y = top + entry.top;
      entry.table.rows.forEach((row, r) => {
        drawRow(entry.table, r, items, left, y, frame, true);
        y += row.height;
      });
      continue;
    }
    let y = top + entry.top;
    for (const line of entry.lines) {
      emitLine(items, line, left, y, frame, top + entry.top);
      y += line.height;
    }
  }
}

// ---------- Tabelas ----------

// Colunas, linhas e células com o conteúdo já medido. Linha mais alta que a página não é dividida.
function measureTable(table, width, ctx) {
  const columnCount = Math.max(table.grid.length, ...table.rows.map((row) => row.cells.reduce((sum, cell) => sum + cell.span, 0)));
  let columns = table.grid.length >= columnCount
    ? table.grid.slice(0, columnCount)
    : Array.from({ length: columnCount }, (_, i) => table.grid[i] ?? 0);
  const known = columns.reduce((sum, w) => sum + w, 0);
  const missingColumns = columns.filter((w) => !w).length;
  const available = Math.max(36, width - Math.max(0, table.indent));
  if (missingColumns) { // sem largura no documento: divide o que sobra
    const each = Math.max(18, (available - known) / missingColumns);
    columns = columns.map((w) => w || each);
  }
  const total = columns.reduce((sum, w) => sum + w, 0);
  if (total > available) columns = columns.map((w) => (w * available) / total);
  const tableWidth = columns.reduce((sum, w) => sum + w, 0);
  const starts = columns.map((_, i) => columns.slice(0, i).reduce((sum, w) => sum + w, 0));
  const x0 = table.align === 'center' ? (width - tableWidth) / 2 : table.align === 'right' ? width - tableWidth : Math.max(0, table.indent);
  const { margins } = table;

  const rows = table.rows.map((row) => {
    let g = row.skip ?? 0;
    const cells = row.cells.map((cell) => {
      const span = Math.min(cell.span, columnCount - g);
      const x = starts[g] ?? 0;
      const w = columns.slice(g, g + span).reduce((sum, c) => sum + c, 0);
      const content = cell.vMerge === 'continue' ? null : measureBlocks(cell.blocks, Math.max(1, w - margins.left - margins.right), ctx);
      const placed = { ...cell, grid: g, span, x, w, content, height: content ? content.height + margins.top + margins.bottom : 0 };
      g += span;
      return placed;
    });
    return { ...row, cells };
  });

  // Altura de cada linha: a célula mais alta (células mescladas na vertical contam no fim do grupo).
  rows.forEach((row) => {
    const own = row.cells.filter((cell) => !cell.vMerge).map((cell) => cell.height);
    let height = Math.max(row.minHeight ?? 0, ...own, 0);
    if (row.exact && row.minHeight) height = row.minHeight;
    row.height = Math.max(height, 4);
  });
  rows.forEach((row, r) => {
    for (const cell of row.cells) {
      if (cell.vMerge !== 'restart') continue;
      let last = r;
      while (rows[last + 1]?.cells.some((c) => c.grid === cell.grid && c.vMerge === 'continue')) last++;
      cell.rowSpan = last - r + 1;
      const groupHeight = rows.slice(r, last + 1).reduce((sum, row2) => sum + row2.height, 0);
      if (cell.height > groupHeight) rows[last].height += cell.height - groupHeight;
      // Nas linhas de continuação, a célula sabe onde o grupo termina (para a borda de baixo).
      for (let k = r + 1; k <= last; k++) {
        const cont = rows[k].cells.find((c) => c.grid === cell.grid && c.vMerge === 'continue');
        if (cont) cont.groupEnd = k === last;
      }
      cell.groupEnd = cell.rowSpan === 1;
    }
  });

  return { rows, columnCount, x0, width: tableWidth, borders: table.borders, margins, height: rows.reduce((sum, row) => sum + row.height, 0) };
}

// Desenha uma linha da tabela: fundo das células, conteúdo e bordas.
// together: as linhas do grupo mesclado estão na mesma página (o conteúdo pode usar a altura do grupo).
function drawRow(table, r, items, left, top, frame, together) {
  const row = table.rows[r];
  const { borders, margins } = table;
  for (const cell of row.cells) {
    const x = left + table.x0 + cell.x;
    let height = row.height;
    if (cell.vMerge === 'restart' && together) {
      height = table.rows.slice(r, r + cell.rowSpan).reduce((sum, row2) => sum + row2.height, 0);
    }
    if (cell.fill) items.push({ type: 'rect', x, y: top, w: cell.w, h: cell.vMerge === 'restart' ? height : row.height, color: cell.fill });
    if (cell.content) {
      const free = height - cell.height;
      const shift = cell.vAlign === 'center' ? free / 2 : cell.vAlign === 'bottom' ? free : 0;
      drawBlocks(cell.content, items, x + margins.left, top + margins.top + Math.max(0, shift), frame);
    }
    // Bordas: as de fora vêm da tabela; as de dentro, de insideH/insideV; a célula pode trocar qualquer uma.
    const side = (name, outer, inner) => (cell.borders?.[name] !== undefined ? cell.borders[name] : outer ? borders[outer] : borders[inner]);
    const firstRow = r === 0;
    const lastRow = r === table.rows.length - 1;
    const merged = cell.vMerge === 'continue';
    const endsHere = cell.vMerge ? cell.groupEnd : true;
    const lines = [
      [merged ? null : side('top', firstRow && 'top', 'insideH'), x, top, x + cell.w, top],
      [endsHere || lastRow ? side('bottom', lastRow && 'bottom', 'insideH') : null, x, top + row.height, x + cell.w, top + row.height],
      [side('left', cell.grid === 0 && 'left', 'insideV'), x, top, x, top + row.height],
      [side('right', cell.grid + cell.span >= table.columnCount && 'right', 'insideV'), x + cell.w, top, x + cell.w, top + row.height],
    ];
    for (const [border, x1, y1, x2, y2] of lines) {
      if (border) items.push({ type: 'line', x1, y1, x2, y2, width: border.width, color: border.color });
    }
  }
}

// ---------- Páginas ----------

// Cabeçalho e rodapé da página: primeira página da seção, páginas pares ou o padrão.
function headerFooterBlocks(set, section, first, even, evenAndOdd) {
  if (!set) return [];
  if (section.titlePg && first) return set.first ?? [];
  if (evenAndOdd && even) return set.even ?? set.default ?? [];
  return set.default ?? [];
}

/**
 * Distribui o documento em páginas.
 * @param {{sections: Array, defaultTab: number, evenAndOdd?: boolean}} doc modelo do docx.js
 * @returns {{pages: Array<{width: number, height: number, items: Array}>, missing: string[]}}
 */
export function layoutDocument(doc) {
  const missing = new Set();
  const ctx = { defaultTab: doc.defaultTab, missing };
  const pages = [];
  const meta = []; // por página: a seção e se é a primeira da seção
  let page = null;
  let geometry = null; // página da seção, com top e bottom do corpo (descontando cabeçalho e rodapé)
  let y = 0;
  let empty = true;

  // Corpo do texto entre o cabeçalho e o rodapé: se eles forem mais altos que a margem, o texto desce (sobe).
  const bodyArea = (section) => {
    const { page: p } = section;
    const column = p.width - p.margin.left - p.margin.right;
    const tallest = (set) => Math.max(0, ...['default', 'first', 'even'].map((kind) => (set?.[kind]
      ? measureBlocks(set[kind], column, { ...ctx, missing: new Set(), fields: { PAGE: '99', NUMPAGES: '99' } }).height
      : 0)));
    const header = tallest(section.header);
    const footer = tallest(section.footer);
    return {
      ...p,
      top: header ? Math.max(p.margin.top, (p.headerDistance ?? 36) + header + 6) : p.margin.top,
      bottom: footer ? Math.min(p.height - p.margin.bottom, p.height - (p.footerDistance ?? 36) - footer - 6) : p.height - p.margin.bottom,
    };
  };

  let sectionFirst = false;
  let currentSection = null;
  const newPage = (next) => {
    if (pages.length >= MAX_PAGES) throw new RangeError(`O documento passa de ${MAX_PAGES} páginas.`);
    geometry = next;
    page = { width: next.width, height: next.height, items: [] };
    pages.push(page);
    meta.push({ section: currentSection, first: sectionFirst });
    sectionFirst = false;
    y = next.top;
    empty = true;
  };
  const bottom = () => geometry.bottom;
  const contentHeight = () => geometry.bottom - geometry.top;

  const place = (line, paragraphTop) => {
    emitLine(page.items, line, geometry.margin.left, y, geometry, paragraphTop);
    y += line.height;
    empty = false;
  };

  let previous = null;
  for (const section of doc.sections) {
    const area = bodyArea(section);
    currentSection = section;
    if (!page) {
      sectionFirst = true;
      newPage(area);
    } else if (section.start !== 'continuous') {
      sectionFirst = true;
      if (empty) {
        page.width = area.width;
        page.height = area.height;
        geometry = area;
        y = area.top;
        meta[meta.length - 1] = { section, first: true };
        sectionFirst = false;
      } else newPage(area);
    }
    const column = section.page.width - section.page.margin.left - section.page.margin.right;
    const blocks = section.blocks.map((block) => (block.type === 'table'
      ? { block, table: measureTable(block, column, ctx) }
      : { block, lines: breakLines(block, column, doc.defaultTab, ctx) }));

    blocks.forEach(({ block, lines, table }, index) => {
      if (table) {
        // Tabela: linha por linha; linha que não cabe vai para a próxima página, com o cabeçalho da tabela repetido.
        const headerRows = [];
        for (const row of table.rows) { if (row.header) headerRows.push(row); else break; }
        table.rows.forEach((row, r) => {
          const repeat = r >= headerRows.length ? headerRows : [];
          if (!empty && y + row.height > bottom() + 0.01) {
            newPage(area);
            repeat.forEach((_, h) => {
              drawRow(table, h, page.items, geometry.margin.left, y, geometry, true);
              y += table.rows[h].height;
            });
          }
          const together = (() => { // grupo mesclado inteiro cabe nesta página?
            let need = 0;
            let k = r;
            do need += table.rows[k].height; while (table.rows[++k]?.cells.some((c) => c.vMerge === 'continue'));
            return y + need <= bottom() + 0.01;
          })();
          drawRow(table, r, page.items, geometry.margin.left, y, geometry, together);
          y += row.height;
          empty = false;
        });
        previous = null;
        return;
      }

      const next = blocks[index + 1]?.block;
      if (block.pageBreakBefore && !empty) newPage(area);
      const joined = (a, b) => a?.type === 'paragraph' && b?.type === 'paragraph' && a.styleId === b.styleId;
      if (!empty && !(block.contextualSpacing && joined(previous, block))) y += block.spacing.before;

      const total = lines.reduce((sum, line) => sum + line.height, 0);
      const unbroken = lines.findIndex((line) => line.pageBreakAfter) < 0;
      if (!empty && unbroken && total <= contentHeight()) {
        const nextLines = blocks[index + 1]?.lines;
        const followUp = block.keepNext && nextLines ? block.spacing.after + (nextLines[0]?.height ?? 0) : 0;
        if ((block.keepLines || block.keepNext) && y + total + followUp > bottom() + 0.01) newPage(area);
      }

      let k = 0;
      let paragraphTop = y;
      while (k < lines.length) {
        // Linhas até a próxima quebra de página manual.
        let end = lines.findIndex((line, i) => i >= k && line.pageBreakAfter);
        end = end < 0 ? lines.length : end + 1;
        let fit = 0;
        let used = 0;
        while (k + fit < end && y + used + lines[k + fit].height <= bottom() + 0.01) used += lines[k + fit++].height;

        const remaining = end - k;
        if (fit < remaining && block.widowControl && !empty) {
          let adjusted = fit;
          if (remaining - adjusted === 1 && remaining > 2) adjusted--; // viúva: última linha sozinha no topo da página
          if (adjusted === 1 && k === 0) adjusted = 0; // órfã: primeira linha sozinha no pé da página
          fit = adjusted;
        }
        if (fit === 0) {
          if (empty) fit = 1; // linha mais alta que a página: vai assim mesmo
          else { newPage(area); paragraphTop = y; continue; }
        }
        for (let i = k; i < k + fit; i++) place(lines[i], paragraphTop);
        k += fit;
        if (k < lines.length) { newPage(area); paragraphTop = y; }
      }

      if (!(block.contextualSpacing && joined(block, next))) y += block.spacing.after;
      previous = block;
    });
  }
  if (!pages.length) {
    newPage({ width: 595.28, height: 841.89, margin: { top: 0, right: 0, bottom: 0, left: 0 }, top: 0, bottom: 841.89 });
  }

  // Cabeçalho e rodapé, depois de saber quantas páginas são (para "Página 3 de 7").
  const total = String(pages.length);
  pages.forEach((current, i) => {
    const { section, first } = meta[i];
    if (!section) return;
    const p = section.page;
    const column = p.width - p.margin.left - p.margin.right;
    const fields = { PAGE: String(i + 1), NUMPAGES: total, SECTIONPAGES: total };
    const frame = { width: p.width, height: p.height, margin: p.margin };
    const header = headerFooterBlocks(section.header, section, first, (i + 1) % 2 === 0, doc.evenAndOdd);
    if (header.length) {
      const measured = measureBlocks(header, column, { ...ctx, fields });
      drawBlocks(measured, current.items, p.margin.left, p.headerDistance ?? 36, frame);
    }
    const footer = headerFooterBlocks(section.footer, section, first, (i + 1) % 2 === 0, doc.evenAndOdd);
    if (footer.length) {
      const measured = measureBlocks(footer, column, { ...ctx, fields });
      drawBlocks(measured, current.items, p.margin.left, p.height - (p.footerDistance ?? 36) - measured.height, frame);
    }
  });
  return { pages, missing: [...missing] };
}
