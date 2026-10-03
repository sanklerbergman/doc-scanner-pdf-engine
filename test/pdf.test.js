import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPdf, readJpegInfo, layoutPage } from '../web/js/pdf.js';

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
