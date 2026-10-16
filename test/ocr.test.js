import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { layoutPage } from '../web/js/pdf.js';
import { textWidth } from '../web/js/fonts.js';
import { readWords } from '../web/js/ocr.js';
import { openPdf, copyPages } from '../web/js/pdf-reader.js';
import { buildPdf } from './helpers/qpdf.js';
import { makeRawPdf, textPageObjects } from './helpers/pdf.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Resultado de OCR simulado (palavras e caixas fixas), no formato que o readWords devolve.
const WORDS = [
  { text: 'Contrato', x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.14, baseline: 0.135, size: 0.04, last: false, confidence: 95 },
  { text: '(nº', x0: 0.32, y0: 0.1, x1: 0.4, y1: 0.14, baseline: 0.135, size: 0.04, last: false, confidence: 90 },
  { text: String.raw`1\2)`, x0: 0.42, y0: 0.1, x1: 0.5, y1: 0.14, baseline: 0.135, size: 0.04, last: true, confidence: 90 },
  { text: 'Ação – Ω', x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.24, baseline: 0.235, size: 0.04, last: true, confidence: 60 },
];

const photo = (width, height, size = 'a4', margin = 18) => ({ jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(width, height, size, margin) });

// Trecho da camada do OCR no conteúdo da página: do "BT" com "3 Tr" até o "ET".
function ocrBlock(text) {
  const match = text.match(/BT\n3 Tr\n[\s\S]*?\nET/);
  assert.ok(match, 'camada do OCR não encontrada');
  return match[0];
}

// Posições (Tm) de cada palavra da camada.
const positions = (block) => [...block.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g)].map((m) => [Number(m[1]), Number(m[2])]);

test('PDF sem OCR e sem assinatura continua idêntico byte a byte (texto, foto e página copiada)', async () => {
  const doc = await openPdf(makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Copiada'),
  }).bytes);
  const copy = copyPages(doc, [0]);
  const pages = (ocr) => [
    {
      width: 595.28, height: 841.89, rotation: 90, items: [
        { type: 'text', x: 72, y: 100, text: String.raw`Texto (ç) \ fim`, font: 'Helvetica', size: 12 },
        { type: 'image', jpeg: fixture('rgb-40x30.jpg'), x: 72, y: 120, w: 40, h: 30 },
      ],
    },
    { jpeg: fixture('gray-16x24.jpg'), ...layoutPage(16, 24, 'a4', 18), ...ocr },
    { copy: { source: copy, page: copy.pages.get(0) }, rotation: 180 },
  ];
  // Valor gravado com o gerador da v2.1.1, antes do OCR e da assinatura.
  const before = buildPdf(pages({}));
  assert.equal(before.length, 3030);
  assert.equal(sha256(before), '9d89abdf7c32466c4078bce469f99e82e55d0492a0cfd3acbc738d0e0a4099c3');
  assert.equal(sha256(buildPdf(pages({ ocr: [] }))), sha256(before), 'OCR sem palavras não muda nada');
});

test('camada do OCR: texto invisível (3 Tr), Helvetica com WinAnsi e texto em hexadecimal', async () => {
  const pdf = buildPdf([{ ...photo(40, 30), ocr: WORDS }]);
  const text = latin1(pdf);
  const block = ocrBlock(text);
  assert.match(text, /\/Resources << \/XObject << \/Im0 5 0 R >> \/Font << \/F1 6 0 R >> >>/);
  assert.match(text, /6 0 obj\n<< \/Type \/Font \/Subtype \/Type1 \/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding >>/);
  assert.ok(text.indexOf('/Im0 Do Q') < text.indexOf('BT\n3 Tr'), 'o texto vai depois da imagem');
  // "Contrato " (com o espaço até a próxima palavra), "(nº ", "1\2)", e na outra linha "Ação – ?".
  assert.ok(block.includes('<436f6e747261746f20> Tj'));
  assert.ok(block.includes('<286eba20> Tj'), '"(" e "º" em hexadecimal');
  assert.ok(block.includes('<315c3229> Tj'), '"\\" e ")" em hexadecimal, sem espaço depois da última palavra da linha');
  assert.ok(block.includes('<41e7e36f2096203f> Tj'), 'ç, ã e travessão na WinAnsi; Ω vira "?"');
  assert.doesNotMatch(block, /\(|\)\s*Tj/, 'nenhuma string literal na camada do OCR');

  // O PDF abre no próprio leitor do app, com o conteúdo inteiro.
  const doc = await openPdf(pdf);
  assert.equal(doc.pages.length, 1);
});

test('camada do OCR: cada palavra na posição em que aparece na imagem, com a largura ajustada (Tz)', () => {
  const page = photo(40, 30); // imagem deitada: página A4 deitada
  const { box } = page;
  const block = ocrBlock(latin1(buildPdf([{ ...page, ocr: WORDS }])));
  const [first] = positions(block);
  assert.ok(Math.abs(first[0] - (box.x + 0.1 * box.w)) < 0.01);
  assert.ok(Math.abs(first[1] - (box.y + (1 - 0.135) * box.h)) < 0.01, 'linha de base medida de baixo');
  const size = 0.04 * box.h;
  assert.ok(block.includes(`/F1 ${Math.round(size * 100) / 100} Tf`), 'tamanho da letra = altura da linha');
  // "Contrato " vai do começo da palavra até o começo da próxima.
  const scale = (100 * (0.32 - 0.1) * box.w) / textWidth('Contrato ', 'Helvetica', size);
  assert.ok(block.includes(`${Math.round(scale * 100) / 100} Tz`));
});

test('camada do OCR: posições dentro da página, em pé, deitada, sem margem e no tamanho da imagem', () => {
  for (const page of [photo(30, 40), photo(40, 30), photo(30, 40, 'letter', 0), photo(40, 30, 'fit', 36)]) {
    const block = ocrBlock(latin1(buildPdf([{ ...page, ocr: [...WORDS, { ...WORDS[0], x0: -0.2, x1: 1.3, baseline: 1.2, last: true }] }])));
    for (const [x, y] of positions(block)) {
      // Tolerância do arredondamento dos números do PDF (duas casas).
      assert.ok(x >= page.box.x - 0.01 && x <= page.box.x + page.box.w + 0.01, `x = ${x}`);
      assert.ok(y >= page.box.y - 0.01 && y <= page.box.y + page.box.h + 0.01, `y = ${y}`);
      assert.ok(x >= 0 && x <= page.width && y >= 0 && y <= page.height);
    }
  }
});

test('camada do OCR junto com página do Word: a Helvetica é gravada uma vez só', () => {
  const text = latin1(buildPdf([
    { width: 595.28, height: 841.89, items: [{ type: 'text', x: 72, y: 100, text: 'Word', font: 'Helvetica', size: 12 }] },
    { ...photo(30, 40), ocr: WORDS },
    { ...photo(30, 40), ocr: WORDS.slice(0, 1) },
  ]));
  assert.equal(text.match(/\/BaseFont \/Helvetica /g).length, 1);
  assert.equal(text.match(/BT\n3 Tr/g).length, 2);
});

test('readWords: palavras do Tesseract em medidas relativas à imagem, com a linha de base de cada palavra', () => {
  const line = (words, extra = {}) => ({
    bbox: { x0: 100, y0: 200, x1: 900, y1: 260 },
    baseline: { x0: 100, y0: 250, x1: 900, y1: 258, has_baseline: true },
    rowAttributes: { row_height: 50, descenders: 10, ascenders: 12 },
    words,
    ...extra,
  });
  const word = (text, x0, x1, confidence = 90) => ({ text, confidence, bbox: { x0, y0: 210, x1, y1: 255 } });
  const blocks = [{
    paragraphs: [{
      lines: [
        line([word('Nome:', 100, 300), word('  ', 310, 320), word('Fulano', 500, 900, 40)]),
        line([word('sem', 100, 200)], { baseline: { has_baseline: false }, bbox: { x0: 100, y0: 300, x1: 200, y1: 340 } }),
        line([word('caixa ruim', 50, 40)]),
      ],
    }],
  }];
  const words = readWords(blocks, 1000, 2000);
  assert.deepEqual(words.map((w) => w.text), ['Nome:', 'Fulano', 'sem']);
  assert.deepEqual(words.map((w) => w.last), [false, true, true]);
  assert.equal(words[0].x0, 0.1);
  assert.equal(words[0].size, 50 / 2000);
  // Linha de base inclinada: no meio de "Fulano" (x = 700) ela está em 250 + 8 × 600/800 = 256.
  assert.ok(Math.abs(words[1].baseline - 256 / 2000) < 1e-9);
  assert.equal(words[1].confidence, 40);
  // Sem linha de base: a parte de baixo da palavra menos os descendentes.
  assert.ok(Math.abs(words[2].baseline - (255 - 10) / 2000) < 1e-9);
  assert.deepEqual(readWords(null, 10, 10), []);
});
