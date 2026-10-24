// Formulários de PDF (#15, fases 5.1 e 5.2): leitura dos campos pelo leitor do app (pdf-form.js) e o valor de cada um
// fixo na página do PDF novo (copyPages com fill), com PDFs montados aqui (test/helpers/pdf.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPdf, copyPages } from '../web/js/pdf-reader.js';
import { readForm, parseDA, standardFont, cleanName, nearbyText, wrapText } from '../web/js/pdf-form.js';
import { unchangedSource } from '../web/js/pdf-append.js';
import { textWidth } from '../web/js/fonts.js';
import { buildPdf } from './helpers/qpdf.js';
import { makeRawPdf, textPageObjects } from './helpers/pdf.js';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const contentOf = (result) => latin1(result.stream.data);

// Formulário de uma página (612 × 792): o catálogo com o /AcroForm (fields: a lista /Fields; acro: o resto), a
// página 3 com os widgets em /Annots e os objetos dos campos a partir do 10. Fontes no /DR: Helv (Helvetica), F4
// (Arial negrito, subconjunto) e Cour (Courier New).
function formPdf(objects, { fields, annots, acro = '', page = '', catalog = '', pages = null } = {}) {
  return makeRawPdf({
    1: `<< /Type /Catalog /Pages 2 0 R${catalog} /AcroForm << /Fields [${fields}] /DA (/Helv 0 Tf 0 g)`
      + ` /DR << /Font << /Helv 5 0 R /F4 6 0 R /Cour 7 0 R >> >>${acro} >> >>`,
    2: pages ?? '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Formulario', { extra: ` /Annots [${annots}]${page}` }),
    6: '<< /Type /Font /Subtype /TrueType /BaseFont /BAAAAA+Arial-BoldMT >>',
    7: '<< /Type /Font /Subtype /TrueType /BaseFont /CourierNewPSMT >>',
    ...objects,
  }).bytes;
}

const open = async (bytes) => {
  const doc = await openPdf(bytes);
  doc.form = await readForm(doc);
  return doc;
};

// O PDF novo com as páginas copiadas (com fill), conferido pelo qpdf, como texto.
function rebuilt(doc, fill, indices = doc.pages.map((_, i) => i)) {
  const copy = copyPages(doc, indices, { fill });
  return latin1(buildPdf(indices.map((index) => ({ copy: { source: copy, page: copy.pages.get(index) } }))));
}

// Onde cada trecho de texto da aparência cai na página: o Tm de cada Tj, passado pela /Matrix e levado da /BBox ao
// /Rect, como o achatamento faz (flattenAnnotations, em pdf-reader.js). [{text, x0, y0, x1, y1}] em pontos da página.
function placedRuns(widget, result, font = 'Helvetica') {
  const text = contentOf(result);
  const size = Number(/\/F1 ([\d.]+) Tf/.exec(text)?.[1] ?? 0);
  const dict = result.stream.dict;
  const [a, b, c, d, e, f] = dict.get('Matrix') ?? [1, 0, 0, 1, 0, 0];
  const bbox = dict.get('BBox');
  const map = (x, y) => [a * x + c * y + e, b * x + d * y + f];
  const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[2], bbox[1]]].map(([x, y]) => map(x, y));
  const box = [Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1])), Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))];
  const [rx0, ry0, rx1, ry1] = widget.rect;
  const sx = (rx1 - rx0) / (box[2] - box[0]);
  const sy = (ry1 - ry0) / (box[3] - box[1]);
  const toPage = ([x, y]) => [rx0 + (x - box[0]) * sx, ry0 + (y - box[1]) * sy];
  return [...text.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm \(((?:\\.|[^\\)])*)\) Tj/g)].map(([, x, y, raw]) => {
    const str = raw.replace(/\\([0-7]{3}|.)/g, (_, s) => (s.length === 3 ? String.fromCharCode(parseInt(s, 8)) : s));
    const w = textWidth(str, font, size);
    const points = [[+x, +y - size * 0.21], [+x + w, +y + size * 0.72]].map((p) => toPage(map(...p)));
    return {
      text: str, size,
      x0: Math.min(points[0][0], points[1][0]), y0: Math.min(points[0][1], points[1][1]),
      x1: Math.max(points[0][0], points[1][0]), y1: Math.max(points[0][1], points[1][1]),
    };
  });
}

const inside = (run, rect, slack = 0.05) => run.x0 >= rect[0] - slack && run.x1 <= rect[2] + slack && run.y0 >= rect[1] - slack && run.y1 <= rect[3] + slack;

// ---------- /DA e fontes ----------

test('/DA: fonte, tamanho e cor, com a cor antes ou depois da fonte', () => {
  assert.deepEqual(parseDA('/Helv 0 Tf 0 g'), { font: 'Helv', size: 0, color: [0] });
  assert.deepEqual(parseDA('0 0 1 rg /F4 11 Tf'), { font: 'F4', size: 11, color: [0, 0, 1] });
  assert.deepEqual(parseDA('/Cour 9.5 Tf 0.1 0.2 0.3 0.4 k'), { font: 'Cour', size: 9.5, color: [0.1, 0.2, 0.3, 0.4] });
  assert.deepEqual(parseDA('2 0 0 rg /TiRo -12 Tf'), { font: 'TiRo', size: 12, color: [1, 0, 0] }, 'cor acima de 1 e tamanho negativo');
  assert.deepEqual(parseDA(''), { font: null, size: 0, color: null });
  assert.deepEqual(parseDA('lixo ) ] /X'), { font: null, size: 0, color: null });
  assert.deepEqual(parseDA('/Helv 1e9 Tf'), { font: null, size: 0, color: null }, 'número que o PDF não tem');
});

test('fonte padrão mais parecida com a do formulário, sem embutir', () => {
  const cases = {
    Helv: 'Helvetica', TiRo: 'Times-Roman', Cour: 'Courier', HeBo: 'Helvetica-Bold', ZaDb: 'Helvetica',
    'BAAAAA+ArialMT': 'Helvetica', 'Arial-BoldMT': 'Helvetica-Bold', 'Calibri,Italic': 'Helvetica-Oblique',
    'TimesNewRomanPSMT': 'Times-Roman', 'TimesNewRomanPS-BoldItalicMT': 'Times-BoldItalic', 'CourierNewPSMT': 'Courier',
    'Courier-BoldOblique': 'Courier-BoldOblique', 'Helvetica-Oblique': 'Helvetica-Oblique', 'MSSansSerif': 'Helvetica',
    'Georgia-Bold': 'Times-Bold', ZapfDingbats: 'Helvetica', 'LiberationSerif': 'Times-Roman',
  };
  for (const [name, font] of Object.entries(cases)) assert.equal(standardFont(name), font, name);
});

// ---------- Leitura dos campos ----------

test('herança em três níveis: tipo, opções, valor, /DA, /Q e /MaxLen vêm do campo de cima; o /DA cai no do /AcroForm', async () => {
  const doc = await open(formPdf({
    10: '<< /T (pessoa) /FT /Tx /Ff 2 /MaxLen 30 /Kids [11 0 R] >>',
    11: '<< /T (dados) /Parent 10 0 R /Q 1 /V (Maria) /Kids [12 0 R] >>',
    12: '<< /T (nome) /Parent 11 0 R /Type /Annot /Subtype /Widget /Rect [100 700 300 720] /F 4 /P 3 0 R >>',
    13: '<< /T (sem-da) /FT /Tx /DA (0 0 1 rg /F4 11 Tf) /Kids [14 0 R] >>',
    14: '<< /Type /Annot /Subtype /Widget /Parent 13 0 R /Rect [100 600 300 620] /P 3 0 R >>',
  }, { fields: '10 0 R 13 0 R', annots: '12 0 R 14 0 R' }));
  const nodes = doc.formFields();
  assert.deepEqual(nodes.map((n) => [n.name, n.terminal]), [['pessoa', false], ['pessoa.dados', false], ['pessoa.dados.nome', true], ['sem-da', true]]);
  const [field, other] = doc.form.fields;
  assert.equal(field.name, 'pessoa.dados.nome');
  assert.equal(field.kind, 'text');
  assert.equal(field.required, true);
  assert.equal(field.maxLen, 30);
  assert.equal(field.value, 'Maria');
  assert.equal(field.widgets[0].align, 1);
  assert.deepEqual(field.widgets[0].da, { font: 'Helvetica', size: 0, color: [0] }, '/DA do /AcroForm');
  assert.deepEqual(other.widgets[0].da, { font: 'Helvetica-Bold', size: 11, color: [0, 0, 1] }, 'F4 é Arial negrito no /DR');
  assert.equal(doc.isSigned(), false);
});

test('mesmo nome em duas páginas é o mesmo campo: o valor vale nas duas', async () => {
  const bytes = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [10 0 R 11 0 R] /DA (/Helv 10 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>',
    2: '<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Um', { extra: ' /Annots [10 0 R]' }),
    ...textPageObjects('Dois', { page: 8, content: 9, extra: ' /Annots [11 0 R]' }),
    10: '<< /T (Nome) /FT /Tx /Type /Annot /Subtype /Widget /Rect [100 700 300 720] /P 3 0 R >>',
    11: '<< /T (Nome) /FT /Tx /Type /Annot /Subtype /Widget /Rect [50 100 250 120] /P 8 0 R >>',
  }).bytes;
  const doc = await open(bytes);
  const { form } = doc;
  assert.equal(form.fields.length, 1);
  assert.deepEqual(form.fields[0].pages, [0, 1]);
  assert.deepEqual(form.pageFields(1).map((f) => f.id), [0]);
  form.setValue(0, 'José da Silva');
  assert.deepEqual([...form.fill().keys()], [10, 11]);
  assert.deepEqual([...form.fill([1]).keys()], [11]);
  assert.equal(form.hasValues(0), true);
  assert.equal(form.hasValues(1), true);
  const out = rebuilt(doc, form.fill());
  assert.equal(out.match(/\(Jos\\351 da Silva\) Tj/g)?.length, 2, 'o valor nas duas páginas');
});

test('fica de fora: widget fora do /Annots, oculto, numa camada oculta e botão de ação; campo sem widget', async () => {
  const doc = await open(formPdf({
    10: '<< /T (visivel) /FT /Tx /Type /Annot /Subtype /Widget /Rect [10 10 100 30] /P 3 0 R >>',
    11: '<< /T (fora) /FT /Tx /Type /Annot /Subtype /Widget /Rect [10 40 100 60] >>',
    12: '<< /T (oculto) /FT /Tx /Type /Annot /Subtype /Widget /F 2 /Rect [10 70 100 90] /P 3 0 R >>',
    13: '<< /T (sem-tela) /FT /Tx /Type /Annot /Subtype /Widget /F 32 /Rect [10 100 100 120] /P 3 0 R >>',
    14: '<< /T (enviar) /FT /Btn /Ff 65536 /Type /Annot /Subtype /Widget /Rect [10 130 100 150] /P 3 0 R >>',
    15: '<< /T (sem-widget) /FT /Tx /V (x) >>',
    16: '<< /T (camada) /FT /Tx /Type /Annot /Subtype /Widget /Rect [10 160 100 180] /P 3 0 R /OC 20 0 R >>',
    20: '<< /Type /OCG /Name (Oculta) >>',
  }, {
    fields: '10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 15 0 R 16 0 R', annots: '10 0 R 12 0 R 13 0 R 14 0 R 16 0 R',
    catalog: ' /OCProperties << /OCGs [20 0 R] /D << /OFF [20 0 R] >> >>',
  }));
  assert.deepEqual(doc.form.fields.map((f) => f.name), ['visivel']);
});

test('caixa, rádio, listas, senha, arquivo e assinatura: tipo, opções e quem não dá para preencher', async () => {
  const doc = await open(formPdf({
    10: '<< /T (aceito) /FT /Btn /V /Sim /Type /Annot /Subtype /Widget /Rect [10 10 30 30] /P 3 0 R /AS /Sim /AP << /N << /Sim 30 0 R /Off 31 0 R >> >> >>',
    11: '<< /T (estado civil) /FT /Btn /Ff 49152 /V /1 /Opt [(Solteiro) (Casado)] /Kids [12 0 R 13 0 R] >>',
    12: '<< /Type /Annot /Subtype /Widget /Parent 11 0 R /Rect [10 40 30 60] /P 3 0 R /AS /Off /AP << /N << /0 30 0 R /Off 31 0 R >> >> >>',
    13: '<< /Type /Annot /Subtype /Widget /Parent 11 0 R /Rect [40 40 60 60] /P 3 0 R /AS /1 /AP << /N << /1 30 0 R /Off 31 0 R >> >> >>',
    14: '<< /T (uf) /FT /Ch /Ff 131072 /V (MG) /Opt [[(SP) (S\\343o Paulo)] [(MG) (Minas Gerais)]] /Type /Annot /Subtype /Widget /Rect [10 70 200 90] /P 3 0 R >>',
    15: '<< /T (cores) /FT /Ch /Ff 2097152 /V [(b) (c)] /Opt [(a) (b) (c)] /TI 1 /Type /Annot /Subtype /Widget /Rect [10 100 200 160] /P 3 0 R >>',
    16: '<< /T (senha) /FT /Tx /Ff 8192 /Type /Annot /Subtype /Widget /Rect [10 170 200 190] /P 3 0 R >>',
    17: '<< /T (anexo) /FT /Tx /Ff 1048576 /Type /Annot /Subtype /Widget /Rect [10 200 200 220] /P 3 0 R >>',
    18: '<< /T (Assinatura1) /FT /Sig /Type /Annot /Subtype /Widget /Rect [10 230 200 260] /P 3 0 R >>',
    19: '<< /T (protocolo) /FT /Tx /Ff 1 /V (123) /Type /Annot /Subtype /Widget /Rect [10 270 200 290] /P 3 0 R >>',
    30: { dict: '/BBox [0 0 20 20]', data: '0 0 m 20 20 l S' },
    31: { dict: '/BBox [0 0 20 20]', data: '' },
  }, { fields: '10 0 R 11 0 R 14 0 R 15 0 R 16 0 R 17 0 R 18 0 R 19 0 R', annots: '10 0 R 12 0 R 13 0 R 14 0 R 15 0 R 16 0 R 17 0 R 18 0 R 19 0 R' }));
  const byName = Object.fromEntries(doc.form.fields.map((f) => [f.name, f]));
  assert.equal(byName.aceito.kind, 'checkbox');
  assert.deepEqual(byName.aceito.options, [{ value: 'Sim', label: 'Sim' }]);
  assert.equal(byName.aceito.value, 'Sim');
  const radio = byName['estado civil'];
  assert.equal(radio.kind, 'radio');
  assert.deepEqual(radio.options, [{ value: '0', label: 'Solteiro' }, { value: '1', label: 'Casado' }], 'estados "0" e "1", com o nome no /Opt');
  assert.equal(radio.value, '1');
  assert.equal(byName.uf.kind, 'combo');
  assert.deepEqual(byName.uf.options, [{ value: 'SP', label: 'São Paulo' }, { value: 'MG', label: 'Minas Gerais' }], '/Opt em pares');
  assert.equal(byName.uf.value, 'MG');
  assert.equal(byName.cores.kind, 'list');
  assert.equal(byName.cores.multiSelect, true);
  assert.deepEqual(byName.cores.value, ['b', 'c']);
  assert.equal(byName.cores.topIndex, 1);
  for (const [name, reason] of [['senha', 'password'], ['anexo', 'file'], ['Assinatura1', 'signature']]) {
    assert.equal(byName[name].fillable, false, name);
    assert.equal(byName[name].editable, false, name);
    assert.equal(byName[name].reason, reason, name);
    assert.throws(() => doc.form.setValue(byName[name].id, 'x'), /não pode ser preenchido/);
  }
  assert.equal(byName.protocolo.readOnly, true);
  assert.equal(byName.protocolo.editable, false);
  assert.equal(byName.protocolo.reason, 'readOnly');
});

test('cálculo e formato (/AA /C, /CO, /F, /K): o texto do script fica guardado, sem rodar; calculado é editável', async () => {
  const doc = await open(formPdf({
    10: '<< /T (total) /FT /Tx /Ff 1 /AA << /C 20 0 R /F << /S /JavaScript /JS (AFNumber_Format\\(2, 2, 0, 0, "R$ ", true\\);) >> >> /Type /Annot /Subtype /Widget /Rect [10 10 100 30] /P 3 0 R >>',
    11: '<< /T (cnpj) /FT /Tx /AA << /K << /S /JavaScript /JS 21 0 R >> >> /Type /Annot /Subtype /Widget /Rect [10 40 100 60] /P 3 0 R >>',
    12: '<< /T (soma) /FT /Tx /Ff 1 /Type /Annot /Subtype /Widget /Rect [10 70 100 90] /P 3 0 R >>',
    20: '<< /S /JavaScript /JS (AFSimple_Calculate\\("SUM", new Array \\("a", "b"\\)\\);) >>',
    21: { data: 'AFSpecial_KeystrokeEx("99.999.999/9999-99");', deflate: true },
  }, { fields: '10 0 R 11 0 R 12 0 R', annots: '10 0 R 11 0 R 12 0 R', acro: ' /CO [10 0 R 12 0 R]' }));
  const [total, cnpj, soma] = doc.form.fields;
  assert.equal(total.scripts.calculate, 'AFSimple_Calculate("SUM", new Array ("a", "b"));');
  assert.equal(total.scripts.format, 'AFNumber_Format(2, 2, 0, 0, "R$ ", true);');
  assert.equal(cnpj.scripts.keystroke, 'AFSpecial_KeystrokeEx("99.999.999/9999-99");', 'script em stream compactado');
  assert.equal(total.calculated, true);
  assert.equal(soma.calculated, true, 'só no /CO');
  assert.equal(cnpj.calculated, false);
  assert.equal(total.readOnly, true);
  assert.equal(total.editable, true, 'calculado: editável mesmo somente leitura');
  assert.equal(soma.editable, true);
});

test('/Lock e /FieldMDP: campo travado pela assinatura fica somente leitura', async () => {
  const doc = await open(formPdf({
    10: '<< /T (nome) /FT /Tx /Type /Annot /Subtype /Widget /Rect [10 10 100 30] /P 3 0 R >>',
    11: '<< /T (cpf) /FT /Tx /Type /Annot /Subtype /Widget /Rect [10 40 100 60] /P 3 0 R >>',
    12: '<< /T (obs) /FT /Tx /Type /Annot /Subtype /Widget /Rect [10 70 100 90] /P 3 0 R >>',
    13: '<< /T (ass) /FT /Sig /V 14 0 R /Lock << /Type /SigFieldLock /Action /Include /Fields [(nome)] >> /Type /Annot /Subtype /Widget /Rect [0 0 0 0] /P 3 0 R >>',
    14: '<< /Type /Sig /Contents <00> /Reference [<< /TransformMethod /FieldMDP /TransformParams << /Action /Exclude /Fields [(nome) (obs)] >> >>] >>',
    15: '<< /T (vazia) /FT /Sig /Lock << /Action /All >> /Type /Annot /Subtype /Widget /Rect [0 0 0 0] /P 3 0 R >>',
  }, { fields: '10 0 R 11 0 R 12 0 R 13 0 R 15 0 R', annots: '10 0 R 11 0 R 12 0 R 13 0 R 15 0 R' }));
  const byName = Object.fromEntries(doc.form.fields.map((f) => [f.name, f]));
  assert.equal(doc.isSigned(), true);
  assert.equal(byName.nome.locked, true, '/Lock com /Include');
  assert.equal(byName.cpf.locked, true, '/FieldMDP com /Exclude: o que não está na lista');
  assert.equal(byName.obs.locked, false);
  assert.equal(byName.cpf.editable, false);
  assert.equal(byName.cpf.reason, 'locked');
  assert.equal(byName.obs.editable, true, 'a assinatura vazia (/Action /All) ainda não trava nada');
});

test('XFA: no híbrido, a parte AcroForm é preenchida; o puro não dá para preencher', async () => {
  const objects = {
    10: '<< /T (nome) /FT /Tx /Type /Annot /Subtype /Widget /Rect [10 10 100 30] /P 3 0 R >>',
    20: { data: '<xdp:xdp/>' },
  };
  const hybrid = await open(formPdf(objects, { fields: '10 0 R', annots: '10 0 R', acro: ' /XFA 20 0 R' }));
  assert.equal(hybrid.form.xfa, 'hybrid');
  assert.equal(hybrid.form.fillable, true);
  hybrid.form.setValue(0, 'Ana');
  const out = rebuilt(hybrid, hybrid.form.fill());
  assert.match(out, /\(Ana\) Tj/);
  assert.doesNotMatch(out, /\/XFA|xdp/, 'o /XFA não vai para o PDF novo');

  const pure = await open(formPdf(objects, { fields: '10 0 R', annots: '10 0 R', acro: ' /XFA 20 0 R', catalog: ' /NeedsRendering true' }));
  assert.equal(pure.form.xfa, 'pure');
  assert.equal(pure.form.fillable, false);
  assert.equal(pure.form.fields[0].reason, 'xfa');
  assert.throws(() => pure.form.setValue(0, 'Ana'));
  assert.equal(pure.form.fill().size, 0);
  const empty = await open(formPdf({ 20: { data: '<xdp:xdp/>' } }, { fields: '', annots: '', acro: ' /XFA 20 0 R' }));
  assert.equal(empty.form.xfa, 'pure', '/XFA sem campos');
});

test('rótulos: /TU; o nome limpo; "Campo N"; e o texto da página em volta, pelo gancho do painel', async () => {
  assert.equal(cleanName('Cep#20Depositante'), 'Cep Depositante');
  assert.equal(cleanName('Raz#C3#A3o social'), 'Razão social');
  assert.equal(cleanName('form1[0].Pagina1[0].NomeCompleto[0]'), 'Nome Completo');
  assert.equal(cleanName('data_de_nascimento'), 'data de nascimento');
  for (const generic of ['Caixa de texto 1_2', 'Text3', 'Check Box12', 'undefined_2', 'Caixa de sele#C3#A7#C3#A3o 1', '12', '']) {
    assert.equal(cleanName(generic), '', generic);
  }
  const doc = await open(formPdf({
    10: '<< /T (Text1) /TU (Nome do segurado) /FT /Tx /Type /Annot /Subtype /Widget /Rect [200 700 400 720] /P 3 0 R >>',
    11: '<< /T (Caixa de texto 1_2) /FT /Tx /Type /Annot /Subtype /Widget /Rect [200 650 400 670] /P 3 0 R >>',
    12: '<< /T (cpf_titular) /TU (undefined) /FT /Tx /Type /Annot /Subtype /Widget /Rect [200 600 400 620] /P 3 0 R >>',
    13: '<< /T (Check Box1) /FT /Btn /Type /Annot /Subtype /Widget /Rect [100 550 112 562] /P 3 0 R >>',
  }, { fields: '10 0 R 11 0 R 12 0 R 13 0 R', annots: '10 0 R 11 0 R 12 0 R 13 0 R' }));
  assert.deepEqual(doc.form.fields.map((f) => f.label), ['Nome do segurado', 'Campo 2', 'cpf titular', 'Campo 4']);
  // Texto da página (pageTextItems), de 0 a 1 com a origem em cima: "Endereço:" à esquerda do segundo campo e
  // "Concordo" à direita da caixa.
  const item = (str, x0, y0, x1, y1) => ({ str, x0: x0 / 612, y0: 1 - y1 / 792, x1: x1 / 612, y1: 1 - y0 / 792 });
  const items = [
    item('Endereço', 120, 652, 170, 664), item(':', 171, 652, 174, 664), item('Concordo com os termos', 118, 551, 230, 561),
    item('CPF do titular', 200, 625, 270, 635),
  ];
  const labels = doc.form.pageLabels(0, items);
  assert.deepEqual([...labels.values()], ['Nome do segurado', 'Endereço', 'CPF do titular', 'Concordo com os termos']);
  assert.deepEqual([...doc.form.pageLabels(0).values()], ['Nome do segurado', 'Campo 2', 'cpf titular', 'Campo 4'], 'sem o texto da página');
  assert.equal(nearbyText({ x0: 0.5, y0: 0.5, x1: 0.6, y1: 0.52 }, items), '', 'nada perto');
});

test('ordem de leitura: de cima para baixo e, na mesma linha, da esquerda para a direita, na página como aparece', async () => {
  const widget = (num, name, rect) => [num, `<< /T (${name}) /FT /Tx /Type /Annot /Subtype /Widget /Rect [${rect}] /P 3 0 R >>`];
  const objects = Object.fromEntries([
    widget(10, 'c', '300 700 400 712'), widget(11, 'a', '50 702 150 714'), widget(12, 'd', '50 600 150 612'),
    widget(13, 'b', '160 699 250 715'),
  ]);
  const doc = await open(formPdf(objects, { fields: '10 0 R 11 0 R 12 0 R 13 0 R', annots: '10 0 R 11 0 R 12 0 R 13 0 R' }));
  assert.deepEqual(doc.form.pageFields(0).map((f) => f.name), ['a', 'b', 'c', 'd']);
  // Com /Rotate 90, o que está à esquerda no PDF fica em cima na tela.
  const turned = await open(formPdf(objects, { fields: '10 0 R 11 0 R 12 0 R 13 0 R', annots: '10 0 R 11 0 R 12 0 R 13 0 R', page: ' /Rotate 90' }));
  assert.deepEqual(turned.form.pageFields(0).map((f) => f.name), ['d', 'a', 'b', 'c']);
  const box = turned.form.fields[1].widgets[0].box;
  assert.ok(box.x0 > 0.8 && box.y0 < 0.1, JSON.stringify(box));
});

// ---------- Estado dos valores ----------

test('valores: gravar, ler, saber se há, limpar, versão da página e aviso de mudança (uma vez por série)', async () => {
  const doc = await open(formPdf({
    10: '<< /T (a) /FT /Tx /V (antes) /Type /Annot /Subtype /Widget /Rect [10 10 100 30] /P 3 0 R >>',
    11: '<< /T (b) /FT /Btn /Type /Annot /Subtype /Widget /Rect [10 40 22 52] /P 3 0 R /AS /Off /AP << /N << /Sim 30 0 R /Off 30 0 R >> >> >>',
    30: { dict: '/BBox [0 0 12 12]', data: '' },
  }, { fields: '10 0 R 11 0 R', annots: '10 0 R 11 0 R' }));
  const { form } = doc;
  const calls = [];
  const stop = form.onChange((pages) => calls.push([...pages]));
  assert.equal(form.value(0), 'antes');
  assert.equal(form.hasValues(), false);
  assert.equal(form.pageVersion(0), 0);
  assert.deepEqual(form.setValue(0, 'depois'), { clipped: false, missing: '' });
  form.setValue(1, true);
  assert.equal(form.value(0), 'depois');
  assert.equal(form.value(1), 'Sim');
  assert.equal(form.hasValues(), true);
  assert.equal(form.hasValues(0), true);
  assert.equal(form.pageVersion(0), 2);
  await Promise.resolve();
  assert.deepEqual(calls, [[0]], 'um aviso para as duas mudanças seguidas');
  form.setValue(0, 'antes'); // de volta ao valor do PDF: não conta como preenchido
  assert.deepEqual([...form.values.keys()], [1]);
  form.clear(0);
  assert.equal(form.hasValues(), false);
  assert.equal(form.value(1), null);
  await Promise.resolve();
  assert.equal(calls.length, 2);
  stop();
  form.setValue(0, 'x');
  await Promise.resolve();
  assert.equal(calls.length, 2, 'parou de acompanhar');
  assert.throws(() => form.setValue(1, 'Talvez'), /Estado inexistente/);
  assert.throws(() => form.setValue(99, 'x'), /Campo inexistente/);
});

test('assinar sem reescrever fica desligado quando há valor preenchido', async () => {
  const doc = await open(formPdf({
    10: '<< /T (a) /FT /Tx /Type /Annot /Subtype /Widget /Rect [10 10 100 30] /P 3 0 R >>',
  }, { fields: '10 0 R', annots: '10 0 R' }));
  const pages = [{ kind: 'pdf', doc, index: 0, rotation: 0 }];
  assert.equal(unchangedSource(pages, { changes: false, groups: [[0]] }), doc);
  doc.form.setValue(0, 'Ana');
  assert.equal(unchangedSource(pages, { changes: false, groups: [[0]] }), null);
  doc.form.clear();
  assert.equal(unchangedSource(pages, { changes: false, groups: [[0]] }), doc);
});

// ---------- Aparências ----------

// Um campo de texto com o widget em rect, com as opções extra (/Ff, /DA, /Q, /MK, /BS…).
async function textField(rect, extra = '', { page = '', acro = '' } = {}) {
  const doc = await open(formPdf({
    10: `<< /T (campo) /FT /Tx /Type /Annot /Subtype /Widget /Rect [${rect}] /P 3 0 R${extra} >>`,
  }, { fields: '10 0 R', annots: '10 0 R', page, acro }));
  const { form } = doc;
  const field = form.fields[0];
  return { doc, form, field, widget: field.widgets[0], draw: (value) => form.appearance(field, field.widgets[0], value) };
}

test('uma linha: fonte, tamanho e cor do /DA; tamanho 0 = altura útil ÷ 1,35, reduzido até caber na largura', async () => {
  const fixed = await textField('100 700 300 720', ' /DA (0 0 1 rg /F4 11 Tf)');
  const result = fixed.draw('Maria');
  const text = contentOf(result);
  assert.match(text, /^q\n.*Q\n\/Tx BMC\nq\n0 0 200 20 re W n\nBT\n\/F1 11 Tf\n0 0 1 rg\n1 0 0 1 2 [\d.]+ Tm \(Maria\) Tj\nET\nQ\nEMC$/s);
  assert.equal(result.stream.dict.get('Resources').get('Font').get('F1').get('BaseFont').value, 'Helvetica-Bold');
  assert.deepEqual(result.stream.dict.get('BBox'), [0, 0, 200, 20]);
  assert.equal(result.clipped, false);
  // Tamanho automático: 20 de altura ÷ 1,35.
  const auto = await textField('100 700 300 720', ' /DA (/Helv 0 Tf 0 g)');
  assert.equal(placedRuns(auto.widget, auto.draw('Ana'))[0].size, 14.815);
  // Texto comprido: a letra diminui até caber na largura (196 pontos úteis).
  const long = 'Um nome bem comprido para caber no campo';
  const run = placedRuns(auto.widget, auto.draw(long))[0];
  assert.ok(Math.abs(textWidth(long, 'Helvetica', run.size) - 196) < 0.1, String(run.size));
  assert.ok(inside(run, auto.widget.rect));
});

test('alinhamento /Q 0, 1 e 2', async () => {
  for (const [q, expected] of [[0, 102], [1, 200 - textWidth('Ana', 'Helvetica', 10) / 2], [2, 298 - textWidth('Ana', 'Helvetica', 10)]]) {
    const { draw, widget } = await textField('100 700 300 720', ` /DA (/Helv 10 Tf 0 g) /Q ${q}`);
    const [run] = placedRuns(widget, draw('Ana'));
    assert.ok(Math.abs(run.x0 - expected) < 0.01, `Q ${q}: ${run.x0}`);
  }
});

test('texto que não cabe: a letra diminui até 6 pt e, se ainda não couber, sai cortado e a função avisa', async () => {
  const { draw, form } = await textField('100 700 160 712', ' /DA (/Helv 10 Tf 0 g)');
  const fits = draw('Ana Lúcia');
  assert.equal(fits.clipped, false);
  const tooLong = draw('Ana Lúcia de Souza Albuquerque');
  assert.equal(tooLong.clipped, true);
  assert.match(contentOf(tooLong), /\/F1 6 Tf/);
  assert.match(contentOf(tooLong), /1 0 0 1 2 [\d.]+ Tm/, 'cortado no fim: o começo aparece');
  assert.match(contentOf(tooLong), /0 0 60 12 re W n/, 'recortado na área do campo');
  assert.deepEqual(form.setValue(0, 'Ana Lúcia de Souza Albuquerque'), { clipped: true, missing: '' });
});

test('letras fora da WinAnsi ficam de fora e são avisadas', async () => {
  const { form } = await textField('100 700 400 720', ' /DA (/Helv 10 Tf 0 g)');
  assert.deepEqual(form.setValue(0, 'Łódź 中 ✓ ação'), { clipped: false, missing: 'Łź中✓' });
  assert.match(contentOf(form.appearance(form.fields[0], form.fields[0].widgets[0], form.value(0))), /\(\\363d   a\\347\\343o\) Tj/);
});

test('várias linhas: quebra por palavra, entrelinha 1,35; tamanho 0 = a maior letra até 12 pt em que tudo cabe', async () => {
  assert.deepEqual(wrapText('um dois três quatro', 'Helvetica', textWidth('um dois três', 'Helvetica', 1)), ['um dois três', 'quatro']);
  assert.deepEqual(wrapText('a\nb\r\nc', 'Helvetica', 100), ['a', 'b', 'c'], 'as quebras da pessoa ficam');
  assert.deepEqual(wrapText('abcdefgh', 'Courier', 1.81), ['abc', 'def', 'gh'], 'palavra maior que a linha: por letra');
  const { draw, widget } = await textField('100 600 300 700', ' /Ff 4096 /DA (/Helv 0 Tf 0 g)');
  const short = placedRuns(widget, draw('Uma linha só'));
  assert.equal(short.length, 1);
  assert.equal(short[0].size, 12, 'cabe com 12 pt');
  const text = 'Requeiro a revisão do benefício conforme os documentos anexos, que comprovam o tempo de contribuição. '.repeat(4);
  const runs = placedRuns(widget, draw(text));
  assert.ok(runs.length > 4 && runs[0].size < 12, `${runs.length} linhas com ${runs[0].size} pt`);
  for (const run of runs) assert.ok(inside(run, widget.rect), JSON.stringify(run));
  for (let i = 1; i < runs.length; i++) assert.ok(Math.abs(runs[i - 1].y0 - runs[i].y0 - runs[0].size * 1.35) < 0.01, 'entrelinha 1,35');
  const fixed = await textField('100 600 300 700', ' /Ff 4096 /DA (/Helv 9 Tf 0 g)');
  assert.equal(placedRuns(fixed.widget, fixed.draw('curto'))[0].size, 9, 'tamanho do /DA quando cabe');
});

test('pente (/Ff 25 com /MaxLen): uma letra centrada em cada casa, com as divisórias na cor da borda', async () => {
  const { draw, widget, form } = await textField('100 700 200 720', ' /Ff 16777216 /MaxLen 5 /DA (/Cour 12 Tf 0 g) /MK << /BC [0 0 0] >>');
  assert.equal(form.fields[0].comb, true);
  const result = draw('12345678');
  assert.equal(result.clipped, true, 'passou do /MaxLen');
  const runs = placedRuns(widget, result, 'Courier');
  assert.deepEqual(runs.map((r) => r.text), ['1', '2', '3', '4', '5']);
  runs.forEach((run, i) => {
    const center = 100 + 20 * i + 10;
    assert.ok(Math.abs((run.x0 + run.x1) / 2 - center) < 0.01, `casa ${i}`);
  });
  assert.match(contentOf(result), /20 0 m 20 20 l 40 0 m 40 20 l 60 0 m 60 20 l 80 0 m 80 20 l S/);
  const right = await textField('100 700 200 720', ' /Ff 16777216 /MaxLen 5 /Q 2 /DA (/Helv 10 Tf 0 g)');
  assert.deepEqual(placedRuns(right.widget, right.draw('12')).map((r) => Math.round((r.x0 + r.x1) / 2)), [170, 190], 'alinhado à direita: as últimas casas');
});

test('fundo, borda (sólida, tracejada, chanfrada, em baixo-relevo, só embaixo) e giro /MK /R', async () => {
  const solid = await textField('0 0 100 20', ' /MK << /BG [1 1 0.8] /BC [1 0 0] >> /BS << /W 2 /S /S >>');
  const text = contentOf(solid.draw('x'));
  assert.match(text, /1 1 0\.8 rg 0 0 100 20 re f/);
  assert.match(text, /1 0 0 RG 2 w 1 1 98 18 re S/);
  assert.match(text, /2 2 96 16 re W n/, 'a área útil fica dentro da borda');
  assert.match(contentOf((await textField('0 0 100 20', ' /MK << /BC [0] >> /BS << /S /D /D [2 1] >>')).draw('x')), /0 G 1 w \[2 1\] 0 d 0\.5 0\.5 99 19 re S/);
  assert.match(contentOf((await textField('0 0 100 20', ' /MK << /BC [0] >> /BS << /S /U >>')).draw('x')), /0 G 1 w 0 0\.5 m 100 0\.5 l S/);
  const beveled = contentOf((await textField('0 0 100 20', ' /MK << /BC [0] /BG [0.8] >> /BS << /S /B >>')).draw('x'));
  assert.match(beveled, /1 g 1 1 m/);
  assert.match(beveled, /0\.4 g 99 19 m/);
  assert.match(beveled, /2 2 96 16 re W n/);
  assert.match(contentOf((await textField('0 0 100 20', ' /MK << /BC [0] >> /BS << /S /I >>')).draw('x')), /0\.5 g 1 1 m.*0\.75 g/s);
  assert.doesNotMatch(contentOf((await textField('0 0 100 20', ' /MK << /BG [] >>')).draw('x')), / re f\n/, 'fundo transparente');
  // Giro 90: a área desenhada tem a largura e a altura trocadas, e a /Matrix leva de volta ao /Rect.
  const turned = await textField('100 100 120 300', ' /MK << /R 90 >> /DA (/Helv 10 Tf 0 g)');
  const result = turned.draw('Vertical');
  assert.deepEqual(result.stream.dict.get('BBox'), [0, 0, 200, 20]);
  assert.deepEqual(result.stream.dict.get('Matrix'), [0, 1, -1, 0, 20, 0]);
  const [run] = placedRuns(turned.widget, result);
  assert.ok(inside(run, turned.widget.rect), JSON.stringify(run));
  assert.ok(run.y1 - run.y0 > run.x1 - run.x0, 'o texto sobe na página');
});

test('/MK /R 90 numa página com /Rotate 90: o texto fica de pé na página como aparece', async () => {
  const { form, widget, doc } = await textField('100 100 120 300', ' /MK << /R 90 >> /DA (/Helv 10 Tf 0 g)', { page: ' /Rotate 90' });
  form.setValue(0, 'De pé');
  const result = form.appearance(form.fields[0], widget, 'De pé');
  // Direção do texto na página: a /Matrix gira 90° para a esquerda; o /Rotate 90 gira a página 90° para a direita.
  const [a, b] = result.stream.dict.get('Matrix');
  assert.deepEqual([a, b], [0, 1], 'o texto corre para cima no PDF…');
  assert.equal(doc.pages[0].rotate, 90, '…que a página girada mostra da esquerda para a direita');
  const out = rebuilt(doc, form.fill());
  assert.match(out, /\/Matrix \[0 1 -1 0 20 0\]/);
  assert.match(out, /\(De p\\351\) Tj/);
});

test('caixa e rádio: o estado "marcado" que o widget tem; sem o desenho, ✓, ✗, ● ou ■ pelo /MK /CA', async () => {
  const doc = await open(formPdf({
    10: '<< /T (com) /FT /Btn /Type /Annot /Subtype /Widget /Rect [10 10 22 22] /P 3 0 R /AS /Off /AP << /N << /Sim 30 0 R /Off 31 0 R >> >> >>',
    11: '<< /T (so-on) /FT /Btn /Type /Annot /Subtype /Widget /Rect [30 10 42 22] /P 3 0 R /AS /Off /AP << /N << /On 30 0 R >> >> >>',
    12: '<< /T (sem-ap) /FT /Btn /Type /Annot /Subtype /Widget /Rect [50 10 62 22] /P 3 0 R /MK << /CA (8) /BC [0] >> /DA (1 0 0 rg /ZaDb 0 Tf) >>',
    13: '<< /T (sem-ap-quadrado) /FT /Btn /Type /Annot /Subtype /Widget /Rect [70 10 82 22] /P 3 0 R /MK << /CA (n) >> >>',
    14: '<< /T (r) /FT /Btn /Ff 32768 /Kids [15 0 R 16 0 R] >>',
    15: '<< /Type /Annot /Subtype /Widget /Parent 14 0 R /Rect [10 40 22 52] /P 3 0 R >>',
    16: '<< /Type /Annot /Subtype /Widget /Parent 14 0 R /Rect [30 40 42 52] /P 3 0 R >>',
    30: { dict: '/BBox [0 0 12 12]', data: '(MARCADA) Tj' },
    31: { dict: '/BBox [0 0 12 12]', data: '(DESMARCADA) Tj' },
  }, { fields: '10 0 R 11 0 R 12 0 R 13 0 R 14 0 R', annots: '10 0 R 11 0 R 12 0 R 13 0 R 15 0 R 16 0 R' }));
  const { form } = doc;
  const [com, soOn, semAp, quadrado, radio] = form.fields;
  const draw = (field, value, i = 0) => form.appearance(field, field.widgets[i], value);
  assert.deepEqual(draw(com, 'Sim'), { state: 'Sim', clipped: false, missing: '' });
  assert.deepEqual(draw(com, null), { state: 'Off', clipped: false, missing: '' });
  assert.deepEqual(draw(soOn, null), { state: 'Off', clipped: false, missing: '' }, 'caixa sem desenho de desligado: nada');
  assert.deepEqual(draw(soOn, 'On').state, 'On');
  // Sem /AP: ✗ (CA 8) em vermelho, com a borda; ■ (CA n); no rádio, ● (padrão).
  const cross = contentOf(draw(semAp, 'Yes'));
  assert.match(cross, /0 G 1 w 0\.5 0\.5 11 11 re S/);
  assert.match(cross, /q 1 0 0 -1 [\d.]+ [\d.]+ cm [\d.]+ w 1 J 1 j 1 0 0 RG\n.* m .* l .* m .* l S Q/s);
  assert.match(contentOf(draw(quadrado, 'Yes')), /q 0 g [\d.]+ [\d.]+ m .* h f Q/);
  assert.deepEqual(radio.options.map((o) => o.value), ['0', '1']);
  assert.match(contentOf(draw(radio, '1', 1)), / c .* h f Q/, '● do rádio');
  assert.equal(draw(radio, '1', 0).stream.data.length > 0, true, 'o widget desligado sem aparência: só a moldura');
  assert.doesNotMatch(contentOf(draw(radio, '1', 0)), / f Q/);
  // No PDF novo: a caixa marcada leva o desenho "marcado" do arquivo, e o desligado nem vai.
  form.setValue(com.id, true);
  const out = rebuilt(doc, form.fill());
  assert.match(out, /\(MARCADA\) Tj/);
  assert.doesNotMatch(out, /DESMARCADA/);
});

test('rádio com estados "0" e "1" e /Opt: o widget cujo estado é a opção escolhida fica marcado', async () => {
  const doc = await open(formPdf({
    10: '<< /T (tipo) /FT /Btn /Ff 49152 /V /0 /Opt [(Pessoa f\\355sica) (Pessoa jur\\355dica)] /Kids [11 0 R 12 0 R] >>',
    11: '<< /Type /Annot /Subtype /Widget /Parent 10 0 R /Rect [10 40 22 52] /P 3 0 R /AS /0 /AP << /N << /0 30 0 R /Off 31 0 R >> >> >>',
    12: '<< /Type /Annot /Subtype /Widget /Parent 10 0 R /Rect [30 40 42 52] /P 3 0 R /AS /Off /AP << /N << /1 30 0 R /Off 31 0 R >> >> >>',
    30: { dict: '/BBox [0 0 12 12]', data: '(ON) Tj' },
    31: { dict: '/BBox [0 0 12 12]', data: '(OFF) Tj' },
  }, { fields: '10 0 R', annots: '11 0 R 12 0 R' }));
  const { form } = doc;
  assert.deepEqual(form.fields[0].options, [{ value: '0', label: 'Pessoa física' }, { value: '1', label: 'Pessoa jurídica' }]);
  assert.equal(form.value(0), '0');
  form.setValue(0, '1');
  assert.deepEqual([...form.fill()], [[11, { state: 'Off' }], [12, { state: '1' }]]);
  assert.throws(() => form.setValue(0, 'Pessoa jurídica'), /Opção inexistente/);
  form.setValue(0, null);
  assert.deepEqual([...form.fill()].map(([, v]) => v.state), ['Off', 'Off']);
});

test('lista suspensa (nome da opção, texto livre com /Ff 19) e lista (a partir do /TI, a escolhida em destaque)', async () => {
  const doc = await open(formPdf({
    10: '<< /T (uf) /FT /Ch /Ff 131072 /Opt [[(SP) (S\\343o Paulo)] [(MG) (Minas Gerais)]] /DA (/Helv 10 Tf 0 g) /Type /Annot /Subtype /Widget /Rect [10 700 200 720] /P 3 0 R >>',
    11: '<< /T (cidade) /FT /Ch /Ff 393216 /Opt [(Belo Horizonte)] /DA (/Helv 10 Tf 0 g) /Type /Annot /Subtype /Widget /Rect [10 650 200 670] /P 3 0 R >>',
    12: '<< /T (cor) /FT /Ch /Opt [(azul) (verde) (amarelo) (vermelho) (preto)] /TI 1 /DA (/Helv 10 Tf 0 g) /Type /Annot /Subtype /Widget /Rect [10 500 200 541] /P 3 0 R >>',
  }, { fields: '10 0 R 11 0 R 12 0 R', annots: '10 0 R 11 0 R 12 0 R' }));
  const { form } = doc;
  const [uf, cidade, cor] = form.fields;
  form.setValue(uf.id, 'MG');
  assert.match(contentOf(form.appearance(uf, uf.widgets[0], 'MG')), /\(Minas Gerais\) Tj/, 'o nome, não o valor de exportação');
  assert.throws(() => form.setValue(uf.id, 'RJ'), /Opção inexistente/);
  form.setValue(cidade.id, 'Contagem');
  assert.match(contentOf(form.appearance(cidade, cidade.widgets[0], 'Contagem')), /\(Contagem\) Tj/, 'texto livre');
  // Lista de 41 pontos de altura, letra de 10: três linhas visíveis a partir do /TI (verde, amarelo, vermelho).
  const list = contentOf(form.appearance(cor, cor.widgets[0], 'amarelo'));
  assert.deepEqual([...list.matchAll(/\(([a-z]+)\) Tj/g)].map((m) => m[1]), ['verde', 'amarelo', 'vermelho']);
  assert.match(list, /0\.6 0\.75 0\.86 rg 0 14 190 13\.5 re f/, 'a escolhida em destaque');
  // A escolhida fora das visíveis: a lista rola até ela.
  const scrolled = contentOf(form.appearance(cor, cor.widgets[0], 'preto'));
  assert.deepEqual([...scrolled.matchAll(/\(([a-z]+)\) Tj/g)].map((m) => m[1]), ['amarelo', 'vermelho', 'preto']);
});

// ---------- PDF novo ----------

test('PDF novo: só o que aparece, sem /AcroForm, /Widget, /V, /AA nem a aparência antiga do campo preenchido', async () => {
  const doc = await open(formPdf({
    10: '<< /T (nome) /FT /Tx /V (Antigo) /AA << /K << /S /JavaScript /JS (app.alert\\(1\\)) >> >> /Type /Annot /Subtype /Widget /Rect [100 700 300 720] /P 3 0 R /AP << /N 30 0 R >> >>',
    11: '<< /T (oculto) /FT /Tx /V (Escondido) /Type /Annot /Subtype /Widget /F 2 /Rect [100 650 300 670] /P 3 0 R /AP << /N 31 0 R >> >>',
    12: '<< /T (vazio) /FT /Tx /Type /Annot /Subtype /Widget /Rect [100 600 300 620] /P 3 0 R /AP << /N 32 0 R >> >>',
    30: { dict: '/BBox [0 0 200 20] /Resources << /Font << /Helv 5 0 R >> >>', data: '/Tx BMC BT /Helv 12 Tf 2 5 Td (APARENCIA-ANTIGA) Tj ET EMC' },
    31: { dict: '/BBox [0 0 200 20]', data: '(OCULTO) Tj' },
    32: { dict: '/BBox [0 0 200 20]', data: '0.9 g 0 0 200 20 re f' },
  }, { fields: '10 0 R 11 0 R 12 0 R', annots: '10 0 R 11 0 R 12 0 R' }));
  doc.form.setValue(0, 'Novo valor');
  const out = rebuilt(doc, doc.form.fill());
  assert.match(out, /\(Novo valor\) Tj/);
  assert.doesNotMatch(out, /APARENCIA-ANTIGA|Antigo|Escondido|OCULTO|app\.alert/);
  assert.doesNotMatch(out, /\/AcroForm|\/Widget|\/V |\/AA|\/Annots|\/NeedAppearances/);
  assert.match(out, /0\.9 g 0 0 200 20 re f/, 'o campo vazio continua com a aparência dele');
});

test('o valor fica dentro do /Rect também com a página girada e com CropBox', async () => {
  for (const page of ['', ' /Rotate 90', ' /Rotate 270 /CropBox [50 50 562 742]']) {
    const { form, widget, doc } = await textField('100 600 300 640', ' /Ff 4096 /DA (/Helv 0 Tf 0 g) /MK << /BC [0] /BG [0.9] >>', { page });
    form.setValue(0, 'Primeira linha\nSegunda linha bem mais comprida que a primeira, para quebrar');
    const result = form.appearance(form.fields[0], widget, form.value(0));
    for (const run of placedRuns(widget, result)) assert.ok(inside(run, widget.rect), `${page}: ${JSON.stringify(run)}`);
    assert.ok(rebuilt(doc, form.fill()).length > 0, page);
  }
});
