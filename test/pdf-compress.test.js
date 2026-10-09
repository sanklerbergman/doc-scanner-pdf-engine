import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { openPdf, copyPages, PdfStream } from '../web/js/pdf-reader.js';
import { compressObjects, compressibleBytes, toRgba } from '../web/js/pdf-compress.js';
import { buildPdf, readJpegInfo } from '../web/js/pdf.js';
import { makeRawPdf } from './helpers/pdf.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const SMALL_JPEG = fixture('gray-16x24.jpg'); // 16 × 24, cinza, 335 bytes

// Ruído: comprime mal, como uma foto guardada sem perda.
const noise = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7919 + (i >> 3) * 104729) % 251);

// "Codificador" de teste: devolve sempre o JPEG pequeno e registra o que recebeu.
function fakeEncoder() {
  const calls = [];
  const encode = async (input) => {
    calls.push(input.jpeg ? 'jpeg' : `pixels ${input.pixels.width}x${input.pixels.height}`);
    return { data: SMALL_JPEG, width: 16, height: 24 };
  };
  return { encode, calls };
}

async function sampleDoc() {
  const rgb = noise(40 * 30 * 3);
  return openPdf(makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /XObject << /A 5 0 R /B 6 0 R /C 7 0 R /D 8 0 R /E 10 0 R /F 11 0 R >> >> >>',
    4: { data: `q 100 0 0 100 0 0 cm /A Do Q ${'BT /F1 12 Tf (texto repetido) Tj ET '.repeat(60)}` },
    5: { dict: '/Type /XObject /Subtype /Image /Width 40 /Height 30 /ColorSpace /DeviceRGB /BitsPerComponent 8', data: rgb, deflate: true },
    6: { dict: '/Type /XObject /Subtype /Image /Width 40 /Height 30 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: fixture('rgb-40x30.jpg') },
    7: { dict: '/Type /XObject /Subtype /Image /Width 40 /Height 30 /ColorSpace [/Indexed /DeviceRGB 1 <000000ffffff>] /BitsPerComponent 8', data: noise(1200), deflate: true },
    8: { dict: '/Type /XObject /Subtype /Image /Width 40 /Height 30 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 9 0 R', data: rgb, deflate: true },
    9: { dict: '/Type /XObject /Subtype /Image /Width 40 /Height 30 /ColorSpace /DeviceGray /BitsPerComponent 8', data: noise(1200), deflate: true },
    10: { dict: '/Type /XObject /Subtype /Image /Width 40 /Height 30 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Mask [0 0 0 0 0 0]', data: rgb, deflate: true },
    11: { dict: '/Type /XObject /Subtype /Image /Width 40 /Height 30 /ColorSpace /DeviceCMYK /BitsPerComponent 8', data: noise(4800), deflate: true },
    20: { dict: '/Type /XObject /Subtype /Image /Width 40 /Height 30 /ColorSpace /DeviceRGB /BitsPerComponent 8', data: rgb, deflate: true }, // ninguém usa
  }).bytes);
}

test('recodifica imagens JPEG e sem perda (RGB), mantém SMask e deixa de fora paleta, máscara e CMYK', async () => {
  const doc = await sampleDoc();
  const { encode, calls } = fakeEncoder();
  const replace = await compressObjects(doc, [0], { encode });

  assert.deepEqual([...replace.keys()].sort((a, b) => a - b), [4, 5, 6, 8]);
  assert.ok(!replace.has(7) && !replace.has(10) && !replace.has(11), 'paleta, /Mask e CMYK ficam como estão');
  assert.ok(!replace.has(9), 'a máscara de transparência (SMask) não vira JPEG');
  assert.ok(!replace.has(20), 'imagem que nenhuma página usa nem é olhada');
  assert.ok(calls.includes('jpeg') && calls.includes('pixels 40x30'));

  const image = replace.get(5);
  assert.equal(image.dict.get('Filter').value, 'DCTDecode');
  assert.equal(image.dict.get('ColorSpace').value, 'DeviceGray'); // o JPEG falso é cinza
  assert.deepEqual([image.dict.get('Width'), image.dict.get('Height')], [16, 24]);
  assert.ok(replace.get(8).dict.has('SMask'), 'a transparência (SMask) continua apontando para a máscara');

  const content = replace.get(4);
  assert.equal(content.dict.get('Filter').value, 'FlateDecode');
  assert.match(Buffer.from(inflateSync(content.data)).toString('latin1'), /\/A Do Q/);
});

test('o PDF comprimido continua válido e menor', async () => {
  const doc = await sampleDoc();
  const replace = await compressObjects(doc, [0], fakeEncoder());
  const plain = copyPages(doc, [0]);
  const small = copyPages(doc, [0], { replace });
  const before = buildPdf([{ copy: { source: plain, page: plain.pages.get(0) } }]);
  const after = buildPdf([{ copy: { source: small, page: small.pages.get(0) } }]);
  assert.ok(after.length < before.length * 0.7, `${before.length} → ${after.length}`);

  const reopened = await openPdf(after);
  const xobjects = reopened.resolve(reopened.resolve(reopened.pages[0].attrs.Resources).get('XObject'));
  const a = reopened.resolve(xobjects.get('A'));
  assert.ok(a instanceof PdfStream);
  assert.deepEqual(readJpegInfo(a.data), { width: 16, height: 24, components: 1 });
  assert.equal(a.dict.get('Length'), a.data.length);
});

test('não troca quando a versão nova não fica menor', async () => {
  const doc = await sampleDoc();
  const huge = new Uint8Array(100000);
  huge.set(SMALL_JPEG);
  const replace = await compressObjects(doc, [0], { encode: async () => ({ data: huge, width: 16, height: 24 }) });
  assert.ok(![5, 6, 8].some((n) => replace.has(n)));
});

test('toRgba: RGB e cinza viram RGBA opaco', () => {
  assert.deepEqual([...toRgba(Uint8Array.from([1, 2, 3, 4, 5, 6]), 2, 1, 3)], [1, 2, 3, 255, 4, 5, 6, 255]);
  assert.deepEqual([...toRgba(Uint8Array.from([9, 200]), 2, 1, 1)], [9, 9, 9, 255, 200, 200, 200, 255]);
});

test('imagem com preditor PNG é lida antes de recodificar', async () => {
  const rows = 2;
  const width = 3;
  const raw = [];
  for (let r = 0; r < rows; r++) {
    raw.push(0); // filtro "None" em cada linha
    for (let i = 0; i < width * 3; i++) raw.push((r * 50 + i * 20) % 256);
  }
  const doc = await openPdf(makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /A 5 0 R >> >> /Contents 4 0 R >>',
    4: { data: '/A Do' },
    5: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${rows} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /Columns ${width} >> /Length 0 >>`,
  }).bytes);
  // o objeto 5 acima tem /Length 0 de propósito: troca pelo stream de verdade
  doc.cache.set(5, new PdfStream(doc.object(5) instanceof PdfStream ? doc.object(5).dict : doc.object(5), new Uint8Array(deflateSync(Uint8Array.from(raw)))));
  let received;
  await compressObjects(doc, [0], { encode: async (input) => { received = input.pixels; return null; } });
  assert.deepEqual([...received.data.subarray(0, 8)], [0, 20, 40, 255, 60, 80, 100, 255]);
  assert.equal(received.height, 2);
});

test('estima quanto do PDF são imagens recomprimíveis, sem decodificar', async () => {
  const doc = await sampleDoc();
  const bytes = compressibleBytes(doc);
  const size = (num) => doc.object(num).data.length;
  assert.equal(bytes, size(5) + size(6) + size(8), 'conta RGB sem perda e JPEG; não conta SMask, paleta, /Mask, CMYK nem imagem sem uso');
  assert.equal(compressibleBytes(await openPdf(makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>', 4: { data: 'BT ET' },
  }).bytes)), 0);
});
