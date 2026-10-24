// Fase 3 da edição (edit-marks.js): marca-texto (ExtGState com /ca, /CA e /BM /Multiply), sublinhado, riscado e marca
// d'água em todas as páginas, nos três tipos de página, com a tarja por cima, o PDF/A e o veraPDF.
// A interface (editor.js, edit-mark-tools.js e watermark.js) é conferida no navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editType, resourceCollector, redactEdits, paintEdits, editCharacters, fileExtras, rotateEdits } from '../web/js/edits.js';
import '../web/js/edit-types.js';
import {
  lineFromDrag, watermarkEdit, watermarkLayout, watermarkText, MARK_ALPHA, WATERMARK_ALPHA, WATERMARK_FONT, DEFAULT_TINT,
} from '../web/js/edit-marks.js';
import { layoutPage, buildPdf as buildRaw } from '../web/js/pdf.js';
import { openPdf, copyPages } from '../web/js/pdf-reader.js';
import { embedFonts, usedCharacters } from '../web/js/pdfa-fonts.js';
import { openCertificate } from '../web/js/sign.js';
import { stampCharacters } from '../web/js/stamp.js';
import { textWidth } from '../web/js/fonts.js';
import { buildPdf } from './helpers/qpdf.js';
import { makeRawPdf, textPageObjects } from './helpers/pdf.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const HIGHLIGHT = { type: 'highlight', x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.23, tint: '#33cc66' };
const UNDERLINE = { type: 'underline', x0: 0.1, y0: 0.3, x1: 0.5, y1: 0.31, color: '#dc2626', width: 2, from: [0, 0.5], to: [1, 0.5] };
const STRIKE = { type: 'strike', x0: 0.1, y0: 0.4, x1: 0.5, y1: 0.45, color: '#000000', width: 1, from: [0.02, 0.9], to: [0.98, 0.1] };
const MARKS = [HIGHLIGHT, UNDERLINE, STRIKE];

const photoPage = (extra = {}) => ({ jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(30, 40, 'a4', 36), ...extra });
const wordPage = (extra = {}) => ({
  width: 595.28, height: 841.89, items: [{ type: 'text', x: 72, y: 100, text: 'Contrato', font: 'Helvetica', size: 12 }], ...extra,
});
const A4 = { width: 595.28, height: 841.89 };

// Conteúdo de uma página de um PDF gerado (os streams juntos) e os recursos dela.
async function pageOf(pdf, index = 0) {
  const doc = await openPdf(pdf);
  const contents = doc.resolve(doc.pages[index].node.get('Contents'));
  const list = Array.isArray(contents) ? contents.map((ref) => doc.resolve(ref)) : [contents];
  const content = list.map((stream) => latin1(stream.data)).join('\n');
  return { doc, content, resources: doc.resolve(doc.pages[index].attrs.Resources) };
}

const sourcePdf = (extra = '') => makeRawPdf({
  1: '<< /Type /Catalog /Pages 2 0 R >>',
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
  ...textPageObjects('Copiada', { extra: ` /Rotate 90 /CropBox [20 30 600 760]${extra}` }),
}).bytes;

// ---------- Marca-texto e ExtGState ----------

test('marca-texto: retângulo cheio com o ExtGState de opacidade e Multiply, na cor escolhida', () => {
  const res = resourceCollector();
  const ops = editType('highlight').pdf(HIGHLIGHT, { w: 200, h: 20 }, res);
  assert.equal(ops, '/Ed1 gs 0.2 0.8 0.4 rg 0 0 200 20 re f');
  assert.deepEqual([...res.states], [['Ed1', { Type: 'ExtGState', ca: MARK_ALPHA, CA: MARK_ALPHA, BM: 'Multiply' }]]);
  // Dois marca-textos na mesma página dividem o mesmo ExtGState; cor inválida vira a padrão.
  const again = editType('highlight').pdf({ ...HIGHLIGHT, tint: 'red' }, { w: 10, h: 10 }, res);
  assert.match(again, /^\/Ed1 gs 1 0\.8 0 rg /);
  assert.equal(DEFAULT_TINT, '#ffcc00');
  assert.equal(res.states.size, 1);
});

test('ExtGState no PDF: dicionário com /ca, /CA e /BM /Multiply na foto, no Word e na página copiada', async () => {
  const doc = await openPdf(sourcePdf());
  const copy = copyPages(doc, [0], { edits: new Map([[0, { edits: [HIGHLIGHT], rotation: 0 }]]) });
  const pdf = buildPdf([photoPage({ edits: [HIGHLIGHT] }), wordPage({ edits: [HIGHLIGHT] }), { copy: { source: copy, page: copy.pages.get(0) } }]);
  for (let i = 0; i < 3; i++) {
    const { doc: again, content, resources } = await pageOf(pdf, i);
    const [, name] = content.match(/\/(Ed\d+) gs [\d. ]+ rg 0 0 [\d.]+ [\d.]+ re f/);
    const state = again.resolve(again.resolve(resources.get('ExtGState')).get(name));
    assert.equal(state.get('ca'), MARK_ALPHA, `página ${i + 1}`);
    assert.equal(state.get('CA'), MARK_ALPHA);
    assert.equal(state.get('BM').value, 'Multiply');
    assert.equal(state.get('Type').value, 'ExtGState');
  }
  assert.match(latin1(pdf), /^%PDF-1\.7/, 'a página copiada sobe a versão; a transparência é do PDF 1.4');
  assert.match(latin1(buildRaw([photoPage({ edits: [HIGHLIGHT] })])), /^%PDF-1\.4/);
});

test('ExtGState na página copiada: nomes novos, sem apagar os que a página já usa', async () => {
  // A página já tem /Ed1 e /Ed2 nos recursos (fonte e ExtGState): as marcas ganham outros nomes.
  const doc = await openPdf(sourcePdf(' /Resources << /Font << /F1 5 0 R /Ed1 5 0 R >> /ExtGState << /Ed2 << /CA 1 >> /GS0 << /ca 0.9 >> >> >>'));
  const watermark = watermarkEdit('CÓPIA');
  const copy = copyPages(doc, [0], { edits: new Map([[0, { edits: [HIGHLIGHT, watermark, UNDERLINE], rotation: 0 }]]) });
  const pdf = buildPdf([{ copy: { source: copy, page: copy.pages.get(0) } }]);
  const { doc: again, content, resources } = await pageOf(pdf);
  const states = again.resolve(resources.get('ExtGState'));
  const fonts = again.resolve(resources.get('Font'));
  assert.deepEqual([...states.keys()].sort(), ['Ed2', 'Ed3', 'Ed4', 'GS0']);
  assert.equal(states.get('Ed2').get('CA'), 1, 'o que a página tinha continua');
  assert.equal(states.get('GS0').get('ca'), 0.9);
  assert.ok(fonts.has('Ed1') && fonts.has('F1'));
  const used = [...content.matchAll(/\/(Ed\d+) (gs|[\d.]+ Tf)/g)].map(([, name]) => name);
  assert.deepEqual(new Set(used), new Set(['Ed3', 'Ed4', 'Ed5']));
  assert.equal(again.resolve(fonts.get('Ed5')).get('BaseFont').value, WATERMARK_FONT);
  assert.equal(states.get('Ed4').get('ca'), WATERMARK_ALPHA);
  assert.equal(states.get('Ed4').has('BM'), false, 'a marca d\'água não multiplica');
});

// ---------- Sublinhado e riscado ----------

test('sublinhado e riscado: linha da cor e da espessura da caneta, de "from" a "to" no quadro da edição', () => {
  assert.equal(editType('underline').pdf(UNDERLINE, { w: 200, h: 4 }), '2 w 0 J 0.863 0.149 0.149 RG\n0 2 m 200 2 l S');
  assert.equal(editType('strike').pdf(STRIKE, { w: 100, h: 10 }), '1 w 0 J 0 0 0 RG\n2 9 m 98 1 l S');
  assert.equal(editType('underline').label, 'Sublinhado');
  assert.equal(editType('strike').label, 'Riscado');
  // "Novo" pelo teclado: linha reta no meio da caixa.
  const made = editType('strike').create({ x0: 0.4, y0: 0.5, x1: 0.6, y1: 0.51 }, { color: '#000000', width: 2 });
  assert.deepEqual([made.from, made.to], [[0, 0.5], [1, 0.5]]);
});

test('linha arrastada: até 4° da horizontal fica reta na altura do começo; mais que isso, inclinada; um toque não cria', () => {
  const props = { color: '#1d4ed8', width: 2 };
  // 3° de inclinação: reta.
  const a = [0.2, 0.5];
  const dx = 200 / A4.width;
  const b = [a[0] + dx, a[1] + (200 * Math.tan((3 * Math.PI) / 180)) / A4.height];
  const flat = lineFromDrag('underline', a, b, props, A4);
  assert.equal(flat.type, 'underline');
  assert.deepEqual([flat.from[1], flat.to[1]], [0.5, 0.5]);
  assert.ok(close(flat.y0 * A4.height, 0.5 * A4.height - 2, 1e-6) && close((flat.y1 - flat.y0) * A4.height, 4, 1e-6), 'meia espessura e um ponto de folga');
  assert.ok(close(flat.x0 * A4.width, a[0] * A4.width - 2) && close(flat.x1 * A4.width, b[0] * A4.width + 2));
  // 10°: inclinada, da cauda à ponta.
  const c = [a[0] + dx, a[1] - (200 * Math.tan((10 * Math.PI) / 180)) / A4.height];
  const tilted = lineFromDrag('strike', a, c, props, A4);
  assert.ok(tilted.from[1] > 0.9 && tilted.to[1] < 0.1 && tilted.from[0] < 0.1 && tilted.to[0] > 0.9, JSON.stringify(tilted));
  assert.equal(lineFromDrag('underline', a, [a[0] + 5 / A4.width, a[1]], props, A4), null);
  // Perto da borda: a caixa não sai da página.
  const edge = lineFromDrag('underline', [0, 0], [0.5, 0], props, A4);
  assert.ok(edge.x0 === 0 && edge.y0 === 0 && edge.y1 > 0);
});

test('prévia no canvas: o marca-texto multiplica com transparência; a linha usa a espessura em pontos', () => {
  const calls = [];
  const ctx = {
    canvas: { width: 300, height: 400 },
    save() {}, restore() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fillRect(...args) { calls.push(['fillRect', this.globalAlpha, this.globalCompositeOperation, this.fillStyle, args]); },
    stroke() { calls.push(['stroke', this.lineWidth, this.strokeStyle, this.lineCap]); },
  };
  paintEdits(ctx, [HIGHLIGHT, UNDERLINE], A4);
  assert.deepEqual(calls[0].slice(0, 4), ['fillRect', MARK_ALPHA, 'multiply', '#33cc66']);
  assert.deepEqual(calls[1], ['stroke', 2, '#dc2626', 'butt']);
});

// ---------- Marca d'água ----------

test('marca d\'água: na diagonal, centrada e dentro de 80% da página, com o tamanho pela largura da Helvetica-Bold', () => {
  for (const [w, h] of [[595.28, 841.89], [841.89, 595.28], [300, 300]]) {
    for (const text of ['CÓPIA', 'CONFIDENCIAL', 'Cópia autêntica — não vale como original']) {
      const { size, u, up, start, letters } = watermarkLayout(text, w, h);
      assert.ok(close(Math.atan2(-u[1], u[0]), Math.atan2(h, w)), 'de baixo à esquerda para cima à direita');
      const length = letters.at(-1).b;
      assert.ok(close(length, textWidth(text, WATERMARK_FONT, size), 1e-6));
      // Os quatro cantos (linha de base e altura das maiúsculas) dentro de 80% da página, e o centro no centro.
      const corner = (s, t) => [start[0] + s * u[0] + t * up[0], start[1] + s * u[1] + t * up[1]];
      const corners = [corner(0, 0), corner(length, 0), corner(length, 0.718 * size), corner(0, 0.718 * size)];
      const xs = corners.map(([x]) => x);
      const ys = corners.map(([, y]) => y);
      assert.ok(Math.max(...xs) - Math.min(...xs) <= 0.8 * w + 1e-6 && Math.max(...ys) - Math.min(...ys) <= 0.8 * h + 1e-6, `${text} em ${w} × ${h}`);
      const center = corner(length / 2, 0.359 * size);
      assert.ok(close(center[0], w / 2, 1e-6) && close(center[1], h / 2, 1e-6));
    }
  }
  assert.equal(watermarkLayout('', 100, 100), null);
  // Só as letras da WinAnsi, numa linha, sem espaço repetido nem nas pontas e com até 40 letras.
  assert.equal(watermarkText('  Cópia ✓ 😀\nfiel  '), 'Cópia fiel');
  assert.equal(watermarkText('x'.repeat(60)).length, 40);
});

test('marca d\'água no PDF: texto em Helvetica-Bold, transparente, girado pela matriz do texto, com acento em octal', () => {
  const res = resourceCollector();
  const edit = watermarkEdit('CÓPIA');
  assert.deepEqual(edit, { type: 'watermark', x0: 0, y0: 0, x1: 1, y1: 1, text: 'CÓPIA' });
  const ops = editType('watermark').pdf(edit, { w: A4.width, h: A4.height }, res);
  const { size, u, up } = watermarkLayout('CÓPIA', A4.width, A4.height);
  const n = (v) => String(Math.round(v * 1e4) / 1e4);
  assert.match(ops, new RegExp(`^/Ed1 gs 0\\.4 0\\.4 0\\.4 rg BT /Ed2 ${n(size).replace('.', '\\.')} Tf\\n`));
  assert.ok(ops.includes(`${n(u[0])} ${n(u[1])} ${n(up[0])} ${n(up[1])} `), ops);
  assert.match(ops, /Tm \(C\\323PIA\) Tj\nET$/);
  assert.deepEqual([...res.states.values()], [{ Type: 'ExtGState', ca: WATERMARK_ALPHA, CA: WATERMARK_ALPHA }]);
  assert.deepEqual([...res.fonts.values()], [WATERMARK_FONT]);
  assert.deepEqual([...editCharacters([edit])], [[WATERMARK_FONT, 'CÓPIA']]);
  // Parênteses e barra invertida escapados.
  assert.match(editType('watermark').pdf(watermarkEdit('(A\\B)'), { w: 100, h: 100 }, resourceCollector()), /\(\\\(A\\\\B\\\)\) Tj/);
  assert.equal(editType('watermark').pdf(watermarkEdit('   '), { w: 100, h: 100 }, resourceCollector()), '');
});

test('marca d\'água na prévia: a letra do aparelho é esticada até a largura da Helvetica-Bold, transparente', () => {
  const calls = [];
  const ctx = {
    canvas: { width: 300, height: 424 },
    save() {}, restore() {}, setTransform() {}, transform(...m) { calls.push(['transform', m]); },
    scale(x, y) { calls.push(['scale', x, y]); },
    measureText: (text) => ({ width: text.length * 100 }),
    fillText(text) { calls.push(['fillText', text, this.globalAlpha, this.font]); },
  };
  paintEdits(ctx, [watermarkEdit('CONFIDENCIAL')], A4);
  const { size, letters } = watermarkLayout('CONFIDENCIAL', A4.width, A4.height);
  const [, sx] = calls.find(([kind]) => kind === 'scale');
  assert.ok(close(sx, letters.at(-1).b / 1200, 1e-9));
  const [, text, alpha, font] = calls.find(([kind]) => kind === 'fillText');
  assert.equal(text, 'CONFIDENCIAL');
  assert.equal(alpha, WATERMARK_ALPHA);
  assert.match(font, new RegExp(`^bold ${size}px `));
});

test('marca d\'água por arquivo: em cada página de cada arquivo gerado', async () => {
  const pages = [photoPage(), wordPage({ rotation: 90 }), wordPage()];
  // Um PDF por página e por intervalos: a marca entra em todas, sem depender da posição no arquivo.
  for (const groups of [[[0, 1, 2]], [[0], [1], [2]], [[0, 1], [2]]]) {
    const extras = fileExtras(groups, () => [watermarkEdit('CÓPIA')]);
    for (const [g, group] of groups.entries()) {
      const pdf = buildPdf(group.map((index, p) => ({ ...pages[index], edits: extras[g][p] })));
      for (let p = 0; p < group.length; p++) {
        const { content } = await pageOf(pdf, p);
        assert.equal(content.match(/\(C\\323PIA\) Tj/g).length, 1, `arquivo ${g + 1}, página ${p + 1}`);
      }
    }
  }
});

test('marca d\'água sob a tarja: saem só as letras que ela pega, e os trechos vão do último para o primeiro', () => {
  const edit = watermarkEdit('CONFIDENCIAL');
  const type = editType('watermark');
  assert.deepEqual(redactEdits([edit], [{ x0: 0, y0: 0, x1: 0.1, y1: 0.05 }], A4), [edit], 'tarja longe: nada muda');
  assert.deepEqual(redactEdits([edit], [{ x0: 0, y0: 0, x1: 1, y1: 1 }], A4), [], 'página inteira tarjada: a marca sai');
  const [cut] = redactEdits([edit], [{ x0: 0.45, y0: 0.45, x1: 0.55, y1: 0.55 }], A4);
  assert.ok(cut.hide.length > 0 && cut.hide.length < 12, JSON.stringify(cut.hide));
  // Nenhuma letra que ficou encosta na tarja (com a altura que a conferência mede, de 20% abaixo a 80% acima).
  const { size, u, up, start, letters } = watermarkLayout('CONFIDENCIAL', A4.width, A4.height);
  const tarja = [0.45 * A4.width, 0.45 * A4.height, 0.55 * A4.width, 0.55 * A4.height];
  letters.forEach((letter, i) => {
    if (cut.hide.includes(i)) return;
    for (const s of [letter.a, (letter.a + letter.b) / 2, letter.b]) {
      for (const t of [-0.2 * size, 0.3 * size, 0.8 * size]) {
        const [x, y] = [start[0] + s * u[0] + t * up[0], start[1] + s * u[1] + t * up[1]];
        assert.ok(!(x > tarja[0] && x < tarja[2] && y > tarja[1] && y < tarja[3]), `${letter.char} sob a tarja`);
      }
    }
  });
  // Dois trechos, o de depois da tarja primeiro: o PDF.js não emenda um no outro por cima do buraco.
  const ops = type.pdf(cut, { w: A4.width, h: A4.height }, resourceCollector());
  const shown = [...ops.matchAll(/\((\w+)\) Tj/g)].map(([, text]) => text);
  assert.equal(shown.length, 2, ops);
  assert.equal(shown.reverse().join('').length + cut.hide.length, 12);
  const xs = [...ops.matchAll(/ ([\d.-]+) [\d.-]+ Tm/g)].map(([, x]) => Number(x));
  assert.ok(xs[0] > xs[1], 'o trecho da direita vem antes');
  // As letras tiradas não entram no subconjunto da fonte do PDF/A: só as que ficam.
  const kept = [...'CONFIDENCIAL'].filter((_, i) => !cut.hide.includes(i)).join('');
  assert.deepEqual([...editCharacters([cut])], [[WATERMARK_FONT, kept]]);
  assert.ok(kept.length < 12);
});

test('foto e Word com tarja: a marca d\'água e as marcas por baixo, as tarjas por cima; o texto sob a tarja sai', async () => {
  const photo = photoPage({ redactions: [{ x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.7 }] });
  const edits = [...MARKS, watermarkEdit('CONFIDENCIAL')];
  const { content } = await pageOf(buildPdf([{ ...photo, edits }]));
  const tarja = content.lastIndexOf('0 0 0 rg');
  assert.ok(content.indexOf(' gs ') < tarja && content.lastIndexOf(' Tj') < tarja, content);
  const shown = [...content.matchAll(/\((\w+)\) Tj/g)].map(([, text]) => text).join('');
  assert.ok(shown.length < 12 && shown.length > 0, shown);
  const word = wordPage({ edits, items: [...wordPage().items, { type: 'redaction', x: 200, y: 300, w: 200, h: 250 }] });
  const { content: text } = await pageOf(buildPdf([word]));
  assert.ok(text.indexOf('re f\nQ') > 0 && text.lastIndexOf(' Tj') < text.lastIndexOf('0 0 0 rg'));
});

test('qpdf --check: marca-texto, sublinhado, riscado e marca d\'água nos três tipos de página, girados', async () => {
  const doc = await openPdf(sourcePdf());
  for (const turn of [0, 90, 180, 270]) {
    const edits = [...rotateEdits(MARKS, turn), watermarkEdit('Cópia fiel (não vale como original)')];
    const copy = copyPages(doc, [0], { edits: new Map([[0, { edits, rotation: turn }]]) });
    buildPdf([photoPage({ edits }), wordPage({ edits, rotation: turn }), { copy: { source: copy, page: copy.pages.get(0) }, rotation: turn }]);
  }
});

test('PDF/A: a marca d\'água pede a Helvetica-Bold embutida, só com as letras dela; sem a fonte, nada sai', async () => {
  const edits = [watermarkEdit('CÓPIA'), HIGHLIGHT];
  assert.throws(() => buildRaw([wordPage({ edits })], { pdfa: true }), /fontes das edições/);
  const used = usedCharacters([photoPage({ edits })]);
  assert.deepEqual([...used.get(WATERMARK_FONT)].sort(), ['A', 'C', 'I', 'P', 'Ó']);
  const fonts = await embedFonts([photoPage({ edits })]);
  const text = latin1(buildPdf([photoPage({ edits })], { pdfa: true, fonts }));
  assert.match(text, /\/BaseFont \/[A-Z]{6}\+LiberationSans-Bold/);
  assert.doesNotMatch(text, /\/BaseFont \/Helvetica-Bold/);
});

// veraPDF (perfil PDF/A-2B), quando a variável VERAPDF aponta o programa. Sem ele, o teste é pulado.
function veraPdf(t, files) {
  const verapdf = process.env.VERAPDF;
  if (!verapdf) {
    t.skip('VERAPDF não definido: a conferência com o veraPDF é pulada');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'verapdf-'));
  try {
    for (const [name, bytes] of Object.entries(files)) {
      writeFileSync(join(dir, name), bytes);
      const windows = /\.bat$/i.test(verapdf);
      const result = spawnSync(windows ? 'cmd.exe' : verapdf, [...(windows ? ['/c', verapdf] : []), '--flavour', '2b', '--format', 'xml', join(dir, name)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const failed = [...result.stdout.matchAll(/clause="([^"]+)" testNumber="(\d+)" status="failed"/g)].map((m) => `${m[1]}-${m[2]}`);
      assert.match(result.stdout, /isCompliant="true"/, `${name}: ${failed.join(', ') || result.stderr.slice(0, 300)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('veraPDF (PDF/A-2B) com transparência: marca-texto, sublinhado, riscado e marca d\'água na foto, no Word e assinado', async (t) => {
  if (!process.env.VERAPDF) {
    t.skip('VERAPDF não definido: a conferência com o veraPDF é pulada');
    return;
  }
  const photo = photoPage({ redactions: [{ x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.7 }] });
  const word = wordPage({ rotation: 90 });
  const photoEdits = [...MARKS, watermarkEdit('CÓPIA')];
  const wordEdits = [...rotateEdits(MARKS, 90), watermarkEdit('CONFIDENCIAL')];
  const pages = [{ ...photo, edits: photoEdits }, { ...word, edits: wordEdits }];
  const fonts = await embedFonts(pages);
  const signer = await openCertificate(fixture('certificados/titular-aes.pfx'), 'senha-de-teste');
  const signed = await signer.sign(pages, new Date(), {
    pdfa: true, stamp: { position: 'bottom-right', page: 'last' }, fonts: await embedFonts(pages, stampCharacters(signer.name)),
  });
  signer.discard();
  veraPdf(t, {
    'marcas-foto.pdf': buildPdf([pages[0]], { pdfa: true, fonts }),
    'marcas-word.pdf': buildPdf([pages[1]], { pdfa: true, fonts }),
    'marcas-assinado.pdf': signed,
  });
});
