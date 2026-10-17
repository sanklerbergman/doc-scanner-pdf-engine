import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ocrWorkers, remainingTime, remainingText, progressNote, MANY_PAGES } from '../web/js/ocr-plan.js';

test('dois motores só com memória e núcleos sobrando e com 3 páginas ou mais', () => {
  const desktop = { deviceMemory: 8, hardwareConcurrency: 8 };
  assert.equal(ocrWorkers(desktop, 3), 2);
  assert.equal(ocrWorkers(desktop, 40), 2);
  assert.equal(ocrWorkers(desktop, 2), 1, 'poucas páginas: ligar outro motor não compensa');
  assert.equal(ocrWorkers({ deviceMemory: 4, hardwareConcurrency: 8 }, 10), 1);
  assert.equal(ocrWorkers({ deviceMemory: 8, hardwareConcurrency: 2 }, 10), 1);
});

test('sem a memória informada (Safari, iPhone), um motor só', () => {
  assert.equal(ocrWorkers({ hardwareConcurrency: 6 }, 10), 1);
  assert.equal(ocrWorkers({ deviceMemory: undefined, hardwareConcurrency: undefined }, 10), 1);
  assert.equal(ocrWorkers(undefined, 10), 1);
});

test('tempo que falta pela média das páginas prontas', () => {
  assert.equal(remainingTime(20000, 2, 10), 80000);
  assert.equal(remainingTime(9000, 3, 4), 3000);
  assert.equal(remainingTime(5000, 0, 10), null, 'nenhuma página pronta: sem estimativa');
  assert.equal(remainingTime(0, 1, 10), null);
  assert.equal(remainingTime(30000, 10, 10), null, 'acabou');
});

test('estimativa arredondada ao minuto, sem prometer precisão', () => {
  assert.equal(remainingText(null), '');
  assert.equal(remainingText(NaN), '');
  assert.equal(remainingText(10000), ' (falta menos de 1 minuto)');
  assert.equal(remainingText(44999), ' (falta menos de 1 minuto)');
  assert.equal(remainingText(50000), ' (falta mais ou menos 1 minuto)');
  assert.equal(remainingText(89000), ' (falta mais ou menos 1 minuto)');
  assert.equal(remainingText(95000), ' (faltam uns 2 minutos)');
  assert.equal(remainingText(7.4 * 60000), ' (faltam uns 7 minutos)');
});

test('andamento: o tempo que falta depois da primeira página; antes, o aviso só com muitas páginas', () => {
  assert.equal(progressNote(0, 0, 5), '', 'poucas páginas: nada antes da primeira');
  assert.equal(progressNote(0, 0, MANY_PAGES - 1), '');
  assert.equal(progressNote(0, 0, 40), ' São 40 páginas: pode levar alguns minutos.');
  assert.equal(progressNote(3000, 1, 40), ' (faltam uns 2 minutos)', '3 s por página, 39 páginas');
  assert.equal(progressNote(6000, 2, 5), ' (falta menos de 1 minuto)');
  assert.equal(progressNote(6000, 5, 5), '', 'acabou');
});
