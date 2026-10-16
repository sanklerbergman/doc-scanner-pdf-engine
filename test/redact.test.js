// Tarjas (redact.js): giro, texto do Word que sai de baixo da tarja, palavras do OCR e a conferência.
// A pintura dos pixels (fotos e páginas de PDF) e a leitura do PDF pelo PDF.js são conferidas no navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRect, rotateRedactions, toUnrotated, toRotatedRects, redactLayout, filterWords, textUnderRedactions } from '../web/js/redact.js';
import { textWidth } from '../web/js/fonts.js';
import { readDocx } from '../web/js/docx.js';
import { layoutDocument } from '../web/js/layout.js';
import { buildPdf } from './helpers/qpdf.js';
import { docxFiles, makeZip, p } from './helpers/docx.js';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const close = (a, b) => Math.abs(a - b) < 1e-9;
const sameRect = (a, b) => ['x0', 'y0', 'x1', 'y1'].every((k) => close(a[k], b[k]));

test('tarja: cantos em ordem, cortada na página, e toque sem arrastar não vira tarja', () => {
  assert.deepEqual(normalizeRect({ x0: 0.8, y0: 0.6, x1: 0.2, y1: 0.4 }), { x0: 0.2, y0: 0.4, x1: 0.8, y1: 0.6 });
  assert.deepEqual(normalizeRect({ x0: -0.5, y0: 0.1, x1: 0.3, y1: 1.4 }), { x0: 0, y0: 0.1, x1: 0.3, y1: 1 });
  assert.equal(normalizeRect({ x0: 0.5, y0: 0.5, x1: 0.501, y1: 0.7 }), null);
});

test('tarja acompanha o giro da página: quatro giros voltam ao começo, e ida e volta batem', () => {
  const rect = { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.3 };
  // Girar 90° no sentido horário: o que estava no canto superior esquerdo vai para o superior direito.
  assert.ok(sameRect(rotateRedactions([rect], 90)[0], { x0: 0.7, y0: 0.1, x1: 0.8, y1: 0.4 }));
  let list = [rect];
  for (let i = 0; i < 4; i++) list = rotateRedactions(list, 90);
  assert.ok(sameRect(list[0], rect));
  for (const rotation of [0, 90, 180, 270]) {
    assert.ok(sameRect(toUnrotated(toRotatedRects([rect], rotation), rotation)[0], rect), `${rotation}°`);
  }
});

const PAGE = { width: 600, height: 800 };
const line = (text, y, extra = {}) => ({ type: 'text', x: 72, y, text, font: 'Helvetica', size: 12, color: null, wordSpacing: 0, rise: 0, ...extra });
// Tarja (de 0 a 1) sobre um trecho de uma linha, pela largura das letras.
function over(item, start, end) {
  const x0 = item.x + textWidth(item.text.slice(0, start), item.font, item.size);
  const x1 = item.x + textWidth(item.text.slice(0, end), item.font, item.size);
  return { x0: x0 / PAGE.width, x1: x1 / PAGE.width, y0: (item.y - 10) / PAGE.height, y1: (item.y + 2) / PAGE.height };
}

test('Word: o texto sob a tarja sai, letra por letra, e o resto da linha fica no lugar', () => {
  const target = line('Nome: Fulano de Tal, CPF 123', 100);
  const above = line('Linha de cima', 80);
  const below = line('Linha de baixo', 120);
  const rect = over(target, 6, 12); // "Fulano"
  const { items } = redactLayout({ ...PAGE, items: [above, target, below] }, [rect]);
  const texts = items.filter((item) => item.type === 'text');
  assert.deepEqual(texts.map((item) => item.text), ['Linha de cima', 'Nome: ', ' de Tal, CPF 123', 'Linha de baixo']);
  const after = texts[2];
  assert.ok(close(after.x, target.x + textWidth('Nome: Fulano', 'Helvetica', 12)), 'o que vem depois não anda');
  assert.equal(items.at(-1).type, 'redaction', 'a caixa vai por último, por cima de tudo');
  assert.ok(close(items.at(-1).x, rect.x0 * PAGE.width) && close(items.at(-1).w, (rect.x1 - rect.x0) * PAGE.width));
});

test('Word: texto justificado (espaço extra entre palavras) e linha inteira sob a tarja', () => {
  const justified = line('um dois tres', 100, { wordSpacing: 6 });
  const x0 = justified.x + textWidth('um ', 'Helvetica', 12) + 6;
  const x1 = x0 + textWidth('dois', 'Helvetica', 12);
  const rect = { x0: x0 / PAGE.width, x1: x1 / PAGE.width, y0: 90 / PAGE.height, y1: 102 / PAGE.height };
  const kept = redactLayout({ ...PAGE, items: [justified] }, [rect]).items.filter((item) => item.type === 'text');
  assert.deepEqual(kept.map((item) => item.text), ['um ', ' tres']);
  const whole = redactLayout({ ...PAGE, items: [line('Tudo coberto', 100)] }, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]);
  assert.deepEqual(whole.items.map((item) => item.type), ['redaction']);
});

test('Word: imagem sob a tarja vem com a área a pintar; linhas e fundos ficam', () => {
  const image = { type: 'image', jpeg: new Uint8Array([1]), x: 100, y: 200, w: 200, h: 100 };
  const border = { type: 'line', x1: 0, x2: 600, y: 300, width: 1 };
  const rect = { x0: 150 / 600, y0: 250 / 800, x1: 400 / 600, y1: 400 / 800 };
  const { items, images } = redactLayout({ ...PAGE, items: [image, border] }, [rect]);
  assert.equal(images.length, 1);
  assert.ok(sameRect(images[0].areas[0], { x0: 0.25, y0: 0.5, x1: 1, y1: 1 }), 'área relativa à imagem, cortada nela');
  assert.notEqual(images[0].item, image, 'a imagem original (que pode estar em outra página) não muda');
  assert.ok(items.includes(images[0].item) && items.includes(border));
});

test('do .docx ao PDF: a palavra sob a tarja não está no arquivo, e o PDF continua válido', async () => {
  const files = docxFiles({ body: p('Nome: Fulano de Tal') + p('CPF: 123.456.789-09') + p('Texto que fica.') });
  const { pages: [page] } = layoutDocument(await readDocx(makeZip(files)));
  const cpf = page.items.find((item) => item.type === 'text' && item.text.includes('123.456'));
  assert.ok(cpf, 'a linha do CPF está na página');
  const start = cpf.text.indexOf('123');
  const x0 = cpf.x + textWidth(cpf.text.slice(0, start), cpf.font, cpf.size);
  const rect = { x0: x0 / page.width, x1: (cpf.x + textWidth(cpf.text, cpf.font, cpf.size)) / page.width, y0: (cpf.y - cpf.size) / page.height, y1: (cpf.y + 3) / page.height };
  const { items } = redactLayout(page, [rect]);
  const text = latin1(buildPdf([{ ...page, items }])); // conferido pelo qpdf
  assert.doesNotMatch(text, /123|456|789/, 'nenhum dígito do CPF no PDF');
  assert.match(text, /\(CPF: \) Tj/);
  assert.match(text, /\(Texto que fica\.\) Tj/);
  assert.match(text, /ET\n(?:.*\n)*q 0 0 0 rg [\d. ]+ re f Q/, 'a caixa preta vem depois do texto');
});

test('Word com a página girada: a tarja marcada na tela pega o texto certo', () => {
  const target = line('Segredo', 100);
  const rect = over(target, 0, 7);
  // Na tela, com a página girada 90°, a mesma área aparece girada.
  const shown = toRotatedRects([rect], 90);
  const { items } = redactLayout({ ...PAGE, items: [target] }, toUnrotated(shown, 90));
  assert.equal(items.filter((item) => item.type === 'text').length, 0);
});

test('OCR: palavras sob a tarja saem, e a palavra antes delas passa a fechar a linha', () => {
  const word = (text, x0, x1, last = false) => ({ text, x0, x1, y0: 0.1, y1: 0.12, baseline: 0.118, size: 0.02, last, confidence: 90 });
  const words = [word('Nome:', 0.1, 0.2), word('Fulano', 0.22, 0.35), word('Silva', 0.37, 0.45, true), word('CPF', 0.1, 0.15, true)];
  const kept = filterWords(words, [{ x0: 0.21, y0: 0.09, x1: 0.36, y1: 0.13 }]);
  assert.deepEqual(kept.map((w) => w.text), ['Nome:', 'Silva', 'CPF']);
  assert.equal(kept[0].last, true, 'o espaço de "Nome:" não estica por cima da tarja');
  assert.equal(words[0].last, false, 'a lista original não muda');
  assert.equal(filterWords(words, []), words);
});

test('conferência: texto sob a tarja é achado; encostar na borda não conta', () => {
  const rect = { x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.3 };
  const under = { str: 'Fulano', x0: 0.25, y0: 0.22, x1: 0.4, y1: 0.24 };
  const beside = { str: 'Nome:', x0: 0.1, y0: 0.22, x1: 0.2, y1: 0.24 };
  const lineBelow = { str: 'Outra linha', x0: 0.2, y0: 0.295, x1: 0.5, y1: 0.32 }; // 5% da altura dentro da tarja
  const partly = { str: 'Fulano de Tal', x0: 0.5, y0: 0.22, x1: 0.8, y1: 0.24 };
  assert.deepEqual(textUnderRedactions([under, beside, lineBelow, partly], [rect]).map((box) => box.str), ['Fulano', 'Fulano de Tal']);
  assert.deepEqual(textUnderRedactions([beside, lineBelow], [rect]), []);
});
