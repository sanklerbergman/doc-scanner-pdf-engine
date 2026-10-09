// Distribui o texto de um documento (modelo do docx.js) em páginas: quebra de linha por palavra,
// alinhamento, recuos, tabulação, espaçamento e paginação. Tudo medido com as larguras das fontes
// padrão do PDF (fonts.js), então o que sai aqui é exatamente o que o PDF desenha.
//
// Cada página sai como {width, height, items}, em pontos, com a origem no canto superior esquerdo:
// - {type: 'text', x, y, text, font, size, color, wordSpacing, rise}, com y na linha de base;
// - {type: 'line', x1, x2, y, width, color}, para sublinhado e tachado.
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

// Peças do parágrafo: palavras (sem espaço), espaços, tabulações e quebras.
function pieces(block, missing) {
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
  for (const run of block.runs) {
    const style = styleOf(run);
    if (run.break) out.push({ kind: 'break', page: run.break === 'page', style });
    else if (run.tab) out.push({ kind: 'tab', style });
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
    } else if (piece.kind === 'word') {
      out.push({ kind: 'word', parts: [piece], width: piece.width });
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
 * Cada linha: {height, baseline, spans: [{x, text, style, width}], wordSpacing, pageBreakAfter}, com x a partir
 * da margem esquerda.
 */
export function breakLines(block, columnWidth, defaultTab, missing = new Set()) {
  const { indent } = block;
  const stops = indent.firstLine < 0 ? [...new Set([...block.tabs, indent.left])].sort((a, b) => a - b) : block.tabs;
  const lines = [];
  const startOf = (first) => indent.left + (first ? indent.firstLine : 0);
  const widthOf = (first) => Math.max(1, columnWidth - indent.right - startOf(first));

  let line;
  // Espaço no começo da linha só fica no início do parágrafo ou depois de uma quebra manual;
  // o que sobra de uma linha que quebrou sozinha some, como no Word.
  const open = (keepSpaces) => { line = { parts: [], width: 0, first: lines.length === 0, keepSpaces }; };
  const hasContent = () => line.parts.some((part) => part.kind !== 'space');
  const fits = (width) => line.width + width <= widthOf(line.first) + 0.01;
  const close = (ending) => {
    while (line.parts[line.parts.length - 1]?.kind === 'space') line.width -= line.parts.pop().width; // espaço no fim não conta
    lines.push({ ...line, ending });
    open(ending !== 'wrap');
  };
  open(true);

  for (const item of groups(pieces(block, missing))) {
    if (item.kind === 'space') {
      if (line.keepSpaces || hasContent()) { line.parts.push(item); line.width += item.width; }
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
      if (fits(item.width)) {
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
  const sizes = raw.parts.filter((part) => part.style).map((part) => part.style.lineSize);
  const size = sizes.length ? Math.max(...sizes) : block.mark.size;
  const natural = size * LINE_HEIGHT;
  const { line, lineRule } = block.spacing;
  const height = lineRule === 'exact' ? line : lineRule === 'atLeast' ? Math.max(natural, line) : natural * line;

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
  let x = start + Math.max(0, offset);
  let span = null;
  for (const part of raw.parts) {
    if (part.kind === 'tab') {
      // Tabulação sublinhada é a "linha para preencher" dos formulários: vira só o sublinhado.
      if (part.style.underline) spans.push({ x, text: '', style: part.style, width: part.width });
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
  return { height, baseline: height - size * DESCENT, spans, wordSpacing, pageBreakAfter: raw.ending === 'page' };
}

/**
 * Distribui o documento em páginas.
 * @param {{sections: Array, defaultTab: number}} doc modelo do docx.js
 * @returns {{pages: Array<{width: number, height: number, items: Array}>, missing: string[]}}
 */
export function layoutDocument(doc) {
  const missing = new Set();
  const pages = [];
  let page = null;
  let geometry = null;
  let y = 0;
  let empty = true;

  const newPage = (next) => {
    if (pages.length >= MAX_PAGES) throw new RangeError(`O documento passa de ${MAX_PAGES} páginas.`);
    geometry = next;
    page = { width: next.width, height: next.height, items: [] };
    pages.push(page);
    y = next.margin.top;
    empty = true;
  };
  const bottom = () => geometry.height - geometry.margin.bottom;
  const contentHeight = () => bottom() - geometry.margin.top;

  const place = (line) => {
    const left = geometry.margin.left;
    for (const { x, text, style, width } of line.spans) {
      const baseline = y + line.baseline;
      if (text.trim()) {
        page.items.push({
          type: 'text', x: left + x, y: baseline, text, font: style.font, size: style.size, color: style.color,
          wordSpacing: line.wordSpacing && text.includes(' ') ? line.wordSpacing : 0, rise: style.rise,
        });
      }
      const rule = (offset) => page.items.push({
        type: 'line', x1: left + x, x2: left + x + width, y: baseline - style.rise + offset * style.size,
        width: Math.max(0.5, style.size * 0.05), color: style.color,
      });
      if (style.underline && width > 0) rule(0.12);
      if (style.strike && text.trim()) rule(-0.3);
    }
    y += line.height;
    empty = false;
  };

  let previous = null;
  for (const section of doc.sections) {
    if (!page) newPage(section.page);
    else if (section.start !== 'continuous') {
      if (empty) { page.width = section.page.width; page.height = section.page.height; geometry = section.page; y = geometry.margin.top; }
      else newPage(section.page);
    }
    const column = section.page.width - section.page.margin.left - section.page.margin.right;
    const paragraphs = section.blocks.map((block) => ({ block, lines: breakLines(block, column, doc.defaultTab, missing) }));

    paragraphs.forEach(({ block, lines }, index) => {
      const next = paragraphs[index + 1]?.block;
      if (block.pageBreakBefore && !empty) newPage(section.page);
      const joined = (a, b) => a && b && a.styleId === b.styleId;
      if (!empty && !(block.contextualSpacing && joined(previous, block))) y += block.spacing.before;

      const total = lines.reduce((sum, line) => sum + line.height, 0);
      const firstBreak = lines.findIndex((line) => line.pageBreakAfter);
      const unbroken = firstBreak < 0;
      if (!empty && unbroken && total <= contentHeight()) {
        const followUp = block.keepNext && next ? block.spacing.after + (paragraphs[index + 1].lines[0]?.height ?? 0) : 0;
        if ((block.keepLines || block.keepNext) && y + total + followUp > bottom() + 0.01) newPage(section.page);
      }

      let k = 0;
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
          else { newPage(section.page); continue; }
        }
        for (let i = k; i < k + fit; i++) place(lines[i]);
        k += fit;
        if (k < lines.length) newPage(section.page);
      }

      if (!(block.contextualSpacing && joined(block, next))) y += block.spacing.after;
      previous = block;
    });
  }
  if (!pages.length) newPage({ width: 595.28, height: 841.89, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  return { pages, missing: [...missing] };
}
