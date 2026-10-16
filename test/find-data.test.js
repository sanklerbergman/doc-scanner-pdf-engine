// Busca de dados para tarjar (find-data.js): padrões brasileiros, dígitos verificadores, falsos positivos comuns
// e a área de cada dado na página.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSensitive, findInPieces, padRect, validCpf, validCnpj, validLuhn } from '../web/js/find-data.js';

const found = (text) => findSensitive(text).map(({ type, value }) => `${type}:${value}`);

test('CPF: válido com e sem pontuação; dígito errado e números repetidos não', () => {
  assert.ok(validCpf('529.982.247-25') && validCpf('52998224725'));
  assert.ok(!validCpf('529.982.247-26') && !validCpf('111.111.111-11') && !validCpf('1234567890'));
  assert.deepEqual(found('CPF: 529.982.247-25, ou 52998224725, ou 529982247-25.'), ['cpf:529.982.247-25', 'cpf:52998224725', 'cpf:529982247-25']);
  assert.deepEqual(found('CPF 529.982.247-26 e 111.111.111-11'), []);
});

test('CNPJ: numérico e alfanumérico (Receita, 2026), com o dígito verificador', () => {
  assert.ok(validCnpj('11.222.333/0001-81') && validCnpj('11222333000181'));
  // Exemplo oficial de CNPJ alfanumérico da Receita Federal.
  assert.ok(validCnpj('12.ABC.345/01DE-35') && validCnpj('12ABC34501DE35'));
  assert.ok(!validCnpj('11.222.333/0001-82') && !validCnpj('12.ABC.345/01DE-36') && !validCnpj('00.000.000/0000-00'));
  assert.deepEqual(found('CNPJ 11.222.333/0001-81; 11222333000181; filial 12.ABC.345/01DE-35'),
    ['cnpj:11.222.333/0001-81', 'cnpj:11222333000181', 'cnpj:12.ABC.345/01DE-35']);
  // Alfanumérico sem pontuação poderia ser qualquer palavra: só com a máscara.
  assert.deepEqual(found('código 12ABC34501DE35'), []);
});

test('e-mail, telefone (com DDD, +55, celular e fixo), CEP e cartão (Luhn)', () => {
  assert.deepEqual(found('maria.silva+teste@exemplo.com.br'), ['email:maria.silva+teste@exemplo.com.br']);
  assert.deepEqual(found('(11) 91234-5678, +55 21 3333-4444, 11 98765-4321, 3333-4444 e 91234-5678'),
    ['telefone:(11) 91234-5678', 'telefone:+55 21 3333-4444', 'telefone:11 98765-4321', 'telefone:3333-4444', 'telefone:91234-5678']);
  assert.deepEqual(found('(01) 91234-5678 e (10) 3333-4444'), [], 'DDD com zero não existe');
  assert.deepEqual(found('CEP 01310-100, CEP: 01310100 e 01.310-100'), ['cep:01310-100', 'cep:01310100', 'cep:01.310-100']);
  assert.ok(validLuhn('4111 1111 1111 1111') && !validLuhn('4111 1111 1111 1112'));
  assert.deepEqual(found('4111 1111 1111 1111, 5555-5555-5555-4444 e 4111111111111112'), ['cartao:4111 1111 1111 1111', 'cartao:5555-5555-5555-4444']);
});

test('falsos positivos comuns: processo, datas, valores, protocolo, boleto e número dentro de outro maior', () => {
  const texts = [
    'Processo nº 0001234-56.2026.8.26.0100',
    'Data: 16/10/2026, 2026-10-16 e 16.10.2026',
    'Valor: R$ 1.234.567,89 e R$ 52.998,22',
    'Protocolo 2026/123456 e matrícula 1234567',
    'Linha digitável 23793.38128 60082.677139 66000.063305 9 86650000010000',
    'Código 152998224725 e 5299822472500', // o CPF 52998224725 dentro de um número maior
    'Hora 10:30 e página 1-3',
  ];
  for (const text of texts) assert.deepEqual(found(text), [], text);
});

test('sem sobreposição: o CPF não aparece também como telefone, e o texto original volta como estava', () => {
  const results = findSensitive('CPF 529.982.247-25');
  assert.equal(results.length, 1);
  assert.equal(results[0].value, '529.982.247-25');
  assert.equal(results[0].start, 4);
});

// Trechos de uma linha (como vêm do layout do Word ou do PDF.js), com a posição de cada letra.
function piece(str, x0, charWidth, y0 = 0.1, y1 = 0.12) {
  return { str, xs: Array.from({ length: str.length + 1 }, (_, i) => x0 + i * charWidth), y0, y1 };
}

test('área do dado: só os caracteres dele, mesmo quando o dado está dividido em trechos', () => {
  const size = { width: 600, height: 800 };
  // "CPF: " e o número em dois trechos colados (ex.: negrito e normal), e outra linha mais abaixo.
  const pieces = [piece('CPF: ', 0.1, 0.01), piece('529.982.', 0.15, 0.01), piece('247-25 fim', 0.23, 0.01), piece('E-mail a@b.com', 0.1, 0.01, 0.2, 0.22)];
  const results = findInPieces(pieces, size);
  assert.deepEqual(results.map((r) => `${r.type}:${r.value}`), ['cpf:529.982.247-25', 'email:a@b.com']);
  const cpf = results[0].rect;
  assert.ok(Math.abs(cpf.x0 - 0.15) < 1e-9 && Math.abs(cpf.x1 - 0.29) < 1e-9, JSON.stringify(cpf));
  assert.deepEqual([cpf.y0, cpf.y1], [0.1, 0.12]);
  assert.ok(Math.abs(results[1].rect.x0 - 0.17) < 1e-9, 'o e-mail começa depois de "E-mail "');
});

test('palavras do OCR separadas por espaço viram um texto só; palavras longe não se juntam ao número', () => {
  const size = { width: 1000, height: 1000 };
  // "CPF" e o número em palavras separadas por um espaço visível.
  const words = [piece('CPF', 0.1, 0.01), piece('529.982.247-25', 0.15, 0.01)];
  assert.deepEqual(findInPieces(words, size).map((r) => r.value), ['529.982.247-25']);
  // "529.982" e "247-25" muito afastados (outra coluna): não formam um CPF.
  const columns = [piece('529.982.', 0.1, 0.01), piece('247-25', 0.6, 0.01)];
  assert.deepEqual(findInPieces(columns, size), []);
});

test('margem da tarja: cresce em volta, proporcional à altura, sem sair da página', () => {
  const rect = padRect({ x0: 0.5, y0: 0.1, x1: 0.6, y1: 0.12 }, { width: 1000, height: 1000 }, 0.5);
  assert.ok(Math.abs(rect.y0 - 0.09) < 1e-9 && Math.abs(rect.y1 - 0.13) < 1e-9 && Math.abs(rect.x0 - 0.49) < 1e-9);
  assert.deepEqual(padRect({ x0: 0, y0: 0, x1: 1, y1: 1 }, { width: 1, height: 1 }), { x0: 0, y0: 0, x1: 1, y1: 1 });
});
