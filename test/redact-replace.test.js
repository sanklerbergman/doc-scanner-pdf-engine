// Tarja com cor e "Substituir texto" (#24): a tarja branca, o texto escrito por cima dela no PDF (Word, foto e página
// de PDF tarjada), a conferência que aceita só esse texto sob a tarja e as letras dele na fonte do PDF/A.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRect, rotateRedactions, toUnrotated, redactLayout, textUnderRedactions, paintRedactions, redactionColor } from '../web/js/redact.js';
import { replacementEdits, replacementLayout, replacementColor } from '../web/js/edit-text.js';
import { editCharacters } from '../web/js/edits.js';
import { textWidth } from '../web/js/fonts.js';
import { readDocx } from '../web/js/docx.js';
import { layoutDocument } from '../web/js/layout.js';
import { layoutPage, redactedEdits } from '../web/js/pdf.js';
import { buildPdf } from './helpers/qpdf.js';
import { docxFiles, makeZip, p } from './helpers/docx.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const hex = (text) => `<${[...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')}>`;

// A linha do CPF de um .docx, com a tarja sobre o número.
async function cpfPage() {
  const files = docxFiles({ body: p('Nome: Fulano de Tal') + p('CPF: 123.456.789-09') });
  const { pages: [page] } = layoutDocument(await readDocx(makeZip(files)));
  const cpf = page.items.find((item) => item.type === 'text' && item.text.includes('123.456'));
  const start = cpf.text.indexOf('123');
  const x0 = cpf.x + textWidth(cpf.text.slice(0, start), cpf.font, cpf.size);
  const rect = { x0: x0 / page.width, x1: (cpf.x + textWidth(cpf.text, cpf.font, cpf.size)) / page.width, y0: (cpf.y - cpf.size) / page.height, y1: (cpf.y + 3) / page.height };
  return { page, rect };
}

test('a cor e o texto da tarja acompanham o corte, o giro e o layout do Word', () => {
  const rect = { x0: 0.8, y0: 0.6, x1: 0.2, y1: 0.4, color: 'white', text: 'Maria' };
  assert.deepEqual(normalizeRect(rect), { x0: 0.2, y0: 0.4, x1: 0.8, y1: 0.6, color: 'white', text: 'Maria' });
  const turned = rotateRedactions([normalizeRect(rect)], 90)[0];
  assert.equal(turned.color, 'white');
  assert.equal(turned.text, 'Maria');
  assert.equal(toUnrotated([turned], 90)[0].text, 'Maria');
  const page = { width: 100, height: 100, items: [{ type: 'image', jpeg: new Uint8Array(1), x: 0, y: 0, w: 100, h: 100 }] };
  const { items, images } = redactLayout(page, [{ x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.2, color: 'white', text: 'Maria' }]);
  const box = items.find((item) => item.type === 'redaction');
  assert.equal(box.color, 'white');
  assert.equal(box.text, 'Maria');
  assert.equal(images[0].areas[0].color, 'white', 'a imagem sob a tarja branca é pintada de branco');
  // Sem cor, continua como antes: preta, sem campo a mais.
  const plain = redactLayout(page, [{ x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.2 }]);
  assert.deepEqual(Object.keys(plain.images[0].areas[0]).sort(), ['x0', 'x1', 'y0', 'y1']);
  assert.equal(redactionColor({}), '#000000');
  assert.equal(redactionColor({ color: 'white' }), '#ffffff');
  assert.equal(redactionColor({ color: 'red' }), '#000000', 'cor desconhecida vira preta');
});

test('pixels: cada tarja é pintada na cor dela', () => {
  const fills = [];
  const ctx = {
    save() {}, restore() {}, setTransform() {}, fillStyle: '',
    fillRect(x, y, w, h) { fills.push([this.fillStyle, x, y, w, h]); },
  };
  paintRedactions(ctx, [{ x0: 0, y0: 0, x1: 0.5, y1: 0.5 }, { x0: 0.5, y0: 0.5, x1: 1, y1: 1, color: 'white' }], 10, 10);
  assert.deepEqual(fills, [['#000000', 0, 0, 5, 5], ['#ffffff', 5, 5, 5, 5]]);
});

test('texto por cima: do maior tamanho que cabe na tarja, à esquerda, no meio da altura e na cor que contrasta', () => {
  const page = { width: 600, height: 800 };
  const rect = { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.15, color: 'white', text: 'Maria Souza' };
  const [edit] = replacementEdits([rect, { x0: 0, y0: 0, x1: 1, y1: 1 }, { ...rect, text: '  \n ' }], page);
  assert.equal(replacementEdits([rect, { x0: 0, y0: 0, x1: 1, y1: 1 }, { ...rect, text: '  \n ' }], page).length, 1, 'tarja sem texto não escreve nada');
  assert.equal(edit.type, 'text');
  assert.equal(edit.color, '#000000', 'preto na tarja branca');
  assert.equal(replacementColor({}), '#ffffff', 'branco na tarja preta');
  assert.equal(edit.x0, rect.x0);
  const eps = 1e-9;
  assert.ok(edit.x1 <= rect.x1 + eps && edit.y0 >= rect.y0 - eps && edit.y1 <= rect.y1 + eps, 'dentro da tarja');
  assert.ok(Math.abs((edit.y0 - rect.y0) - (rect.y1 - edit.y1)) < eps, 'no meio da altura');
  // Encosta numa das medidas: ou na largura, ou na altura.
  assert.ok(Math.abs(edit.x1 - rect.x1) < eps || Math.abs(edit.y1 - edit.y0 - (rect.y1 - rect.y0)) < eps);
  // A conta não depende da unidade: em pixels (a tela) ou em pontos (o PDF), a mesma caixa de 0 a 1.
  const [px] = replacementEdits([rect], { width: 1200, height: 1600 });
  for (const k of ['x0', 'y0', 'x1', 'y1']) assert.ok(Math.abs(px[k] - edit[k]) < eps, k);
  const layout = replacementLayout(rect, page);
  assert.equal(layout.lines.length, 1);
  assert.equal(layout.lines[0].text, 'Maria Souza');
  assert.equal(replacementLayout({ ...rect, text: '' }, page), null);
});

test('Word: tarja branca com texto por cima: o CPF sai, a caixa é branca e o texto novo vem depois dela', async () => {
  const { page, rect } = await cpfPage();
  const { items } = redactLayout(page, [{ ...rect, color: 'white', text: '000.000.000-00' }]);
  const text = latin1(buildPdf([{ ...page, items }])); // conferido pelo qpdf
  assert.doesNotMatch(text, /123|456|789/, 'nenhum dígito do CPF no PDF');
  assert.match(text, /q 1 1 1 rg [\d. ]+ re f Q/, 'a caixa é branca');
  assert.doesNotMatch(text, /q 0 0 0 rg [\d. ]+ re f Q/, 'nenhuma caixa preta');
  const box = text.indexOf('q 1 1 1 rg');
  const written = text.indexOf(`${hex('000.000.000-00')} Tj`);
  assert.ok(written > box, 'o texto novo vem depois da caixa (por cima dela)');
  assert.match(text, /0 0 0 rg\n1 0 0 -1 /, 'em preto');
});

test('Word: tarja preta com texto e página girada: o texto vai em branco, por cima', async () => {
  const { page, rect } = await cpfPage();
  const { items } = redactLayout(page, toUnrotated([{ ...rect, text: 'X' }], 0));
  const text = latin1(buildPdf([{ ...page, items, rotation: 90 }]));
  assert.match(text, /q 0 0 0 rg [\d. ]+ re f Q/);
  assert.ok(text.indexOf(`${hex('X')} Tj`) > text.indexOf('q 0 0 0 rg'), 'depois da caixa');
  assert.match(text, /1 1 1 rg\n1 0 0 -1 /, 'em branco');
});

test('foto e página de PDF tarjada: a tarja vai de novo na cor dela, e o texto por cima', () => {
  const photo = { jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(30, 40, 'a4', 36) };
  const redactions = [{ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.3, color: 'white', text: 'Novo valor' }, { x0: 0.1, y0: 0.5, x1: 0.9, y1: 0.6 }];
  const text = latin1(buildPdf([{ ...photo, redactions }]));
  assert.match(text, /q 1 1 1 rg [\d. ]+ re f Q/);
  assert.match(text, /q 0 0 0 rg [\d. ]+ re f Q/);
  const written = text.indexOf(`${hex('Novo valor')} Tj`);
  assert.ok(written > text.lastIndexOf(' re f Q'), 'o texto vem depois das duas caixas');
  // Sem texto nem edição, a foto continua só com a imagem (as tarjas já estão nos pixels).
  assert.doesNotMatch(latin1(buildPdf([{ ...photo, redactions: [{ x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.2, color: 'white' }] }])), / re f Q/);
});

test('conferência: o texto escrito na tarja não conta, e o que estava embaixo continua contando', () => {
  const rect = { x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.3, color: 'white', text: 'Maria\nSouza Lima' };
  const written = { str: 'Souza Lima', x0: 0.21, y0: 0.25, x1: 0.5, y1: 0.28 };
  const part = { str: 'Maria', x0: 0.21, y0: 0.21, x1: 0.3, y1: 0.24 };
  const old = { str: 'Fulano', x0: 0.25, y0: 0.22, x1: 0.4, y1: 0.24 };
  const mixed = { str: 'Maria Fulano', x0: 0.21, y0: 0.21, x1: 0.5, y1: 0.24 };
  assert.deepEqual(textUnderRedactions([written, part, old, mixed], [rect]).map((box) => box.str), ['Fulano', 'Maria Fulano']);
  // O mesmo texto sob uma tarja sem texto conta, mesmo que outra tarja (que ele não pega) tenha esse texto.
  const plain = { x0: 0.2, y0: 0.5, x1: 0.6, y1: 0.6 };
  const below = { ...written, y0: 0.52, y1: 0.55 };
  assert.deepEqual(textUnderRedactions([below], [rect, plain]).map((box) => box.str), ['Souza Lima']);
});

test('PDF/A: as letras do texto escrito na tarja entram na fonte embutida', async () => {
  const { page, rect } = await cpfPage();
  const { items } = redactLayout(page, [{ ...rect, color: 'white', text: 'Ânimo' }]);
  const used = editCharacters(redactedEdits({ ...page, items }));
  assert.equal(used.get('Helvetica'), 'Ânimo');
});
