// Formulário preenchido em outro programa (#16): o programa grava o valor do campo (/V) sem desenhar a aparência dele,
// e pede para o leitor redesenhar (/NeedAppearances) ou deixa o campo sem /AP. O PDF.js redesenha na tela; até a
// v4.0.0, o PDF novo (copyPages) levava a aparência guardada, vazia ou velha, e o app só avisava ao abrir. Na v4.1.0,
// o app desenha esses campos de novo (pdf-form.js), também ao só juntar, dividir ou assinar, e o PDF novo sai igual
// à tela.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPdf, copyPages } from '../web/js/pdf-reader.js';
import { openPdfFile } from '../web/js/pdf-open.js';
import { readForm } from '../web/js/pdf-form.js';
import { buildPdf, qpdfRun } from './helpers/qpdf.js';
import { makeRawPdf, textPageObjects } from './helpers/pdf.js';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

// Formulário com um campo preenchido. need: /NeedAppearances no /AcroForm; ap: a aparência do campo ('empty': vazia,
// como a do programa que só grava o valor; 'old': com outro texto; 'value': com o valor; 'none': sem /AP).
function formPdf({ need = true, ap = 'empty', value = '(Fulano de Tal)', type = 'Tx', extra = '' } = {}) {
  const appearance = ap === 'none' ? '' : ' /AP << /N 7 0 R >>';
  const drawn = { empty: '/Tx BMC EMC', old: '/Tx BMC BT /Helv 12 Tf 2 5 Td (Antigo) Tj ET EMC', value: `/Tx BMC BT /Helv 12 Tf 2 5 Td ${value} Tj ET EMC` }[ap] ?? '';
  return makeRawPdf({
    1: `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [8 0 R]${need ? ' /NeedAppearances true' : ''} /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>`,
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Nome:', { extra: ' /Annots [6 0 R]' }),
    // Campo com o valor e, embaixo dele, o widget (que herda o tipo e o valor).
    8: `<< /FT /${type} /T (nome) /V ${value}${extra} /Kids [6 0 R] >>`,
    6: `<< /Type /Annot /Subtype /Widget /Parent 8 0 R /DA (/Helv 12 Tf 0 g) /Rect [100 600 300 620] /F 4 /P 3 0 R${appearance} >>`,
    7: { dict: '/Type /XObject /Subtype /Form /BBox [0 0 200 20] /Resources << /Font << /Helv 5 0 R >> >>', data: drawn },
  }).bytes;
}

// O PDF novo com a página copiada, como o app monta (com os campos desenhados de novo), conferido pelo qpdf.
async function copied(bytes) {
  const doc = await openPdf(bytes);
  const form = await readForm(doc);
  const copy = copyPages(doc, [0], { fill: form.fill() });
  return latin1(buildPdf([{ copy: { source: copy, page: copy.pages.get(0) } }]));
}

test('#16 corrigido: com /NeedAppearances, o valor aparece no PDF novo, e a aparência guardada (vazia ou velha) não vai', async () => {
  const out = await copied(formPdf());
  assert.match(out, /\(Fulano de Tal\) Tj/, 'o valor desenhado de novo');
  assert.doesNotMatch(out, /\/Tx BMC EMC/, 'a aparência vazia não vai');
  assert.doesNotMatch(out, /\/AcroForm|\/NeedAppearances|\/V |\/Widget/);
  // Aparência velha: sai o valor, não o texto antigo.
  const old = await copied(formPdf({ ap: 'old' }));
  assert.match(old, /\(Fulano de Tal\) Tj/);
  assert.doesNotMatch(old, /Antigo/);
  // Valor sem aparência nenhuma, mesmo sem /NeedAppearances: outros programas mostram o valor, e o app também.
  assert.match(await copied(formPdf({ need: false, ap: 'none' })), /\(Fulano de Tal\) Tj/);
  // Com a aparência desenhada pelo programa e sem /NeedAppearances, ela vai como está.
  const kept = await copied(formPdf({ need: false, ap: 'value' }));
  assert.match(kept, /2 5 Td \(Fulano de Tal\) Tj/);
});

test('#16: só o que precisa é desenhado de novo', async () => {
  const redrawn = async (options) => (await readForm(await openPdf(formPdf(options)))).fill().size;
  assert.equal(await redrawn({ need: true, ap: 'empty' }), 1, '/NeedAppearances com valor');
  assert.equal(await redrawn({ need: true, ap: 'value' }), 1, 'com /NeedAppearances, a aparência pode estar velha');
  assert.equal(await redrawn({ need: false, ap: 'none' }), 1, 'valor sem aparência');
  assert.equal(await redrawn({ need: false, ap: 'value' }), 0, 'aparência desenhada: fica');
  assert.equal(await redrawn({ need: true, value: '()' }), 0, 'formulário em branco: fica a aparência guardada');
  assert.equal(await redrawn({ need: true, value: '(   )' }), 0);
  assert.equal(await redrawn({ need: true, value: '<FEFF>' }), 0, 'texto UTF-16 vazio');
  assert.equal(await redrawn({ need: true, value: '<FEFF0041>' }), 1);
  assert.equal(await redrawn({ need: true, type: 'Ch', value: '[(Um) (Dois)]' }), 1, 'lista com escolha');
  assert.equal(await redrawn({ need: true, type: 'Tx', value: '(segredo)', extra: ' /Ff 8192' }), 0, 'senha nunca');
});

test('#16: caixa de marcar sem /AS, com o valor no /V, sai marcada como na tela', async () => {
  const bytes = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [8 0 R 9 0 R] /NeedAppearances true >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Caixas', { extra: ' /Annots [8 0 R 9 0 R]' }),
    8: '<< /FT /Btn /T (sem-as) /V /Sim /Type /Annot /Subtype /Widget /Rect [100 600 112 612] /P 3 0 R /AP << /N << /Sim 7 0 R /Off 10 0 R >> >> >>',
    9: '<< /FT /Btn /T (com-as) /V /Sim /AS /Off /Type /Annot /Subtype /Widget /Rect [100 580 112 592] /P 3 0 R /AP << /N << /Sim 7 0 R /Off 10 0 R >> >> >>',
    7: { dict: '/BBox [0 0 12 12]', data: '(MARCADA) Tj' },
    10: { dict: '/BBox [0 0 12 12]', data: '(DESMARCADA) Tj' },
  }).bytes;
  const doc = await openPdf(bytes);
  const form = await readForm(doc);
  assert.deepEqual([...form.fill()], [[8, { state: 'Sim' }]], 'com /AS válido, o PDF.js mostra o /AS: fica');
  const copy = copyPages(doc, [0], { fill: form.fill() });
  const out = latin1(buildPdf([{ copy: { source: copy, page: copy.pages.get(0) } }]));
  assert.match(out, /\(MARCADA\) Tj/);
  assert.match(out, /\(DESMARCADA\) Tj/);
});

test('#16: o PDF com senha desenha a prévia (a cópia decifrada) já com os valores', async () => {
  // O formulário com senha vem do qpdf (o protectPdf do app só cifra os PDFs que ele mesmo monta).
  const encrypted = qpdfRun(['--encrypt', 'senha', 'dono', '256', '--'], formPdf());
  if (!encrypted) return; // sem o qpdf (fora do CI)
  const { doc } = await openPdfFile(new File([encrypted.output], 'formulario.pdf'), 'senha');
  assert.ok(doc.form, 'os campos vêm junto: o leitor decifra tudo ao abrir');
  assert.match(latin1(doc.previewBytes), /\(Fulano de Tal\) Tj/);
});

test('ao abrir: a nota diz quantos campos o formulário tem, e o aviso do #16 só fica para o que o app não desenha igual', async () => {
  const notes = async (bytes) => (await openPdfFile(new File([bytes], 'formulario.pdf'))).notes;
  const annotations = 'No PDF novo, links e campos de formulário viram parte da página: o que estava preenchido continua visível, mas não dá mais para clicar nem editar.';
  assert.deepEqual(await notes(formPdf()), ['Este PDF tem um formulário com 1 campo.', annotations], 'o valor é desenhado de novo: sem aviso');
  assert.deepEqual(await notes(formPdf({ need: false, ap: 'value' })), ['Este PDF tem um formulário com 1 campo.', annotations]);
  // Letra fora das fontes padrão do PDF: o app desenha o resto, e avisa.
  const polish = await notes(formPdf({ value: '<FEFF0141006F00640069>' })); // "Łodi"
  assert.equal(polish[1], 'Este formulário foi preenchido em outro programa, que não desenhou os valores nos campos. O app desenha de novo, mas a letra “Ł” não existe nas fontes do PDF e fica de fora.');
  const cut = await notes(formPdf({ value: `(${'Muito comprido '.repeat(20)})` }));
  assert.match(cut[1], /O app desenha de novo, mas um dos valores não cabe no campo e sai cortado\.$/);
  const plain = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Sem campos'),
  }).bytes;
  const opened = await openPdfFile(new File([plain], 'simples.pdf'));
  assert.deepEqual(opened.notes, []);
  assert.equal(opened.doc.form, undefined, 'sem campos, o pdf-form.js nem é usado');
});

test('XFA puro: a nota diz por que não dá para preencher', async () => {
  const bytes = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /NeedsRendering true /AcroForm << /Fields [] /XFA 9 0 R >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Please wait...'),
    9: { data: '<xdp:xdp/>' },
  }).bytes;
  const { notes, doc } = await openPdfFile(new File([bytes], 'xfa.pdf'));
  assert.equal(doc.form.xfa, 'pure');
  assert.deepEqual(notes, ['Este PDF é um formulário XFA, que só o Adobe Reader mostra e preenche: aqui não dá para preencher, e as páginas podem aparecer vazias ou só com um aviso do Adobe.']);
});
