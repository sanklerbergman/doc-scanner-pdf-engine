import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakLines, layoutDocument, sanitize } from '../web/js/layout.js';
import { textWidth, pdfFont } from '../web/js/fonts.js';

const run = (text, props = {}) => ({
  text, bold: false, italic: false, underline: false, strike: false, size: 12, color: null, family: 'sans', vertAlign: null, ...props,
});

const paragraph = (runs, props = {}) => ({
  type: 'paragraph', styleId: '', runs, label: null, mark: run(''), align: 'left',
  indent: { left: 0, right: 0, firstLine: 0 }, spacing: { before: 0, after: 0, line: 1, lineRule: 'auto' }, tabs: [],
  contextualSpacing: false, keepNext: false, keepLines: false, pageBreakBefore: false, widowControl: true, ...props,
});

const A4 = { width: 595.28, height: 841.89, margin: { top: 72, right: 72, bottom: 72, left: 72 } };
const doc = (blocks, page = A4) => ({ sections: [{ page, start: 'nextPage', blocks }], defaultTab: 36 });
const lineText = (line) => line.spans.map((span) => span.text).join('');
const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';

test('larguras das fontes padrão (valores dos AFM da Adobe)', () => {
  assert.equal(textWidth('Hello', 'Helvetica', 10), 22.78);
  assert.equal(textWidth('Ação', 'Helvetica', 10), (667 + 500 + 556 + 556) / 100);
  assert.equal(textWidth('W', 'Times-Bold', 1000), 1000);
  assert.equal(textWidth('iii', 'Courier-Oblique', 10), 18);
  assert.equal(textWidth('€—“”', 'Helvetica', 1000), 556 + 1000 + 333 + 333);
  assert.equal(pdfFont('sans', true, true), 'Helvetica-BoldOblique');
  assert.equal(pdfFont('serif', false, false), 'Times-Roman');
  assert.equal(pdfFont('mono', false, true), 'Courier-Oblique');
});

test('quebra por palavra, sem passar da largura e sem espaço no fim da linha', () => {
  const lines = breakLines(paragraph([run(LOREM)]), 200, 36);
  assert.ok(lines.length > 3);
  for (const line of lines) {
    const text = lineText(line);
    assert.ok(!text.endsWith(' ') && !text.startsWith(' '), `"${text}"`);
    assert.ok(textWidth(text, 'Helvetica', 12) <= 200 + 0.01, `"${text}" passou da largura`);
  }
  assert.equal(lines.map(lineText).join(' '), LOREM, 'nenhuma palavra cortada nem perdida');
});

test('palavra maior que a linha é cortada letra a letra', () => {
  const long = 'Pneumoultramicroscopicossilicovulcanoconiótico';
  const lines = breakLines(paragraph([run(`A ${long} fim`)]), 120, 36);
  assert.equal(lines.map(lineText).join('').replace(/ /g, ''), `A${long}fim`);
  for (const line of lines) assert.ok(textWidth(lineText(line), 'Helvetica', 12) <= 120.01);
});

test('palavra em trechos de formatação diferente não se separa', () => {
  const lines = breakLines(paragraph([run('aaaa '), run('neg', { bold: true }), run('rito')]), textWidth('aaaa negr', 'Helvetica', 12), 36);
  assert.deepEqual(lines.map(lineText), ['aaaa', 'negrito']);
  assert.deepEqual(lines[1].spans.map((span) => span.style.font), ['Helvetica-Bold', 'Helvetica']);
});

test('justificado: linhas cheias vão até a margem; a última fica à esquerda', () => {
  const lines = breakLines(paragraph([run(LOREM)], { align: 'justify' }), 200, 36);
  for (const line of lines.slice(0, -1)) {
    assert.ok(line.wordSpacing > 0);
    const last = line.spans[line.spans.length - 1];
    assert.ok(Math.abs(last.x + last.width - 200) < 0.01, 'termina na margem direita');
  }
  assert.equal(lines[lines.length - 1].wordSpacing, 0);
});

test('centralizado e à direita', () => {
  const width = textWidth('meio', 'Helvetica', 12);
  const [center] = breakLines(paragraph([run('meio')], { align: 'center' }), 300, 36);
  assert.ok(Math.abs(center.spans[0].x - (300 - width) / 2) < 1e-9);
  const [right] = breakLines(paragraph([run('meio')], { align: 'right', indent: { left: 0, right: 20, firstLine: 0 } }), 300, 36);
  assert.ok(Math.abs(right.spans[0].x + width - 280) < 1e-9);
});

test('tabulação padrão a cada 36 pt e rótulo de lista com recuo deslocado', () => {
  const [line] = breakLines(paragraph([run('ab'), { ...run(''), tab: true }, run('cd')]), 400, 36);
  assert.equal(line.spans[1].x, 36);

  const block = paragraph([run('item')], {
    label: { ...run(''), text: '', suffix: 'tab' }, indent: { left: 36, right: 0, firstLine: -18 },
  });
  const [listLine] = breakLines(block, 400, 36);
  assert.equal(listLine.spans[0].text, '•', 'marcador da fonte Symbol vira •');
  assert.equal(listLine.spans[0].x, 18);
  assert.equal(listLine.spans[1].x, 36, 'o texto começa no recuo esquerdo');
});

test('quebra de linha manual e espaçamento entre linhas', () => {
  const lines = breakLines(paragraph([run('um'), { ...run(''), break: 'line' }, run('dois')], { spacing: { before: 0, after: 0, line: 2, lineRule: 'auto' } }), 400, 36);
  assert.deepEqual(lines.map(lineText), ['um', 'dois']);
  assert.ok(Math.abs(lines[0].height - 12 * 1.15 * 2) < 1e-9);
  const [exact] = breakLines(paragraph([run('x')], { spacing: { before: 0, after: 0, line: 30, lineRule: 'exact' } }), 400, 36);
  assert.equal(exact.height, 30);
});

test('caracteres fora das fontes do PDF: equivalentes, "?" e normalização de acentos', () => {
  const missing = new Set();
  assert.equal(sanitize('ão­ ≤ ‑ ​ok', missing), 'ão <= - ok');
  assert.equal(sanitize('Ω e 😀', missing), '? e ?');
  assert.deepEqual([...missing], ['Ω', '😀']);
  assert.equal(sanitize('ç ã õ é ü € “” – —', missing), 'ç ã õ é ü € “” – —');
});

test('paginação: muitas linhas viram várias páginas, sempre dentro das margens', () => {
  const blocks = Array.from({ length: 60 }, (_, i) => paragraph([run(`${i + 1}. ${LOREM}`)], { spacing: { before: 0, after: 6, line: 1, lineRule: 'auto' } }));
  const { pages } = layoutDocument(doc(blocks));
  assert.equal(pages.length, 3); // 60 parágrafos de 2 linhas, ~50 linhas por página
  for (const page of pages) {
    assert.equal(page.width, A4.width);
    for (const item of page.items) {
      assert.ok(item.y >= A4.margin.top && item.y <= A4.height - A4.margin.bottom + 0.01, `y=${item.y}`);
      if (item.type === 'text') assert.ok(item.x + textWidth(item.text, item.font, item.size) <= A4.width - A4.margin.right + 0.01);
    }
  }
  const all = pages.flatMap((page) => page.items.map((item) => item.text)).join(' ');
  for (let i = 1; i <= 60; i++) assert.ok(all.includes(`${i}. Lorem`), `parágrafo ${i}`);
});

test('quebra de página manual, "quebra antes" e página da seção', () => {
  const landscape = { width: 841.89, height: 595.28, margin: A4.margin };
  const { pages } = layoutDocument({
    defaultTab: 36,
    sections: [
      { page: A4, start: 'nextPage', blocks: [paragraph([run('um'), { ...run(''), break: 'page' }, run('dois')]), paragraph([run('três')], { pageBreakBefore: true })] },
      { page: landscape, start: 'nextPage', blocks: [paragraph([run('deitada')])] },
    ],
  });
  assert.deepEqual(pages.map((page) => page.items.map((item) => item.text).join(' ')), ['um', 'dois', 'três', 'deitada']);
  assert.equal(pages[3].width, 841.89);
});

test('órfã e "manter com o próximo": o parágrafo não começa sozinho no pé da página', () => {
  const lineHeight = 12 * 1.15;
  const filler = (lines) => paragraph([run('x')], { spacing: { before: 0, after: lines * lineHeight - lineHeight, line: 1, lineRule: 'auto' } });
  const usable = A4.height - 144;
  const room = Math.floor(usable / lineHeight);

  // Sobra espaço para uma linha só: o parágrafo de várias linhas vai inteiro para a próxima página.
  const long = paragraph([run(LOREM.repeat(2))]);
  const orphan = layoutDocument(doc([filler(room - 1), long]));
  assert.equal(orphan.pages[0].items.length, 1);

  // Título com "manter com o próximo" na última linha: desce junto com o parágrafo seguinte.
  const title = paragraph([run('Título', { bold: true })], { keepNext: true });
  const kept = layoutDocument(doc([filler(room - 1), title, paragraph([run(LOREM)])]));
  assert.equal(kept.pages[0].items.length, 1);
  assert.equal(kept.pages[1].items[0].text, 'Título');
});

test('sublinhado vira linha; documento vazio vira uma página em branco', () => {
  const { pages } = layoutDocument(doc([paragraph([run('importante', { underline: true, color: [1, 0, 0] })])]));
  const line = pages[0].items.find((item) => item.type === 'line');
  assert.ok(line);
  assert.ok(Math.abs(line.x2 - line.x1 - textWidth('importante', 'Helvetica', 12)) < 1e-9);
  assert.deepEqual(line.color, [1, 0, 0]);

  const empty = layoutDocument({ defaultTab: 36, sections: [{ page: A4, start: 'nextPage', blocks: [] }] });
  assert.equal(empty.pages.length, 1);
  assert.equal(empty.pages[0].items.length, 0);
});
