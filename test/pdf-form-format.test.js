// Formatos do Acrobat nos formulários (pdf-form-format.js): leitura das chamadas sem rodar o script, formatação do
// valor digitado, dica e teclado, falha fechada e os scripts reais do pedido de restituição da Receita.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCall, readFieldFormat, formatFieldValue, fieldInputHints } from '../web/js/pdf-form-format.js';

// Formata vários valores de uma vez: { digitado: esperado }. Esperado null: o valor não serve e volta como digitado.
function check(spec, cases) {
  for (const [typed, expected] of Object.entries(cases)) {
    const result = formatFieldValue(spec, typed);
    if (expected === null) {
      assert.equal(result.ok, false, `"${typed}" não devia servir`);
      assert.equal(result.text, typed.trim());
      assert.ok(result.message);
    } else {
      assert.equal(result.ok, true, `"${typed}": ${result.message}`);
      assert.equal(result.text, expected, `"${typed}"`);
      // Formatar de novo o que já saiu formatado não muda nada.
      assert.equal(formatFieldValue(spec, result.text).text, expected, `de novo: "${expected}"`);
    }
  }
}

const number = (args) => readFieldFormat(`AFNumber_Format(${args});`, `AFNumber_Keystroke(${args});`);

test('parseCall: só uma chamada com argumentos literais, com os escapes do JavaScript', () => {
  assert.deepEqual(parseCall('AFNumber_Format(2, 2, 0, 0, "", true);'), { name: 'AFNumber_Format', args: [2, 2, 0, 0, '', true] });
  assert.deepEqual(parseCall(String.raw`  AFNumber_Format(2,2,0,0,"R$ ",false)  ` + '\r\n'), { name: 'AFNumber_Format', args: [2, 2, 0, 0, 'R$ ', false] });
  assert.deepEqual(parseCall(String.raw`f('a\'b', "\x41\u{1F600}\n", -1.5)`), { name: 'f', args: ["a'b", 'A\u{1F600}\n', -1.5] });
  assert.deepEqual(parseCall('validarCNPJ();'), { name: 'validarCNPJ', args: [] });
  for (const js of [
    'AFNumber_Format(2, 2, 0, 0, "", true); AFNumber_Format(2, 2, 0, 0, "", true);', // duas chamadas
    'AFNumber_Format(2, 2, 0, 0, "", true);;',
    'AFNumber_Format(2, 2, 0, 0, "", true); // comentário',
    'AFNumber_Format(event.value)', // variável
    'AFNumber_Format(1 + 1)', // expressão
    'AFNumber_Format(2,)', // vírgula sobrando
    'AFNumber_Format("sem fim)',
    String.raw`AFNumber_Format("\u12")`, // escape incompleto
    String.raw`AFNumber_Format("\101")`, // octal
    'if (event.value) AFNumber_Format(2, 2, 0, 0, "", true);',
    'AFNumber_Format',
    '',
    'x'.repeat(2000),
  ]) assert.equal(parseCall(js), null, js.slice(0, 60));
  assert.equal(parseCall(undefined), null);
});

test('scripts reais do pedido de restituição da Receita (anexo I da IN RFB 2.055): formato, moeda e máscaras', () => {
  // Os textos do /AA /F e /AA /K como estão no PDF, um de cada combinação (531 campos com /AA, 9 combinações).
  const valor = number('2, 2, 0, 0, ""');
  assert.equal(valor, null, 'cinco argumentos: falta o da moeda antes');
  const operacao = readFieldFormat('AFNumber_Format(2, 2, 0, 0, "", true);', 'AFNumber_Keystroke(2, 2, 0, 0, "", true);');
  assert.deepEqual(operacao, { kind: 'number', decimals: 2, separator: 2, negative: 0, currency: '', prepend: true });
  check(operacao, { '1234,5': '1.234,50', '1234567,891': '1.234.567,89', 0: '0,00', 'mil': null });
  const credito = readFieldFormat(String.raw`AFNumber_Format(2, 2, 0, 0, "R$ ", true);`,
    String.raw`AFNumber_Keystroke(2, 2, 0, 0, "R$ ", true);`);
  assert.deepEqual(credito, { kind: 'number', decimals: 2, separator: 2, negative: 0, currency: 'R$ ', prepend: true });
  check(credito, { '1234,56': 'R$ 1.234,56', 'R$ 10': 'R$ 10,00', '-5': '-R$ 5,00' });
  assert.deepEqual(fieldInputHints(credito), { placeholder: 'R$ 0,00', inputMode: 'decimal' });

  // Máscaras só no teclado; o validarCNPJ() e o validarCPF() ficam no /AA /V, que não é lido.
  const masks = {
    '99.999.999/9999-99': ['11222333000181', '11.222.333/0001-81', '00.000.000/0000-00'],
    '999.999.999-99': ['52998224725', '529.982.247-25', '000.000.000-00'],
    '99/99/9999': ['05022024', '05/02/2024', '00/00/0000'],
    '99/9999': ['022024', '02/2024', '00/0000'],
    9999: ['2024', '2024', '0000'],
    '99999.999999/9999.99': ['10880123456202412', '10880.123456/2024.12', '00000.000000/0000.00'],
  };
  for (const [mask, [typed, formatted, hint]] of Object.entries(masks)) {
    const spec = readFieldFormat(undefined, `AFSpecial_KeystrokeEx("${mask}");`);
    assert.deepEqual(spec, { kind: 'mask', mask });
    check(spec, { [typed]: formatted });
    assert.deepEqual(fieldInputHints(spec), { placeholder: hint, inputMode: 'numeric' });
  }
  // Os 20 campos de PIS/Pasep têm /AA vazio, e a validação é função própria do formulário.
  assert.equal(readFieldFormat(undefined, undefined), null);
  assert.equal(readFieldFormat('validarCNPJ();', undefined), null);
  assert.equal(readFieldFormat(undefined, 'validarCPF();'), null);
});

test('AFNumber_Format: os cinco estilos de separador', () => {
  const expected = ['1,234,567.89', '1234567.89', '1.234.567,89', '1234567,89', "1'234'567.89"];
  expected.forEach((text, separator) => {
    const spec = number(`2, ${separator}, 0, 0, "", true`);
    assert.equal(spec.separator, separator);
    check(spec, { '1234567,891': text, 999: separator === 0 || separator === 1 || separator === 4 ? '999.00' : '999,00' });
  });
  check(number('0, 2, 0, 0, "", true'), { '1234,5': '1.235', '0,4': '0' });
  check(number('3, 0, 0, 0, "", true'), { '1,2345': '1.235' });
  assert.equal(number('2, 5, 0, 0, "", true'), null, 'estilo 5 não existe');
});

test('AFNumber_Format: moeda antes e depois, e os quatro estilos de negativo', () => {
  check(number('2, 2, 0, 0, " €", false'), { '1234,5': '1.234,50 €', '-1234,5': '-1.234,50 €' });
  check(number('2, 0, 0, 0, "$", true'), { '-1234.5': '-$1,234.50' });
  const styles = [
    ['2, 2, 0, 0, "R$ ", true', '-R$ 1.234,56', false],
    ['2, 2, 1, 0, "R$ ", true', 'R$ 1.234,56', true],
    ['2, 2, 2, 0, "R$ ", true', '(R$ 1.234,56)', false],
    ['2, 2, 3, 0, "R$ ", true', '(R$ 1.234,56)', true],
  ];
  for (const [args, text, red] of styles) {
    assert.deepEqual(formatFieldValue(number(args), '-1234,56'), { ok: true, text, red }, args);
    assert.deepEqual(formatFieldValue(number(args), '1234,56'), { ok: true, text: 'R$ 1.234,56', red: false }, args);
  }
  check(number('2, 2, 2, 0, "R$ ", true'), { '(1234,56)': '(R$ 1.234,56)' });
  check(number('2, 2, 2, 0, " €", false'), { '-1234,56': '(1.234,56 €)' });
  // Negativo que arredonda para zero perde o sinal e a cor.
  assert.deepEqual(formatFieldValue(number('2, 2, 3, 0, "", true'), '-0,001'), { ok: true, text: '0,00', red: false });
});

test('número digitado do jeito brasileiro ou americano, arredondado sem ponto flutuante', () => {
  // Campo com vírgula decimal (estilo 2): ponto com três algarismos é milhar.
  check(number('2, 2, 0, 0, "", true'), {
    '1.234,56': '1.234,56', '1,234.56': '1.234,56', '1.234': '1.234,00', '1.5': '1,50', '1234.567': '1.234,57',
    '1.234.567': '1.234.567,00', '1 234,5': '1.234,50', ',5': '0,50', '5,': '5,00', '+7': '7,00', '007': '7,00',
    '2,345': '2,35', '9,999': '10,00', '0,005': '0,01', '1,005': '1,01', '99999999999999999999,995': '100.000.000.000.000.000.000,00',
    abc: null, '12a': null, '1.23.4': null, '1,2,3': null, '1e3': null, '--1': null, '(-1)': null, ',': null, '1.234,5,6': null,
  });
  // Campo com ponto decimal (estilo 0): vírgula sozinha continua sendo decimal, como se digita no Brasil.
  check(number('2, 0, 0, 0, "", true'), { '1.234,56': '1,234.56', '1,5': '1.50', '1.234': '1.23', '1,234,567': '1,234,567.00' });
});

test('AFPercent_Format: o número digitado já é a porcentagem; % antes ou depois', () => {
  const spec = readFieldFormat('AFPercent_Format(2, 0);', 'AFPercent_Keystroke(2, 0);');
  assert.deepEqual(spec, { kind: 'percent', decimals: 2, separator: 0, prepend: false });
  check(spec, { 15: '15.00%', '15,5%': '15.50%', '-3': '-3.00%', '1234.5': '1,234.50%', 'muito': null });
  check(readFieldFormat('AFPercent_Format(1, 2, true);', 'AFPercent_Keystroke(1, 2);'), { '12,34': '%12,3' });
  check(readFieldFormat('AFPercent_Format(0, 3);', ''), { '99,5': '100%' });
  assert.deepEqual(fieldInputHints(spec), { placeholder: '0.00%', inputMode: 'decimal' });
  assert.equal(readFieldFormat('AFPercent_Format(2, 0, false, 1);', null), null, 'argumento a mais');
  assert.equal(readFieldFormat(null, 'AFPercent_Keystroke(2, 0, true);'), null, 'o de teclado não tem o terceiro');
});

test('AFDate_FormatEx: datas válidas e impossíveis, ano bissexto, só algarismos e nome do mês', () => {
  const spec = readFieldFormat('AFDate_FormatEx("dd/mm/yyyy");', 'AFDate_KeystrokeEx("dd/mm/yyyy");');
  assert.deepEqual(spec, { kind: 'date', format: 'dd/mm/yyyy', input: 'dd/mm/yyyy' });
  check(spec, {
    '05/02/2024': '05/02/2024', '5/2/24': '05/02/2024', '5-2-1999': '05/02/1999', '05022024': '05/02/2024', '050224': '05/02/2024',
    '5/2/49': '05/02/2049', '5/2/50': '05/02/1950', '5 de fevereiro de 2024': '05/02/2024', '5 fev. 2024': '05/02/2024', '5 Feb 2024': '05/02/2024',
    '29/02/2024': '29/02/2024', '29/02/2000': '29/02/2000', '31/12/2024': '31/12/2024',
    '29/02/2023': null, '29/02/1900': null, '31/02/2024': null, '31/04/2024': null, '32/01/2024': null, '00/01/2024': null, '10/13/2024': null,
    '05/02': null, '2024-02-05': null, '5/2/024': null, ontem: null, '05/02/2024 14:30': null, '0502202': null,
  });
  assert.equal(formatFieldValue(spec, '31/02/2024').message, 'Esta data não existe.');
  assert.equal(formatFieldValue(spec, 'ontem').message, 'Use o formato dd/mm/aaaa.');
  assert.deepEqual(fieldInputHints(spec), { placeholder: 'dd/mm/aaaa', inputMode: 'numeric' });

  check(readFieldFormat('AFDate_FormatEx("mm/dd/yy");', ''), { '2/29/24': '02/29/24', '12/31/2024': '12/31/24', '2/30/24': null });
  // Mês por extenso: sai em inglês, como no Acrobat; entra em inglês ou português.
  const named = readFieldFormat('AFDate_FormatEx("d-mmm-yyyy");', 'AFDate_KeystrokeEx("d-mmm-yyyy");');
  check(named, { '5/2/2024': '5-Feb-2024', '5 fev 2024': '5-Feb-2024', '5 março 2024': '5-Mar-2024', '31 set 2024': null, '5 xyz 2024': null });
  assert.deepEqual(fieldInputHints(named), { placeholder: 'd-mmm-aaaa', inputMode: 'text' });
  check(readFieldFormat('AFDate_FormatEx("yyyy-mm-dd HH:MM");', ''), {
    '2024-02-05 14:30': '2024-02-05 14:30', '2024-02-05 14': '2024-02-05 14:00', '202402051430': '2024-02-05 14:30',
    '2024-02-05 24:00': null, '2024-02-05': null,
  });
  // Letra literal só com a barra invertida antes de cada uma; sem ela, o "e" solto não é código e o formato é recusado.
  check(readFieldFormat(String.raw`AFDate_FormatEx("dddd, d \\d\\e mmmm \\d\\e yyyy");`, ''), { '05/02/2024': 'Monday, 5 de February de 2024' });
  assert.equal(readFieldFormat(String.raw`AFDate_FormatEx("d \\de mmmm");`, ''), null);
  // Teclado e formato diferentes: digita-se na ordem do teclado, e o texto mostrado também serve.
  check(readFieldFormat('AFDate_FormatEx("mmmm d, yyyy");', 'AFDate_KeystrokeEx("mm/dd/yyyy");'), {
    '02/05/2024': 'February 5, 2024', 'February 5, 2024': 'February 5, 2024',
  });
});

test('AFDate_Format e AFDate_Keystroke pelo índice; AFTime pela hora', () => {
  assert.deepEqual(readFieldFormat('AFDate_Format(2);', 'AFDate_Keystroke(2);'), { kind: 'date', format: 'mm/dd/yy', input: 'mm/dd/yy' });
  check(readFieldFormat('AFDate_Format(10);', 'AFDate_Keystroke(10);'), { '2/5/2024': 'Feb 5, 2024' });
  check(readFieldFormat('AFDate_Format(12);', ''), { '2/5/24 14:30': '2/5/24 2:30 pm' });
  assert.equal(readFieldFormat('AFDate_Format(14);', ''), null);
  assert.equal(readFieldFormat('AFDate_Format("2");', ''), null);

  const clock = readFieldFormat('AFTime_Format(0);', 'AFTime_Keystroke(0);');
  assert.deepEqual(clock, { kind: 'time', format: 'HH:MM', input: 'HH:MM' });
  check(clock, { '14:30': '14:30', '9:5': '09:05', 1430: '14:30', 930: '09:30', 9: '09:00', '14h30': '14:30', '2:30 pm': '14:30', '24:00': null, '14:60': null, '1:2:3': null });
  assert.equal(formatFieldValue(clock, '25:00').message, 'Esta hora não existe.');
  assert.deepEqual(fieldInputHints(clock), { placeholder: 'hh:mm', inputMode: 'numeric' });

  const ampm = readFieldFormat('AFTime_Format(1);', 'AFTime_Keystroke(1);');
  check(ampm, { '14:30': '2:30 pm', '2:30 PM': '2:30 pm', '2:30 p.m.': '2:30 pm', '0:05': '12:05 am', '12:00 am': '12:00 am', '12:00': '12:00 pm', '13:00 pm': null });
  assert.deepEqual(fieldInputHints(ampm), { placeholder: 'h:mm am/pm', inputMode: 'text' });
  check(readFieldFormat('AFTime_Format(3);', ''), { '23:59:59': '11:59:59 pm', '23:59': '11:59:00 pm', '23:59:60': null });
  const hours = readFieldFormat(String.raw`AFTime_FormatEx("HH\\hMM");`, String.raw`AFTime_KeystrokeEx("HH\\hMM");`);
  check(hours, { '14h30': '14h30', '14:30': '14h30', 1430: '14h30' });
  // Com letra literal, a dica é um exemplo ("hhhmm" não se entende).
  assert.deepEqual(fieldInputHints(hours), { placeholder: '23h59', inputMode: 'numeric' });
  assert.equal(formatFieldValue(hours, '25h00').message, 'Esta hora não existe.');
  assert.equal(formatFieldValue(hours, 'agora').message, 'Use o formato 23h59.');
  assert.equal(readFieldFormat('AFTime_Format(4);', ''), null);
});

test('AFSpecial_Format 0 a 3: CEP americano, CEP + 4, telefone e SSN', () => {
  const special = (style) => readFieldFormat(`AFSpecial_Format(${style});`, `AFSpecial_Keystroke(${style});`);
  assert.deepEqual(special(0), { kind: 'special', style: 0 });
  check(special(0), { 12345: '12345', 1234: null, 123456: null, '1234a': null });
  check(special(1), { 123456789: '12345-6789', '12345 6789': '12345-6789', 12345: null });
  check(special(2), { 5551234567: '(555) 123-4567', '555.123.4567': '(555) 123-4567', 1234567: '123-4567', 12345678: null, 11912345678: null });
  check(special(3), { 123456789: '123-45-6789', '123-45-678': null });
  assert.deepEqual(fieldInputHints(special(0)), { placeholder: '00000', inputMode: 'numeric' });
  assert.deepEqual(fieldInputHints(special(2)), { placeholder: '(000) 000-0000', inputMode: 'numeric' });
  assert.equal(readFieldFormat('AFSpecial_Format(4);', 'AFSpecial_Keystroke(4);'), null);
  assert.equal(readFieldFormat('AFSpecial_Format(2);', 'AFSpecial_Keystroke(3);'), null, 'formato e teclado diferentes');
});

test('AFSpecial_KeystrokeEx: CNPJ, CPF, CEP, telefone e máscaras com letras', () => {
  const mask = (text) => readFieldFormat(null, `AFSpecial_KeystrokeEx("${text}");`);
  const cnpj = mask('99.999.999/9999-99');
  check(cnpj, {
    11222333000181: '11.222.333/0001-81', '11.222.333/0001-81': '11.222.333/0001-81', '11 222 333 0001 81': '11.222.333/0001-81',
    '11.222.333/0001': null, 112223330001811: null, '12ABC34501DE35': null,
  });
  assert.equal(formatFieldValue(cnpj, '11.222.333/0001').message, 'Use o formato 00.000.000/0000-00.');
  check(mask('999.999.999-99'), { 52998224725: '529.982.247-25', '529 982 247 25': '529.982.247-25', 5299822472: null });
  check(mask('99999-999'), { '01310100': '01310-100', '01310-100': '01310-100', '01.310-100': '01310-100' });
  check(mask('(99) 99999-9999'), { 11912345678: '(11) 91234-5678', '11 91234 5678': '(11) 91234-5678', 1191234567: null });
  // A = letra, O = letra ou algarismo, X = qualquer.
  const plate = mask('AAA9O99');
  check(plate, { ABC1D23: 'ABC1D23', 'abc-1234': 'abc1234', AB12345: null });
  assert.deepEqual(fieldInputHints(plate), { placeholder: 'AAA0X00', inputMode: 'text' });
  check(mask('XX-99'), { 'a$12': 'a$-12' });
  assert.equal(mask(''), null);
  assert.equal(mask('---'), null, 'máscara sem nenhuma casa');
});

test('falha fechada: argumentos estranhos ou faltando, várias chamadas e função desconhecida', () => {
  const strange = [
    'AFNumber_Format(2, 2, 0, 0, "");', // falta um argumento
    'AFNumber_Format(2, 2, 0, 0, "", true, 1);',
    'AFNumber_Format("2", 2, 0, 0, "", true);',
    'AFNumber_Format(-1, 2, 0, 0, "", true);',
    'AFNumber_Format(2.5, 2, 0, 0, "", true);',
    'AFNumber_Format(2, 2, 4, 0, "", true);', // negativo 4 não existe
    'AFNumber_Format(2, 2, 0, 0, "R1", true);', // algarismo na moeda
    'AFNumber_Format(2, 2, 0, 0, ".", true);',
    'AFNumber_Format(2, 2, 0, 0, "", "true");',
    'AFNumber_Format(2, 2, 0, 0, "", true); AFNumber_Format(2, 0, 0, 0, "", true);',
    'AFDate_FormatEx("dd/mm/aaaa");', // letra que não é código
    'AFDate_FormatEx("yyy");',
    'AFDate_FormatEx("dd/yyyy");', // dia sem mês
    'AFDate_FormatEx("dd/dd/yyyy");',
    'AFDate_FormatEx(2);',
    'AFDate_FormatEx();',
    String.raw`AFDate_FormatEx("dd/mm/yyyy\\");`, // barra invertida sem nada depois
    'AFTime_FormatEx("tt");',
    'validarCNPJ();',
    'constructor();',
    'toString();',
    'AFSpecial_KeystrokeEx("99");', // função de teclado no lugar do formato
  ];
  for (const format of strange) assert.equal(readFieldFormat(format, undefined), null, format);
  // Script de teclado sozinho vale: formata por ele.
  assert.equal(readFieldFormat('  ', 'AFNumber_Keystroke(2, 2, 0, 0, "", true);').kind, 'number');
  // Os dois têm que ser conhecidos e combinar.
  assert.equal(readFieldFormat('AFNumber_Format(2, 2, 0, 0, "", true);', 'validarValor();'), null);
  assert.equal(readFieldFormat('meuFormato();', 'AFNumber_Keystroke(2, 2, 0, 0, "", true);'), null);
  assert.equal(readFieldFormat('AFNumber_Format(2, 2, 0, 0, "", true);', 'AFDate_KeystrokeEx("dd/mm/yyyy");'), null);
  assert.equal(readFieldFormat('AFNumber_Format(2, 2, 0, 0, "", true);', 'AFNumber_Format(2, 2, 0, 0, "", true);'), null);
  assert.equal(readFieldFormat('AFPercent_Format(2, 0);', 'AFNumber_Keystroke(2, 0, 0, 0, "", true);'), null);
  assert.equal(readFieldFormat(42, undefined), null);
});

test('sem formato, o valor sai como digitado; vazio fica vazio; dica e teclado padrão', () => {
  assert.deepEqual(formatFieldValue(null, '  qualquer coisa '), { ok: true, text: '  qualquer coisa ' });
  assert.deepEqual(formatFieldValue({ kind: 'outro' }, 'x'), { ok: true, text: 'x' });
  assert.deepEqual(formatFieldValue(number('2, 2, 0, 0, "", true'), '   '), { ok: true, text: '' });
  assert.deepEqual(formatFieldValue(readFieldFormat('AFDate_FormatEx("dd/mm/yyyy");', ''), ''), { ok: true, text: '' });
  assert.deepEqual(fieldInputHints(null), { placeholder: '', inputMode: 'text' });
  assert.deepEqual(fieldInputHints(number('0, 2, 0, 0, "", true')), { placeholder: '0', inputMode: 'numeric' });
});
