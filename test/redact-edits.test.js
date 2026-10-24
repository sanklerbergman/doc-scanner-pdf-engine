// A tarja apaga também as edições: nenhum ponto de caminho de desenho, forma, marcação ou rubrica fica dentro dela
// (os caminhos são cortados), e no PDF/A as letras tiradas pela tarja não ficam no subconjunto da fonte embutida (nem no
// programa, nem no /Widths, nem no ToUnicode). Foto, Word e página de PDF que virou imagem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cutPath, multiply, redactEdits } from '../web/js/edits.js';
import { textEdit, allPagesText } from '../web/js/edit-text.js';
import { watermarkEdit } from '../web/js/edit-marks.js';
import { textWidth } from '../web/js/fonts.js';
import { layoutPage, buildPdf as buildRaw, redactedEdits } from '../web/js/pdf.js';
import { openPdf, PdfStream } from '../web/js/pdf-reader.js';
import { embedFonts } from '../web/js/pdfa-fonts.js';
import { buildPdf } from './helpers/qpdf.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const A4 = { width: 595.28, height: 841.89 };

// ---------- Leitura dos caminhos do PDF gerado ----------

const TOKEN = /\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|\/[^\s/[\]()<>]+|[^\s/[\]()<>]+|[[\]]/g;
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Todos os pontos de caminho (m, l, c, v, y, re) de um conteúdo, no espaço da página, entrando nos Form XObjects.
function pathPoints(doc, data, resources, ctm = [1, 0, 0, 1, 0, 0], out = []) {
  const stack = [];
  let operands = [];
  const xobjects = doc.resolve(doc.resolve(resources)?.get?.('XObject'));
  for (const [token] of latin1(data).matchAll(TOKEN)) {
    if (/^[-+.\d]/.test(token)) operands.push(Number(token));
    else if (token.startsWith('/') || token.startsWith('(') || token.startsWith('<') || token === '[' || token === ']') operands.push(token);
    else {
      const n = operands;
      if (token === 'q') stack.push(ctm);
      else if (token === 'Q') ctm = stack.pop();
      else if (token === 'cm') ctm = multiply(ctm, n.slice(-6));
      else if (token === 'm' || token === 'l') out.push(apply(ctm, n.slice(-2)));
      else if (token === 'c') for (let i = 0; i < 3; i++) out.push(apply(ctm, n.slice(-6 + 2 * i, -4 + 2 * i || undefined)));
      else if (token === 'v' || token === 'y') for (let i = 0; i < 2; i++) out.push(apply(ctm, n.slice(-4 + 2 * i, -2 + 2 * i || undefined)));
      else if (token === 're') {
        const [x, y, w, h] = n.slice(-4);
        out.push(...[[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((p) => apply(ctm, p)));
      } else if (token === 'Do') {
        const form = doc.resolve(xobjects?.get(n.at(-1).slice(1)));
        if (form instanceof PdfStream && doc.resolve(form.dict.get('Subtype'))?.value === 'Form') {
          const matrix = doc.resolve(form.dict.get('Matrix')) ?? [1, 0, 0, 1, 0, 0];
          pathPoints(doc, form.data, form.dict.get('Resources'), multiply(ctm, matrix), out);
        }
      }
      operands = [];
    }
  }
  return out;
}

async function pagePoints(pdf, index) {
  const doc = await openPdf(pdf);
  const page = doc.pages[index];
  const contents = doc.resolve(page.node.get('Contents'));
  const streams = Array.isArray(contents) ? contents.map((ref) => doc.resolve(ref)) : [contents];
  const data = new Uint8Array(streams.flatMap((s) => [...s.data, 10]));
  return { doc, points: pathPoints(doc, data, page.attrs.Resources) };
}

const strictlyInside = ([x, y], [x0, y0, x1, y1]) => x > x0 && x < x1 && y > y0 && y < y1;

// ---------- As edições ----------

const RUBRIC = { id: 7, w: 100, h: 40, strokes: [[[0, 0.5], [0.25, 0.1], [0.5, 0.9], [0.75, 0.1], [1, 0.5]], [[0.5, 0.5]]], color: '#000000', width: 2 };
// Todas atravessam o meio da página (x = 0,5), onde a tarja começa.
const VECTORS = [
  { type: 'rect', x0: 0.3, y0: 0.1, x1: 0.7, y1: 0.18, color: '#dc2626', width: 2 },
  { type: 'arrow', x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.28, color: '#1d4ed8', width: 2, from: [0.06, 0.88], to: [0.94, 0.12] },
  { type: 'arrow', x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.38, color: '#1d4ed8', width: 2, from: [0.94, 0.5], to: [0.06, 0.5] },
  { type: 'check', x0: 0.45, y0: 0.4, x1: 0.55, y1: 0.46, color: '#15803d', width: 3, turn: 90 },
  { type: 'cross', x0: 0.45, y0: 0.47, x1: 0.55, y1: 0.53, color: '#000000', width: 4 },
  { type: 'ink', x0: 0.2, y0: 0.55, x1: 0.8, y1: 0.65, color: '#000000', width: 2, strokes: [[[0, 0.5], [0.3, 0.1], [0.6, 0.9], [1, 0.5]], [[0.55, 0.5]]] },
  { type: 'highlight', x0: 0.3, y0: 0.66, x1: 0.7, y1: 0.69, tint: '#ffcc00' },
  { type: 'underline', x0: 0.3, y0: 0.7, x1: 0.7, y1: 0.71, color: '#1d4ed8', width: 2, from: [0, 0.5], to: [1, 0.5] },
  { type: 'strike', x0: 0.3, y0: 0.72, x1: 0.7, y1: 0.73, color: '#dc2626', width: 2, from: [0, 0.5], to: [1, 0.5] },
  { type: 'rubric', x0: 0.3, y0: 0.8, x1: 0.7, y1: 0.86, rubric: RUBRIC },
];

test('cutPath: traço cortado nas bordas da tarja (com folga), área cheia dividida nas faixas de fora, curva achatada', () => {
  const tarja = [[40, -10, 60, 10]];
  const line = cutPath([['M', 0, 0], ['L', 100, 0]], tarja).map(([op, ...v]) => [op, ...v.map((n) => Math.round(n * 1e6) / 1e6)]);
  assert.deepEqual(line, [['M', 0, 0], ['L', 39.98, 0], ['M', 60.02, 0], ['L', 100, 0]]);
  // Fechado e sem nada tirado continua fechado (os cantos continuam unidos).
  assert.deepEqual(cutPath([['M', 0, 0], ['L', 10, 0], ['L', 10, 10], ['Z']], [[50, 50, 60, 60]]).at(-1), ['Z']);
  const square = cutPath([['M', 0, 0], ['L', 100, 0], ['L', 100, 100], ['L', 0, 100], ['Z']], [[30, 30, 70, 70]], { fill: true });
  const pieces = square.filter(([op]) => op === 'M').length;
  assert.equal(pieces, 4, 'o quadrado menos o miolo: quatro faixas');
  for (const [op, x, y] of square) if (op !== 'Z') assert.ok(!strictlyInside([x, y], [30, 30, 70, 70]), `${x},${y}`);
  const curve = cutPath([['M', 0, 0], ['Q', 50, 100, 100, 0]], [[45, 0, 55, 100]]);
  assert.ok(curve.every(([op]) => op === 'M' || op === 'L'), 'a curva cortada vira linhas');
  assert.equal(curve.filter(([op]) => op === 'M').length, 2);
  assert.deepEqual(cutPath([['M', 0, 0], ['L', 10, 0]], [[-5, -5, 20, 5]]), [], 'tudo dentro: nada fica');
  assert.deepEqual(cutPath([['M', 0, 0], ['L', 10, 0]], undefined), [['M', 0, 0], ['L', 10, 0]]);
});

const photoPage = (extra = {}) => ({ jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(30, 40, 'a4', 36), ...extra });

// Tarja na página como aparece (de 0 a 1) → no espaço do PDF (para conferir os pontos).
function userRect(rect, { box = [0, 0, A4.width, A4.height], rotate = 0 } = {}) {
  const [bx0, by0, bx1, by1] = box;
  const w = bx1 - bx0;
  const h = by1 - by0;
  if (rotate === 90) return [bx0 + rect.y0 * w, by0 + rect.x0 * h, bx0 + rect.y1 * w, by0 + rect.x1 * h];
  return [bx0 + rect.x0 * w, by1 - rect.y1 * h, bx0 + rect.x1 * w, by1 - rect.y0 * h];
}

test('desenho, formas, marcações e rubrica pegos em parte pela tarja: nenhum ponto de caminho dentro dela (foto, Word e PDF)', async () => {
  const half = { x0: 0.5, y0: 0, x1: 1, y1: 1 };
  const slit = { x0: 0.38, y0: 0.5, x1: 0.42, y1: 0.7 }; // uma tira no meio do desenho, do marca-texto e dos traços
  // Foto: a tarja vem da imagem; aqui ela é escolhida na folha e levada para a imagem.
  const photo = photoPage();
  const { x, y, w, h } = photo.box;
  const top = photo.height - y - h;
  const toImage = (r) => ({
    x0: (r.x0 * photo.width - x) / w, x1: (r.x1 * photo.width - x) / w, y0: (r.y0 * photo.height - top) / h, y1: (r.y1 * photo.height - top) / h,
  });
  const photoCovers = [half, slit].map((r) => ({ ...r, y0: Math.max(r.y0, top / photo.height), y1: Math.min(r.y1, (top + h) / photo.height), x1: Math.min(r.x1, (x + w) / photo.width) }));
  // Word girado 90°: a tarja é uma caixa do layout (antes do giro).
  const word = { width: A4.width, height: A4.height, rotation: 90, items: [] };
  const wordCovers = [half, slit].map((r) => ({ x0: r.y0, y0: 1 - r.x1, x1: r.y1, y1: 1 - r.x0 })); // de volta para antes do giro
  word.items = wordCovers.map((r) => ({ type: 'redaction', x: r.x0 * A4.width, y: r.y0 * A4.height, w: (r.x1 - r.x0) * A4.width, h: (r.y1 - r.y0) * A4.height }));
  // Página de PDF tarjada: vira imagem, com a tarja na página inteira.
  const pdfPage = { jpeg: fixture('rgb-40x30.jpg'), width: 612, height: 792, box: { x: 0, y: 0, w: 612, h: 792 } };
  const pages = [
    { ...photo, edits: VECTORS, redactions: photoCovers.map(toImage) },
    { ...word, edits: VECTORS },
    { ...pdfPage, edits: VECTORS, redactions: [half, slit] },
    { ...photoPage(), edits: VECTORS }, // sem tarja: a rubrica de sempre
  ];
  const pdf = buildPdf(pages);
  const tarjas = [
    photoCovers.map((r) => userRect(r, { box: [0, 0, photo.width, photo.height] })),
    [half, slit].map((r) => userRect(r, { rotate: 90 })),
    [half, slit].map((r) => userRect(r, { box: [0, 0, 612, 792] })),
  ];
  for (let i = 0; i < 3; i++) {
    const { points } = await pagePoints(pdf, i);
    const inside = points.filter((p) => tarjas[i].some((t) => strictlyInside(p, t)));
    assert.deepEqual(inside, [], `página ${i + 1}: ponto de caminho dentro da tarja`);
    const outside = points.filter((p) => !tarjas[i].some((t) => strictlyInside(p, t)));
    assert.ok(outside.length > 40, `página ${i + 1}: o que fica fora da tarja continua no arquivo (${outside.length} pontos)`);
  }
  // A rubrica pega em parte vai num Form XObject cortado; a da página sem tarja é a de sempre, inteira. Páginas com o
  // mesmo corte no quadro da rubrica (aqui, o Word e a página de PDF) dividem a mesma variante.
  const doc = await openPdf(pdf);
  const formOf = (i) => {
    const xobjects = doc.resolve(doc.resolve(doc.pages[i].attrs.Resources).get('XObject'));
    return [...xobjects.values()].map((ref) => ref.num).find((num) => doc.resolve(doc.object(num)?.dict?.get('Subtype'))?.value === 'Form');
  };
  const whole = formOf(3);
  assert.ok(whole);
  for (let i = 0; i < 3; i++) assert.ok(formOf(i) && formOf(i) !== whole, `página ${i + 1}: a rubrica cortada não é a inteira`);
  assert.ok(latin1(pdf).match(/\/Subtype \/Form \/BBox \[0 0 100 40\]/g).length >= 3);
});

test('edição pega em parte, por inteiro e não pega; tipo sem corte pego em parte não sai', () => {
  const page = A4;
  const rect = VECTORS[0];
  assert.deepEqual(redactEdits([rect], [{ x0: 0, y0: 0, x1: 1, y1: 1 }], page), []);
  assert.deepEqual(redactEdits([rect], [{ x0: 0, y0: 0.9, x1: 1, y1: 1 }], page), [rect]);
  const [cut] = redactEdits([rect], [{ x0: 0.5, y0: 0, x1: 1, y1: 1 }], page);
  assert.ok(cut.cuts.length === 1);
  assert.throws(() => redactEdits([{ type: 'nao-corta', x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }], [{ x0: 0.5, y0: 0, x1: 1, y1: 1 }], page), /não pôde ser apagada/);
});

// ---------- PDF/A: as letras tarjadas não ficam na fonte embutida ----------

const TARJADAS = ['J', 'ã', 'S', 'v'];
const hexCode = (char) => `<${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`;

async function assertLeftOut(pages, font) {
  const fonts = await embedFonts(pages);
  const embedded = fonts.get(font);
  assert.ok(embedded, `fonte ${font} embutida`);
  for (const char of TARJADAS) assert.ok(!embedded.chars.includes(char), `${char} no subconjunto: ${embedded.chars}`);
  assert.ok(embedded.chars.includes('N') && embedded.chars.includes(':'), 'o que fica continua');
  const text = latin1(buildPdf(pages, { pdfa: true, fonts }));
  for (const char of TARJADAS) assert.ok(!text.includes(hexCode(char)), `${char} no ToUnicode`);
}

test('PDF/A: texto "Nome: João da Silva" com tarja sobre "João da Silva" não leva J, ã, S nem v na fonte embutida', async () => {
  const edit = textEdit({ text: 'Nome: João da Silva', size: 20 }, [0.5, 0.3], A4);
  const left = edit.x0 * A4.width + 0.2 * 20 + textWidth('Nome: ', 'Helvetica', 20);
  const item = { type: 'redaction', x: left - 1, y: edit.y0 * A4.height - 2, w: edit.x1 * A4.width - left + 4, h: (edit.y1 - edit.y0) * A4.height + 4 };
  const page = { width: A4.width, height: A4.height, items: [item], edits: [edit] };
  // Saem as letras de "João da Silva" (e o espaço antes, que a tarja também pega); "Nome:" fica.
  const hidden = redactedEdits(page)[0].hidden.map(([, k]) => k);
  assert.deepEqual(hidden.filter((k) => k > 5), [...'João da Silva'].map((_, k) => k + 6));
  assert.ok(hidden.every((k) => k >= 5));
  await assertLeftOut([page], 'Helvetica');
});

test('PDF/A: cabeçalho e rodapé com tarja: as letras tiradas não ficam na fonte embutida', async () => {
  const edits = allPagesText({ header: { text: 'Nome: João da Silva', spot: 'top-left' }, footer: { text: 'Nome: João da Silva', spot: 'bottom-left' } },
    { position: 1, total: 1, size: A4 });
  const photo = photoPage({ edits });
  const { x, y, w, h } = photo.box;
  const top = photo.height - y - h;
  // Tarja da metade direita da linha de cada texto, na folha → na imagem (a margem é coberta só onde há imagem).
  const covers = edits.map((edit) => {
    const at = edit.x0 * photo.width + (textWidth('Nome: ', 'Helvetica', 10) + 2) * (edit.y1 - edit.y0) * photo.height / (10 * 1.65);
    return { x0: (at - x) / w, x1: 1, y0: (edit.y0 * photo.height - 2 - top) / h, y1: (edit.y1 * photo.height + 2 - top) / h };
  });
  // O cabeçalho e o rodapé ficam na margem, fora da imagem: as tarjas da imagem não chegam lá. Na página de PDF
  // tarjada (que vira imagem da página inteira), chegam.
  const pdfPage = { jpeg: fixture('rgb-40x30.jpg'), width: A4.width, height: A4.height, box: { x: 0, y: 0, w: A4.width, h: A4.height }, edits };
  pdfPage.redactions = edits.map((edit) => {
    const at = edit.x0 + (0.2 * 10 + textWidth('Nome: ', 'Helvetica', 10)) / A4.width;
    return { x0: at - 0.001, x1: 1, y0: edit.y0 - 0.005, y1: edit.y1 + 0.005 };
  });
  assert.ok(covers.length === 2);
  await assertLeftOut([pdfPage], 'Helvetica');
});

test('PDF/A: marca d\'água com tarja: as letras tiradas não ficam na fonte embutida', async () => {
  const edit = watermarkEdit('ABCDEFGHIJ');
  const page = { width: A4.width, height: A4.height, items: [], edits: [edit] };
  // A diagonal sobe da esquerda para a direita: a tarja no alto, à direita, pega as últimas letras.
  page.items.push({ type: 'redaction', x: A4.width * 0.55, y: 0, w: A4.width * 0.45, h: A4.height * 0.45 });
  const [cut] = redactedEdits(page);
  const hidden = cut.hide.map((i) => 'ABCDEFGHIJ'[i]);
  assert.ok(hidden.length > 0 && hidden.length < 10, hidden.join(''));
  const fonts = await embedFonts([page]);
  const chars = fonts.get('Helvetica-Bold').chars;
  for (const char of hidden) assert.ok(!chars.includes(char), `${char} no subconjunto: ${chars}`);
  const text = latin1(buildPdf([page], { pdfa: true, fonts }));
  for (const char of hidden) assert.ok(!text.includes(hexCode(char)), `${char} no ToUnicode`);
});

test('PDF/A sem tarja: as letras continuam todas (nada some sem tarja)', async () => {
  const edit = textEdit({ text: 'Nome: João da Silva', size: 20 }, [0.5, 0.3], A4);
  const fonts = await embedFonts([{ width: A4.width, height: A4.height, items: [], edits: [edit] }]);
  for (const char of TARJADAS) assert.ok(fonts.get('Helvetica').chars.includes(char));
  assert.ok(latin1(buildRaw([{ width: A4.width, height: A4.height, items: [], edits: [edit] }], { pdfa: true, fonts })).includes(hexCode('J')));
});
