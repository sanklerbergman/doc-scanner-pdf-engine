// Lógica do painel de preenchimento (#15, fase 5.3) e os formatos do Acrobat na interface e na aparência (fase 5.4):
// contador, dica e teclado, formatação ao sair do campo, vermelho no negativo, /MaxLen e obrigatórios vazios. A ordem
// de leitura está em pdf-form.test.js. O painel (form-panel.js) é conferido no navegador, pelo Playwright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPdf } from '../web/js/pdf-reader.js';
import { readForm, counterText, inputHints, formatTyped, requiredEmpty, optionLabels } from '../web/js/pdf-form.js';
import { makeRawPdf, textPageObjects } from './helpers/pdf.js';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

// Formulário de uma página (612 × 792) com os campos a partir do objeto 10.
async function formDoc(objects, { fields, annots, acro = '' }) {
  const doc = await openPdf(makeRawPdf({
    1: `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${fields}] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >>${acro} >> >>`,
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Formulario', { extra: ` /Annots [${annots}]` }),
    ...objects,
  }).bytes);
  doc.form = await readForm(doc);
  return doc;
}

const widget = (rect, extra = '') => `/Type /Annot /Subtype /Widget /Rect [${rect}] /P 3 0 R${extra}`;
const js = (code) => `<< /S /JavaScript /JS (${code.replace(/[()\\]/g, '\\$&')}) >>`;
const draw = (form, id, value) => latin1(form.appearance(form.fields[id], form.fields[id].widgets[0], value).stream.data);

test('contador, dica e teclado pelo formato, e o maxlength pelo /MaxLen', async () => {
  assert.equal(counterText(12, 34), '12 de 34');
  const { form } = await formDoc({
    10: `<< /T (cnpj) /FT /Tx /MaxLen 18 /AA << /K ${js('AFSpecial_KeystrokeEx("99.999.999/9999-99");')} >> ${widget('10 10 200 30')} >>`,
    11: `<< /T (valor) /FT /Tx /MaxLen 14 /AA << /F ${js('AFNumber_Format(2, 2, 0, 0, "R$ ", true);')} /K ${js('AFNumber_Keystroke(2, 2, 0, 0, "R$ ", true);')} >> ${widget('10 40 200 60')} >>`,
    12: `<< /T (livre) /FT /Tx /AA << /F ${js('validarCNPJ();')} >> ${widget('10 70 200 90')} >>`,
  }, { fields: '10 0 R 11 0 R 12 0 R', annots: '10 0 R 11 0 R 12 0 R' });
  const [cnpj, valor, livre] = form.fields;
  assert.deepEqual(cnpj.format, { kind: 'mask', mask: '99.999.999/9999-99' });
  assert.deepEqual(inputHints(cnpj), { placeholder: '00.000.000/0000-00', inputMode: 'numeric', maxLength: 18 });
  assert.deepEqual(inputHints(valor), { placeholder: 'R$ 0,00', inputMode: 'decimal', maxLength: 14 });
  assert.equal(livre.format, null, 'função própria do formulário: sem formato');
  assert.deepEqual(inputHints(livre), { placeholder: '', inputMode: 'text', maxLength: null });
});

test('formatar ao sair do campo: o valor formatado; o que não serve fica como digitado, com o aviso', () => {
  const mask = { kind: 'text', format: { kind: 'mask', mask: '99.999.999/9999-99' } };
  assert.deepEqual(formatTyped(mask, '12345678000190'), { ok: true, text: '12.345.678/0001-90' });
  const bad = formatTyped(mask, '123');
  assert.equal(bad.ok, false);
  assert.equal(bad.text, '123');
  assert.match(bad.message, /00\.000\.000\/0000-00/);
  assert.deepEqual(formatTyped({ kind: 'text', format: null }, ' como veio '), { ok: true, text: ' como veio ' });
  // Negativo em vermelho, sem o sinal (estilo 1): no controle, o sinal fica, para o valor continuar negativo.
  const red = { kind: 'text', format: { kind: 'number', decimals: 2, separator: 2, negative: 1, currency: 'R$ ', prepend: true } };
  assert.deepEqual(formatTyped(red, '-1234,5'), { ok: true, text: '-R$ 1.234,50', red: true });
  assert.deepEqual(formatTyped(red, '-R$ 1.234,50'), { ok: true, text: '-R$ 1.234,50', red: true }, 'formatar de novo não muda');
  assert.deepEqual(formatTyped(red, '1234,5'), { ok: true, text: 'R$ 1.234,50', red: false });
  const parens = { kind: 'text', format: { ...red.format, negative: 3 } };
  assert.equal(formatTyped(parens, '-1234,5').text.includes('-'), false, 'entre parênteses: sem o sinal a mais');
});

test('aparência com formato: o texto formatado, o negativo em vermelho, e o /MaxLen não corta o formatado', async () => {
  const { form } = await formDoc({
    10: `<< /T (saldo) /FT /Tx /MaxLen 6 /DA (/Helv 10 Tf 0 g) /AA << /F ${js('AFNumber_Format(2, 2, 1, 0, "", true);')} >> ${widget('100 700 300 720')} >>`,
    11: `<< /T (simples) /FT /Tx /MaxLen 6 /DA (/Helv 10 Tf 0 g) ${widget('100 650 300 670')} >>`,
  }, { fields: '10 0 R 11 0 R', annots: '10 0 R 11 0 R' });
  form.setValue(0, '-1234567,8');
  assert.match(draw(form, 0, form.value(0)), /\n1 0 0 rg\n.*\(1\.234\.567,80\) Tj/s, 'vermelho, sem o sinal, e inteiro (12 letras com /MaxLen 6)');
  assert.match(draw(form, 0, '1234,5'), /\n0 g\n.*\(1\.234,50\) Tj/s);
  assert.match(draw(form, 0, 'abc'), /\(abc\) Tj/, 'o que não serve sai como digitado');
  assert.match(draw(form, 1, '12345678'), /\(123456\) Tj/, 'sem formato, o /MaxLen ainda corta');
});

test('#16 com formato: o valor cru gravado por outro programa sai formatado, como o Acrobat mostra', async () => {
  const { form } = await formDoc({
    10: `<< /T (valor) /FT /Tx /V (1234.5) /DA (/Helv 10 Tf 0 g) /AA << /F ${js('AFNumber_Format(2, 2, 0, 0, "R$ ", true);')} >> ${widget('100 700 300 720')} >>`,
  }, { fields: '10 0 R', annots: '10 0 R', acro: ' /NeedAppearances true' });
  assert.match(latin1(form.fill().get(10).stream.data), /\(R\$ 1\.234,50\) Tj/);
});

test('obrigatórios vazios, avisados ao aplicar (sem bloquear): somente leitura não conta', async () => {
  const { form } = await formDoc({
    10: `<< /T (nome) /FT /Tx /Ff 2 ${widget('10 700 100 720')} >>`,
    11: `<< /T (cpf) /FT /Tx /Ff 2 /V (123) ${widget('10 650 100 670')} >>`,
    12: `<< /T (obs) /FT /Tx ${widget('10 600 100 620')} >>`,
    13: `<< /T (protocolo) /FT /Tx /Ff 3 ${widget('10 550 100 570')} >>`,
    14: `<< /T (aceito) /FT /Btn /Ff 2 ${widget('10 500 22 512', ' /AP << /N << /Sim 30 0 R >> >>')} >>`,
    30: { dict: '/BBox [0 0 12 12]', data: '' },
  }, { fields: '10 0 R 11 0 R 12 0 R 13 0 R 14 0 R', annots: '10 0 R 11 0 R 12 0 R 13 0 R 14 0 R' });
  const empty = (draft) => requiredEmpty(form.pageFields(0), (f) => (draft.has(f.id) ? draft.get(f.id) : form.value(f.id))).map((f) => f.name);
  assert.deepEqual(empty(new Map()), ['nome', 'aceito']);
  assert.deepEqual(empty(new Map([[0, '  '], [1, '']])), ['nome', 'cpf', 'aceito']);
  assert.deepEqual(empty(new Map([[0, 'Ana'], [4, 'Sim']])), []);
});

test('nomes das opções do rádio: o do /Opt ou, quando ele não diz nada, o texto à direita de cada uma', async () => {
  const states = (on) => ` /AP << /N << /${on} 30 0 R /Off 30 0 R >> >>`;
  const { form } = await formDoc({
    10: '<< /T (tipo) /FT /Btn /Ff 49152 /Opt [(Escolha1) (Escolha1)] /Kids [11 0 R 12 0 R] >>',
    11: `<< /Parent 10 0 R ${widget('100 700 112 712', states(0))} >>`,
    12: `<< /Parent 10 0 R ${widget('100 680 112 692', states(1))} >>`,
    13: '<< /T (sexo) /FT /Btn /Ff 49152 /Opt [(Feminino) (Masculino)] /Kids [14 0 R 15 0 R] >>',
    14: `<< /Parent 13 0 R ${widget('100 600 112 612', states(0))} >>`,
    15: `<< /Parent 13 0 R ${widget('200 600 212 612', states(1))} >>`,
    30: { dict: '/BBox [0 0 12 12]', data: '' },
  }, { fields: '10 0 R 13 0 R', annots: '11 0 R 12 0 R 14 0 R 15 0 R' });
  const [tipo, sexo] = form.fields;
  const item = (str, x0, y0, x1, y1) => ({ str, x0: x0 / 612, y0: 1 - y1 / 792, x1: x1 / 612, y1: 1 - y0 / 792 });
  const items = [item('Restituição', 116, 701, 170, 711), item('Ressarcimento', 116, 681, 180, 691)];
  assert.deepEqual([...optionLabels(tipo, 0, items).values()], ['Restituição', 'Ressarcimento']);
  assert.deepEqual([...optionLabels(tipo, 0).values()], ['Opção 1', 'Opção 2'], 'sem o texto da página');
  assert.deepEqual([...optionLabels(sexo, 0, items).values()], ['Feminino', 'Masculino'], 'o /Opt diz o que é');
});

test('o valor que o painel grava é o do controle: formatado, com o sinal do negativo em vermelho', async () => {
  const { form } = await formDoc({
    10: `<< /T (cnpj) /FT /Tx /MaxLen 18 /DA (/Helv 10 Tf 0 g) /AA << /K ${js('AFSpecial_KeystrokeEx("99.999.999/9999-99");')} >> ${widget('100 700 300 720')} >>`,
  }, { fields: '10 0 R', annots: '10 0 R' });
  const shown = formatTyped(form.fields[0], '12345678000190').text;
  form.setValue(0, shown);
  assert.equal(form.value(0), '12.345.678/0001-90');
  assert.match(draw(form, 0, form.value(0)), /\(12\.345\.678\/0001-90\) Tj/);
});
