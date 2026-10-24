// Formulário preenchido em outro programa (#16): o programa grava o valor do campo (/V) sem desenhar a aparência dele,
// e pede para o leitor redesenhar (/NeedAppearances) ou deixa o campo sem /AP. O PDF.js redesenha na tela (conferido no
// navegador), mas o PDF novo (copyPages) leva a aparência guardada, vazia ou velha. Na v4.0.0, o app só avisa ao abrir;
// a correção vem com o preenchimento de formulários (v4.1.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPdf, copyPages } from '../web/js/pdf-reader.js';
import { openPdfFile } from '../web/js/pdf-open.js';
import { buildPdf } from './helpers/qpdf.js';
import { makeRawPdf, textPageObjects } from './helpers/pdf.js';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

// Formulário com um campo preenchido. need: /NeedAppearances no /AcroForm; ap: a aparência do campo ('empty': vazia,
// como a do programa que só grava o valor; 'old': com outro texto; 'value': com o valor; 'none': sem /AP).
function formPdf({ need = true, ap = 'empty', value = '(Fulano de Tal)', type = 'Tx' } = {}) {
  const appearance = ap === 'none' ? '' : ' /AP << /N 7 0 R >>';
  const drawn = { empty: '/Tx BMC EMC', old: '/Tx BMC BT /Helv 12 Tf 2 5 Td (Antigo) Tj ET EMC', value: `/Tx BMC BT /Helv 12 Tf 2 5 Td ${value} Tj ET EMC` }[ap] ?? '';
  return makeRawPdf({
    1: `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [8 0 R]${need ? ' /NeedAppearances true' : ''} /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>`,
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Nome:', { extra: ' /Annots [6 0 R]' }),
    // Campo com o valor e, embaixo dele, o widget (que herda o tipo e o valor).
    8: `<< /FT /${type} /T (nome) /V ${value} /Kids [6 0 R] >>`,
    6: `<< /Type /Annot /Subtype /Widget /Parent 8 0 R /DA (/Helv 12 Tf 0 g) /Rect [100 600 300 620] /F 4 /P 3 0 R${appearance} >>`,
    7: { dict: '/Type /XObject /Subtype /Form /BBox [0 0 200 20] /Resources << /Font << /Helv 5 0 R >> >>', data: drawn },
  }).bytes;
}

// O PDF novo com a página copiada (conferido pelo qpdf), como texto.
const copied = (doc) => {
  const copy = copyPages(doc, [0]);
  return latin1(buildPdf([{ copy: { source: copy, page: copy.pages.get(0) } }]));
};

test('#16 confirmado: com /NeedAppearances, o PDF novo leva a aparência guardada e o valor do campo some', async () => {
  // O original tem o valor no campo (o PDF.js desenha a partir do /V quando o formulário pede /NeedAppearances), mas a
  // aparência gravada está vazia.
  const source = formPdf();
  assert.match(latin1(source), /\/NeedAppearances true/);
  assert.match(latin1(source), /\/V \(Fulano de Tal\)/);
  const out = copied(await openPdf(source));
  assert.doesNotMatch(out, /Fulano/, 'o valor não está em lugar nenhum do PDF novo');
  assert.match(out, /\/Tx BMC EMC/, 'vai a aparência vazia');
  assert.doesNotMatch(out, /\/AcroForm|\/NeedAppearances|\/V /);
  // Aparência velha: no PDF novo aparece o texto antigo, não o valor.
  const old = copied(await openPdf(formPdf({ ap: 'old' })));
  assert.match(old, /\(Antigo\) Tj/);
  assert.doesNotMatch(old, /Fulano/);
  // Com a aparência desenhada pelo programa, o valor vai junto (o caso que já funciona).
  assert.match(copied(await openPdf(formPdf({ need: false, ap: 'value' }))), /\(Fulano de Tal\) Tj/);
});

test('#16: o app reconhece o formulário preenchido sem a aparência do valor', async () => {
  const check = async (options) => (await openPdf(formPdf(options))).formValuesWithoutAppearance();
  assert.equal(await check({ need: true, ap: 'empty' }), true, '/NeedAppearances com valor');
  assert.equal(await check({ need: true, ap: 'value' }), true, 'com /NeedAppearances, a aparência pode estar velha');
  assert.equal(await check({ need: false, ap: 'none' }), true, 'valor sem aparência');
  assert.equal(await check({ need: false, ap: 'value' }), false, 'aparência desenhada: nada a avisar');
  assert.equal(await check({ need: true, value: '()' }), false, 'formulário em branco: nada se perde');
  assert.equal(await check({ need: true, value: '(   )' }), false);
  assert.equal(await check({ need: true, value: '<FEFF>' }), false, 'texto UTF-16 vazio');
  assert.equal(await check({ need: true, value: '<FEFF0041>' }), true);
  assert.equal(await check({ need: true, type: 'Ch', value: '[(Um) (Dois)]' }), true, 'lista com escolha');
  assert.equal(await check({ need: true, type: 'Btn', value: '/Sim' }), false, 'caixa de marcar usa o estado que o arquivo tem');
  const plain = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Sem campos'),
  }).bytes;
  assert.equal((await openPdf(plain)).formValuesWithoutAppearance(), false);
});

test('#16: ao abrir, a nota avisa que os valores preenchidos podem não aparecer no PDF novo', async () => {
  const notes = async (bytes) => (await openPdfFile(new File([bytes], 'formulario.pdf'))).notes;
  const warned = await notes(formPdf());
  assert.equal(warned.length, 1);
  assert.match(warned[0], /preenchido em outro programa.*os valores preenchidos podem não aparecer/);
  assert.match(warned[0], /sem dar para clicar nem editar/);
  const fine = await notes(formPdf({ need: false, ap: 'value' }));
  assert.deepEqual(fine, ['No PDF novo, links e campos de formulário viram parte da página: o que estava preenchido continua visível, mas não dá mais para clicar nem editar.']);
});
