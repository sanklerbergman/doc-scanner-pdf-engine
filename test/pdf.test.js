import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildPdf, readJpegInfo, layoutPage } from '../web/js/pdf.js';
import { readDocx } from '../web/js/docx.js';
import { layoutDocument } from '../web/js/layout.js';
import { docxFiles, makeZip, p } from './helpers/docx.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

test('readJpegInfo lê dimensões e componentes', () => {
  assert.deepEqual(readJpegInfo(fixture('rgb-40x30.jpg')), { width: 40, height: 30, components: 3 });
  assert.deepEqual(readJpegInfo(fixture('gray-16x24.jpg')), { width: 16, height: 24, components: 1 });
  assert.deepEqual(readJpegInfo(fixture('progressive-40x30.jpg')), { width: 40, height: 30, components: 3 });
});

test('readJpegInfo recusa o que não é JPEG', () => {
  assert.throws(() => readJpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), /JPEG/);
});

test('buildPdf gera estrutura válida: offsets do xref e startxref batem', () => {
  const page = (name) => ({ jpeg: fixture(name), ...layoutPage(40, 30, 'a4', 18) });
  const pdf = buildPdf([page('rgb-40x30.jpg'), page('gray-16x24.jpg')]);
  const text = latin1(pdf);

  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.endsWith('%%EOF\n'));
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/ColorSpace \/DeviceRGB/);
  assert.match(text, /\/ColorSpace \/DeviceGray/);

  const startxref = Number(text.match(/startxref\n(\d+)\n/)[1]);
  assert.ok(text.startsWith('xref\n', startxref));

  const entries = text.slice(startxref).match(/^\d{10} \d{5} [nf] $/gm);
  assert.equal(entries.length, 1 + 2 + 2 * 3);
  entries.slice(1).forEach((entry, i) => {
    assert.ok(text.startsWith(`${i + 1} 0 obj\n`, Number(entry.slice(0, 10))), `objeto ${i + 1}`);
  });
});

test('buildPdf embute o JPEG sem alterar nenhum byte', () => {
  const jpeg = fixture('rgb-40x30.jpg');
  const pdf = buildPdf([{ jpeg, ...layoutPage(40, 30, 'fit', 0) }]);
  const start = latin1(pdf).indexOf(latin1(jpeg));
  assert.ok(start > 0);
  assert.deepEqual(pdf.subarray(start, start + jpeg.length), jpeg);
});

test('buildPdf não grava metadados', () => {
  const text = latin1(buildPdf([{ jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(40, 30, 'a4', 0) }]));
  assert.doesNotMatch(text, /\/Info|\/Producer|\/Creator|\/CreationDate|\/Metadata/);
});

test('buildPdf exige ao menos uma página', () => {
  assert.throws(() => buildPdf([]), /Nenhuma página/);
});

test('layoutPage centraliza, respeita margem e deita a página para imagem larga', () => {
  const portrait = layoutPage(1000, 2000, 'a4', 18);
  assert.equal(portrait.width, 595.28);
  assert.equal(portrait.height, 841.89);
  assert.ok(Math.abs(portrait.box.h - (841.89 - 36)) < 1e-9);
  assert.ok(Math.abs(portrait.box.x * 2 + portrait.box.w - portrait.width) < 1e-9);

  const landscape = layoutPage(3000, 2000, 'letter', 0);
  assert.deepEqual([landscape.width, landscape.height], [792, 612]);

  const fit = layoutPage(300, 600, 'fit', 10);
  assert.ok(Math.abs(fit.box.w - 595.28) < 1e-9);
  assert.ok(Math.abs(fit.width - 615.28) < 1e-9);
});

// ---------- Páginas de texto (documentos do Word) ----------

// Confere que cada entrada do xref aponta para o início do objeto certo.
function assertValidXref(text) {
  const startxref = Number(text.match(/startxref\n(\d+)\n/)[1]);
  assert.ok(text.startsWith('xref\n', startxref));
  const entries = text.slice(startxref).match(/^\d{10} \d{5} [nf] $/gm);
  assert.equal(entries.length, Number(text.match(/\/Size (\d+)/)[1]));
  entries.slice(1).forEach((entry, i) => {
    assert.ok(text.startsWith(`${i + 1} 0 obj\n`, Number(entry.slice(0, 10))), `objeto ${i + 1}`);
  });
  return entries.length;
}

const textPage = (items, extra = {}) => ({ width: 595.28, height: 841.89, items, ...extra });
const word = (text, font = 'Helvetica', y = 100) => ({ type: 'text', x: 72, y, text, font, size: 12, color: null, wordSpacing: 0, rise: 0 });

test('PDF só de fotos continua idêntico byte a byte ao de antes das páginas de texto', () => {
  const pdf = buildPdf([
    { jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(40, 30, 'a4', 18) },
    { jpeg: fixture('gray-16x24.jpg'), ...layoutPage(16, 24, 'letter', 0) },
    { jpeg: fixture('progressive-40x30.jpg'), ...layoutPage(40, 30, 'fit', 36) },
  ]);
  assert.equal(pdf.length, 3675);
  assert.equal(createHash('sha256').update(pdf).digest('hex'), '897d2f1127cb084ca5af0149791790655b78c59a7172ff894d2be82001797147');
});

test('página de texto: fontes padrão com WinAnsi, acentos em octal e parênteses escapados', () => {
  const text = latin1(buildPdf([textPage([
    word(String.raw`Atenção (ç) \ €`),
    word('Negrito', 'Helvetica-Bold', 120),
    { type: 'text', x: 72, y: 140, text: 'de novo', font: 'Helvetica', size: 10, color: [1, 0, 0], wordSpacing: 2.5, rise: 3 },
    { type: 'line', x1: 72, x2: 120, y: 142, width: 0.6, color: [1, 0, 0] },
  ])]));
  assertValidXref(text);
  assert.match(text, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/);
  assert.match(text, /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/);
  assert.equal(text.match(/\/Type \/Font/g).length, 2, 'cada fonte aparece uma vez só');
  assert.ok(text.includes(String.raw`(Aten\347\343o \(\347\) \\ \200) Tj`), 'ç = 347, ã = 343, € = 200 (octal)');
  assert.ok(text.includes('1 0 0 1 72 741.89 Tm'), 'y medido do topo vira y medido de baixo');
  assert.ok(text.includes('1 0 0 rg') && text.includes('2.5 Tw') && text.includes('3 Ts'));
  assert.ok(text.includes('1 0 0 RG\n0.6 w 72 699.89 m 120 699.89 l S'));
  assert.doesNotMatch(text, /\/Info|\/Producer|\/Creator|\/CreationDate|\/Metadata/);
});

test('mistura de foto e texto, com página de texto girada', () => {
  const text = latin1(buildPdf([
    textPage([word('primeira')]),
    { jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(40, 30, 'a4', 18) },
    textPage([word('terceira', 'Times-Roman')], { rotation: 90 }),
    textPage([]),
  ]));
  assert.equal(assertValidXref(text), 1 + 2 + 2 + 3 + 2 + 2 + 2); // livre, catálogo, páginas, 3 páginas, 2 fontes
  assert.match(text, /\/Count 4/);
  assert.match(text, /\/Kids \[3 0 R 5 0 R 8 0 R 10 0 R\]/);
  assert.match(text, /\/Rotate 90/);
  assert.match(text, /\/Resources << \/Font << \/F1 12 0 R >> >>/);
  assert.match(text, /\/Resources << >>/, 'página em branco também é válida');
});

test('página de texto recusa fonte desconhecida e caractere sem suporte', () => {
  assert.throws(() => buildPdf([textPage([word('x', 'Arial')])]), /Fonte desconhecida/);
  assert.throws(() => buildPdf([textPage([word('Ω')])]), /sem suporte/);
});

test('do .docx ao PDF: texto pesquisável e sem metadados do documento', async () => {
  const files = docxFiles({
    body: p('Contrato de prestação de serviços', { rPr: '<w:b/><w:sz w:val="28"/>' }) + p('Cláusula 1ª – Do objeto.') +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1701" w:bottom="1417" w:left="1701"/></w:sectPr>',
  });
  files['docProps/core.xml'] = '<cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:creator>Fulana de Tal</dc:creator></cp:coreProperties>';
  const { pages } = layoutDocument(await readDocx(makeZip(files)));
  const text = latin1(buildPdf(pages));
  assertValidXref(text);
  assert.ok(text.includes(String.raw`(Contrato de presta\347\343o de servi\347os) Tj`));
  assert.ok(text.includes(String.raw`(Cl\341usula 1\252 \226 Do objeto.) Tj`));
  assert.match(text, /\/BaseFont \/Times-Bold/);
  assert.ok(!text.includes('Fulana'));
  assert.doesNotMatch(text, /\/Info|\/Producer|\/Creator|\/CreationDate|\/Metadata/);
});
