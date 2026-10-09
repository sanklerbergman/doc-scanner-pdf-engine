import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRanges } from '../web/js/ranges.js';

test('intervalos, páginas soltas e "até o fim"', () => {
  assert.deepEqual(parseRanges('1-3, 4-5', 6), [[0, 1, 2], [3, 4]]);
  assert.deepEqual(parseRanges(' 2 ; 6 ', 6), [[1], [5]]);
  assert.deepEqual(parseRanges('5-', 6), [[4, 5]]);
  assert.deepEqual(parseRanges('1 a 2,3–4', 4), [[0, 1], [2, 3]]);
});

test('mensagens claras para o que não dá', () => {
  assert.throws(() => parseRanges('', 3), /Escreva os intervalos/);
  assert.throws(() => parseRanges('1-x', 3), /Não entendi "1-x"/);
  assert.throws(() => parseRanges('2-9', 3), /página 9 não existe: a lista tem 3 páginas/);
  assert.throws(() => parseRanges('3-1', 3), /o começo vem depois do fim/);
  assert.throws(() => parseRanges('0-1', 3), /começam no 1/);
});
