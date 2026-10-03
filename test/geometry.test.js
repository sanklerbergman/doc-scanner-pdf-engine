import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDocument, warpPixels, quadSize, toRotated, fromRotated, isFullFrame, FULL_QUAD } from '../web/js/geometry.js';

// Papel claro (quadrilátero) sobre fundo escuro com textura.
function scene(width, height, quad, { paper = 215, background = 70 } = {}) {
  const inside = (x, y) => quad.every(([ax, ay], i) => {
    const [bx, by] = quad[(i + 1) % 4];
    return (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= 0;
  });
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const noise = ((x * 31 + y * 17) % 23) - 11;
      gray[y * width + x] = (inside(x, y) ? paper - (y / height) * 40 : background) + noise;
    }
  }
  return gray;
}

const close = (a, b, tolerance) => a.every((point, i) => Math.abs(point[0] - b[i][0]) <= tolerance && Math.abs(point[1] - b[i][1]) <= tolerance);

test('detectDocument acha os cantos de um papel em perspectiva', () => {
  const quad = [[70, 20], [150, 24], [185, 300], [30, 290]];
  const found = detectDocument(scene(220, 320, quad), 220, 320);
  assert.ok(found, 'deveria detectar');
  const expected = quad.map(([x, y]) => [x / 220, y / 320]);
  assert.ok(close(found, expected, 0.03), JSON.stringify(found));
});

test('detectDocument acha papel cortado pela borda da foto', () => {
  const quad = [[80, 15], [160, 15], [200, 330], [30, 330]]; // sai por baixo
  const found = detectDocument(scene(220, 320, quad), 220, 320);
  assert.ok(found);
  assert.ok(found[2][1] > 0.97 && found[3][1] > 0.97);
});

test('detectDocument desiste quando não há um papel claro destacado', () => {
  const flat = new Uint8Array(200 * 300).fill(200);
  assert.equal(detectDocument(flat, 200, 300), null);
  const everything = [[2, 2], [198, 2], [198, 298], [2, 298]];
  assert.equal(detectDocument(scene(200, 300, everything), 200, 300), null);
  const tiny = [[90, 140], [110, 140], [110, 160], [90, 160]];
  assert.equal(detectDocument(scene(200, 300, tiny), 200, 300), null);
});

test('warpPixels com o quadro inteiro devolve a mesma imagem', () => {
  const w = 8, h = 6;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < src.length; i++) src[i] = i % 4 === 3 ? 255 : (i * 7) % 256;
  const out = warpPixels(src, w, h, [[0, 0], [w, 0], [w, h], [0, h]], w, h);
  assert.deepEqual(out, src);
});

test('warpPixels leva cada canto do quad ao canto do retângulo', () => {
  const w = 40, h = 40;
  const src = new Uint8ClampedArray(w * h * 4).fill(255);
  const paint = (x, y, r) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) src[((y + dy) * w + x + dx) * 4] = r; };
  const quad = [[10, 5], [30, 8], [35, 34], [6, 30]];
  [10, 60, 110, 160].forEach((r, i) => paint(quad[i][0], quad[i][1], r));
  const out = warpPixels(src, w, h, quad, 20, 20);
  const red = (x, y) => out[(y * 20 + x) * 4];
  assert.ok(Math.abs(red(0, 0) - 10) < 8 && Math.abs(red(19, 0) - 60) < 8);
  assert.ok(Math.abs(red(19, 19) - 110) < 8 && Math.abs(red(0, 19) - 160) < 8);
});

test('quadSize usa a média dos lados opostos', () => {
  assert.deepEqual(quadSize([[0, 0], [10, 0], [14, 20], [-4, 20]]), { width: 14, height: (Math.hypot(4, 20) * 2) / 2 });
});

test('toRotated e fromRotated são inversas e mantêm a ordem dos cantos na tela', () => {
  const quad = [[0.1, 0.2], [0.8, 0.25], [0.9, 0.9], [0.05, 0.85]];
  for (const rotation of [0, 90, 180, 270]) {
    const rotated = toRotated(quad, rotation);
    assert.ok(close(fromRotated(rotated, rotation), quad, 1e-12), `ida e volta em ${rotation}`);
    // Na foto girada, o primeiro canto continua sendo o de cima à esquerda.
    const sums = rotated.map(([x, y]) => x + y);
    assert.equal(sums.indexOf(Math.min(...sums)), 0, `canto superior esquerdo em ${rotation}`);
  }
  // Girar 90° no sentido horário leva o canto superior esquerdo da foto para a direita.
  assert.ok(close([toRotated(FULL_QUAD, 90)[1]], [[1, 0]], 1e-12));
});

test('isFullFrame reconhece o quadro inteiro', () => {
  assert.ok(isFullFrame(FULL_QUAD));
  assert.ok(isFullFrame([[0.005, 0], [1, 0.004], [0.999, 1], [0, 0.996]]));
  assert.ok(!isFullFrame([[0.1, 0], [1, 0], [1, 1], [0, 1]]));
});
