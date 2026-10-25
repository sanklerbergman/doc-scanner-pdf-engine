// Formulários de PDFs maliciosos ou estranhos (#15, review da v4.1.0): a leitura dos campos e o desenho dos valores não
// travam nem estouram a memória, nada do PDF cai em propriedade herdada de objeto comum, e um erro na leitura não
// impede o PDF de abrir. Também a dica do "formulário" sem campos (Editar → Texto).
// Os casos que travariam rodam num Worker com tempo e memória limitados: uma regressão falha o teste, sem travar a
// suíte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { openPdf, copyPages } from '../web/js/pdf-reader.js';
import { readForm, nearbyText, inputHints } from '../web/js/pdf-form.js';
import { loadForm } from '../web/js/pdf-open.js';
import { looksLikeForm } from '../web/js/page-text.js';
import { buildPdf } from './helpers/qpdf.js';
import { makeRawPdf, textPageObjects } from './helpers/pdf.js';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const url = (path) => new URL(path, import.meta.url).href;

/**
 * Roda body (o corpo de uma função async que recebe bytes e devolve o resultado) num Worker com até ms de tempo e
 * 256 MB de memória. Devolve {ms, result} (ms: o tempo do corpo, sem carregar os módulos) ou {timeout} ou {error}.
 */
function limited(body, bytes, ms = 5000) {
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const reader = await import(${JSON.stringify(url('../web/js/pdf-reader.js'))});
      const form = await import(${JSON.stringify(url('../web/js/pdf-form.js'))});
      const start = performance.now();
      const result = await (async (bytes) => { ${body} })(workerData);
      parentPort.postMessage({ ms: performance.now() - start, result });
    })().catch((err) => parentPort.postMessage({ error: err.stack }));`;
  return new Promise((resolve) => {
    const worker = new Worker(code, { eval: true, workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const finish = (value) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ timeout: true }), ms);
    worker.once('message', finish);
    worker.once('error', (err) => finish({ error: err.message }));
  });
}

const fast = (outcome, limit = 1000) => {
  assert.equal(outcome.timeout, undefined, 'passou do tempo');
  assert.equal(outcome.error, undefined, outcome.error);
  assert.ok(outcome.ms < limit, `${Math.round(outcome.ms)} ms`);
};

test('/Kids enorme e repetido (10 mil campos com o mesmo filho 10 mil vezes): a leitura para no limite, sem travar', async () => {
  // Cada campo empilha 10 mil vezes o mesmo filho, que já foi lido: sem um limite de entradas, são 100 milhões de voltas.
  const count = 10000;
  const objects = {
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields 21 0 R >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Kids'),
    11: '<< /T (t) /FT /Tx >>',
    20: `[${'11 0 R '.repeat(count)}]`,
    21: `[${Array.from({ length: count }, (_, i) => `${100 + i} 0 R`).join(' ')}]`,
  };
  for (let i = 0; i < count; i++) objects[100 + i] = '<< /T (c) /Kids 20 0 R >>';
  const outcome = await limited(`
    const doc = await reader.openPdf(bytes);
    const nodes = doc.formFields();
    const read = await form.readForm(doc);
    return { nodes: nodes.length, fields: read.fields.length, signed: doc.isSigned() };`, makeRawPdf(objects).bytes, 10000);
  fast(outcome);
  assert.ok(outcome.result.nodes <= 10000, String(outcome.result.nodes));
});

test('pente com /MaxLen enorme: sem laço sem fim nem stream gigante; o controle não recebe um maxlength inválido', async () => {
  const pdf = (maxLen) => makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [10 0 R] /NeedAppearances true /DA (/Helv 0 Tf 0 g) >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Pente', { extra: ' /Annots [10 0 R]' }),
    10: `<< /T (cpf) /FT /Tx /Ff 16777216 /MaxLen ${maxLen} /V (12345) /MK << /BC [0] >> /Type /Annot /Subtype /Widget /Rect [100 700 300 720] /P 3 0 R >>`,
  }).bytes;
  for (const maxLen of ['2147483647', '1000000000000000']) {
    const outcome = await limited(`
      const doc = await reader.openPdf(bytes);
      const read = await form.readForm(doc);
      read.redrawn();
      read.setValue(0, '1234567890');
      const sizes = [...read.fill().values()].map((item) => item.stream.data.length);
      return { sizes, maxLength: form.inputHints(read.fields[0]).maxLength };`, pdf(maxLen));
    fast(outcome);
    assert.ok(outcome.result.sizes.every((size) => size < 20000), JSON.stringify(outcome.result.sizes));
    assert.ok(outcome.result.maxLength <= 2147483647, String(outcome.result.maxLength));
  }
  // Um pente que cabe continua pente: uma letra em cada casa.
  const doc = await openPdf(pdf(5));
  const read = await readForm(doc);
  assert.equal(read.fields[0].comb, true);
  assert.deepEqual(inputHints(read.fields[0]).maxLength, 5);
});

test('rótulo pelo texto vizinho: trecho enorme ou cheio de ":" não fica quadrático', async () => {
  const box = { x0: 0.5, y0: 0.5, x1: 0.7, y1: 0.52 };
  for (const str of [`${':'.repeat(200000)}a`, `${' -'.repeat(100000)}x`, `Nome${':'.repeat(300000)}`]) {
    const item = { str, x0: 0.1, y0: 0.5, x1: 0.49, y1: 0.52 };
    const start = performance.now();
    const label = nearbyText(box, [item]);
    assert.ok(performance.now() - start < 1000, `${Math.round(performance.now() - start)} ms`);
    assert.ok(label.length <= 80, String(label.length));
  }
  assert.equal(nearbyText(box, [{ str: 'Nome do segurado: ', x0: 0.1, y0: 0.5, x1: 0.49, y1: 0.52 }]), 'Nome do segurado');
  assert.equal(nearbyText(box, [{ str: 'Data — ', x0: 0.1, y0: 0.5, x1: 0.49, y1: 0.52 }]), 'Data');
});

test('/DA e /MK /CA com nome de propriedade de objeto ("constructor", "__proto__"): fonte e marca padrão', async () => {
  const bytes = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [10 0 R 11 0 R 12 0 R] /NeedAppearances true >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Proto', { extra: ' /Annots [10 0 R 11 0 R 12 0 R]' }),
    10: '<< /T (a) /FT /Tx /V (Ana) /DA (/constructor 12 Tf 0 g) /Type /Annot /Subtype /Widget /Rect [100 700 300 720] /P 3 0 R >>',
    11: '<< /T (b) /FT /Tx /V (Bia) /DA (/__proto__ 0 Tf 0 g) /Type /Annot /Subtype /Widget /Rect [100 650 300 670] /P 3 0 R >>',
    12: '<< /T (c) /FT /Btn /V /Yes /MK << /CA (constructor) >> /DA (/toString 0 Tf 0 g) /Type /Annot /Subtype /Widget /Rect [100 600 112 612] /P 3 0 R >>',
  }).bytes;
  const doc = await openPdf(bytes);
  const form = await readForm(doc);
  assert.deepEqual(form.fields.map((f) => f.widgets[0].da.font), ['Helvetica', 'Helvetica', 'Helvetica']);
  const fill = form.fill();
  const copy = copyPages(doc, [0], { fill });
  const out = latin1(buildPdf([{ copy: { source: copy, page: copy.pages.get(0) } }]));
  assert.match(out, /\(Ana\) Tj/);
  assert.match(out, /\(Bia\) Tj/);
  assert.match(latin1(fill.get(12).stream.data), / m .* l .* l S Q/, 'a caixa sem desenho ganha o ✓ padrão');
});

test('erro na leitura dos campos: o PDF abre como antes, sem preencher, com uma nota', async () => {
  const bytes = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [10 0 R] >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Erro', { extra: ' /Annots [10 0 R]' }),
    10: '<< /T (a) /FT /Tx /V (Ana) /Type /Annot /Subtype /Widget /Rect [100 700 300 720] /P 3 0 R >>',
  }).bytes;
  const doc = await openPdf(bytes);
  doc.formFields(); // os campos já lidos pela assinatura (isSigned) continuam valendo
  const broken = await loadForm(doc, () => { throw new Error('PDF estranho'); });
  assert.equal(broken.form, null);
  assert.deepEqual(broken.notes, ['Não deu para ler os campos do formulário deste PDF: ele sai com os campos como estão, e não dá para preenchê-lo aqui.']);
  const fine = await loadForm(doc);
  assert.equal(fine.form.fields.length, 1);
  assert.deepEqual(fine.notes, ['Este PDF tem um formulário com 1 campo.']);
});

test('"formulário" sem campos: a página parece um formulário (linhas para preencher, quadrinhos, "requerimento")', () => {
  const items = (...lines) => lines.map((str) => ({ str }));
  assert.equal(looksLikeForm(items('REQUERIMENTO', 'Nome: ____________________________', 'CPF: _______________', 'Data: ___/___/_____')), true);
  assert.equal(looksLikeForm(items('Autorização de débito', 'Banco: ..............................', 'Agência: ...................', '( ) Conta corrente  ( ) Poupança')), true);
  assert.equal(looksLikeForm(items('Formulário de inscrição', 'Nome completo: ______________________')), true, 'a palavra e uma linha bastam');
  assert.equal(looksLikeForm(items('Contrato de locação', 'O locador e o locatário acordam...', '_______________________', 'Assinatura')), false, 'uma linha de assinatura não faz formulário');
  assert.equal(looksLikeForm(items('Relatório anual', 'Receita cresceu 10%.', 'Tabela 1 ... 12')), false);
  assert.equal(looksLikeForm([]), false);
  assert.equal(looksLikeForm(items(`${'_'.repeat(500000)}x`)), false, 'texto enorme não trava (só uma linha)');
  assert.equal(looksLikeForm(items('Sumário', 'Capítulo 1 ................ 3', 'Capítulo 2 ................ 12', 'Anexo ..........45')), false, 'pontilhado de sumário');
  const start = performance.now();
  looksLikeForm(Array.from({ length: 5000 }, () => ({ str: `${'.'.repeat(1990)} 1` })));
  assert.ok(performance.now() - start < 1000, `pontilhado longo: ${Math.round(performance.now() - start)} ms`);
});
