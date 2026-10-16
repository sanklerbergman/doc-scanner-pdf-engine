// Fonte TrueType (ttf.js): leitura das larguras e do cmap e o subconjunto das letras usadas, com as Liberation de
// web/vendor/liberation (as mesmas que o PDF/A embute).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTrueType, TrueTypeError } from '../web/js/ttf.js';
import { textWidth } from '../web/js/fonts.js';

const liberation = async (name) => {
  const { default: base64 } = await import(`../web/vendor/liberation/${name}.ttf.js`);
  return new Uint8Array(Buffer.from(base64, 'base64'));
};

const cp = (char) => char.codePointAt(0);

// Soma de conferência do TrueType: palavras de 32 bits, somadas sem sinal.
function checksum(bytes) {
  const padded = new Uint8Array((bytes.length + 3) & ~3);
  padded.set(bytes);
  const view = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
}

function tablesOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map();
  for (let i = 0; i < view.getUint16(4); i++) {
    const at = 12 + i * 16;
    out.set(String.fromCharCode(...bytes.subarray(at, at + 4)), { checksum: view.getUint32(at + 4), offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return out;
}

test('lê a Liberation Sans: nome, medidas, cmap e larguras iguais às da Helvetica', async () => {
  const font = readTrueType(await liberation('LiberationSans-Regular'));
  assert.equal(font.postScriptName, 'LiberationSans');
  assert.equal(font.unitsPerEm, 2048);
  assert.ok(font.numGlyphs > 2000);
  assert.equal(font.italicAngle, 0);
  assert.equal(font.fixedPitch, false);
  assert.ok(font.ascent > 0 && font.descent < 0 && font.capHeight > 0);
  for (const char of 'Aaçã€“—ª') assert.ok(font.glyphOf(cp(char)) > 0, char);
  assert.equal(font.glyphOf(0x4e00), 0, 'o que a fonte não tem dá a letra 0');
  for (const char of 'Contrato de locação, R$ 1.500,00 — “aspas”') {
    assert.equal(font.width(cp(char)), textWidth(char, 'Helvetica', 1000), char);
  }
  const mono = readTrueType(await liberation('LiberationMono-Italic'));
  assert.equal(mono.fixedPitch, true);
  assert.ok(mono.italicAngle < 0);
});

test('subconjunto: só as letras usadas (e as partes das compostas), com os mesmos números e larguras', async () => {
  const bytes = await liberation('LiberationSerif-Bold');
  const font = readTrueType(bytes);
  const used = [...'Cláusula 1ª — R$ 1.500,00'].map(cp);
  const subset = font.subset(used);
  assert.ok(subset.length < bytes.length / 5, `${subset.length} bytes`);
  const again = readTrueType(subset);
  assert.equal(again.numGlyphs, font.numGlyphs, 'mesmos números de letra');
  assert.equal(again.postScriptName, 'LiberationSerif-Bold');
  for (const code of used) {
    assert.equal(again.glyphOf(code), font.glyphOf(code));
    assert.equal(again.width(code), font.width(code));
  }
  assert.equal(again.glyphOf(cp('Z')), 0, 'letra não usada fica fora do cmap');
  // Letra usada tem o desenho inteiro; a não usada fica vazia (e sem largura).
  const glyf = (data, glyph) => {
    const t = tablesOf(data);
    const view = new DataView(data.buffer, data.byteOffset);
    const loca = t.get('loca').offset;
    const long = view.getInt16(t.get('head').offset + 50) === 1;
    const at = (g) => (long ? view.getUint32(loca + g * 4) : view.getUint16(loca + g * 2) * 2);
    return at(glyph + 1) - at(glyph);
  };
  assert.ok(glyf(subset, font.glyphOf(cp('C'))) > 0);
  assert.equal(glyf(subset, font.glyphOf(cp('Z'))), 0);
  assert.equal(again.advance(font.glyphOf(cp('Z'))), 0);

  // "é" é composto ("e" + acento): só com ele no texto, o "e" vai junto, mas fora do cmap.
  const sans = await liberation('LiberationSans-Regular');
  const sansFont = readTrueType(sans);
  const onlyE = sansFont.subset([cp('é')]);
  const view = new DataView(onlyE.buffer);
  const t = tablesOf(onlyE);
  assert.ok(view.getInt16(t.get('glyf').offset + view.getUint32(t.get('loca').offset + sansFont.glyphOf(cp('é')) * 4)) < 0, 'é composto');
  assert.ok(glyf(onlyE, sansFont.glyphOf(cp('e'))) > 0, 'o "e" do "é" vai junto');
  assert.equal(readTrueType(onlyE).glyphOf(cp('e')), 0);
});

test('subconjunto: tabelas com as somas de conferência certas, em ordem e alinhadas, e o arquivo inteiro também', async () => {
  const subset = readTrueType(await liberation('LiberationMono-Regular')).subset([...'Código 0123'].map(cp));
  const tables = tablesOf(subset);
  const tags = [...tables.keys()];
  assert.deepEqual(tags, [...tags].sort());
  assert.ok(!tags.some((tag) => ['GSUB', 'GPOS', 'kern', 'DSIG'].includes(tag)), tags.join(' '));
  for (const [tag, { checksum: sum, offset, length }] of tables) {
    assert.equal(offset % 4, 0, `${tag} alinhada`);
    if (tag === 'head') continue; // a soma da head é feita com o checkSumAdjustment zerado
    assert.equal(sum, checksum(subset.subarray(offset, offset + length)), tag);
  }
  assert.equal(checksum(subset), 0xb1b0afba, 'checkSumAdjustment');
  const post = tables.get('post');
  assert.equal(new DataView(subset.buffer).getUint32(post.offset), 0x00030000, 'post formato 3, sem os nomes das letras');
});

test('o que não é TrueType é recusado com mensagem própria', () => {
  assert.throws(() => readTrueType(new Uint8Array(40)), TrueTypeError);
  assert.throws(() => readTrueType(new TextEncoder().encode('%PDF-1.7 não é fonte')), TrueTypeError);
  const header = new Uint8Array(28);
  new DataView(header.buffer).setUint32(0, 0x00010000);
  new DataView(header.buffer).setUint16(4, 1);
  header.set([0x68, 0x65, 0x61, 0x64], 12); // uma tabela "head" que passa do fim do arquivo
  new DataView(header.buffer).setUint32(20, 10);
  new DataView(header.buffer).setUint32(24, 999);
  assert.throws(() => readTrueType(header), /fora do arquivo/);
});
