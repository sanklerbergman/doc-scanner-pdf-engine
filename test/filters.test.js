import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilter } from '../web/js/filters.js';

// "Foto" sintética: papel azulado com sombra em degradê e um bloco de tinta escura.
function photo(width = 64, height = 64) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const ink = x > 20 && x < 40 && y > 20 && y < 26;
      const shade = 1 - (y / height) * 0.4;
      data[p] = (ink ? 30 : 170) * shade;
      data[p + 1] = (ink ? 30 : 190) * shade;
      data[p + 2] = (ink ? 40 : 230) * shade;
      data[p + 3] = 255;
    }
  }
  return { data, width, height };
}
const pixel = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];

test('enhance clareia o papel e preserva os três canais de cor', () => {
  const img = photo();
  applyFilter(img, 'enhance');
  const [r, g, b] = pixel(img, 5, 50); // papel, na parte sombreada
  assert.ok(r > 150 && g > 150 && b > 200, `papel ficou ${[r, g, b]}`);
  assert.ok(b > r, 'o tom azulado do papel deve continuar');
  assert.ok(Math.max(...pixel(img, 30, 23)) < 110, 'a tinta deve continuar escura');
});

test('document gera cinza com papel branco e tinta escura', () => {
  const img = photo();
  applyFilter(img, 'document');
  const [r, g, b] = pixel(img, 5, 50);
  assert.ok(r === g && g === b && r > 235, `papel ficou ${[r, g, b]}`);
  assert.ok(pixel(img, 30, 23)[0] < 110);
});

test('bw só produz preto ou branco', () => {
  const img = photo();
  applyFilter(img, 'bw');
  for (let p = 0; p < img.data.length; p += 4) assert.ok(img.data[p] === 0 || img.data[p] === 255);
  assert.equal(pixel(img, 30, 23)[0], 0);
  assert.equal(pixel(img, 5, 50)[0], 255);
});
