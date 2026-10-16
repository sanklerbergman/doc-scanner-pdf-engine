// Carimbo visível da assinatura (stamp.js): texto, tamanho, lugar na página (com /Rotate e CropBox) e o campo no
// PDF assinado. Só certificados de TESTE (test/fixtures/certificados).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stampLayout, placeStamp, buildStamp, stampPageIndex, STAMP_POSITIONS } from '../web/js/stamp.js';
import { buildPdfToSign, layoutPage } from '../web/js/pdf.js';
import { openPdf, copyPages, PdfStream } from '../web/js/pdf-reader.js';
import { openCertificate, SignError } from '../web/js/sign.js';
import { textWidth } from '../web/js/fonts.js';
import { samplePdfs } from './helpers/pdf.js';
import { qpdfCheck } from './helpers/qpdf.js';

const TIME = new Date(2026, 9, 16, 14, 32, 5);
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

// ---------- Texto e tamanho ----------

test('texto do carimbo: nome, data e hora com o fuso do aparelho', () => {
  const { lines, width, height } = stampLayout('PESSOA DE TESTE', TIME, 595);
  assert.deepEqual(lines.map(({ text }) => text).slice(0, 2), ['Assinado digitalmente por', 'PESSOA DE TESTE']);
  assert.match(lines[2].text, /^em 16\/10\/2026 às 14:32 \(UTC([+-]\d{1,2}(:\d\d)?)?\)$/);
  assert.equal(lines[1].font, 'Helvetica-Bold');
  assert.equal(width, 150);
  assert.ok(height > 30 && height < 50, `altura ${height}`);
});

test('nome comprido: a letra diminui e, no limite, o nome é cortado com reticências', () => {
  const long = 'MARIA APARECIDA DOS SANTOS OLIVEIRA DE SOUZA PEREIRA DA SILVA';
  const wide = stampLayout(long, TIME, 595);
  assert.equal(wide.width, 260);
  assert.equal(wide.lines[1].text, long);
  assert.ok(wide.lines[1].size < 9 && wide.lines[1].size >= 5);
  // Página estreita: a caixa encolhe até caber com a margem, e o nome é cortado.
  const narrow = stampLayout(long.repeat(3), TIME, 200);
  assert.ok(narrow.width <= 200 - 48, `largura ${narrow.width}`);
  assert.ok(narrow.lines[1].text.endsWith('…'));
  for (const line of narrow.lines) assert.ok(textWidth(line.text, line.font, line.size) <= narrow.width - 12, line.text);
});

test('caractere que as fontes padrão não têm vira "?", e caractere de controle sai', () => {
  assert.equal(stampLayout('JOÃO 李\u0007 ÇÃ', TIME, 595).lines[1].text, 'JOÃO ? ÇÃ');
  assert.equal(stampLayout('  ', TIME, 595).lines[1].text, '?');
});

test('página do carimbo: primeira, última ou o número, sempre dentro do arquivo', () => {
  assert.equal(stampPageIndex('first', 5), 0);
  assert.equal(stampPageIndex('last', 5), 4);
  assert.equal(stampPageIndex(undefined, 5), 4);
  assert.equal(stampPageIndex(3, 5), 2);
  assert.equal(stampPageIndex(9, 5), 4);
  assert.equal(stampPageIndex(0, 5), 0);
});

// ---------- Lugar na página ----------

test('lugar do carimbo numa página sem giro: 24 pontos da borda, ou centrado', () => {
  const size = { width: 150, height: 40 };
  const at = (position) => placeStamp({ box: [0, 0, 595, 842], rotate: 0 }, position, size).rect;
  assert.deepEqual(at('top-left'), [24, 778, 174, 818]);
  assert.deepEqual(at('top-center'), [222.5, 778, 372.5, 818]);
  assert.deepEqual(at('top-right'), [421, 778, 571, 818]);
  assert.deepEqual(at('bottom-left'), [24, 24, 174, 64]);
  assert.deepEqual(at('bottom-center'), [222.5, 24, 372.5, 64]);
  assert.deepEqual(at('bottom-right'), [421, 24, 571, 64]);
  // Página menor que o carimbo mais a margem: a margem diminui, e o carimbo não sai da página.
  assert.deepEqual(placeStamp({ box: [0, 0, 160, 50], rotate: 0 }, 'top-left', size).rect, [5, 5, 155, 45]);
});

// Da coordenada do PDF para a página como aparece (origem em cima à esquerda), em cada giro.
const VISIBLE = {
  0: ([x1, , , y2], [x, y]) => [x - x1, y2 - y],
  90: ([x1, y1], [x, y]) => [y - y1, x - x1],
  180: ([, y1, x2], [x, y]) => [x2 - x, y - y1],
  270: ([, , x2, y2], [x, y]) => [y2 - y, x2 - x],
};

test('com /Rotate e CropBox deslocada: o carimbo fica no lugar visível escolhido e de pé', () => {
  const box = [50, 60, 550, 760];
  const size = { width: 150, height: 40 };
  for (const rotate of [0, 90, 180, 270]) {
    const toVisible = (point) => VISIBLE[rotate](box, point);
    for (const position of Object.keys(STAMP_POSITIONS)) {
      const { rect, matrix, visible } = placeStamp({ box, rotate }, position, size);
      // O retângulo do campo, visto na página girada, é a caixa escolhida.
      const corners = [[rect[0], rect[1]], [rect[2], rect[3]]].map(toVisible);
      const u = Math.min(corners[0][0], corners[1][0]);
      const v = Math.min(corners[0][1], corners[1][1]);
      assert.deepEqual([u, v, Math.abs(corners[0][0] - corners[1][0]), Math.abs(corners[0][1] - corners[1][1])],
        [visible.x, visible.y, size.width, size.height], `${rotate}°, ${position}`);
      const [pageW, pageH] = rotate % 180 ? [700, 500] : [500, 700];
      const [row, column] = position.split('-');
      assert.equal(v, row === 'top' ? 24 : pageH - 24 - 40, `${rotate}°, ${position}: altura`);
      assert.equal(u, { left: 24, center: (pageW - 150) / 2, right: pageW - 24 - 150 }[column], `${rotate}°, ${position}: lado`);
      // De pé: o eixo x da aparência aponta para a direita da página girada, e o eixo y para cima.
      const direction = ([dx, dy]) => {
        const [a, b] = toVisible([box[0] + dx, box[1] + dy]);
        const [c, d] = toVisible([box[0], box[1]]);
        return [a - c, b - d];
      };
      assert.deepEqual(direction([matrix[0], matrix[1]]).map((n) => n + 0), [1, 0], `${rotate}°: eixo x`);
      assert.deepEqual(direction([matrix[2], matrix[3]]).map((n) => n + 0), [0, -1], `${rotate}°: eixo y`);
    }
  }
});

test('aparência: formulário só com ASCII, texto em hexadecimal e /Length certo', () => {
  const { rect, appearance } = buildStamp({ name: 'JOSÉ (TESTE) \\ ÇÃO', time: TIME, position: 'bottom-right' }, { box: [0, 0, 595, 842], rotate: 90 });
  assert.equal(rect.length, 4);
  assert.match(appearance, /^<< \/Type \/XObject \/Subtype \/Form \/BBox \[0 0 [\d.]+ [\d.]+\] \/Matrix \[0 1 -1 0 0 0\]/);
  assert.ok(/^[\x20-\x7e\n]*$/.test(appearance), 'só ASCII');
  assert.doesNotMatch(appearance, /JOS|\(TESTE\)/, 'o nome não entra como texto literal');
  const [, length, content] = appearance.match(/\/Length (\d+) >>\nstream\n([\s\S]*)\nendstream$/);
  assert.equal(content.length, Number(length));
  assert.match(content, /\/F2 [\d.]+ Tf .* <4a4f53c9202854455354452920[0-9a-f]+> Tj/);
});

// ---------- No PDF assinado ----------

test('PDF montado pelo app: o carimbo fica no campo da página escolhida, com a aparência', async () => {
  const sample = await openPdf(samplePdfs().arvore); // página girada 90° e com CropBox deslocada
  const copy = copyPages(sample, [0]);
  const pages = [
    { jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(40, 30, 'a4', 18) },
    { width: 595.28, height: 841.89, rotation: 270, items: [{ type: 'text', x: 72, y: 100, text: 'Contrato', font: 'Helvetica', size: 12 }] },
    { copy: { source: copy, page: copy.pages.get(0) }, rotation: 90 },
  ];
  for (const [page, index] of [['first', 0], [2, 1], ['last', 2]]) {
    const { bytes } = buildPdfToSign(pages, { reserve: 64, time: TIME, stamp: { name: 'PESSOA DE TESTE', position: 'top-right', page } });
    qpdfCheck(bytes);
    const doc = await openPdf(bytes);
    const withAnnots = doc.pages.map((p) => (p.node.get('Annots') ? 1 : 0));
    assert.deepEqual(withAnnots, [0, 1, 2].map((i) => (i === index ? 1 : 0)), `página ${page}`);
    const widget = doc.resolve(doc.resolve(doc.pages[index].node.get('Annots'))[0]);
    const [x1, y1, x2, y2] = doc.resolve(widget.get('Rect'));
    assert.ok(x2 - x1 > 30 && y2 - y1 > 30, 'campo visível');
    const crop = doc.pages[index].crop ?? doc.pages[index].media;
    assert.ok(x1 >= crop[0] && y1 >= crop[1] && x2 <= crop[2] && y2 <= crop[3], 'dentro da área visível');
    assert.ok(doc.resolve(doc.resolve(widget.get('AP')).get('N')) instanceof PdfStream);
    assert.equal(doc.isSigned(), true);
  }
});

test('carimbo e PDF/A não se combinam (o PDF/A exige fonte embutida no texto visível)', async () => {
  const pages = [{ jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(40, 30, 'a4', 18) }];
  assert.throws(() => buildPdfToSign(pages, { reserve: 64, time: TIME, pdfa: true, stamp: { name: 'X', position: 'top-left', page: 'last' } }), /PDF\/A/);
  const signer = await openCertificate(fixture('certificados/titular-aes.pfx'), 'senha-de-teste');
  await assert.rejects(signer.sign(pages, TIME, { pdfa: true, stamp: { position: 'top-left', page: 'last' } }), (err) => err instanceof SignError && /PDF\/A/.test(err.message));
  // Sem carimbo, o campo continua invisível na primeira página, como antes.
  const plain = new TextDecoder('latin1').decode(buildPdfToSign(pages, { reserve: 64, time: TIME }).bytes);
  assert.match(plain, /\/Rect \[0 0 0 0\] \/P 3 0 R \/V \d+ 0 R >>/);
  assert.doesNotMatch(plain, /\/AP /);
  signer.discard();
});
