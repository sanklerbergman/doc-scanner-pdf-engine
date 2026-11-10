// Trocar texto (#38): os textos da página como alvos de toque (replace-text.js), a tarja branca com o texto original e
// o texto novo no PDF com a letra do original (tamanho e família), no Word, na foto e na página de PDF tarjada.
// O toque, os contornos e o painel são conferidos no navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textTargets, targetAt, replacementMark, fitMark, familyOf } from '../web/js/replace-text.js';
import { replacementEdits, replacementLayout, textBox } from '../web/js/edit-text.js';
import { redactLayout, textUnderRedactions } from '../web/js/redact.js';
import { readDocx } from '../web/js/docx.js';
import { layoutDocument } from '../web/js/layout.js';
import { layoutPage, pageCovers } from '../web/js/pdf.js';
import { buildPdf } from './helpers/qpdf.js';
import { docxFiles, makeZip, p } from './helpers/docx.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const hex = (text) => `<${[...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')}>`;
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// Um trecho do PDF.js: caixa de 1 letra de altura (0,01 da página).
const piece = (str, x0, x1, y0 = 0.1, extra = {}) => ({ str, x0, x1, y0, y1: y0 + 0.01, size: 0.01, ...extra });

test('PDF: o rótulo e o valor ao lado são alvos separados; trechos colados (sem espaço) se juntam', () => {
  const targets = textTargets([
    piece('MUNICÍPIO:', 0.1, 0.2),
    piece('Cuiabá', 0.205, 0.26), // um espaço depois do rótulo: outro trecho, outro alvo
    piece('03/11/', 0.5, 0.55),
    piece('2026', 0.5502, 0.58), // colado: a mesma data
    piece('Outra linha', 0.1, 0.2, 0.2),
  ]);
  assert.deepEqual(targets.map((target) => target.text), ['MUNICÍPIO:', 'Cuiabá', '03/11/2026', 'Outra linha']);
  const date = targets[2];
  assert.ok(close(date.x0, 0.5) && close(date.x1, 0.58));
  assert.equal(date.size, 0.01);
});

test('OCR: as palavras da mesma linha perto umas das outras viram uma frase, com espaço', () => {
  const word = (str, x0, x1, line) => ({ str, x0, x1, y0: 0.3 + line * 0.02, y1: 0.31 + line * 0.02, line, words: true });
  const targets = textTargets([
    word('03', 0.1, 0.12, 0), word('de', 0.124, 0.14, 0), word('novembro', 0.144, 0.2, 0),
    word('longe', 0.5, 0.55, 0), // a mais de 0,6 da altura da letra: outra frase
    word('abaixo', 0.1, 0.15, 1),
  ]);
  assert.deepEqual(targets.map((target) => target.text), ['03 de novembro', 'longe', 'abaixo']);
});

test('letra de outro tamanho ou de outra família não se junta, e o espaço repetido vira um só', () => {
  const targets = textTargets([
    piece('Título', 0.1, 0.2, 0.1, { y1: 0.13 }),
    piece('nota', 0.2001, 0.25),
    piece('Times', 0.3, 0.35, 0.1, { family: 'serif' }),
    piece('Sans', 0.3501, 0.4),
    piece('  muitos   espaços  ', 0.1, 0.3, 0.5),
    piece('   ', 0.1, 0.3, 0.6), // só espaço: nada
  ]);
  assert.deepEqual(targets.map((target) => target.text), ['Título', 'nota', 'Times', 'Sans', 'muitos espaços']);
  assert.equal(targets[2].family, 'serif');
  assert.equal(targets[3].family, undefined, 'sem serifa é o padrão: não vai na tarja');
});

test('toque: acha o texto sob o dedo, com folga, e o mais perto quando há dois', () => {
  const targets = textTargets([piece('A', 0.1, 0.2), piece('B', 0.3, 0.4)]);
  assert.equal(targetAt(targets, 0.15, 0.105).text, 'A');
  assert.equal(targetAt(targets, 0.15, 0.1125).text, 'A', 'logo abaixo da linha ainda conta');
  assert.equal(targetAt(targets, 0.25, 0.105), null, 'no meio do caminho, longe dos dois');
  assert.equal(targetAt(targets, 0.15, 0.2), null);
  assert.equal(targetAt([], 0.1, 0.1), null);
});

test('a tarja da troca: branca, com folga em volta, o texto original e a letra dele', () => {
  const [target] = textTargets([piece('Cuiabá', 0.2, 0.3, 0.1, { family: 'serif' })]);
  const mark = replacementMark(target, { width: 1, height: 1 });
  assert.equal(mark.color, 'white');
  assert.equal(mark.text, 'Cuiabá');
  assert.equal(mark.size, 0.01);
  assert.equal(mark.family, 'serif');
  assert.ok(mark.x0 < 0.2 && mark.x1 > 0.3 && mark.y0 < 0.1 && mark.y1 > 0.11, 'cobre o texto inteiro');
  assert.ok(mark.y1 - mark.y0 < 0.0125, 'folga pequena: não pega a linha de cima nem a de baixo');
  const edge = replacementMark({ text: 'x', x0: 0, y0: 0, x1: 0.1, y1: 0.01 });
  assert.ok(edge.x0 === 0 && edge.y0 === 0, 'não sai da página');
});

test('família da letra pelo nome da fonte', () => {
  assert.equal(familyOf('sans-serif'), 'sans');
  assert.equal(familyOf('serif'), 'serif');
  assert.equal(familyOf('monospace'), 'mono');
  assert.equal(familyOf('Times-Bold'), 'serif');
  assert.equal(familyOf('Courier'), 'mono');
  assert.equal(familyOf('Helvetica-Bold'), 'sans');
  assert.equal(familyOf('ArialMT'), 'sans');
  assert.equal(familyOf(undefined), 'sans');
});

test('texto por cima com o tamanho do original: o mesmo, ou menor se não couber na largura; sem ele, o maior que cabe', () => {
  const page = { width: 600, height: 800 };
  const rect = { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.12, color: 'white', text: 'Cuiabá', size: 12 / 800, family: 'serif' };
  const [edit] = replacementEdits([rect], page);
  assert.equal(edit.family, 'serif');
  const [bw, bh] = textBox('Cuiabá', 'serif', 12);
  assert.ok(close(edit.x1 - edit.x0, bw / 600) && close(edit.y1 - edit.y0, bh / 800), 'letra de 12');
  assert.ok(close((edit.y0 + edit.y1) / 2, 0.11), 'no meio da altura da tarja');
  // Texto novo comprido: diminui até caber na largura.
  const [long] = replacementEdits([{ ...rect, text: 'Várzea Grande, Mato Grosso, Brasil, América do Sul, planeta Terra' }], page);
  assert.ok(close(long.x1, rect.x1), 'encosta na borda direita da tarja');
  assert.ok(long.y1 - long.y0 < bh / 800);
  // Família desconhecida: sem serifa. Sem size: o maior que cabe (o Substituir texto do #24).
  assert.equal(replacementEdits([{ ...rect, family: 'comic' }], page)[0].family, 'sans');
  const [fit] = replacementEdits([{ ...rect, size: undefined }], page);
  assert.ok(close(fit.y1 - fit.y0, rect.y1 - rect.y0) || close(fit.x1, rect.x1), 'ocupa a tarja');
  assert.ok(replacementLayout(rect, page).font.includes('Times'));
});

test('Word: a troca sai no PDF na letra e no tamanho do original, e o texto antigo some', async () => {
  const files = docxFiles({ body: p('Município: Cuiabá') });
  const { pages: [page] } = layoutDocument(await readDocx(makeZip(files)));
  const item = page.items.find((entry) => entry.type === 'text' && entry.text.includes('Cuiab'));
  const rect = {
    x0: item.x / page.width, x1: (item.x + 150) / page.width,
    y0: (item.y - item.size) / page.height, y1: (item.y + item.size * 0.3) / page.height,
    color: 'white', text: 'Várzea Grande', size: item.size / page.height, family: 'serif',
  };
  const { items } = redactLayout(page, [rect]);
  const covers = pageCovers({ ...page, items });
  assert.ok(close(covers[0].size, rect.size) && covers[0].family === 'serif', 'o tamanho e a família chegam ao PDF');
  const text = latin1(buildPdf([{ ...page, items }])); // conferido pelo qpdf
  assert.doesNotMatch(text, /Cuiab/);
  assert.match(text, /Times-Roman/);
  const written = text.indexOf(`${hex('Várzea Grande')} Tj`);
  assert.ok(written > 0, 'o texto novo está no PDF');
  assert.match(text.slice(0, written), new RegExp(` ${item.size} Tf[^]*$`), 'na letra do original');
});

test('foto: o tamanho da letra, medido na imagem, vira o da folha', () => {
  const photo = { jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(30, 40, 'a4', 36) };
  const [cover] = pageCovers({ ...photo, redactions: [{ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2, color: 'white', text: 'x', size: 0.05 }] });
  assert.ok(close(cover.size, (0.05 * photo.box.h) / photo.height));
  const text = latin1(buildPdf([{ ...photo, redactions: [{ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2, color: 'white', text: 'Novo', size: 0.05 }] }]));
  assert.ok(text.includes(`${hex('Novo')} Tj`));
});

test('conferência: o texto trocado não conta como texto sob a tarja, o original conta', () => {
  const mark = replacementMark({ text: 'Cuiabá', x0: 0.2, y0: 0.1, x1: 0.3, y1: 0.11, size: 0.01 });
  const under = [{ str: 'Cuiabá', x0: 0.2, y0: 0.1, x1: 0.3, y1: 0.11 }];
  assert.equal(textUnderRedactions(under, [mark]).length, 0, 'o texto escrito na tarja é o que fica');
  assert.equal(textUnderRedactions(under, [{ ...mark, text: 'Várzea Grande' }]).length, 1, 'o original sob a troca é acusado');
});

test('texto novo mais comprido: a tarja cresce para a direita até caber na letra do original, sem sair da página', () => {
  const page = { width: 600, height: 800 };
  const mark = { x0: 0.2, y0: 0.1, x1: 0.26, y1: 0.115, color: 'white', text: 'Várzea Grande', size: 9 / 800 };
  const { mark: wide, grew } = fitMark(mark, page);
  assert.ok(grew);
  const [edit] = replacementEdits([wide], page);
  assert.ok(close(edit.y1 - edit.y0, textBox('Várzea Grande', 'sans', 9)[1] / 800), 'a letra continua de 9');
  assert.equal(wide.y0, mark.y0, 'só a largura muda');
  // Mais curto: a tarja fica como está (o original continua coberto).
  assert.deepEqual(fitMark({ ...mark, text: 'X' }, page), { mark: { ...mark, text: 'X' }, grew: false });
  // Perto da borda: para na página.
  assert.equal(fitMark({ ...mark, x0: 0.95, x1: 0.97 }, page).mark.x1, 1);
  // Tarja sem o tamanho do original (Substituir texto do #24): não mexe.
  assert.equal(fitMark({ ...mark, size: undefined }, page).grew, false);
});
