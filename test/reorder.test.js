import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveItem, newIndex, dropIndex, shiftOffsets, bounds, clampShift, edgeSpeed, EDGE, MAX_SPEED, BOOST, BOOST_MS } from '../web/js/reorder.js';

// Cartões de 100 × 150 com 10 de espaço, `columns` por linha, como a grade da lista de páginas.
function grid(count, columns, { width = 100, height = 150, gap = 10 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const left = (i % columns) * (width + gap);
    const top = Math.floor(i / columns) * (height + gap);
    return { left, top, right: left + width, bottom: top + height };
  });
}
const center = ({ left, top, right, bottom }) => ({ x: (left + right) / 2, y: (top + bottom) / 2 });

test('moveItem leva o item para a posição final, sem mudar a lista original', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveItem(list, 2, 0), ['c', 'a', 'b', 'd']);
  assert.deepEqual(moveItem(list, 0, 3), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveItem(list, 1, 2), ['a', 'c', 'b', 'd']);
  assert.deepEqual(moveItem(list, 1, 1), list);
  assert.notEqual(moveItem(list, 1, 1), list);
  assert.deepEqual(list, ['a', 'b', 'c', 'd']);
  assert.deepEqual(moveItem(['só'], 0, 0), ['só']);
});

test('newIndex diz onde cada item foi parar, igual ao moveItem', () => {
  const list = [0, 1, 2, 3, 4, 5];
  for (let from = 0; from < list.length; from++) {
    for (let to = 0; to < list.length; to++) {
      const moved = moveItem(list, from, to);
      for (const i of list) assert.equal(moved[newIndex(i, from, to)], i, `de ${from} para ${to}, item ${i}`);
    }
  }
});

test('dropIndex numa coluna só: a altura decide, também fora da largura e entre os cartões', () => {
  const rects = grid(4, 1);
  assert.equal(dropIndex(rects, { x: 50, y: 10 }), 0);
  assert.equal(dropIndex(rects, { x: 50, y: 400 }), 2);
  assert.equal(dropIndex(rects, { x: 900, y: 400 }), 2); // o dedo saiu para o lado
  assert.equal(dropIndex(rects, { x: 50, y: 152 }), 0); // no espaço entre o 1º e o 2º, mais perto do 1º
  assert.equal(dropIndex(rects, { x: 50, y: 158 }), 1);
  assert.equal(dropIndex(rects, { x: 50, y: -500 }), 0); // acima da lista
  assert.equal(dropIndex(rects, { x: 50, y: 5000 }), 3); // abaixo da lista
});

test('dropIndex numa coluna só com alturas diferentes (foto, Word, PDF)', () => {
  const rects = [
    { left: 0, top: 0, right: 300, bottom: 600 },
    { left: 0, top: 616, right: 300, bottom: 1156 },
    { left: 0, top: 1172, right: 300, bottom: 1772 },
  ];
  assert.equal(dropIndex(rects, { x: 150, y: 620 }), 1);
  assert.equal(dropIndex(rects, { x: 150, y: 1160 }), 1);
  assert.equal(dropIndex(rects, { x: 150, y: 1170 }), 2);
});

test('dropIndex na grade de várias colunas: linha e coluna', () => {
  const rects = grid(7, 3); // 3 + 3 + 1
  rects.forEach((rect, i) => assert.equal(dropIndex(rects, center(rect)), i));
  assert.equal(dropIndex(rects, { x: 160, y: 75 }), 1); // um pouco à esquerda do centro do 2º
  assert.equal(dropIndex(rects, { x: 104, y: 75 }), 0); // no espaço entre colunas, mais perto do 1º
  assert.equal(dropIndex(rects, { x: 270, y: 240 }), 5); // 2ª linha, 3ª coluna
  assert.equal(dropIndex(rects, { x: 270, y: 400 }), 6); // depois do último, na última linha: o último
  assert.equal(dropIndex(rects, { x: 900, y: 75 }), 2); // à direita da 1ª linha
});

test('dropIndex com um cartão só e com a lista vazia', () => {
  assert.equal(dropIndex(grid(1, 1), { x: 999, y: 999 }), 0);
  assert.equal(dropIndex([], { x: 0, y: 0 }), -1);
});

test('shiftOffsets numa coluna: os do meio andam a altura do arrastado mais o espaço', () => {
  const rects = [
    { left: 0, top: 0, right: 300, bottom: 600 },
    { left: 0, top: 616, right: 300, bottom: 1156 },
    { left: 0, top: 1172, right: 300, bottom: 1772 },
    { left: 0, top: 1788, right: 300, bottom: 2388 },
  ];
  // A 3ª (600 de altura) vai para o começo: a 1ª e a 2ª descem 616; a 4ª fica.
  assert.deepEqual(shiftOffsets(rects, 2, 0), [{ x: 0, y: 616 }, { x: 0, y: 616 }, { x: 0, y: 0 }, { x: 0, y: 0 }]);
  // A 2ª (540 de altura) vai para o fim: a 3ª e a 4ª sobem 556.
  assert.deepEqual(shiftOffsets(rects, 1, 3), [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: -556 }, { x: 0, y: -556 }]);
  // No mesmo lugar, ninguém anda.
  assert.ok(shiftOffsets(rects, 1, 1).every(({ x, y }) => x === 0 && y === 0));
});

test('shiftOffsets na grade: cada um vai para o lugar do vizinho, também trocando de linha', () => {
  const rects = grid(5, 3);
  // O 5º (2ª linha, 2ª coluna) vai para o começo: 1º → 2º, 2º → 3º, 3º → 4º (desce e volta à 1ª coluna), 4º → 5º.
  assert.deepEqual(shiftOffsets(rects, 4, 0), [
    { x: 110, y: 0 }, { x: 110, y: 0 }, { x: -220, y: 160 }, { x: 110, y: 0 }, { x: 0, y: 0 },
  ]);
  assert.deepEqual(shiftOffsets(rects, 0, 2), [
    { x: 0, y: 0 }, { x: -110, y: 0 }, { x: -110, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
  ]);
});

test('clampShift prende o cartão arrastado dentro da área dos cartões', () => {
  const rects = grid(5, 3);
  const area = bounds(rects);
  assert.deepEqual(area, { left: 0, top: 0, right: 320, bottom: 310 });
  assert.deepEqual(clampShift(rects[4], area, 30, -40), { x: 30, y: -40 });
  assert.deepEqual(clampShift(rects[4], area, 999, 999), { x: 110, y: 0 }); // não passa da direita nem de baixo
  assert.deepEqual(clampShift(rects[4], area, -999, -999), { x: -110, y: -160 });
  // Numa coluna só, não sai para os lados.
  const column = grid(3, 1);
  assert.deepEqual(clampShift(column[1], bounds(column), 50, 20), { x: 0, y: 20 });
});

test('edgeSpeed rola perto das bordas, mais rápido quanto mais perto, e para no meio', () => {
  assert.equal(edgeSpeed(332, 664), 0);
  assert.equal(edgeSpeed(EDGE, 664), 0);
  assert.equal(edgeSpeed(664 - EDGE, 664), 0);
  assert.equal(edgeSpeed(0, 664), -MAX_SPEED);
  assert.equal(edgeSpeed(664, 664), MAX_SPEED);
  assert.equal(edgeSpeed(-50, 664), -MAX_SPEED); // o dedo passou da borda
  assert.equal(edgeSpeed(EDGE / 2, 664), -MAX_SPEED / 2);
  assert.ok(edgeSpeed(640, 664) > edgeSpeed(600, 664));
  // Tela baixa: a faixa encolhe para um quinto da altura.
  assert.equal(edgeSpeed(70, 300), 0);
  assert.equal(edgeSpeed(60, 300), 0);
  assert.equal(edgeSpeed(30, 300), -MAX_SPEED / 2);
});

test('edgeSpeed acelera com o dedo parado na faixa, até BOOST vezes', () => {
  assert.equal(edgeSpeed(0, 664, 0), -MAX_SPEED);
  assert.equal(edgeSpeed(0, 664, BOOST_MS / 2), -MAX_SPEED * (1 + BOOST) / 2);
  assert.equal(edgeSpeed(664, 664, BOOST_MS), MAX_SPEED * BOOST);
  assert.equal(edgeSpeed(664, 664, BOOST_MS * 10), MAX_SPEED * BOOST);
  assert.equal(edgeSpeed(332, 664, BOOST_MS), 0); // no meio da tela, nada
});
