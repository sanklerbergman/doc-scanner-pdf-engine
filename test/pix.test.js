import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc16, pixPayload } from '../web/js/pix.js';

test('crc16 bate com o valor de referência do CRC-16/CCITT-FALSE', () => {
  assert.equal(crc16('123456789'), '29B1');
});

test('pixPayload monta os campos com tamanhos corretos e CRC válido', () => {
  const code = pixPayload('123e4567-e89b-12d3-a456-426614174000', { name: 'SCANNER DOC', city: 'BRASIL' });
  assert.ok(code.startsWith('00020126580014BR.GOV.BCB.PIX0136123e4567-e89b-12d3-a456-426614174000'));
  assert.ok(code.includes('5204000053039865802BR5911SCANNER DOC6006BRASIL62070503***6304'));
  assert.equal(code.slice(-4), crc16(code.slice(0, -4)));
});

test('pixPayload corta nome e cidade nos limites do padrão', () => {
  const code = pixPayload('chave', { name: 'N'.repeat(40), city: 'C'.repeat(40) });
  assert.ok(code.includes(`5925${'N'.repeat(25)}6015${'C'.repeat(15)}62`));
});
