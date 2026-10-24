// Texto novo (edit-text.js): só WinAnsi, tamanho da caixa e da letra, operadores do PDF nos três tipos de página,
// texto sob a tarja fora do arquivo, PDF/A com a Liberation embutida, numeração, cabeçalho e rodapé por arquivo, e o
// painel acima do teclado virtual (keyboard-panel.js). O painel e a prévia são conferidos no navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  winAnsiText, droppedMessage, textBox, textEdit, retext, editTextSize, textFont, pageNumber, allPagesText, NUMBER_FORMATS,
} from '../web/js/edit-text.js';
import { editsContent, resourceCollector, redactEdits, rotateEdits, fileExtras, editCharacters, editType } from '../web/js/edits.js';
import { textWidth, winAnsiCode } from '../web/js/fonts.js';
import { layoutPage, buildPdf as buildRaw } from '../web/js/pdf.js';
import { openPdf, copyPages } from '../web/js/pdf-reader.js';
import { embedFonts, usedCharacters } from '../web/js/pdfa-fonts.js';
import { keyboardOverlap } from '../web/js/keyboard-panel.js';
import { buildPdf } from './helpers/qpdf.js';
import { makeRawPdf, textPageObjects } from './helpers/pdf.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const hex = (text) => [...text].map((c) => winAnsiCode(c).toString(16).padStart(2, '0')).join('');
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const A4 = { width: 595.28, height: 841.89 };

const photoPage = (extra = {}) => ({ jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(30, 40, 'a4', 36), ...extra });
const wordPage = (extra = {}) => ({
  width: 595.28, height: 841.89, items: [{ type: 'text', x: 72, y: 100, text: 'Contrato', font: 'Helvetica', size: 12 }], ...extra,
});
async function pageContent(pdf, index = 0) {
  const doc = await openPdf(pdf);
  const contents = doc.resolve(doc.pages[index].node.get('Contents'));
  return (Array.isArray(contents) ? contents.map((ref) => doc.resolve(ref)) : [contents]).map((s) => latin1(s.data)).join('\n');
}

test('só as letras das fontes do PDF: emoji e alfabetos não latinos saem e são avisados; acento composto vira a letra', () => {
  assert.deepEqual(winAnsiText('Olá 😀 Привет — “ok” € ç'), { text: 'Olá   — “ok” € ç', dropped: ['😀', 'П', 'р', 'и', 'в', 'е', 'т'] });
  assert.equal(winAnsiText('ação').text, 'ação', 'a + til (como o macOS cola) vira ã');
  assert.equal(winAnsiText('a\tb\r\nc\rd').text, 'a b\nc\nd');
  assert.deepEqual(winAnsiText('a\u0000b​c️'), { text: 'abc', dropped: [] }, 'controle e seletores somem sem aviso');
  assert.equal(droppedMessage([]), '');
  assert.equal(droppedMessage(['😀']), 'A letra 😀 não existe nas fontes do PDF e ficou de fora.');
  assert.equal(droppedMessage(['😀', 'П', 'р']), 'As letras 😀 П e р não existem nas fontes do PDF e ficaram de fora.');
});

test('caixa do tamanho do texto: largura da linha mais comprida, altura das linhas, folga proporcional à letra', () => {
  const [w, h] = textBox('Olá\nmundo comprido', 'sans', 10);
  assert.ok(close(w, textWidth('mundo comprido', 'Helvetica', 10) + 4));
  assert.ok(close(h, 10 * (2 * 1.25 + 0.4)));
  const [w2, h2] = textBox('Olá\nmundo comprido', 'sans', 20);
  assert.ok(close(w2, 2 * w) && close(h2, 2 * h), 'a proporção não muda com o tamanho');
  assert.ok(close(textBox('abc', 'mono', 10)[0], 3 * 6 + 4), 'Courier: 600 milésimos por letra');
  assert.deepEqual(['sans', 'serif', 'mono', 'outra'].map(textFont), ['Helvetica', 'Times-Roman', 'Courier', 'Helvetica']);
});

test('texto novo no ponto tocado, dentro da página; texto largo demais fica com a letra menor; trocar mantém o canto e o giro', () => {
  const edit = textEdit({ text: 'Recebido', size: 14 }, [0.5, 0.5], A4);
  assert.ok(close((edit.x0 + edit.x1) / 2, 0.5, 1e-5) && close((edit.y0 + edit.y1) / 2, 0.5, 1e-5));
  assert.ok(close(editTextSize(edit, A4), 14, 1e-3), 'a letra sai da caixa');
  const corner = textEdit({ text: 'Recebido', size: 14 }, [0.99, 0.01], A4);
  assert.ok(corner.x1 <= 1 && corner.y0 >= 0);
  const wide = textEdit({ text: 'x'.repeat(300), size: 24 }, [0.5, 0.5], A4);
  assert.ok(wide.x1 - wide.x0 <= 1 - 24 / A4.width + 1e-9 && editTextSize(wide, A4) < 24);
  const changed = retext({ ...edit, turn: 90 }, { text: 'Recebido em 24/10', size: 20, family: 'serif', color: '#dc2626' }, A4);
  assert.equal(changed.x0, edit.x0);
  assert.equal(changed.y0, edit.y0);
  assert.equal(changed.turn, 90);
  const [w, h] = textBox('Recebido em 24/10', 'serif', 20);
  assert.ok(close((changed.x1 - changed.x0) * A4.width, h) && close((changed.y1 - changed.y0) * A4.height, w), 'girada, a caixa troca os lados');
  assert.ok(close(editTextSize(changed, A4), 20, 1e-3));
  assert.equal(retext({ ...edit, x0: 0.95, x1: 1 }, { text: 'Recebido', size: 14 }, A4).x1 <= 1, true, 'anda para dentro da página');
});

test('operadores do PDF: a fonte da família, a letra desvirada no quadro, o texto em hexadecimal e as linhas uma embaixo da outra', () => {
  for (const [family, font] of [['sans', 'Helvetica'], ['serif', 'Times-Roman'], ['mono', 'Courier']]) {
    const res = resourceCollector();
    const edit = textEdit({ text: 'Olá (x) \\ y\nSegunda', size: 12, family, color: '#1d4ed8' }, [0.5, 0.5], A4);
    const ops = editsContent([edit], { box: [0, 0, A4.width, A4.height] }, res);
    assert.deepEqual([...res.fonts.values()], [font]);
    assert.match(ops, /BT \/Ed1 12 Tf 0\.114 0\.306 0\.847 rg/);
    assert.ok(ops.includes(`1 0 0 -1 2.4 13.8 Tm <${hex('Olá (x) \\ y')}> Tj`), ops);
    assert.ok(ops.includes(`1 0 0 -1 2.4 28.8 Tm <${hex('Segunda')}> Tj`), 'a segunda linha 1,25 letra abaixo');
    assert.doesNotMatch(ops, /\(/, 'nada de string literal');
  }
  assert.equal(editType('text').describe({ text: 'Recebido\nem 24/10' }), 'Texto "Recebido"');
});

const rotated = () => makeRawPdf({
  1: '<< /Type /Catalog /Pages 2 0 R >>',
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
  ...textPageObjects('Copiada', { extra: ' /Rotate 90 /CropBox [20 30 600 760]' }),
}).bytes;

test('texto na foto, no Word girado e na página copiada com /Rotate: as fontes padrão sem embutir, e o qpdf aprova', async () => {
  const edit = textEdit({ text: 'Recebido em 24/10/2026 — ação', size: 14 }, [0.4, 0.3], A4);
  const doc = await openPdf(rotated());
  for (const turn of [0, 90, 180, 270]) {
    const edits = rotateEdits([edit], turn);
    const copy = copyPages(doc, [0], { edits: new Map([[0, { edits, rotation: turn }]]) });
    const pdf = buildPdf([photoPage({ edits }), wordPage({ edits, rotation: turn }), { copy: { source: copy, page: copy.pages.get(0) }, rotation: turn }]);
    for (let i = 0; i < 3; i++) assert.ok((await pageContent(pdf, i)).includes(hex('Recebido em 24/10/2026 — ação')), `${turn}°, página ${i + 1}`);
    assert.match(latin1(pdf), /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/);
    assert.doesNotMatch(latin1(pdf), /FontFile2/);
  }
});

test('Word: o texto da edição usa o mesmo objeto da Helvetica do documento', () => {
  const edit = textEdit({ text: 'Novo', size: 12 }, [0.5, 0.5], A4);
  const text = latin1(buildPdf([wordPage({ edits: [edit] })]));
  assert.equal(text.match(/\/BaseFont \/Helvetica/g).length, 1);
  assert.match(text, /\/Font << \/F1 (\d+) 0 R \/Ed1 \1 0 R >>/);
});

test('texto sob a tarja sai do arquivo, letra por letra; o resto fica no mesmo lugar; tudo coberto, a edição sai', async () => {
  const edit = textEdit({ text: 'AAAA BBBB', size: 24 }, [0.5, 0.5], A4);
  const width = edit.x1 - edit.x0;
  // Tarja sobre a primeira palavra (do Word, em pontos, antes do giro).
  const cover = { x0: edit.x0 - 0.01, x1: edit.x0 + width * 0.45, y0: edit.y0 - 0.01, y1: edit.y1 + 0.01 };
  const item = { type: 'redaction', x: cover.x0 * A4.width, y: cover.y0 * A4.height, w: (cover.x1 - cover.x0) * A4.width, h: (cover.y1 - cover.y0) * A4.height };
  const content = await pageContent(buildPdf([wordPage({ edits: [edit], items: [...wordPage().items, item] })]));
  const strings = [...content.matchAll(/<([0-9a-f]+)> Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1'));
  assert.deepEqual(strings, [' BBBB'], 'nenhum A no arquivo (o texto do Word vai em string literal, fora desta conta)');
  const x = 0.2 * 24 + textWidth('AAAA', 'Helvetica', 24);
  assert.ok(content.includes(`1 0 0 -1 ${Math.round(x * 100) / 100} 27.6 Tm <${hex(' BBBB')}> Tj`), 'BBBB no mesmo lugar de antes');
  const [kept] = redactEdits([edit], [cover], A4);
  assert.equal(kept.hidden.length, 4);
  assert.deepEqual(redactEdits([edit], [{ x0: 0, y0: 0, x1: 1, y1: 1 }], A4), []);
  assert.deepEqual(redactEdits([edit], [{ x0: 0, y0: 0, x1: 0.1, y1: 0.1 }], A4), [edit], 'longe da tarja, nada muda');
  // Tarja só encostando em cima (menos de 20% da altura da letra): a letra fica.
  const graze = { x0: 0, x1: 1, y0: 0, y1: edit.y0 + (0.2 * 24 + 0.95 * 24 - 0.75 * 24 + 0.1 * 24 * 0.97) / A4.height };
  assert.deepEqual(redactEdits([edit], [graze], A4), [edit]);
});

test('texto girado com a página e foto tarjada: a tarja tira as letras que ela cobre na página como aparece', async () => {
  const edit = textEdit({ text: 'AAAA BBBB', size: 24 }, [0.5, 0.5], A4);
  const [turned] = rotateEdits([edit], 90); // página deitada: o texto desce na vertical
  const page = { width: A4.height, height: A4.width };
  const height = turned.y1 - turned.y0;
  const cover = { x0: turned.x0 - 0.01, x1: turned.x1 + 0.01, y0: turned.y0 - 0.01, y1: turned.y0 + height * 0.45 };
  const [kept] = redactEdits([turned], [cover], page);
  assert.deepEqual(kept.hidden.map(([, k]) => k), [0, 1, 2, 3]);
  // Foto: a tarja vem da imagem (de 0 a 1 nela) e é levada para a folha.
  const photo = photoPage();
  const { x, y, w, h } = photo.box;
  const top = photo.height - y - h;
  const sheet = { width: photo.width, height: photo.height };
  const onPhoto = textEdit({ text: 'AAAA BBBB', size: 24 }, [0.5, 0.5], sheet);
  const toImage = (vx, vy) => [(vx * sheet.width - x) / w, (vy * sheet.height - top) / h];
  const [ix0, iy0] = toImage(onPhoto.x0 - 0.01, onPhoto.y0 - 0.01);
  const [ix1, iy1] = toImage(onPhoto.x0 + (onPhoto.x1 - onPhoto.x0) * 0.45, onPhoto.y1 + 0.01);
  const content = await pageContent(buildPdf([{ ...photo, edits: [onPhoto], redactions: [{ x0: ix0, y0: iy0, x1: ix1, y1: iy1 }] }]));
  assert.ok(!content.includes(hex('AAAA')) && content.includes(hex(' BBBB')), content);
});

test('PDF/A: as letras do texto entram no subconjunto, a Liberation vai embutida e, sem ela, nada sai', async () => {
  const edit = textEdit({ text: 'Página — ação', size: 12, family: 'serif' }, [0.5, 0.5], A4);
  assert.deepEqual([...editCharacters([edit])], [['Times-Roman', 'Página — ação']]);
  const pages = [photoPage({ edits: [edit] })];
  assert.deepEqual([...usedCharacters(pages).get('Times-Roman')].sort(), [...new Set('Página — ação')].sort());
  assert.throws(() => buildRaw(pages, { pdfa: true }), /fontes das edições/);
  const text = latin1(buildPdf(pages, { pdfa: true, fonts: await embedFonts(pages) }));
  assert.match(text, /\/BaseFont \/[A-Z]{6}\+LiberationSerif/);
  assert.match(text, /FontFile2/);
});

test('numeração: "1", "1 de 7" e "Página 1 de 7"', () => {
  assert.deepEqual(Object.keys(NUMBER_FORMATS).map((format) => pageNumber(format, 3, 7)), ['3', '3 de 7', 'Página 3 de 7']);
});

test('numeração, cabeçalho e rodapé: a 24 pontos da borda, no lugar escolhido; no mesmo lugar, um sobre o outro', () => {
  const settings = {
    number: { format: 'page-n-of', spot: 'bottom-right' },
    header: { text: 'Contrato nº 12', spot: 'top-center' },
    footer: { text: 'Confidencial', spot: 'bottom-right' },
  };
  const edits = allPagesText(settings, { position: 2, total: 5, size: A4 });
  const byText = Object.fromEntries(edits.map((edit) => [edit.text, edit]));
  const number = byText['Página 2 de 5'];
  assert.ok(close(number.x1 * A4.width, A4.width - 24, 1e-6) && close(number.y1 * A4.height, A4.height - 24, 1e-6));
  assert.ok(close(editTextSize(number, A4), 10, 1e-3));
  const header = byText['Contrato nº 12'];
  assert.ok(close(header.y0 * A4.height, 24) && close((header.x0 + header.x1) / 2, 0.5));
  const footer = byText.Confidencial;
  assert.ok(footer.y1 < number.y0, 'o rodapé fica acima do número, que fica mais perto da borda');
  assert.ok(close((number.y0 - footer.y1) * A4.height, 2, 1e-6));
  assert.deepEqual(allPagesText({ header: { text: '   ', spot: 'top-left' } }, { position: 1, total: 1, size: A4 }), [], 'cabeçalho vazio não entra');
  const long = allPagesText({ footer: { text: 'x'.repeat(200), spot: 'bottom-left' } }, { position: 1, total: 1, size: A4 })[0];
  assert.ok(close(long.x0 * A4.width, 24) && long.x1 * A4.width <= A4.width - 24 + 1e-6, 'texto comprido diminui para caber');
});

test('numeração por arquivo: tudo num PDF só, um PDF por página e por intervalos começam do 1', () => {
  const texts = (groups) => fileExtras(groups, (context) => allPagesText({ number: { format: 'n-of', spot: 'bottom-center' } }, { ...context, size: A4 }))
    .map((file) => file.map(([edit]) => edit.text));
  assert.deepEqual(texts([[0, 1, 2]]), [['1 de 3', '2 de 3', '3 de 3']]);
  assert.deepEqual(texts([[0], [1], [2]]), [['1 de 1'], ['1 de 1'], ['1 de 1']]);
  assert.deepEqual(texts([[2, 3], [0, 1, 4]]), [['1 de 2', '2 de 2'], ['1 de 3', '2 de 3', '3 de 3']]);
});

test('numeração no PDF: em cada página do arquivo, fixa no conteúdo, e o qpdf aprova', async () => {
  const pages = [photoPage(), wordPage({ rotation: 90 }), photoPage()];
  const extras = fileExtras([[0, 1, 2]], (context) => allPagesText({ number: { format: 'page-n-of', spot: 'bottom-center' } },
    { ...context, size: pages[context.index].jpeg ? pages[context.index] : { width: A4.height, height: A4.width } }))[0];
  const pdf = buildPdf(pages.map((page, i) => ({ ...page, edits: extras[i] })));
  for (let i = 0; i < 3; i++) assert.ok((await pageContent(pdf, i)).includes(hex(`Página ${i + 1} de 3`)), `página ${i + 1}`);
});

test('painel acima do teclado virtual: quanto da tela o teclado cobre', () => {
  assert.equal(keyboardOverlap(664, null), 0);
  assert.equal(keyboardOverlap(664, { height: 664, offsetTop: 0 }), 0);
  assert.equal(keyboardOverlap(664, { height: 360, offsetTop: 0 }), 304);
  assert.equal(keyboardOverlap(664, { height: 360, offsetTop: 40 }), 264, 'a tela rolou para mostrar o campo');
  assert.equal(keyboardOverlap(664, { height: 700, offsetTop: 0 }), 0);
});
