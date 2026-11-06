import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paperAnnouncement, PAPER_IDLE, PAPER_SETTLE_MS, PAPER_GAP_MS } from '../web/js/camera.js';

// Simula o laço da câmera (uma leitura a cada 400 ms) e devolve os anúncios com o instante em que saíram.
function run(readings, { start = 0, step = 400, busyUntil = () => -Infinity } = {}) {
  let state = PAPER_IDLE;
  const said = [];
  readings.forEach((found, i) => {
    const now = start + i * step;
    const out = paperAnnouncement(state, found, now, busyUntil(now));
    state = out.state;
    if (out.announce !== null) said.push([now, out.announce]);
  });
  return said;
}
const repeat = (value, n) => Array(n).fill(value);

test('o estado só é anunciado depois de se manter por um segundo', () => {
  assert.deepEqual(run(repeat(false, 3)), [], 'em 800 ms ainda não fala');
  assert.deepEqual(run(repeat(false, 4)), [[1200, false]]);
});

test('o mesmo estado não é repetido', () => {
  assert.deepEqual(run(repeat(true, 40)), [[1200, true]]);
});

test('o tremor da mão (achou, perdeu, achou) não gera anúncio', () => {
  const shaky = [...repeat(true, 5), false, true, false, true, true, false, ...repeat(true, 10)];
  assert.deepEqual(run(shaky), [[1200, true]]);
});

test('mudança firme é anunciada, respeitando o intervalo mínimo entre anúncios', () => {
  const said = run([...repeat(true, 4), ...repeat(false, 20)]);
  assert.deepEqual(said.map(([, found]) => found), [true, false]);
  const [[first], [second]] = said;
  assert.ok(second - first >= PAPER_GAP_MS, `anúncios a ${second - first} ms`);
  assert.ok(second - 1600 >= PAPER_SETTLE_MS);
});

test('um aviso prioritário recente adia o anúncio, que sai depois', () => {
  const said = run(repeat(true, 20), { busyUntil: () => 3000 });
  assert.deepEqual(said, [[3200, true]]);
});

test('estado que volta ao anunciado antes de assentar não é falado', () => {
  const said = run([...repeat(true, 4), false, false, ...repeat(true, 20)]);
  assert.deepEqual(said, [[1200, true]]);
});
