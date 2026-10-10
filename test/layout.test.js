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

// ---------- Fase 2: tabelas, imagens, cabeçalho e rodapé ----------

const border = { width: 0.5, color: null };
const allBorders = { top: border, bottom: border, left: border, right: border, insideH: border, insideV: border };
const tableCell = (text, extra = {}) => ({ span: 1, vMerge: null, fill: null, borders: {}, vAlign: 'top', blocks: [paragraph([run(text)])], ...extra });
const table = (rows, extra = {}) => ({
  type: 'table', grid: [100, 200], rows, margins: { top: 0, bottom: 0, left: 5.4, right: 5.4 },
  borders: allBorders, indent: 0, align: 'left', ...extra,
});
const row = (cells, extra = {}) => ({ minHeight: 0, exact: false, header: false, skip: 0, cells, ...extra });

test('tabela: texto dentro das células, bordas, fundo e linha que cresce com o conteúdo', () => {
  const { pages } = layoutDocument(doc([table([
    row([tableCell('Nome', { fill: [0, 0, 0.5] }), tableCell('Valor')]),
    row([tableCell('Item'), tableCell(LOREM)]),
  ])]));
  const items = pages[0].items;
  const name = items.find((item) => item.text === 'Nome');
  assert.ok(Math.abs(name.x - (72 + 5.4)) < 1e-9, 'texto começa na margem da célula');
  const value = items.find((item) => item.text === 'Valor');
  assert.ok(Math.abs(value.x - (72 + 100 + 5.4)) < 1e-9, 'segunda coluna');
  const lorem = items.filter((item) => item.type === 'text' && item.x > 172 && item.y > name.y);
  assert.ok(lorem.length > 3, 'o texto longo quebra dentro da célula');
  for (const item of lorem) assert.ok(item.x + textWidth(item.text, item.font, item.size) <= 72 + 300 - 5.4 + 0.01);

  const rect = items.find((item) => item.type === 'rect');
  assert.deepEqual([rect.x, rect.y, rect.w], [72, 72, 100]);
  const borders = items.filter((item) => item.type === 'line');
  assert.ok(borders.some((line) => line.x1 === line.x2), 'bordas verticais');
  const bottom = Math.max(...borders.map((line) => Math.max(line.y1 ?? line.y, line.y2 ?? line.y)));
  assert.ok(bottom > lorem[lorem.length - 1].y, 'a última borda fica abaixo do texto mais baixo');
});

test('tabela: largura encolhe para caber, centralizada, e célula mesclada na vertical não repete borda', () => {
  const wide = layoutDocument(doc([table([row([tableCell('a'), tableCell('b')])], { grid: [400, 400], align: 'center' })]));
  const lines = wide.pages[0].items.filter((item) => item.type === 'line');
  const xs = lines.flatMap((line) => [line.x1, line.x2]);
  assert.ok(Math.min(...xs) >= 72 - 0.01 && Math.max(...xs) <= 595.28 - 72 + 0.01, 'tabela larga encolhe para a coluna');

  const merged = layoutDocument(doc([table([
    row([tableCell('mesclada', { vMerge: 'restart' }), tableCell('1')]),
    row([tableCell('', { vMerge: 'continue', blocks: [] }), tableCell('2')]),
  ])]));
  const horizontal = merged.pages[0].items.filter((item) => item.type === 'line' && (item.y1 ?? item.y) === (item.y2 ?? item.y) && item.x2 <= 172.01);
  const ys = [...new Set(horizontal.map((line) => line.y1 ?? line.y))];
  assert.equal(ys.length, 2, 'na coluna mesclada só há a borda de cima e a de baixo');
});

test('tabela longa: quebra entre linhas e repete a linha de cabeçalho', () => {
  const rows = [row([tableCell('Cabeçalho A'), tableCell('Cabeçalho B')], { header: true })];
  for (let i = 1; i <= 80; i++) rows.push(row([tableCell(`linha ${i}`), tableCell(`valor ${i}`)]));
  const { pages } = layoutDocument(doc([table(rows)]));
  assert.ok(pages.length >= 2);
  for (const page of pages) {
    const texts = page.items.filter((item) => item.type === 'text');
    assert.equal(texts[0].text, 'Cabeçalho A', 'cada página começa com o cabeçalho da tabela');
    for (const item of page.items) assert.ok((item.y2 ?? item.y ?? item.y1) <= 841.89 - 72 + 0.01);
  }
  const all = pages.flatMap((page) => page.items.map((item) => item.text)).filter(Boolean);
  assert.ok(all.includes('linha 80') && all.includes('valor 1'));
});

test('imagem na linha: aumenta a linha, encolhe para caber e flutuante fica no lugar da âncora', () => {
  const block = paragraph([run('antes '), { ...run(''), image: 'logo', width: 900, height: 450 }, run(' depois')]);
  const { pages } = layoutDocument(doc([block, paragraph([{ ...run(''), float: { image: 'selo', width: 50, height: 40, h: { relative: 'page', offset: 10, align: null }, v: { relative: 'page', offset: 0, align: 'bottom' } } }])]));
  const image = pages[0].items.find((item) => item.image === 'logo');
  const column = 595.28 - 144;
  assert.ok(Math.abs(image.w - column) < 1e-6 && Math.abs(image.h - column / 2) < 1e-6, 'imagem larga encolhe sem deformar');
  const after = pages[0].items.find((item) => item.text === 'depois');
  assert.ok(after.y > image.y + image.h - 0.01, 'o texto depois da imagem fica abaixo dela');
  const seal = pages[0].items.find((item) => item.image === 'selo');
  assert.deepEqual([seal.x, seal.y], [10, 841.89 - 40]);
});

test('cabeçalho e rodapé: em toda página, com "Página X de Y" e capa diferente', () => {
  const footer = [paragraph([run('Página '), { ...run(''), field: 'PAGE', text: '1' }, run(' de '), { ...run(''), field: 'NUMPAGES', text: '1' }], { align: 'center' })];
  const page = { ...A4, headerDistance: 36, footerDistance: 36 };
  const blocks = Array.from({ length: 120 }, (_, i) => paragraph([run(`parágrafo ${i + 1}`)]));
  const { pages } = layoutDocument({
    defaultTab: 36,
    sections: [{ page, start: 'nextPage', blocks, titlePg: true, header: { default: [paragraph([run('Empresa')])], first: [paragraph([run('Capa')])] }, footer: { default: footer } }],
  });
  assert.ok(pages.length >= 2);
  const texts = (p) => p.items.filter((item) => item.type === 'text').map((item) => item.text);
  assert.ok(texts(pages[0]).includes('Capa') && !texts(pages[0]).includes('Empresa'), 'primeira página com o cabeçalho de capa');
  assert.ok(texts(pages[1]).includes('Empresa'));
  assert.ok(!texts(pages[0]).includes('Página'), 'capa sem rodapé próprio fica sem rodapé, como no Word');
  pages.forEach((p, i) => {
    if (i > 0) assert.ok(texts(p).includes(`Página ${i + 1} de ${pages.length}`), `rodapé da página ${i + 1}`);
    const body = p.items.filter((item) => item.text?.startsWith('parágrafo'));
    const headerItem = p.items.find((item) => item.text === 'Empresa' || item.text === 'Capa');
    assert.ok(body.every((item) => item.y > headerItem.y), 'o corpo fica abaixo do cabeçalho');
  });
});
