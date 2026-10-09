import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as nodeCrc32 } from 'node:zlib';
import { openZip, crc32, ZipError } from '../web/js/zip.js';
import { makeZip } from './helpers/docx.js';

const text = 'Atenção: parágrafo com acentuação. '.repeat(20);

test('lê arquivos guardados sem compressão e comprimidos', async () => {
  for (const store of [true, false]) {
    const zip = openZip(makeZip({ 'a.txt': text, 'pasta/b.xml': '<x/>' }, { store }));
    assert.deepEqual(zip.names, ['a.txt', 'pasta/b.xml']);
    assert.ok(zip.has('pasta/b.xml'));
    assert.ok(!zip.has('c.txt'));
    assert.equal(await zip.readText('a.txt'), text);
    assert.equal(await zip.readText('pasta/b.xml'), '<x/>');
  }
});

test('crc32 bate com o do zlib', () => {
  const bytes = new TextEncoder().encode(text);
  assert.equal(crc32(bytes), nodeCrc32(bytes));
  assert.equal(crc32(new Uint8Array()), 0);
});

test('lê texto em UTF-16 com marca de ordem dos bytes', async () => {
  const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from('<a>é</a>', 'utf16le')]);
  assert.equal(await openZip(makeZip({ 'a.xml': utf16 })).readText('a.xml'), '<a>é</a>');
});

test('recusa o que não é ZIP', () => {
  assert.throws(() => openZip(new TextEncoder().encode('não sou um zip, sou só texto')), ZipError);
  assert.throws(() => openZip(new Uint8Array()), /não é um ZIP/);
});

test('recusa ZIP corrompido: byte trocado (CRC) e arquivo cortado', async () => {
  const bytes = makeZip({ 'a.txt': text }, { store: true });
  const changed = bytes.slice();
  changed[30 + 'a.txt'.length + 5] ^= 0xff; // um byte do conteúdo
  await assert.rejects(openZip(changed).read('a.txt'), /corrompido/);

  const deflated = makeZip({ 'a.txt': text });
  const broken = deflated.slice();
  broken.fill(0xaa, 40, 60); // estraga o fluxo comprimido
  await assert.rejects(openZip(broken).read('a.txt'), /corrompido/);

  assert.throws(() => openZip(bytes.subarray(0, bytes.length - 10)), ZipError);
});

test('ZIP bomb: para de descompactar ao passar do limite, mesmo com tamanho declarado pequeno', async () => {
  const zeros = new Uint8Array(1024 * 1024); // 1 MB de zeros comprime para ~1 KB
  const liar = makeZip({ 'bomba.xml': { data: zeros, declaredSize: 100 } });
  await assert.rejects(openZip(liar, { maxFileSize: 64 * 1024 }).read('bomba.xml'), /grande demais/);

  const honest = makeZip({ 'grande.xml': zeros });
  await assert.rejects(openZip(honest, { maxFileSize: 64 * 1024 }).read('grande.xml'), /grande demais/);
});

test('limite do total descompactado e do número de entradas', async () => {
  const zip = openZip(makeZip({ 'a.txt': 'x'.repeat(600), 'b.txt': 'y'.repeat(600) }), { maxTotalSize: 1000 });
  await zip.read('a.txt');
  await assert.rejects(zip.read('b.txt'), /grande demais/);

  assert.throws(() => openZip(makeZip({ a: '1', b: '2', c: '3' }), { maxEntries: 2 }), /itens demais/);
});

test('recusa entrada protegida por senha e arquivo que não existe', async () => {
  const zip = openZip(makeZip({ 'a.txt': { data: 'segredo', encrypted: true } }));
  await assert.rejects(zip.read('a.txt'), /senha/);
  await assert.rejects(zip.read('b.txt'), /Falta b\.txt/);
});
