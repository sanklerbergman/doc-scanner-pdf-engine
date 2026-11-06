import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NUDGES, NUDGE_STEP, nudgeOf } from '../web/js/edit-nudge.js';

test('nudgeOf: cada seta do teclado anda o passo de 1% para o lado dela', () => {
  assert.deepEqual(nudgeOf('ArrowLeft'), [-NUDGE_STEP, 0]);
  assert.deepEqual(nudgeOf('ArrowRight'), [NUDGE_STEP, 0]);
  assert.deepEqual(nudgeOf('ArrowUp'), [0, -NUDGE_STEP]);
  assert.deepEqual(nudgeOf('ArrowDown'), [0, NUDGE_STEP]);
  assert.equal(NUDGE_STEP, 0.01);
});

test('nudgeOf: outro passo (o Shift no recorte) e outras teclas', () => {
  assert.deepEqual(nudgeOf('ArrowDown', 0.05), [0, 0.05]);
  assert.equal(nudgeOf('Enter'), null);
  assert.equal(nudgeOf('a'), null);
});

test('os botões das setas fazem o mesmo que as teclas, com um nome para mover e outro para o tamanho', () => {
  assert.deepEqual(NUDGES.map(({ key }) => key), ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']);
  for (const nudge of NUDGES) {
    assert.deepEqual([nudge.dx * NUDGE_STEP, nudge.dy * NUDGE_STEP], nudgeOf(nudge.key));
    assert.ok(nudge.move && nudge.grow && nudge.move !== nudge.grow);
  }
});
