// Imagem e rubrica (edit-media.js, fase 4 da edição): imagem com e sem transparência (/SMask e JPEG), a mesma imagem
// uma vez por arquivo, a rubrica como Form XObject uma vez por arquivo e chamada em cada página, nomes sem colisão na
// página copiada, a parte da imagem sob a tarja apagada dos pixels, qpdf --check e veraPDF (PDF/A-2b).
// A ferramenta (edit-image.js) e o quadro da rubrica (rubric.js) são conferidos no navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  storeImage, imageRecord, keepImages, forgetMedia, onForget, hasTransparency, flateImage, pngPredict, pngUnpredict,
  imageCuts, cutKey, cutFlate, pixelCuts, rubricFromStrokes, rubricEdit, RUBRIC_SIZES,
} from '../web/js/edit-media.js';
import { editType, rotateEdits, redactEdits, resizeEdit, editsContent, resourceCollector, spotBox } from '../web/js/edits.js';
import { layoutPage, buildPdf as buildRaw } from '../web/js/pdf.js';
import { openPdf, copyPages, unpredict, PdfDict, PdfName, PdfStream } from '../web/js/pdf-reader.js';
import { embedFonts } from '../web/js/pdfa-fonts.js';
import { allPagesText } from '../web/js/edit-text.js';
import { watermarkEdit } from '../web/js/edit-marks.js';
import { buildPdf } from './helpers/qpdf.js';
import { makeRawPdf, textPageObjects } from './helpers/pdf.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const photoPage = (extra = {}) => ({ jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(30, 40, 'a4', 36), ...extra });
const wordPage = (extra = {}) => ({
  width: 595.28, height: 841.89, items: [{ type: 'text', x: 72, y: 100, text: 'Contrato', font: 'Helvetica', size: 12 }], ...extra,
});
const rotatedPdf = (extra = '') => makeRawPdf({
  1: '<< /Type /Catalog /Pages 2 0 R >>',
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
  ...textPageObjects('Copiada', { extra: ` /Rotate 90 /CropBox [20 30 600 760]${extra}` }),
}).bytes;

// Imagem RGBA de teste: um degradê colorido, com a metade de baixo meio transparente e um canto transparente de vez.
function sample(width = 8, height = 6, { gray = false, opaque = false } = {}) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = (x * 37 + y * 11) & 255;
      rgba.set(gray ? [r, r, r] : [r, (x * 90) & 255, (y * 50) & 255], i);
      rgba[i + 3] = opaque ? 255 : x === 0 && y === 0 ? 0 : y >= height / 2 ? 128 : 255;
    }
  }
  return rgba;
}

const ALPHA = await flateImage(sample(), 8, 6);
const GRAY = await flateImage(sample(10, 4, { gray: true }), 10, 4);
const JPEG = { kind: 'jpeg', width: 40, height: 30, data: fixture('rgb-40x30.jpg') };
storeImage('alfa', ALPHA);
storeImage('cinza', GRAY);
storeImage('foto', JPEG);

const image = (id, box = { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.325 }, extra = {}) => ({ type: 'image', ...box, image: id, ...extra });

// Conteúdo de uma página do PDF gerado (todos os streams juntos).
async function pageContent(pdf, index = 0) {
  const doc = await openPdf(pdf);
  const contents = doc.resolve(doc.pages[index].node.get('Contents'));
  const list = Array.isArray(contents) ? contents.map((ref) => doc.resolve(ref)) : [contents];
  return list.map((stream) => latin1(stream.data)).join('\n');
}

// Os XObjects que o conteúdo da página chama com Do, resolvidos nos recursos dela.
async function drawnObjects(pdf, index = 0) {
  const doc = await openPdf(pdf);
  const xobjects = doc.resolve(doc.resolve(doc.pages[index].attrs.Resources).get('XObject'));
  const content = await pageContent(pdf, index);
  return { doc, list: [...content.matchAll(/\/(Ed\d+) Do/g)].map(([, name]) => ({ name, stream: doc.resolve(xobjects.get(name)) })) };
}

// Amostras de um stream Flate do PDF gerado, com o preditor desfeito pelo leitor do app (outra implementação).
const samples = (stream) => unpredict(new Uint8Array(inflateSync(stream.data)), stream.dict.get('DecodeParms'));

// ---------- Codificação ----------

test('preditor PNG: o Paeth daqui volta igual pelo desfazer daqui e pelo do leitor de PDF', () => {
  for (const channels of [1, 3]) {
    const bytes = Uint8Array.from({ length: 7 * 5 * channels }, (_, i) => (i * 73 + (i >> 3) * 19) & 255);
    const predicted = pngPredict(bytes, 7, 5, channels);
    assert.equal(predicted.length, (7 * channels + 1) * 5);
    assert.ok([...Array(5).keys()].every((row) => predicted[row * (7 * channels + 1)] === 4), 'Paeth em toda linha');
    assert.deepEqual(pngUnpredict(predicted, 7, 5, channels), bytes);
    assert.deepEqual(unpredict(predicted, new Map([['Predictor', 15], ['Colors', channels], ['Columns', 7]])), bytes);
  }
});

test('transparência de verdade: só alfa abaixo de 255 conta', () => {
  assert.equal(hasTransparency(sample(4, 4, { opaque: true })), false);
  assert.equal(hasTransparency(sample(4, 4)), true);
});

test('imagem com transparência: Flate com o preditor e a máscara /SMask em cinza; as cores e o alfa voltam iguais', async () => {
  assert.equal(ALPHA.kind, 'flate');
  assert.equal(ALPHA.gray, false);
  const rgba = sample();
  const pdf = buildPdf([photoPage({ edits: [image('alfa')] })]);
  const { list } = await drawnObjects(pdf);
  assert.equal(list.length, 1);
  const { dict } = list[0].stream;
  assert.equal(dict.get('Subtype').value, 'Image');
  assert.equal(dict.get('ColorSpace').value, 'DeviceRGB');
  assert.equal(dict.get('Filter').value, 'FlateDecode');
  assert.deepEqual([...dict.get('DecodeParms')], [['Predictor', 15], ['Colors', 3], ['BitsPerComponent', 8], ['Columns', 8]]);
  const color = samples(list[0].stream);
  assert.deepEqual([...color], [...rgba].filter((_, i) => i % 4 !== 3));
  const doc = await openPdf(pdf);
  const mask = doc.resolve(dict.get('SMask'));
  assert.ok(mask instanceof PdfStream);
  assert.equal(mask.dict.get('ColorSpace').value, 'DeviceGray');
  assert.equal(mask.dict.get('Width'), 8);
  assert.equal(mask.dict.get('SMask'), undefined, 'a máscara não tem máscara');
  assert.deepEqual([...samples(mask)], [...rgba].filter((_, i) => i % 4 === 3));
  // Na página: a imagem de pé no quadro da edição ("w 0 0 -h 0 h cm"), por cima da foto.
  const content = await pageContent(pdf);
  assert.match(content, /\/Im0 Do Q\nq [-\d. ]+ cm\n[\d.]+ 0 0 -[\d.]+ 0 [\d.]+ cm \/Ed1 Do\nQ$/);
  assert.match(latin1(pdf), /^%PDF-1\.4/, 'máscara /SMask é do PDF 1.4');
});

test('imagem cinza com transparência (rubrica escaneada, carimbo): as cores num canal só', async () => {
  assert.equal(GRAY.gray, true);
  const { list } = await drawnObjects(buildPdf([wordPage({ edits: [image('cinza')] })]));
  const { dict } = list[0].stream;
  assert.equal(dict.get('ColorSpace').value, 'DeviceGray');
  assert.equal(dict.get('DecodeParms').get('Colors'), 1);
  assert.deepEqual([...samples(list[0].stream)], [...sample(10, 4, { gray: true })].filter((_, i) => i % 4 === 0));
});

test('imagem sem transparência: JPEG inteiro (DCTDecode), sem máscara', async () => {
  const pdf = buildPdf([photoPage({ edits: [image('foto')] })]);
  const { list } = await drawnObjects(pdf);
  const { dict, data } = list[0].stream;
  assert.equal(dict.get('Filter').value, 'DCTDecode');
  assert.equal(dict.get('DecodeParms'), undefined);
  assert.equal(dict.get('SMask'), undefined);
  assert.deepEqual(data, JPEG.data);
});

// ---------- Uma vez por arquivo ----------

test('a mesma imagem várias vezes (duplicada, girada, em outra página): um objeto só por arquivo; a página copiada tem o seu', async () => {
  const one = image('alfa');
  const two = image('alfa', { x0: 0.5, y0: 0.5, x1: 0.8, y1: 0.725 });
  const doc = await openPdf(rotatedPdf());
  const copy = copyPages(doc, [0], { edits: new Map([[0, { edits: [one, two], rotation: 0 }]]) });
  const pdf = buildPdf([
    photoPage({ edits: [one, two] }),
    wordPage({ edits: rotateEdits([one], 90), rotation: 90 }),
    photoPage({ edits: [image('foto'), image('foto', { x0: 0.6, y0: 0.6, x1: 0.9, y1: 0.825 })] }),
    { copy: { source: copy, page: copy.pages.get(0) } },
  ]);
  const text = latin1(pdf);
  // A imagem e a máscara (8 × 6): uma vez nas fotos e no Word, outra vez na cópia.
  assert.equal(text.match(/\/Width 8 \/Height 6/g)?.length ?? 0, 2 * 2, 'fotos e Word dividem; a cópia tem a sua');
  assert.equal(text.match(/\/Filter \/DCTDecode/g).length, 2 + 1, 'as duas fotos e o JPEG da edição, uma vez só');
  for (const [page, count] of [[0, 2], [1, 1], [2, 2], [3, 2]]) {
    const { list } = await drawnObjects(pdf, page);
    assert.equal(list.length, count, `página ${page + 1}`);
    assert.equal(new Set(list.map(({ name }) => name)).size, 1, `página ${page + 1}: a mesma imagem, o mesmo nome`);
  }
});

test('nomes sem colisão na página copiada: a imagem, a máscara e a rubrica com nomes que ela ainda não usa', async () => {
  const doc = await openPdf(rotatedPdf(' /Resources << /Font << /F1 5 0 R >> /XObject << /Ed1 5 0 R >> /ExtGState << /Ed2 << /CA 1 >> >> >>'));
  const rubric = rubricFromStrokes([[[0.1, 0.5], [0.5, 0.2], [0.9, 0.6]]], { color: '#1d4ed8', width: 3 }, { width: 300, height: 120 }, 900);
  const edits = [image('alfa'), rubricEdit(rubric, 'bottom-right', 80, { width: 730, height: 580 })];
  const copy = copyPages(doc, [0], { edits: new Map([[0, { edits, rotation: 0 }]]) });
  const pdf = buildPdf([{ copy: { source: copy, page: copy.pages.get(0) } }]);
  const again = await openPdf(pdf);
  const res = again.resolve(again.pages[0].attrs.Resources);
  const names = ['Font', 'ExtGState', 'XObject'].flatMap((key) => [...(again.resolve(res.get(key))?.keys() ?? [])]);
  assert.equal(new Set(names).size, names.length, names.join(' '));
  const { list } = await drawnObjects(pdf);
  assert.deepEqual(list.map(({ name }) => name), ['Ed3', 'Ed4'], 'os nomes que a página já usava ficaram com ela');
  assert.equal(list[0].stream.dict.get('Subtype').value, 'Image');
  assert.equal(list[1].stream.dict.get('Subtype').value, 'Form');
  assert.ok(again.resolve(again.resolve(res.get('XObject')).get('Ed1')), 'o /Ed1 de antes continua');
});

// ---------- Rubrica ----------

const STROKES = [[[0.1, 0.6], [0.3, 0.2], [0.45, 0.7], [0.7, 0.3], [0.9, 0.55]], [[0.5, 0.8]]];
const RUBRIC = rubricFromStrokes(STROKES, { color: '#000000', width: 3 }, { width: 320, height: 160 }, 1);

test('rubrica: a caixa envolve os traços, com folga para a espessura; o lado maior no tamanho escolhido, no lugar da grade', () => {
  assert.ok(RUBRIC.w > 0.8 * 320 && RUBRIC.w < 320 && RUBRIC.h > 0.6 * 160 && RUBRIC.h < 160, `${RUBRIC.w} × ${RUBRIC.h}`);
  assert.ok(RUBRIC.strokes.flat().every(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1));
  const page = { width: 595.28, height: 841.89 };
  const edit = rubricEdit(RUBRIC, 'bottom-right', RUBRIC_SIZES.medium.side, page);
  const w = (edit.x1 - edit.x0) * page.width;
  const h = (edit.y1 - edit.y0) * page.height;
  assert.ok(close(Math.max(w, h), (3 * 72) / 2.54, 1e-3), 'lado maior de 3 cm');
  assert.ok(close(w / h, RUBRIC.w / RUBRIC.h, 1e-3), 'sem deformar');
  assert.deepEqual(edit, { type: 'rubric', ...spotBox('bottom-right', [w, h], page), rubric: RUBRIC });
  assert.ok(editType('rubric').keepRatio);
  assert.ok(close((1 - edit.x1) * page.width, 24, 1e-3) && close((1 - edit.y1) * page.height, 24, 1e-3), 'a 24 pontos da borda');
});

test('rubrica no mesmo lugar da numeração e do rodapé: sai de cima deles, para dentro da página; a marca d\'água não conta', () => {
  const page = { width: 595.28, height: 841.89 };
  const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  // Numeração e rodapé embaixo, à direita, empilhados pela fase 2; cabeçalho em cima, à esquerda.
  const texts = allPagesText({
    number: { format: 'page-n-of', spot: 'bottom-right' },
    footer: { text: 'Rodapé do contrato', spot: 'bottom-right' },
    header: { text: 'Cabeçalho', spot: 'top-left' },
  }, { position: 2, total: 7, size: page });
  const placed = [watermarkEdit('CÓPIA'), ...texts];
  const alone = rubricEdit(RUBRIC, 'bottom-right', RUBRIC_SIZES.medium.side, page);
  assert.ok(texts.some((text) => overlaps(text, alone)), 'sem o placed, ela cairia em cima do texto');
  for (const spot of ['bottom-right', 'top-left']) {
    const edit = rubricEdit(RUBRIC, spot, RUBRIC_SIZES.medium.side, page, placed);
    assert.ok(texts.every((text) => !overlaps(text, edit)), `${spot}: não cobre a numeração, o rodapé nem o cabeçalho`);
    const first = rubricEdit(RUBRIC, spot, RUBRIC_SIZES.medium.side, page);
    assert.ok(close(edit.x1 - edit.x0, first.x1 - first.x0) && close(edit.y1 - edit.y0, first.y1 - first.y0), 'mesmo tamanho');
    assert.ok(spot.startsWith('top') ? edit.y0 > first.y0 : edit.y1 < first.y1, 'para dentro da página');
    const near = spot.startsWith('top') ? edit.y0 - Math.max(...texts.filter((t) => t.y1 < 0.5).map((t) => t.y1)) : Math.min(...texts.filter((t) => t.y0 > 0.5).map((t) => t.y0)) - edit.y1;
    assert.ok(close(near * page.height, 4, 0.01), `${spot}: logo depois do texto (${near * page.height} pt)`);
  }
  // Lugar livre: fica onde estava, mesmo com a marca d'água na página inteira.
  assert.deepEqual(rubricEdit(RUBRIC, 'top-right', 60, page, placed), rubricEdit(RUBRIC, 'top-right', 60, page));
});

test('rubrica em todas as páginas: um Form XObject só no arquivo, chamado em cada página na escala da caixa', async () => {
  const doc = await openPdf(rotatedPdf());
  const sizes = [{ width: 595.28, height: 841.89 }, { width: 841.89, height: 595.28 }, { width: 730, height: 580 }];
  const at = (size) => rubricEdit(RUBRIC, 'bottom-center', RUBRIC_SIZES.large.side, size);
  const copy = copyPages(doc, [0], { edits: new Map([[0, { edits: [at(sizes[2])], rotation: 0 }]]) });
  const photo = photoPage();
  const pdf = buildPdf([
    { ...photo, edits: [at({ width: photo.width, height: photo.height })] },
    wordPage({ edits: [at(sizes[0])] }),
    wordPage({ edits: [at(sizes[1])], rotation: 90 }),
    { copy: { source: copy, page: copy.pages.get(0) } },
  ]);
  const text = latin1(pdf);
  assert.equal(text.match(/\/Subtype \/Form/g).length, 2, 'um nas fotos e no Word, um na cópia');
  const forms = new Set();
  for (let i = 0; i < 4; i++) {
    const { list } = await drawnObjects(pdf, i);
    assert.equal(list.length, 1, `página ${i + 1}`);
    const { stream } = list[0];
    assert.equal(stream.dict.get('Subtype').value, 'Form');
    assert.deepEqual(stream.dict.get('BBox'), [0, 0, Math.round(RUBRIC.w * 1e4) / 1e4, Math.round(RUBRIC.h * 1e4) / 1e4]);
    assert.ok(stream.dict.get('Resources') instanceof PdfDict);
    if (i < 3) forms.add(stream);
    // A escala da caixa: o lado maior com 4,5 cm.
    const content = await pageContent(pdf, i);
    const [, sx, sy] = content.match(/\n([\d.]+) 0 0 ([\d.]+) 0 0 cm \/Ed\d+ Do/);
    assert.ok(close(Number(sx) * RUBRIC.w, (4.5 * 72) / 2.54, 0.01) && close(Number(sy), Number(sx), 1e-4), content);
  }
  // O desenho dentro do Form é o do desenho à mão, no quadro da rubrica.
  const [form] = forms;
  const ink = editType('ink').pdf({ type: 'ink', strokes: RUBRIC.strokes, color: '#000000', width: 3 }, { w: RUBRIC.w, h: RUBRIC.h });
  assert.equal(latin1(form.data), ink);
  assert.match(ink, / c S\n.* c h f$/s, 'traço em curvas e o toque como ponto');
});

test('rubrica nova (outro desenho) é outro Form; a mesma em vários arquivos vai em cada um', () => {
  const other = { ...RUBRIC, id: 2, color: '#1d4ed8' };
  const size = { width: 595.28, height: 841.89 };
  const pdf = buildRaw([wordPage({ edits: [rubricEdit(RUBRIC, 'top-left', 60, size)] }), wordPage({ edits: [rubricEdit(other, 'top-left', 60, size)] })]);
  assert.equal(latin1(pdf).match(/\/Subtype \/Form/g).length, 2);
  // "Um PDF por página": cada arquivo é montado à parte e leva a sua.
  const files = [0, 1].map(() => buildRaw([wordPage({ edits: [rubricEdit(RUBRIC, 'top-left', 60, size)] })]));
  assert.deepEqual(files.map((file) => latin1(file).match(/\/Subtype \/Form/g).length), [1, 1]);
});

test('prévia no canvas: a imagem ocupa a caixa (de pé no quadro); a rubrica, o desenho na escala da caixa', () => {
  const calls = [];
  const ctx = {
    canvas: { width: 300, height: 400 },
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {}, closePath() {},
    stroke() {}, fill() {}, setTransform() {}, fillRect(...args) { calls.push(['fillRect', ...args]); },
    scale(...args) { calls.push(['scale', ...args]); }, drawImage(...args) { calls.push(['drawImage', ...args]); },
  };
  const picture = { width: 8, height: 6 };
  storeImage('com-previa', { ...ALPHA, picture });
  editType('image').paint(ctx, image('com-previa'), { w: 120, h: 90 });
  assert.deepEqual(calls.pop(), ['drawImage', picture, 0, 0, 120, 90]);
  editType('image').paint(ctx, image('nao-existe'), { w: 10, h: 5 });
  assert.deepEqual(calls.pop(), ['fillRect', 0, 0, 10, 5], 'sem a imagem, um quadro cinza');
  editType('rubric').paint(ctx, { rubric: RUBRIC }, { w: RUBRIC.w / 2, h: RUBRIC.h / 2 });
  assert.deepEqual(calls.pop(), ['scale', 0.5, 0.5]);
});

test('imagem e rubrica com a proporção travada ao mudar o tamanho', () => {
  const edit = image('alfa', { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.2 });
  const resized = resizeEdit(edit, 2, 0.6, 0.25, 600 / 800);
  const ratio = (e) => ((e.x1 - e.x0) * 600) / ((e.y1 - e.y0) * 800);
  assert.ok(close(ratio(resized), ratio(edit), 1e-4));
});

// ---------- Tarja ----------

test('imagem sob a tarja: onde cortar, na imagem de pé, nos quatro giros', () => {
  const box = { x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.4 };
  const rect = { x0: 0, y0: 0, x1: 0.3, y1: 0.3 }; // pega o canto de cima à esquerda da caixa: 1/4 da largura, metade da altura
  assert.deepEqual(imageCuts(image('alfa', box), [rect]), [[0, 0, 0.25, 0.5]]);
  assert.deepEqual(imageCuts(image('alfa', box), [{ x0: 0.7, y0: 0, x1: 1, y1: 1 }]), [], 'tarja longe da imagem');
  // Girada 90° (no sentido horário), o canto de cima à esquerda da caixa é o de baixo à esquerda da imagem de pé.
  assert.deepEqual(imageCuts(image('alfa', box, { turn: 90 }), [rect]), [[0, 0.75, 0.5, 1]]);
  assert.deepEqual(imageCuts(image('alfa', box, { turn: 180 }), [rect]), [[0.75, 0.5, 1, 1]]);
  assert.deepEqual(imageCuts(image('alfa', box, { turn: 270 }), [rect]), [[0.5, 0, 1, 0.25]]);
  // A conta bate com a página girada: girar a página e as tarjas juntas dá o mesmo corte.
  const [turned] = rotateEdits([image('alfa', box)], 90);
  const [cover] = rotateEdits([{ type: 'rect', ...rect }], 90);
  assert.deepEqual(imageCuts(turned, [cover]), [[0, 0, 0.25, 0.5]]);
  assert.deepEqual(pixelCuts([[0, 0, 0.25, 0.5]], 8, 6), [[0, 0, 2, 3]]);
  assert.equal(cutKey('alfa', [[0, 0, 0.25, 0.5]]), 'alfa#0,0,0.25,0.5');
});

test('tarja: imagem inteira sob ela sai; em parte, só com a parte coberta apagada dos pixels (sem isso, nada sai)', async () => {
  // Foto na folha: a tarja cobre a imagem da foto inteira (de 0 a 1 nela), e a edição fica toda sobre a foto.
  const page = photoPage();
  const sheet = (x, y) => [(page.box.x + x * page.box.w) / page.width, (page.height - page.box.y - page.box.h + y * page.box.h) / page.height];
  const [x0, y0] = sheet(0, 0);
  const [x1, y1] = sheet(0.5, 1);
  const inside = image('alfa', { x0, y0, x1, y1 });
  const covered = { ...page, redactions: [{ x0: 0, y0: 0, x1: 1, y1: 1 }], edits: [inside] };
  assert.ok(!latin1(buildPdf([covered])).includes('/Width 8 /Height 6'), 'inteira sob a tarja: a imagem nem vai para o arquivo');
  const size = { width: page.width, height: page.height };
  assert.deepEqual(redactEdits([inside], [{ x0: 0, y0: 0, x1: 1, y1: 1 }], size), []);
  assert.deepEqual(redactEdits([inside], [{ x0: 0.9, y0: 0.9, x1: 1, y1: 1 }], size), [inside], 'tarja longe: a imagem fica como está');
  assert.throws(() => redactEdits([inside], [{ x0: 0, y0: 0, x1: 1, y1: y0 + (y1 - y0) / 2 }], size), /tarja/, 'pelo hook, com o tamanho da página');

  // A tarja pega metade da imagem (a de cima).
  const half = { ...page, redactions: [{ x0: 0, y0: 0, x1: 1, y1: 0.5 }], edits: [inside] };
  assert.throws(() => buildRaw([half]), /tarja/);
  const covers = [{ x0: 0, y0: 0, x1: 1, y1: (page.height - page.box.y - page.box.h + 0.5 * page.box.h) / page.height }];
  const cuts = imageCuts(inside, covers);
  assert.deepEqual(cuts, [[0, 0, 1, 0.5]]);
  storeImage(cutKey('alfa', cuts), await cutFlate(imageRecord('alfa'), cuts));
  const pdf = buildPdf([half]);
  const { list } = await drawnObjects(pdf);
  const color = samples(list[0].stream);
  const doc = await openPdf(pdf);
  const alpha = samples(doc.resolve(list[0].stream.dict.get('SMask')));
  const rgba = sample();
  for (let p = 0; p < 8 * 6; p++) {
    const top = p < 8 * 3;
    assert.deepEqual([...color.subarray(p * 3, p * 3 + 3)], top ? [0, 0, 0] : [...rgba.subarray(p * 4, p * 4 + 3)], `pixel ${p}`);
    assert.equal(alpha[p], top ? 255 : rgba[p * 4 + 3], `alfa ${p}`);
  }
  // A original continua na memória, para a prévia e para outro arquivo sem a tarja.
  assert.ok(imageRecord('alfa'));
});

test('limpar: keepImages tira só a imagem que nenhuma edição usa (e as versões tarjadas dela); forgetMedia tira tudo e avisa', () => {
  const preview = { width: 5, height: 5 };
  storeImage('sobra', { ...JPEG, picture: preview });
  storeImage('sobra#0,0,1,1', { ...JPEG, picture: preview });
  storeImage('usada', JPEG);
  keepImages([image('usada'), image('alfa'), image('cinza'), image('foto'), image('com-previa'), { type: 'rect' }]);
  assert.equal(imageRecord('sobra'), undefined);
  assert.equal(imageRecord('sobra#0,0,1,1'), undefined);
  assert.equal(preview.width, 0, 'a prévia devolve a memória');
  assert.ok(imageRecord('usada') && imageRecord('alfa'));
  let told = 0;
  onForget(() => told++);
  forgetMedia();
  assert.equal(imageRecord('usada'), undefined);
  assert.equal(imageRecord('alfa'), undefined);
  assert.equal(told, 1);
  assert.throws(() => buildRaw([wordPage({ edits: [image('alfa')] })]), /memória/, 'imagem que saiu da memória não vai para o PDF');
  // De volta, para os testes seguintes.
  storeImage('alfa', ALPHA);
  storeImage('cinza', GRAY);
  storeImage('foto', JPEG);
});

test('recursos da imagem: nomes de PDF válidos, só ASCII, e chave inválida recusada', () => {
  const res = resourceCollector();
  const ops = editsContent([image('alfa'), image('foto')], { box: [0, 0, 600, 800] }, res);
  assert.equal(res.xobjects.size, 2);
  assert.equal(res.objects.size, 1, 'só a máscara da imagem com transparência');
  assert.doesNotMatch(ops, /[^\n\x20-\x7e]/);
  assert.throws(() => storeImage('a b', JPEG), /inválida/);
  assert.throws(() => storeImage('x', { kind: 'jpeg', width: 0, height: 1, data: new Uint8Array() }), /incompleta/);
});

// ---------- Conferência ----------

test('qpdf --check: imagem e rubrica nos três tipos de página, giradas e com a página girada', async () => {
  const doc = await openPdf(rotatedPdf());
  const edits = [image('alfa'), image('cinza', { x0: 0.5, y0: 0.6, x1: 0.7, y1: 0.7 }), image('foto', { x0: 0.6, y0: 0.1, x1: 0.9, y1: 0.3 })];
  for (const turn of [0, 90, 180, 270]) {
    const list = [...rotateEdits(edits, turn), rubricEdit(RUBRIC, 'bottom-left', 70, { width: 595.28, height: 841.89 })];
    const copy = copyPages(doc, [0], { edits: new Map([[0, { edits: list, rotation: turn }]]) });
    buildPdf([photoPage({ edits: list }), wordPage({ edits: list, rotation: turn }), { copy: { source: copy, page: copy.pages.get(0) }, rotation: turn }]);
  }
});

test('veraPDF (perfil PDF/A-2B): imagem com transparência, JPEG, imagem cinza, imagem tarjada e rubrica', async (t) => {
  const verapdf = process.env.VERAPDF;
  if (!verapdf) {
    t.skip('VERAPDF não definido: a conferência com o veraPDF é pulada');
    return;
  }
  const page = photoPage();
  const size = { width: page.width, height: page.height };
  const rubric = (where) => rubricEdit(RUBRIC, 'bottom-right', RUBRIC_SIZES.medium.side, where);
  const tarjada = { ...page, redactions: [{ x0: 0, y0: 0, x1: 1, y1: 0.5 }], edits: [image('alfa', { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.4 }), rubric(size)] };
  const covers = [{ x0: 0, y0: 0, x1: 1, y1: (page.height - page.box.y - page.box.h / 2) / page.height }];
  const cuts = imageCuts(tarjada.edits[0], covers);
  if (cuts.length) storeImage(cutKey('alfa', cuts), await cutFlate(imageRecord('alfa'), cuts));
  const fonts = await embedFonts([wordPage()]); // o texto do Word vai com a fonte embutida, como no app
  const files = {
    'imagem-foto.pdf': buildPdf([{ ...page, edits: [image('alfa'), image('foto', { x0: 0.5, y0: 0.5, x1: 0.8, y1: 0.725 }), rubric(size)] }], { pdfa: true }),
    'imagem-word.pdf': buildPdf([wordPage({ edits: [...rotateEdits([image('cinza'), image('alfa', { x0: 0.5, y0: 0.5, x1: 0.8, y1: 0.725 })], 90), rubric({ width: 841.89, height: 595.28 })], rotation: 90 })], { pdfa: true, fonts }),
    'imagem-tarjada.pdf': buildPdf([tarjada], { pdfa: true }),
    'rubrica-varias.pdf': buildPdf([{ ...page, edits: [rubric(size)] }, wordPage({ edits: [rubric({ width: 595.28, height: 841.89 })] })], { pdfa: true, fonts }),
  };
  const dir = mkdtempSync(join(tmpdir(), 'verapdf-'));
  try {
    for (const [name, bytes] of Object.entries(files)) {
      writeFileSync(join(dir, name), bytes);
      const windows = /\.bat$/i.test(verapdf);
      const result = spawnSync(windows ? 'cmd.exe' : verapdf, [...(windows ? ['/c', verapdf] : []), '--flavour', '2b', '--format', 'xml', join(dir, name)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const failed = [...result.stdout.matchAll(/clause="([^"]+)" testNumber="(\d+)" status="failed"/g)].map((m) => `${m[1]}-${m[2]}`);
      assert.match(result.stdout, /isCompliant="true"/, `${name}: ${failed.join(', ') || result.stderr.slice(0, 300)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
