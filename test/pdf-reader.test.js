import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { openPdf, copyPages, PdfError, PdfStream, PdfName } from '../web/js/pdf-reader.js';
import { layoutPage } from '../web/js/pdf.js';
import { makeRawPdf, textPageObjects } from './helpers/pdf.js';
import { buildPdf } from './helpers/qpdf.js';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

// Texto do conteúdo de uma página (descompacta se precisar).
function contentOf(doc, index) {
  const page = doc.pages[index].node;
  let contents = doc.resolve(page.get('Contents'));
  if (!Array.isArray(contents)) contents = [page.get('Contents')];
  return contents.map((ref) => {
    const stream = doc.resolve(ref);
    const filter = doc.resolve(stream.dict.get('Filter'));
    return latin1(filter instanceof PdfName ? inflateSync(stream.data) : stream.data);
  }).join('\n');
}

const simple = (text, xref = 'table', packed = []) => makeRawPdf({
  1: '<< /Type /Catalog /Pages 2 0 R >>',
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
  ...textPageObjects(text),
}, { xref, packed }).bytes;

// Junta páginas (de um ou mais PDFs) e reabre o resultado com o próprio leitor.
async function merge(list) {
  const sources = new Map();
  const pages = [];
  for (const [doc, index, rotation = 0] of list) {
    if (!sources.has(doc)) sources.set(doc, []);
    sources.get(doc).push(index);
  }
  const copies = new Map([...sources].map(([doc, indices]) => [doc, copyPages(doc, indices)]));
  for (const [doc, index, rotation = 0] of list) {
    const copy = copies.get(doc);
    pages.push({ copy: { source: copy, page: copy.pages.get(index) }, rotation });
  }
  const out = buildPdf(pages);
  return { bytes: out, doc: await openPdf(out) };
}

test('lê PDF com tabela xref clássica', async () => {
  const doc = await openPdf(simple('Classica'));
  assert.equal(doc.pages.length, 1);
  assert.equal(doc.pages[0].width, 612);
  assert.equal(doc.pages[0].height, 792);
  assert.match(contentOf(doc, 0), /\(Classica\) Tj/);
});

test('lê xref em stream (com preditor PNG) e objetos dentro de object streams', async () => {
  const doc = await openPdf(simple('Comprimido', 'stream', [1, 2, 3, 5]));
  assert.equal(doc.pages.length, 1);
  assert.match(contentOf(doc, 0), /\(Comprimido\) Tj/);
  assert.equal(doc.resolve(doc.pages[0].attrs.Resources).get('Font') instanceof Map, true);
});

test('atualização incremental: a versão mais nova de cada objeto vence', async () => {
  const first = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    ...textPageObjects('Antigo'),
  });
  const updated = makeRawPdf({ 4: { data: 'BT /F1 24 Tf 72 720 Td (Novo) Tj ET' } }, { start: first.bytes, prev: first.xrefOffset });
  const doc = await openPdf(updated.bytes);
  assert.match(contentOf(doc, 0), /\(Novo\) Tj/);
});

test('xref quebrada: reconstrói varrendo os objetos', async () => {
  const bytes = simple('Quebrado');
  const text = latin1(bytes).replace(/startxref\n\d+/, 'startxref\n999999');
  const doc = await openPdf(Uint8Array.from(text, (c) => c.charCodeAt(0)));
  assert.match(contentOf(doc, 0), /\(Quebrado\) Tj/);

  const noTable = latin1(simple('SemTabela')).replace(/xref\n[\s\S]*$/, '');
  const rebuilt = await openPdf(Uint8Array.from(noTable, (c) => c.charCodeAt(0)));
  assert.equal(rebuilt.pages.length, 1, 'sem xref nem trailer: acha o catálogo na varredura');
});

test('árvore de páginas: herda MediaBox, Rotate e Resources; CropBox muda o tamanho', async () => {
  const doc = await openPdf(makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [6 0 R 3 0 R] /Count 3 /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> >>',
    3: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Rotate 90 /CropBox [10 10 310 410] >>',
    4: { data: 'BT /F1 12 Tf (x) Tj ET' },
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    6: '<< /Type /Pages /Parent 2 0 R /Kids [7 0 R 8 0 R] /Count 2 /Rotate 180 >>',
    7: '<< /Type /Page /Parent 6 0 R /Contents 4 0 R >>',
    8: '<< /Type /Page /Parent 6 0 R /Contents 4 0 R /MediaBox [0 0 200 100] /Rotate -90 >>',
  }).bytes);
  assert.deepEqual(doc.pages.map((p) => [p.width, p.height, p.rotate]), [[595, 842, 180], [100, 200, 270], [400, 300, 90]]);
  assert.ok(doc.pages.every((p) => doc.resolve(p.attrs.Resources).has('Font')));
});

test('recusa PDF criptografado, arquivo que não é PDF e PDF sem páginas', async () => {
  const encrypted = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', ...textPageObjects('x'),
    9: '<< /Filter /Standard /V 2 /R 3 >>',
  }, { trailer: '/Root 1 0 R /Encrypt 9 0 R' }).bytes;
  await assert.rejects(openPdf(encrypted), /senha/);
  await assert.rejects(openPdf(new TextEncoder().encode('não sou PDF')), PdfError);
  await assert.rejects(openPdf(makeRawPdf({ 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [] /Count 0 >>' }).bytes), /nenhuma página/);
});

test('limites: páginas demais e bomba de compressão num object stream', async () => {
  await assert.rejects(openPdf(simple('x'), { maxPages: 0 }), /passa de 0 páginas/);
  const bomb = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', ...textPageObjects('x'),
  }, { xref: 'stream', packed: [1, 2] }).bytes;
  await assert.rejects(openPdf(bomb, { maxStreamSize: 10 }), /grande demais/);
});

test('detecta assinatura digital', async () => {
  const signed = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [9 0 R] >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', ...textPageObjects('x'),
    9: '<< /FT /Sig /T (Assinatura1) /V 10 0 R >>',
    10: '<< /Type /Sig /Filter /Adobe.PPKLite /Contents <00> >>',
  }).bytes;
  assert.equal((await openPdf(signed)).isSigned(), true);
  assert.equal((await openPdf(simple('x'))).isSigned(), false);
});

test('juntar: páginas de dois PDFs e uma foto, na ordem pedida, com xref válida', async () => {
  const a = await openPdf(simple('Primeiro'));
  const b = await openPdf(simple('Segundo', 'stream', [1, 2, 3, 5]));
  const copyA = copyPages(a, [0]);
  const copyB = copyPages(b, [0]);
  const out = buildPdf([
    { copy: { source: copyB, page: copyB.pages.get(0) } },
    { jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(40, 30, 'a4', 18) },
    { copy: { source: copyA, page: copyA.pages.get(0) }, rotation: 90 },
  ]);
  const text = latin1(out);
  assert.ok(text.startsWith('%PDF-1.7\n'));
  const startxref = Number(text.match(/startxref\n(\d+)\n/)[1]);
  const entries = text.slice(startxref).match(/^\d{10} \d{5} [nf] $/gm);
  entries.slice(1).forEach((entry, i) => assert.ok(text.startsWith(`${i + 1} 0 obj\n`, Number(entry.slice(0, 10))), `objeto ${i + 1}`));

  const merged = await openPdf(out);
  assert.equal(merged.pages.length, 3);
  assert.match(contentOf(merged, 0), /\(Segundo\) Tj/);
  assert.match(contentOf(merged, 2), /\(Primeiro\) Tj/);
  assert.equal(merged.pages[2].rotate, 90);
  assert.equal(merged.pages[0].width, 612, 'MediaBox herdada vai para a página copiada');
});

test('dividir: a mesma fonte usada em várias páginas é copiada uma vez só', async () => {
  const doc = await openPdf(makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R 6 0 R 7 0 R] /Count 3 /Resources << /Font << /F1 5 0 R >> >> >>',
    3: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    4: { data: 'BT /F1 12 Tf (um) Tj ET' },
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    6: '<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>',
    7: '<< /Type /Page /Parent 2 0 R /Contents 9 0 R >>',
    8: { data: 'BT /F1 12 Tf (dois) Tj ET' },
    9: { data: 'BT /F1 12 Tf (tres) Tj ET' },
  }).bytes);
  const { doc: split } = await merge([[doc, 2], [doc, 0]]);
  assert.equal(split.pages.length, 2);
  assert.match(contentOf(split, 0), /\(tres\)/);
  assert.match(contentOf(split, 1), /\(um\)/);
  const text = latin1(buildPdf([...(() => { const c = copyPages(doc, [0, 2]); return [0, 2].map((i) => ({ copy: { source: c, page: c.pages.get(i) } })); })()]));
  assert.equal(text.match(/\/BaseFont \/Helvetica/g).length, 1);
  assert.ok(!text.includes('(dois)'), 'página que não foi escolhida não entra');
});

test('saída sem metadados, JavaScript, ações nem anotações clicáveis; aparências viram parte da página', async () => {
  const doc = await openPdf(makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /OpenAction 20 0 R /Names << /JavaScript 20 0 R >> /Metadata 21 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    ...textPageObjects('Formulario', { extra: ' /Annots [10 0 R 11 0 R 12 0 R] /AA << /O 20 0 R >> /Metadata 21 0 R' }),
    10: '<< /Type /Annot /Subtype /Link /Rect [0 0 100 20] /A << /S /URI /URI (https://exemplo.invalid) >> >>',
    11: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (nome) /V (Maria) /F 4 /Rect [100 600 300 620] /AP << /N 13 0 R >> >>',
    12: '<< /Type /Annot /Subtype /Widget /F 2 /Rect [0 0 10 10] /AP << /N 13 0 R >> >>',
    13: { dict: '/BBox [0 0 200 20] /Resources << /Font << /F1 5 0 R >> >>', data: 'BT /F1 12 Tf 2 5 Td (Maria) Tj ET' },
    20: '<< /S /JavaScript /JS (app.alert\\(1\\)) >>',
    21: { dict: '/Type /Metadata /Subtype /XML', data: '<x:xmpmeta>autor: Fulana</x:xmpmeta>' },
  }, { trailer: '/Root 1 0 R /Info 22 0 R' }).bytes);
  assert.equal(doc.hasAnnotations(), true);
  const { bytes, doc: out } = await merge([[doc, 0]]);
  const text = latin1(bytes);
  for (const forbidden of ['/Info', '/Metadata', 'JavaScript', '/JS', 'OpenAction', '/AA', '/Annots', '/URI', 'Fulana', '/Widget']) {
    assert.ok(!text.includes(forbidden), `não deveria ter ${forbidden}`);
  }
  const content = contentOf(out, 0);
  assert.match(content, /^q\n/, 'conteúdo original isolado entre q e Q');
  assert.match(content, /\(Formulario\) Tj/);
  assert.match(content, /q 1 0 0 1 100 600 cm \/Annot0 Do Q/, 'o campo preenchido é desenhado no lugar dele');
  assert.ok(!content.includes('/Annot1'), 'anotação oculta não aparece');
  const xobject = out.resolve(out.resolve(out.pages[0].attrs.Resources).get('XObject')).get('Annot0');
  const form = out.resolve(xobject);
  assert.ok(form instanceof PdfStream);
  assert.equal(form.dict.get('Subtype').value, 'Form');
  assert.match(latin1(form.data), /\(Maria\) Tj/);
});

test('recursos com nomes como /B ou /JS não somem na cópia', async () => {
  const doc = await openPdf(makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /B 5 0 R /JS 5 0 R /Parent 5 0 R >> >> >>',
    4: { data: 'BT /B 12 Tf (x) Tj /JS 12 Tf (y) Tj ET' },
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  }).bytes);
  const { doc: copy } = await merge([[doc, 0]]);
  const fonts = copy.resolve(copy.resolve(copy.pages[0].attrs.Resources).get('Font'));
  assert.deepEqual([...fonts.keys()], ['B', 'JS', 'Parent']);
});

test('reabre o PDF gerado pelo próprio app', async () => {
  const own = buildPdf([{ jpeg: fixture('gray-16x24.jpg'), ...layoutPage(16, 24, 'letter', 0) }]);
  const doc = await openPdf(own);
  assert.equal(doc.pages.length, 1);
  assert.deepEqual([doc.pages[0].width, doc.pages[0].height], [612, 792]);
  const { doc: again } = await merge([[doc, 0], [doc, 0]]);
  assert.equal(again.pages.length, 2);
});
