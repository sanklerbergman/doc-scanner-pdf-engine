import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loupeCenter } from '../web/js/viewer.js';

// Lupa de 120 px, a 48 px do dedo, a pelo menos 8 px da borda da tela.
const options = { size: 120, gap: 48, margin: 8 };
const radius = 60;
const away = 48 + radius;
const phone = { width: 390, height: 664 }; // iPhone 16e, em pé
const at = (x, y) => ({ left: x, right: x, top: y, bottom: y });
const onScreen = ({ x, y }, screen) =>
  x - radius >= 8 - 1e-9 && x + radius <= screen.width - 8 + 1e-9 && y - radius >= 8 - 1e-9 && y + radius <= screen.height - 8 + 1e-9;
const clearOf = (center, x, y) => Math.hypot(center.x - x, center.y - y) >= away - 1e-9;

test('loupeCenter põe a lupa acima do dedo, numa distância que ele não cobre', () => {
  assert.deepEqual(loupeCenter(at(200, 400), phone, options), { x: 200, y: 400 - away });
});

test('loupeCenter perto da borda de cima vai para o lado com mais espaço, na altura do dedo', () => {
  assert.deepEqual(loupeCenter(at(50, 100), phone, options), { x: 50 + away, y: 100 });
  assert.deepEqual(loupeCenter(at(340, 100), phone, options), { x: 340 - away, y: 100 });
  // Rente ao topo: a lupa desce só o bastante para caber na tela.
  assert.deepEqual(loupeCenter(at(340, 2), phone, options), { x: 340 - away, y: 8 + radius });
});

test('loupeCenter perto da borda do lado continua acima, encostada na borda', () => {
  assert.deepEqual(loupeCenter(at(4, 400), phone, options), { x: 8 + radius, y: 400 - away });
  assert.deepEqual(loupeCenter(at(388, 400), phone, options), { x: 390 - 8 - radius, y: 400 - away });
});

test('loupeCenter em tela estreita, sem espaço em cima nem dos lados, vai para baixo', () => {
  const narrow = { width: 320, height: 568 };
  assert.deepEqual(loupeCenter(at(160, 90), narrow, options), { x: 160, y: 90 + away });
});

test('loupeCenter deixa descobertos o dedo e o canto quando o dedo passa da borda da foto', () => {
  // Canto preso na borda de baixo da foto, dedo 100 px abaixo: a lupa fica acima do canto, não só do dedo.
  const center = loupeCenter({ left: 200, right: 200, top: 450, bottom: 550 }, phone, options);
  assert.deepEqual(center, { x: 200, y: 450 - away });
  assert.ok(clearOf(center, 200, 450) && clearOf(center, 200, 550));
});

test('loupeCenter nunca sai da tela nem cobre o ponto, em pé, deitado e no computador', () => {
  for (const screen of [phone, { width: 664, height: 390 }, { width: 1280, height: 800 }]) {
    for (let x = 0; x <= screen.width; x += 5) {
      for (let y = 0; y <= screen.height; y += 5) {
        const center = loupeCenter(at(x, y), screen, options);
        assert.ok(onScreen(center, screen), `fora da tela em ${x},${y} (${screen.width}×${screen.height})`);
        assert.ok(clearOf(center, x, y), `cobre o ponto ${x},${y} (${screen.width}×${screen.height})`);
      }
    }
  }
});

test('loupeCenter com o ponteiro fora da tela (mouse arrastado para fora) ainda deixa a lupa dentro dela', () => {
  for (const [x, y] of [[-200, -200], [-50, 300], [600, 300], [200, 900], [900, 900]]) {
    assert.ok(onScreen(loupeCenter(at(x, y), phone, options), phone), `${x},${y}`);
  }
  assert.ok(onScreen(loupeCenter(at(100, 100), phone), phone), 'com o tamanho padrão');
});
