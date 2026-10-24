// Edições da página (edits.js e edit-shapes.js): modelo, giro, folha com margem, caminhos (seta, ✓, ✗ e traço à mão),
// operadores no PDF nos três tipos de página, recursos sem nome repetido, tarja por cima e assinar sem reescrever.
// O editor (editor.js) e a prévia no canvas são conferidos no navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  registerEditType, rotateEdits, moveEdit, resizeEdit, growEdit, duplicateEdit, boxAround, normalizeBox, editFrame,
  pageMatrix, multiply, editsContent, resourceCollector, redactEdits, paintEdits, editCharacters, smoothStroke,
  simplifyStroke, strokePath, pathOps, prepareStroke, fileExtras, spotBox, MIN_SIDE,
} from '../web/js/edits.js';
import { arrowParts, arrowFromLine, inkFromStrokes, inkStrokes, arrowHead } from '../web/js/edit-shapes.js';
import { visibleToPdf, ROTATE } from '../web/js/geometry.js';
import { layoutPage, buildPdf as buildRaw } from '../web/js/pdf.js';
import { openPdf, copyPages } from '../web/js/pdf-reader.js';
import { unchangedSource } from '../web/js/pdf-append.js';
import { usedCharacters } from '../web/js/pdfa-fonts.js';
import { buildPdf } from './helpers/qpdf.js';
import { makeRawPdf, textPageObjects } from './helpers/pdf.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const closePoint = (a, b, eps = 1e-6) => close(a[0], b[0], eps) && close(a[1], b[1], eps);
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const RECT = { type: 'rect', x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.3, color: '#dc2626', width: 2 };
const CHECK = { type: 'check', x0: 0.6, y0: 0.1, x1: 0.65, y1: 0.14, color: '#15803d', width: 2 };
const CROSS = { type: 'cross', x0: 0.7, y0: 0.7, x1: 0.75, y1: 0.74, color: '#000000', width: 4 };
const ARROW = { type: 'arrow', x0: 0.2, y0: 0.5, x1: 0.6, y1: 0.6, color: '#1d4ed8', width: 2, from: [0.06, 0.88], to: [0.94, 0.12] };
const INK = { type: 'ink', x0: 0.1, y0: 0.8, x1: 0.5, y1: 0.9, color: '#000000', width: 2, strokes: [[[0, 0.5], [0.3, 0.1], [0.6, 0.9], [1, 0.5]], [[0.5, 0.5]]] };
const ALL = [RECT, CHECK, CROSS, ARROW, INK];

// Conteúdo da primeira página de um PDF gerado (o stream, ou a lista de streams juntos).
async function pageContent(pdf, index = 0) {
  const doc = await openPdf(pdf);
  const contents = doc.resolve(doc.pages[index].node.get('Contents'));
  const list = Array.isArray(contents) ? contents.map((ref) => doc.resolve(ref)) : [contents];
  return list.map((stream) => latin1(stream.data)).join('\n');
}

// ---------- Modelo ----------

test('girar a página gira as edições junto: a caixa acompanha o conteúdo e o turn soma; quatro giros voltam ao começo', () => {
  const [turned] = rotateEdits([RECT], 90);
  // 90° no sentido horário: (x, y) → (1 − y, x).
  assert.ok(close(turned.x0, 0.7) && close(turned.y0, 0.1) && close(turned.x1, 0.8) && close(turned.y1, 0.4), JSON.stringify(turned));
  assert.equal(turned.turn, 90);
  assert.equal(turned.color, RECT.color, 'cor e espessura vão junto');
  let list = ALL;
  for (let i = 0; i < 4; i++) list = rotateEdits(list, 90);
  list.forEach((edit, i) => {
    assert.ok(['x0', 'y0', 'x1', 'y1'].every((k) => close(edit[k], ALL[i][k])), edit.type);
    assert.equal(edit.turn, 0);
  });
  assert.deepEqual(rotateEdits([RECT], 270)[0].turn, 270);
});

test('o desenho girado com a página cai no mesmo lugar do conteúdo girado (giro e matriz da edição batem)', () => {
  const page = { width: 600, height: 800 };
  const turnedPage = { width: 800, height: 600 };
  for (const degrees of [90, 180, 270]) {
    const [turned] = rotateEdits([ARROW], degrees);
    const after = degrees % 180 ? turnedPage : page;
    const before = editFrame(ARROW, page.width, page.height);
    const now = editFrame(turned, after.width, after.height);
    assert.ok(close(before.size.w, now.size.w) && close(before.size.h, now.size.h), `${degrees}°: o quadro de pé não muda`);
    // Um ponto do quadro (a ponta da seta) → página antes, girada → tem que ser o mesmo ponto da página depois.
    const tip = [ARROW.to[0] * before.size.w, ARROW.to[1] * before.size.h];
    const [u, v] = apply(before.matrix, tip);
    const expected = ROTATE[degrees]([u / page.width, v / page.height]);
    const [u2, v2] = apply(now.matrix, tip);
    assert.ok(closePoint([u2 / after.width, v2 / after.height], expected), `${degrees}°`);
  }
});

test('mover, mudar o tamanho e duplicar não saem da página', () => {
  assert.deepEqual(moveEdit(RECT, 0.8, -0.5), { ...RECT, x0: 0.7, x1: 1, y0: 0, y1: 0.1 });
  const grown = growEdit(RECT, 0.01, 0.02);
  assert.ok(close(grown.x1, 0.41) && close(grown.y1, 0.32) && grown.x0 === RECT.x0);
  const shrunk = growEdit(RECT, -1, -1);
  assert.ok(close(shrunk.x1 - shrunk.x0, MIN_SIDE) && close(shrunk.y1 - shrunk.y0, MIN_SIDE), 'nunca menor que o mínimo');
  // Arrastar o canto de cima à esquerda além do oposto: para no mínimo, sem virar do avesso.
  const corner = resizeEdit(RECT, 0, 0.9, 0.9);
  assert.ok(corner.x0 < corner.x1 && corner.y0 < corner.y1 && close(corner.x1, RECT.x1) && close(corner.y1, RECT.y1));
  const outside = resizeEdit(RECT, 2, 1.5, 1.5);
  assert.ok(outside.x1 === 1 && outside.y1 === 1);
  const copy = duplicateEdit(RECT);
  assert.ok(close(copy.x0, 0.13) && close(copy.y0, 0.23), 'um pouco abaixo e à direita');
  assert.notEqual(copy, RECT);
  const edge = duplicateEdit({ ...RECT, x0: 0.9, x1: 1, y0: 0.95, y1: 1 });
  assert.ok(close(edge.x0, 0.87) && close(edge.y1, 0.97), 'sem espaço, para cima e para a esquerda');
  assert.deepEqual(normalizeBox({ x0: 0.5, y0: 1.2, x1: -0.1, y1: 0.4 }), { x0: 0, y0: 0.4, x1: 0.5, y1: 1 });
});

test('desenho à mão mantém a proporção ao mudar o tamanho (na página, em pontos)', () => {
  const ink = { ...INK, x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.2 };
  const aspect = 600 / 800;
  const ratio = (e) => ((e.x1 - e.x0) * 600) / ((e.y1 - e.y0) * 800);
  for (const resized of [resizeEdit(ink, 2, 0.5, 0.25, aspect), resizeEdit(ink, 0, 0.05, 0.02, aspect), growEdit(ink, 0.05, 0, aspect)]) {
    assert.ok(close(ratio(resized), ratio(ink), 1e-9), JSON.stringify(resized));
  }
  const big = resizeEdit(ink, 2, 5, 5, aspect);
  assert.ok(big.x1 <= 1 && big.y1 <= 1 && close(ratio(big), ratio(ink), 1e-9), 'no limite da página, os dois lados param juntos');
});

test('caixa do tamanho padrão no meio da página, dentro dela mesmo na borda', () => {
  const page = { width: 600, height: 800 };
  assert.deepEqual(boxAround(0.5, 0.5, [150, 80], page), { x0: 0.375, y0: 0.45, x1: 0.625, y1: 0.55 });
  const corner = boxAround(0.99, 0.01, [60, 80], page);
  assert.ok(close(corner.x1, 1) && corner.y0 === 0);
});

// ---------- Matrizes ----------

test('pageMatrix é a mesma conta de visibleToPdf, nos quatro giros e com CropBox', () => {
  const box = [20, 30, 600, 760];
  for (const rotate of [0, 90, 180, 270]) {
    for (const [u, v] of [[0, 0], [100, 50], [300, 400]]) {
      assert.ok(closePoint(apply(pageMatrix(box, rotate), [u, v]), visibleToPdf(box, rotate, u, v)), `${rotate}° ${u},${v}`);
    }
  }
});

test('quadro da edição: de pé (w × h), girado dentro da caixa com turn', () => {
  const edit = { ...RECT, turn: 90 };
  const { size, matrix } = editFrame(edit, 600, 800);
  // Caixa de 180 × 80 na página; girada 90°, o quadro de pé é 80 × 180.
  assert.ok(close(size.w, 80) && close(size.h, 180));
  // O canto de cima à esquerda do quadro vai para o canto de cima à direita da caixa.
  assert.ok(closePoint(apply(matrix, [0, 0]), [0.4 * 600, 0.2 * 800]));
  assert.ok(closePoint(apply(matrix, [size.w, size.h]), [0.1 * 600, 0.3 * 800]));
});

// ---------- Caminhos ----------

test('seta: a ponta fica em "to", a linha acaba dentro da ponta, e a seta curta é um toque', () => {
  const size = { w: 200, h: 100 };
  const { line, head } = arrowParts(ARROW, size);
  const tip = [ARROW.to[0] * 200, ARROW.to[1] * 100];
  assert.ok(closePoint(head[0].slice(1), tip));
  assert.equal(head.at(-1)[0], 'Z');
  const [, x, y] = line[1];
  const toTip = Math.hypot(tip[0] - x, tip[1] - y);
  assert.ok(toTip > 0 && toTip < arrowHead(2), 'a linha para antes da ponta, dentro dela');
  const page = { width: 600, height: 800 };
  assert.equal(arrowFromLine([0.5, 0.5], [0.505, 0.5], { color: '#000000', width: 2 }, page), null);
  const made = arrowFromLine([0.2, 0.5], [0.6, 0.5], { color: '#000000', width: 2 }, page);
  assert.ok(made.y1 - made.y0 > 0, 'seta na horizontal ganha altura para a ponta');
  const frame = editFrame(made, page.width, page.height);
  const start = apply(frame.matrix, [made.from[0] * frame.size.w, made.from[1] * frame.size.h]);
  assert.ok(closePoint(start, [0.2 * 600, 0.5 * 800], 0.05), 'a cauda fica onde o arrasto começou');
});

test('✓ e ✗: caminhos de traço dentro da caixa, com a espessura do lado de dentro', () => {
  for (const edit of [CHECK, CROSS]) {
    const ops = editsContent([edit], { box: [0, 0, 600, 800] }, resourceCollector());
    const body = ops.split('\n').slice(1, -1).join('\n');
    assert.match(body, / S$/);
    const { size } = editFrame(edit, 600, 800);
    const numbers = [...body.matchAll(/(-?[\d.]+) (-?[\d.]+) [ml]/g)].map((m) => [Number(m[1]), Number(m[2])]);
    for (const [x, y] of numbers) assert.ok(x >= edit.width / 2 - 1e-9 && x <= size.w - edit.width / 2 + 1e-9 && y >= 0 && y <= size.h, `${edit.type}: ${x},${y}`);
  }
});

test('traço à mão: suavizar tira a tremida, simplificar fica só com o que muda o desenho, as pontas ficam', () => {
  const shaky = Array.from({ length: 200 }, (_, i) => [i, (i % 2 ? 0.6 : -0.6)]); // reta com tremida de ±0,6
  const smooth = smoothStroke(shaky, 2);
  const swing = (list) => Math.max(...list.slice(2, -2).map(([, y]) => Math.abs(y)));
  assert.ok(swing(smooth) < swing(shaky) / 3, `${swing(smooth)}`);
  assert.deepEqual(smooth[0], shaky[0]);
  assert.deepEqual(smooth.at(-1), shaky.at(-1));
  const simple = simplifyStroke(smooth, 0.35);
  assert.ok(simple.length < 10, `${simple.length} pontos`);
  assert.deepEqual(simple[0], smooth[0]);
  assert.deepEqual(simple.at(-1), smooth.at(-1));
  // Curva: nenhum ponto descartado fica longe do traço simplificado.
  const curve = Array.from({ length: 300 }, (_, i) => [i, 40 * Math.sin(i / 30)]);
  const kept = simplifyStroke(curve, 0.5);
  assert.ok(kept.length > 10 && kept.length < 80, `${kept.length}`);
  const dist = (p) => Math.min(...kept.slice(1).map((b, i) => {
    const a = kept[i];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)));
    return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1]));
  }));
  assert.ok(curve.every((p) => dist(p) <= 0.5 + 1e-9));
  // Traço comprido (um minuto de caneta a 240 Hz) não estoura a pilha.
  const long = Array.from({ length: 15000 }, (_, i) => [i / 10, 40 * Math.sin(i / 300)]);
  assert.ok(simplifyStroke(long, 0.35).length > 2);
  assert.ok(prepareStroke(long.map(([x, y]) => [x / 1600, 0.5 + y / 800]), { width: 1600, height: 800 }).length < 200);
});

test('traço à mão: curvas pelo meio de cada trecho, do primeiro ao último ponto; a cúbica do PDF termina no mesmo lugar', () => {
  const points = [[0, 0], [10, 10], [20, 0], [30, 10]];
  const path = strokePath(points);
  assert.deepEqual(path[0], ['M', 0, 0]);
  assert.deepEqual(path[1], ['Q', 10, 10, 15, 5]);
  assert.deepEqual(path.at(-1), ['Q', 20, 0, 30, 10]);
  assert.deepEqual(strokePath([[0, 0], [5, 5]]), [['M', 0, 0], ['L', 5, 5]]);
  const ops = pathOps(path);
  assert.match(ops, /^0 0 m /);
  assert.match(ops, / 30 10 c$/);
  // Quadrática (0,0)-(10,10)-(15,5) em cúbica: controles a 2/3 do caminho até o ponto de controle.
  assert.ok(ops.includes('6.67 6.67 11.67 8.33 15 5 c'), ops);
  const page = { width: 600, height: 800 };
  const raw = Array.from({ length: 100 }, (_, i) => [0.1 + i * 0.004, 0.5 + (i % 2 ? 0.0005 : -0.0005)]);
  const prepared = prepareStroke(raw, page);
  assert.ok(prepared.length < raw.length / 10 && prepared.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1));
});

test('desenho: a caixa envolve os traços, e os traços voltam para a página como estavam; um toque vira um ponto', () => {
  const page = { width: 600, height: 800 };
  const strokes = [[[0.2, 0.3], [0.25, 0.35], [0.3, 0.3]], [[0.4, 0.32]]];
  const ink = inkFromStrokes(strokes, { color: '#000000', width: 2 }, page);
  assert.equal(ink.type, 'ink');
  assert.ok(ink.x0 < 0.2 && ink.x1 > 0.4 && ink.y0 < 0.3 && ink.y1 > 0.35);
  inkStrokes(ink).flat().forEach((point, i) => assert.ok(closePoint(point, strokes.flat()[i], 1e-3), `${point}`));
  const ops = editsContent([ink], { box: [0, 0, 600, 800] }, resourceCollector());
  assert.match(ops, /1 J 1 j/, 'pontas e cantos redondos');
  assert.match(ops, / c S\n/, 'o traço vira curva');
  assert.match(ops, / c h f\nQ$/, 'o toque vira um círculo cheio');
});

// ---------- PDF ----------

const photoPage = (extra = {}) => ({ jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(30, 40, 'a4', 36), ...extra });
const wordPage = (extra = {}) => ({
  width: 595.28, height: 841.89, items: [{ type: 'text', x: 72, y: 100, text: 'Contrato', font: 'Helvetica', size: 12 }], ...extra,
});

test('foto: edições na folha inteira, com a margem, por cima da imagem; sem edição, o PDF não muda', async () => {
  const plain = buildPdf([photoPage()]);
  assert.deepEqual(buildRaw([photoPage({ edits: [] })]), plain, 'lista vazia não muda nada');
  // Retângulo no canto da folha, dentro da margem de 36 pontos.
  const margin = { type: 'rect', x0: 0, y0: 0, x1: 0.05, y1: 0.03, color: '#000000', width: 1 };
  const pdf = buildPdf([photoPage({ edits: [margin, ...ALL] })]);
  const content = await pageContent(pdf);
  assert.match(content, /^q [\d. ]+ cm \/Im0 Do Q\nq 1 0 0 -1 0 841\.89 cm\n/, 'a imagem primeiro, depois a edição no canto de cima da folha');
  assert.equal(content.match(/^q 1 0 0 -1 [\d.]+ [\d.]+ cm$/gm).length, 6);
  assert.match(latin1(pdf), /%PDF-1\.4/, 'só caminhos: o PDF continua 1.4');
});

test('foto com tarja: as edições por baixo e as tarjas de novo por cima, como caixas pretas, na folha', async () => {
  // A tarja pega só um pedaço do retângulo: o pedaço sob ela sai do arquivo (redact-edits.test.js), e a caixa preta,
  // arredondada para fora, vem por cima do resto.
  const page = photoPage({ redactions: [{ x0: 0, y0: 0, x1: 0.3, y1: 0.3 }], edits: [RECT] });
  const content = await pageContent(buildPdf([page]));
  const { box } = page;
  const down = (v) => Math.floor(v * 100) / 100;
  const up = (v) => Math.ceil(v * 100) / 100;
  const n = (v) => String(Math.round(v * 100) / 100);
  const [x0, y0, x1, y1] = [down(box.x), down(box.y + 0.7 * box.h), up(box.x + 0.3 * box.w), up(box.y + box.h)];
  const tarja = `q 0 0 0 rg ${n(x0)} ${n(y0)} ${n(x1 - x0)} ${n(y1 - y0)} re f Q`;
  assert.ok(content.includes(tarja), content);
  assert.ok(content.indexOf(' S\nQ') < content.indexOf(tarja), 'a tarja vem depois da edição');
  // Sem edição, a tarja já está nos pixels e não vai de novo.
  assert.ok(!(await pageContent(buildPdf([photoPage({ redactions: page.redactions })]))).includes('0 0 0 rg'));
});

test('edição inteira sob uma tarja sai do arquivo; a que só encosta fica, coberta', () => {
  const covers = [{ x0: 0, y0: 0, x1: 0.45, y1: 0.35 }];
  assert.deepEqual(redactEdits([RECT, ARROW], covers), [ARROW]);
  assert.deepEqual(redactEdits([RECT], []), [RECT]);
  const page = photoPage({ redactions: [{ x0: 0, y0: 0, x1: 1, y1: 1 }], edits: [{ ...RECT, x0: 0.3, y0: 0.3, x1: 0.4, y1: 0.4 }] });
  assert.ok(!latin1(buildRaw([page])).includes(' re S'), 'o retângulo sob a tarja não vai para o arquivo');
});

test('Word: edições depois do texto e antes das tarjas, girando com o /Rotate da página', async () => {
  const page = wordPage({
    rotation: 90, edits: [RECT, ARROW],
    items: [...wordPage().items, { type: 'redaction', x: 60, y: 80, w: 100, h: 30 }],
  });
  const content = await pageContent(buildPdf([page]));
  const text = content.indexOf('Tj');
  const edit = content.indexOf(' cm\n');
  const tarja = content.lastIndexOf('0 0 0 rg');
  assert.ok(text < edit && edit < tarja, content);
  // Página girada 90°: a matriz leva o quadro da edição para a página como aparece (pageMatrix).
  const [x, y] = visibleToPdf([0, 0, 595.28, 841.89], 90, RECT.x0 * 841.89, RECT.y0 * 595.28);
  assert.ok(content.includes(`q 0 1 1 0 ${Math.round(x * 1e4) / 1e4} ${Math.round(y * 1e4) / 1e4} cm`), content);
});

const rotatedPdf = (extra = '') => makeRawPdf({
  1: '<< /Type /Catalog /Pages 2 0 R >>',
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
  ...textPageObjects('Copiada', { extra: ` /Rotate 90 /CropBox [20 30 600 760]${extra}` }),
}).bytes;

test('página copiada: edições depois do conteúdo original (entre q e Q), com o /Rotate dela, o giro do app e a CropBox', async () => {
  const doc = await openPdf(rotatedPdf());
  for (const rotation of [0, 90]) {
    const copy = copyPages(doc, [0], { edits: new Map([[0, { edits: [RECT], rotation }]]) });
    const pdf = buildPdf([{ copy: { source: copy, page: copy.pages.get(0) }, rotation }]);
    const again = await openPdf(pdf);
    const contents = again.resolve(again.pages[0].node.get('Contents'));
    assert.equal(latin1(again.resolve(contents[0]).data), 'q');
    const added = latin1(again.resolve(contents.at(-1)).data);
    assert.match(added, /^Q\nq /);
    const rotate = (90 + rotation) % 360;
    const box = [20, 30, 600, 760];
    const sideways = rotate % 180 !== 0;
    const width = sideways ? 730 : 580;
    const height = sideways ? 580 : 730;
    const [x, y] = visibleToPdf(box, rotate, RECT.x0 * width, RECT.y0 * height);
    const m = pageMatrix(box, rotate);
    assert.ok(added.includes(`q ${m.slice(0, 4).join(' ')} ${Math.round(x * 1e4) / 1e4} ${Math.round(y * 1e4) / 1e4} cm`), `${rotate}°: ${added}`);
  }
  // Sem edição (ou com a lista vazia), a página sai igual.
  const plain = buildPdf([{ copy: { source: copyPages(doc, [0]), page: copyPages(doc, [0]).pages.get(0) } }]);
  const empty = copyPages(doc, [0], { edits: new Map([[0, { edits: [], rotation: 0 }]]) });
  assert.deepEqual(buildPdf([{ copy: { source: empty, page: empty.pages.get(0) } }]), plain);
});

// Tipo de teste que pede um de cada recurso: fonte, ExtGState, imagem com máscara (/SMask) e formulário repetido.
registerEditType('teste-recursos', {
  label: 'Teste', gender: 'm',
  paint() {},
  characters: () => new Map([['Times-Roman', 'Olá']]),
  pdf(edit, { w, h }, res) {
    const font = res.font('Times-Roman');
    const state = res.extGState({ ca: 0.5, CA: 0.5, BM: 'Multiply' });
    const mask = res.object('mascara', { dict: { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }, data: new Uint8Array([128]) });
    const image = res.xObject('imagem', { dict: { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: mask }, data: new Uint8Array([255, 0, 0]) });
    const form = res.xObject('rubrica', { dict: { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }, data: new TextEncoder().encode('0 0 m 10 10 l S') });
    return `${state} gs BT ${font} 10 Tf 1 0 0 -1 0 ${h} Tm <4f6c> Tj ET q ${w} 0 0 -${h} 0 ${h} cm ${image} Do Q ${form} Do`;
  },
});
const RES = { type: 'teste-recursos', x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.2 };

test('coletor de recursos: nomes novos, que a página ainda não usa; o mesmo pedido, o mesmo nome', () => {
  const res = resourceCollector(['Ed1', 'Ed3']);
  assert.equal(res.font('Helvetica'), '/Ed2');
  assert.equal(res.font('Helvetica'), '/Ed2');
  assert.equal(res.extGState({ ca: 0.5 }), '/Ed4');
  assert.equal(res.xObject('a', { dict: {}, data: new Uint8Array() }), '/Ed5');
  assert.equal(res.xObject('a', { dict: {}, data: new Uint8Array() }), '/Ed5');
  assert.equal(res.empty, false);
  assert.equal(resourceCollector().empty, true);
});

test('recursos das edições na foto, no Word e na página copiada: sem nome repetido e com a imagem e a rubrica gravadas uma vez', async () => {
  const doc = await openPdf(rotatedPdf(' /Resources << /Font << /F1 5 0 R /Ed1 5 0 R >> /ExtGState << /Ed2 << /CA 1 >> >> >>'));
  const copy = copyPages(doc, [0], { edits: new Map([[0, { edits: [RES, RECT], rotation: 0 }]]) });
  const pdf = buildPdf([
    photoPage({ edits: [RES], ocr: [{ text: 'OCR', x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.14, baseline: 0.13, size: 0.04, last: true }] }),
    wordPage({ edits: [RES] }),
    { copy: { source: copy, page: copy.pages.get(0) } },
  ]);
  const again = await openPdf(pdf);
  const resources = (i) => again.resolve(again.pages[i].attrs.Resources);
  for (let i = 0; i < 3; i++) {
    const res = resources(i);
    const names = ['Font', 'ExtGState', 'XObject'].flatMap((key) => [...(again.resolve(res.get(key))?.keys() ?? [])]);
    assert.equal(new Set(names).size, names.length, `página ${i + 1}: ${names}`);
    const content = await pageContent(pdf, i);
    for (const [, name] of content.matchAll(/\/(Ed\d+) (?:gs|\d+ Tf|Do)/g)) assert.ok(names.includes(name), `página ${i + 1}: ${name} nos recursos`);
  }
  // A página copiada já usava /Ed1 e /Ed2: as edições ganharam outros nomes, e os de antes continuam.
  const copied = resources(2);
  assert.equal(again.resolve(again.resolve(copied.get('ExtGState')).get('Ed2')).get('CA'), 1);
  assert.ok(again.resolve(copied.get('Font')).has('Ed1'));
  // Foto e Word: uma imagem, uma máscara e uma rubrica no arquivo inteiro (a página copiada tem as suas).
  const text = latin1(pdf);
  assert.equal(text.match(/\/Subtype \/Form \/BBox \[0 0 10 10\]/g).length, 2);
  assert.equal(text.match(/\/SMask \d+ 0 R/g).length, 2);
  assert.equal(text.match(/\/BaseFont \/Times-Roman/g).length, 2, 'a Times da foto e do Word é uma só; a da cópia é dela');
});

test('edição com fonte e PDF/A: sem a fonte embutida, nada sai; as letras da edição entram no subconjunto', () => {
  assert.throws(() => buildRaw([wordPage({ edits: [RES] })], { pdfa: true }), /fontes das edições/);
  assert.deepEqual([...editCharacters([RES, RECT])], [['Times-Roman', 'Olá']]);
  const used = usedCharacters([photoPage({ edits: [RES] })]);
  assert.deepEqual([...used.get('Times-Roman')].sort(), ['O', 'l', 'á']);
});

test('conteúdo das edições: tipo desconhecido e texto fora do ASCII são recusados', () => {
  assert.throws(() => editsContent([{ type: 'nada', x0: 0, y0: 0, x1: 1, y1: 1 }], { box: [0, 0, 10, 10] }, resourceCollector()), /desconhecido/);
  registerEditType('teste-acento', { label: 'Acento', gender: 'm', paint() {}, pdf: () => 'BT (ação) Tj ET' });
  assert.throws(() => editsContent([{ type: 'teste-acento', x0: 0, y0: 0, x1: 1, y1: 1 }], { box: [0, 0, 10, 10] }, resourceCollector()), /ASCII/);
  assert.throws(() => registerEditType('rect', {}), /repetido/);
});

test('prévia no canvas: cada edição com a matriz da página para os pixels, e espessura em pontos', () => {
  const calls = [];
  const ctx = {
    canvas: { width: 300, height: 400 },
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() { calls.push(['stroke', this.lineWidth]); },
    setTransform(...m) { calls.push(['matrix', m]); },
  };
  paintEdits(ctx, [RECT], { width: 600, height: 800 });
  const [, matrix] = calls.find(([kind]) => kind === 'matrix');
  assert.deepEqual(matrix, [0.5, 0, 0, 0.5, 0.1 * 300, 0.2 * 400]);
  assert.deepEqual(calls.find(([kind]) => kind === 'stroke'), ['stroke', 2]);
});

test('qpdf --check: as cinco formas nos três tipos de página, giradas e com a página girada', async () => {
  const doc = await openPdf(rotatedPdf());
  for (const turn of [0, 90, 180, 270]) {
    const edits = rotateEdits(ALL, turn);
    const copy = copyPages(doc, [0], { edits: new Map([[0, { edits, rotation: turn }]]) });
    buildPdf([photoPage({ edits }), wordPage({ edits, rotation: turn }), { copy: { source: copy, page: copy.pages.get(0) }, rotation: turn }]);
  }
});

// ---------- Assinar sem reescrever e "em todas as páginas" ----------

test('assinar sem reescrever fica desligado quando uma página tem edição (ou "em todas as páginas" está ligado)', async () => {
  const doc = await openPdf(rotatedPdf());
  const pages = [{ kind: 'pdf', doc, index: 0, rotation: 0 }];
  const groups = [[0]];
  assert.equal(unchangedSource(pages, { changes: false, groups }), doc);
  assert.equal(unchangedSource([{ ...pages[0], edits: [RECT] }], { changes: false, groups }), null);
  assert.equal(unchangedSource([{ ...pages[0], edits: [] }], { changes: false, groups }), doc, 'lista vazia não é mudança');
  assert.equal(unchangedSource(pages, { changes: true, groups }), null);
  assert.equal(unchangedSource([{ ...pages[0], redactions: [RECT] }], { changes: false, groups }), null);
  assert.equal(unchangedSource([{ ...pages[0], rotation: 90 }], { changes: false, groups }), null);
  assert.equal(unchangedSource(pages, { changes: false, groups: null }), null);
});

test('"em todas as páginas": a posição e o total contam dentro de cada arquivo', () => {
  const number = ({ position, total }) => [{ position, total }];
  // Tudo num PDF só, um PDF por página e por intervalos: cada arquivo começa do 1.
  assert.deepEqual(fileExtras([[0, 1, 2]], number).flat(2), [{ position: 1, total: 3 }, { position: 2, total: 3 }, { position: 3, total: 3 }]);
  assert.deepEqual(fileExtras([[0], [1], [2]], number).map((file) => file[0][0]), [{ position: 1, total: 1 }, { position: 1, total: 1 }, { position: 1, total: 1 }]);
  const ranges = fileExtras([[0, 1], [2, 3, 4]], (context) => [context]);
  assert.deepEqual(ranges[1].map(([context]) => [context.position, context.total, context.file, context.files, context.index]), [[1, 3, 2, 2, 2], [2, 3, 2, 2, 3], [3, 3, 2, 2, 4]]);
  assert.deepEqual(fileExtras([[0, 1]], () => undefined), [[[], []]], 'nada a acrescentar');
});

test('lugares da grade de seis: a 24 pontos da borda, como o carimbo, e dentro da página pequena', () => {
  const page = { width: 600, height: 800 };
  const box = spotBox('bottom-right', [100, 20], page);
  assert.ok(close(box.x1, (600 - 24) / 600) && close(box.y1, (800 - 24) / 800) && close(box.x1 - box.x0, 100 / 600));
  const top = spotBox('top-center', [100, 20], page);
  assert.ok(close(top.x0, 250 / 600) && close(top.y0, 24 / 800));
  const tiny = spotBox('top-left', [300, 50], { width: 200, height: 40 });
  assert.ok(tiny.x0 === 0 && tiny.x1 === 1 && tiny.y0 === 0 && tiny.y1 === 1);
});

test('matriz composta: multiply aplica a da direita primeiro', () => {
  const m = multiply([2, 0, 0, 2, 10, 0], [1, 0, 0, 1, 5, 5]);
  assert.deepEqual(apply(m, [0, 0]), [20, 10]);
});
