import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { layoutPage } from '../web/js/pdf.js';
import { textWidth } from '../web/js/fonts.js';
import { readWords, ocrQuality, lowConfidence } from '../web/js/ocr.js';
import { openPdf, copyPages } from '../web/js/pdf-reader.js';
import { unskew, unskewRect } from '../web/js/geometry.js';
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

test('readWords: ruído de borda e sombra (só sinais, nota baixa) sai; palavra com letra ou dígito fica, mesmo com nota 0', () => {
  const box = (x0) => ({ x0, y0: 210, x1: x0 + 40, y1: 255 });
  const line = (words, y0 = 200) => ({ bbox: { x0: 0, y0, x1: 1000, y1: y0 + 60 }, rowAttributes: { row_height: 50 }, words });
  const words = (list) => list.map(([text, confidence], i) => ({ text, confidence, bbox: box(i * 50) }));
  const blocks = [{
    paragraphs: [{
      lines: [
        // Dados que a busca (Ctrl+F) e a busca de CPF e CNPJ precisam, com as notas baixas que o Tesseract deu a
        // palavras certas nas medições (o CPF partido em dois, com nota 0, no documento nítido com o filtro Documento).
        line(words([['CPF', 12], ['123.456', 0], ['.789-09,', 0], ['R$', 0], ['1.500,00', 3], ['nº', 5], ['12.345.678/0001-95', 8]])),
        // Sinais que valem como palavra ficam com qualquer nota; travessão com nota boa também.
        line(words([['§', 20], ['1º', 40], ['Silva', 90], ['&', 30], ['Filhos', 90], ['10', 90], ['%', 10], ['—', 92], ['fim', 90]])),
        // Lixo de borda, risco e sombra: sai. A última palavra da linha passa a ser "texto".
        line(words([['|', 40], ['texto', 95], ['==', 9], [':', 0], ['«', 42], ['....', 30]])),
        // Linha só de lixo: some inteira.
        line(words([['|||', 12], ['—', 0], ['~', 33]])),
        // Sinal com nota boa fica (o filtro é só para o que o Tesseract mesmo duvida).
        line(words([['—', 50], ['|', 81]])),
      ],
    }],
  }];
  const out = readWords(blocks, 1000, 2000);
  assert.deepEqual(out.map((w) => w.text), [
    'CPF', '123.456', '.789-09,', 'R$', '1.500,00', 'nº', '12.345.678/0001-95',
    '§', '1º', 'Silva', '&', 'Filhos', '10', '%', '—', 'fim',
    'texto',
    '—', '|',
  ]);
  assert.deepEqual(out.filter((w) => w.last).map((w) => w.text), ['12.345.678/0001-95', 'fim', 'texto', '|']);
});

// Página simulada no formato do readWords: [texto, nota] de cada palavra.
const scored = (list) => list.map(([text, confidence]) => ({ ...WORDS[0], text, confidence }));

test('ocrQuality: média das notas ponderada pelos caracteres e fração do texto em palavras fracas (nota < 70)', () => {
  // "Contrato" (8 caracteres) com 90 e "nº" (2) com 40: (8 × 90 + 2 × 40) / 10 = 80; 2 de 10 caracteres fracos.
  assert.deepEqual(ocrQuality(scored([['Contrato', 90], ['nº', 40]])), { mean: 80, weak: 0.2 });
  // Letra acentuada conta como um caractere; nota 70 já não é fraca.
  assert.deepEqual(ocrQuality(scored([['Ação', 70], ['é', 0]])), { mean: 56, weak: 0.2 });
  assert.deepEqual(ocrQuality([]), { mean: 100, weak: 0 });
});

test('lowConfidence: documento nítido e foto mediana não avisam; desfocado, tudo duvidoso ou um trecho ruim avisam', () => {
  const same = (count, confidence) => Array.from({ length: count }, () => ['palavra', confidence]);
  // Documento nítido como o medido: quase tudo com 96, ordinais e travessões um pouco abaixo, o "@" lido como "Q"
  // e a assinatura lida como lixo com nota baixa.
  assert.equal(lowConfidence(scored([...same(40, 96), ['1º', 93], ['—', 92], ['contatoQexemplo.com.br', 84], ['NNVVVVVUVVV', 27]])), false);
  // Foto mediana (desfoque leve, JPEG ruim): média 85,2 e 10% do texto fraco.
  assert.equal(lowConfidence(scored([...same(36, 88), ...same(4, 60)])), false);
  // Tudo meio duvidoso (das palavras com nota de 70 a 79, só metade estava certa): média 75, abaixo de 82.
  assert.deepEqual(ocrQuality(scored(same(40, 75))), { mean: 75, weak: 0 });
  assert.equal(lowConfidence(scored(same(40, 75))), true);
  // Um quarto do texto fraco numa página boa: a média fica em 88,25, mas a fração fraca (25%) passa de 20%.
  assert.deepEqual(ocrQuality(scored([...same(30, 96), ...same(10, 65)])), { mean: 88.25, weak: 0.25 });
  assert.equal(lowConfidence(scored([...same(30, 96), ...same(10, 65)])), true);
  // Desfocado de 4 px (palavras e notas da medição): quase tudo com nota baixa.
  assert.equal(lowConfidence(scored([['CONTRATO', 95], ['Cornvduate', 14], ['Mara', 75], ['Agarecita', 0], ['Concesção', 5]])), true);
  // Sem palavras: nada para avisar (a mensagem já diz que não achou texto).
  assert.equal(lowConfidence([]), false);
});

// ---------- Página torta ----------

// Linha "ALFA BRAVO" como o Tesseract do app devolveu numa imagem de 1200 × 1600 desenhada girada 5° no sentido
// horário, lida com rotateAuto: ele endireitou a imagem (rotateRadians −0,0876) e mediu nela.
const TILT = -0.0875513032078743;
const tiltedBlocks = () => [{
  paragraphs: [{
    lines: [{
      bbox: { x0: 100, y0: 156, x1: 1000, y1: 201 },
      baseline: { x0: 100, y0: 200, x1: 1000, y1: 200, has_baseline: true },
      rowAttributes: { row_height: 44, descenders: 1, ascenders: 0 },
      words: [
        { text: 'ALFA', confidence: 96, bbox: { x0: 100, y0: 157, x1: 246, y1: 200 } },
        { text: 'BRAVO', confidence: 96, bbox: { x0: 804, y0: 156, x1: 1000, y1: 201 } },
      ],
    }],
  }],
}];

test('readWords na página torta: caixa que envolve a palavra na imagem torta e as medidas da imagem endireitada', () => {
  const straight = readWords(tiltedBlocks(), 1200, 1600);
  assert.deepEqual(straight.map((w) => [w.angle, w.straight]), [[0, undefined], [0, undefined]], 'página reta: sem giro');
  const words = readWords(tiltedBlocks(), 1200, 1600, TILT);
  assert.deepEqual(words.map((w) => w.text), ['ALFA', 'BRAVO']);
  words.forEach((word, i) => {
    assert.equal(word.angle, TILT);
    const { x0, y0, x1, y1, baseline } = straight[i];
    assert.deepEqual(word.straight, { x0, y0, x1, y1, baseline });
    assert.deepEqual([word.size, word.last, word.confidence], [straight[i].size, straight[i].last, straight[i].confidence]);
  });
  // Onde "ALFA" foi desenhada (100 a 247 × 157 a 200, girada 5° em volta do centro): a caixa envolve os quatro cantos.
  const a = (5 * Math.PI) / 180;
  for (const [x, y] of [[100, 157], [247, 157], [247, 200], [100, 200]]) {
    const u = 600 + (x - 600) * Math.cos(a) - (y - 800) * Math.sin(a);
    const v = 800 + (x - 600) * Math.sin(a) + (y - 800) * Math.cos(a);
    const [alfa] = words;
    assert.ok(u >= alfa.x0 * 1200 - 2 && u <= alfa.x1 * 1200 + 2 && v >= alfa.y0 * 1600 - 2 && v <= alfa.y1 * 1600 + 2, `${u} ${v}`);
  }
  // O começo da linha de base (de onde a camada escreve) volta para o ponto em que a palavra começa na imagem torta.
  const [u, v] = unskew(words[0].straight.x0 * 1200, words[0].straight.baseline * 1600, TILT, 1200, 1600);
  assert.ok(Math.abs(u - (600 - 500 * Math.cos(a) + 600 * Math.sin(a))) < 0.5);
  assert.ok(Math.abs(v - (800 - 500 * Math.sin(a) - 600 * Math.cos(a))) < 0.5);
  // A caixa da palavra torta é maior que a da palavra reta (envolve a palavra girada).
  assert.ok(words[1].y1 - words[1].y0 > straight[1].y1 - straight[1].y0 + 0.01);
});

// Palavras da primeira linha de WORDS numa página torta: as mesmas medidas, agora na imagem endireitada.
const tiltWords = (list, angle, size) => list.map((word) => ({
  ...word, ...unskewRect(word, angle, size), angle, straight: { x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1, baseline: word.baseline },
}));

test('camada do OCR na página torta: o texto vai inclinado como a linha, a partir do começo da palavra torta', () => {
  const page = photo(40, 30);
  const { box } = page;
  const words = tiltWords(WORDS.slice(0, 3), 0.1, { width: box.w, height: box.h });
  const block = ocrBlock(latin1(buildPdf([{ ...page, ocr: words }])));
  // Matriz girada 0,1 rad (cos 0,995, sen 0,0998) e o começo da linha de base levado para a imagem torta.
  const [u, v] = unskew(0.1 * box.w, 0.135 * box.h, 0.1, box.w, box.h);
  const at = (n) => String(Math.round(n * 100) / 100);
  assert.ok(block.includes(`0.995 0.0998 -0.0998 0.995 ${at(box.x + u)} ${at(box.y + box.h - v)} Tm <436f6e747261746f20> Tj`), block);
  // A largura ao longo da linha é a da imagem endireitada: o mesmo Tz da página reta.
  const scale = (100 * (0.32 - 0.1) * box.w) / textWidth('Contrato ', 'Helvetica', 0.04 * box.h);
  assert.ok(block.includes(`${Math.round(scale * 100) / 100} Tz`));
  assert.equal(block.match(/0\.995 0\.0998 -0\.0998 0\.995 [\d.]+ [\d.]+ Tm/g).length, 3);
  for (const [, x, y] of block.matchAll(/0\.995 0\.0998 -0\.0998 0\.995 ([\d.]+) ([\d.]+) Tm/g)) {
    assert.ok(x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h, `${x} ${y} dentro da imagem`);
  }
  // Ângulo 0 (página reta) sai byte a byte igual a antes.
  const plain = WORDS.map((word) => ({ ...word, angle: 0 }));
  assert.deepEqual(buildPdf([{ ...page, ocr: plain }]), buildPdf([{ ...page, ocr: WORDS }]));
});

// ---------- PDF escaneado ----------

// Duas páginas com os mesmos recursos (objeto 6): a primeira girada 90° e com a CropBox deslocada. A fonte /OCR já
// existe nos recursos, então a camada usa outro nome.
const scannedPdf = () => openPdf(makeRawPdf({
  1: '<< /Type /Catalog /Pages 2 0 R >>',
  2: '<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>',
  3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /CropBox [50 60 550 760] /Rotate 90 /Resources 6 0 R /Contents 4 0 R >>',
  4: { data: 'q 500 0 0 700 50 60 cm /Im0 Do Q', deflate: true },
  5: { dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', data: 'x' },
  6: '<< /XObject << /Im0 5 0 R >> /Font << /OCR 8 0 R >> >>',
  7: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources 6 0 R /Contents 4 0 R >>',
  8: '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
}).bytes);

test('PDF escaneado: a camada entra só na página lida, com recursos próprios e o conteúdo original intacto', async () => {
  const doc = await scannedPdf();
  const copy = copyPages(doc, [0, 1], { ocr: new Map([[0, { words: WORDS, rotation: 0 }]]) });
  const pdf = buildPdf([0, 1].map((i) => ({ copy: { source: copy, page: copy.pages.get(i) } })));
  const again = await openPdf(pdf);
  const fonts = (i) => again.resolve(again.resolve(again.pages[i].attrs.Resources).get('Font'));
  // A página lida ganhou a Helvetica com outro nome; a outra continua com os recursos de antes.
  assert.deepEqual([...fonts(0).keys()], ['OCR', 'OCR1']);
  assert.equal(again.resolve(fonts(0).get('OCR1')).get('BaseFont').value, 'Helvetica');
  assert.equal(again.resolve(fonts(0).get('OCR1')).get('Encoding').value, 'WinAnsiEncoding');
  assert.deepEqual([...fonts(1).keys()], ['OCR']);
  // Conteúdo: o original entre q e Q, e a camada invisível depois.
  const contents = again.resolve(again.pages[0].node.get('Contents'));
  assert.equal(contents.length, 3);
  assert.equal(latin1(again.resolve(contents[0]).data), 'q');
  const layer = latin1(again.resolve(contents[2]).data);
  assert.match(layer, /^Q\nBT\n3 Tr\n\/OCR1 20 Tf/, 'altura da linha: 4% dos 500 pontos visíveis');
  assert.equal(again.resolve(again.pages[1].node.get('Contents')) instanceof Array, false, 'a outra página não muda');
});

test('PDF escaneado com /Rotate: o texto fica de pé e em cima da palavra, na página como ela aparece', async () => {
  const doc = await scannedPdf();
  const copy = copyPages(doc, [0], { ocr: new Map([[0, { words: WORDS, rotation: 0 }]]) });
  const layer = latin1(buildPdf([{ copy: { source: copy, page: copy.pages.get(0) } }]));
  // Página visível de 700 × 500 (girada): "Contrato" em 10% da largura e linha de base em 13,5% da altura.
  // Na página girada 90°, x do PDF = 50 + 0,135 × 500 e y = 60 + 0,1 × 700; a matriz deixa o texto de pé.
  assert.ok(layer.includes('0 1 -1 0 117.5 130 Tm <436f6e747261746f20> Tj'), layer.match(/BT\n3 Tr[\s\S]*?ET/)?.[0]);
  for (const [, x, y] of layer.matchAll(/0 1 -1 0 (-?[\d.]+) (-?[\d.]+) Tm/g)) {
    assert.ok(x >= 50 && x <= 550 && y >= 60 && y <= 760, `${x} ${y} dentro da área visível`);
  }
});

test('PDF escaneado girado no app: o texto vai com o giro total (o do PDF mais o do app), lido de pé', async () => {
  const doc = await scannedPdf();
  // A pessoa girou mais 90° no app: a página aparece com 180°, de 500 × 700, e o OCR leu assim.
  const copy = copyPages(doc, [0], { ocr: new Map([[0, { words: WORDS, rotation: 90 }]]) });
  const layer = latin1(buildPdf([{ copy: { source: copy, page: copy.pages.get(0) }, rotation: 90 }]));
  assert.match(layer, /\/Rotate 180/);
  // 180°: x do PDF = 550 − 0,1 × 500 e y = 60 + 0,135 × 700; a matriz vira o texto de cabeça para baixo no PDF.
  assert.ok(layer.includes('-1 0 0 -1 500 154.5 Tm <436f6e747261746f20> Tj'), layer.match(/BT\n3 Tr[\s\S]*?ET/)?.[0]);
  assert.match(layer, /\/OCR1 28 Tf/, 'altura da linha: 4% dos 700 pontos visíveis');
});

test('PDF escaneado torto e com /Rotate: a inclinação da linha vai junto com a matriz que deixa o texto de pé', async () => {
  const doc = await scannedPdf();
  // Página visível de 700 × 500 (girada 90°), lida torta: 0,1 rad.
  const words = tiltWords(WORDS.slice(0, 3), 0.1, { width: 700, height: 500 });
  const copy = copyPages(doc, [0], { ocr: new Map([[0, { words, rotation: 0 }]]) });
  const layer = latin1(buildPdf([{ copy: { source: copy, page: copy.pages.get(0) } }]));
  // Inclinação (cos 0,995, sen 0,0998) e depois o giro de 90° (0 1 −1 0); começo da palavra levado para a página
  // torta e daí para o PDF girado: x = 50 + v, y = 60 + u.
  const [u, v] = unskew(0.1 * 700, 0.135 * 500, 0.1, 700, 500);
  const at = (n) => String(Math.round(n * 100) / 100);
  assert.ok(layer.includes(`-0.0998 0.995 -0.995 -0.0998 ${at(50 + v)} ${at(60 + u)} Tm <436f6e747261746f20> Tj`), layer.match(/BT\n3 Tr[\s\S]*?ET/)?.[0]);
  assert.equal(layer.match(/-0\.0998 0\.995 -0\.995 -0\.0998 [\d.]+ [\d.]+ Tm/g).length, 3);
  // O PDF continua abrindo no leitor do app.
  assert.equal((await openPdf(buildPdf([{ copy: { source: copy, page: copy.pages.get(0) } }]))).pages.length, 1);
});

test('PDF escaneado: sem palavras (ou sem OCR), a página copiada sai igual', async () => {
  const doc = await scannedPdf();
  const plain = buildPdf([{ copy: { source: copyPages(doc, [0]), page: copyPages(doc, [0]).pages.get(0) } }]);
  const copy = copyPages(doc, [0], { ocr: new Map([[0, { words: [], rotation: 0 }], [1, { words: WORDS, rotation: 0 }]]) });
  assert.deepEqual(buildPdf([{ copy: { source: copy, page: copy.pages.get(0) } }]), plain);
});
