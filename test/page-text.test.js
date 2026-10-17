// Texto para o botão "Copiar texto" (page-text.js): linhas do OCR, do PDF e do Word, e o Word tarjado.
// A área de transferência e o OCR de verdade são conferidos no navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainText, linesText, layoutBoxes, documentText, wordCount, TextUnderRedaction } from '../web/js/page-text.js';
import { filterWords } from '../web/js/redact.js';
import { textWidth } from '../web/js/fonts.js';
import { readDocx } from '../web/js/docx.js';
import { layoutDocument } from '../web/js/layout.js';
import { docxFiles, makeZip, p } from './helpers/docx.js';

const word = (text, x0, y0, last = false) => ({ text, x0, y0, x1: x0 + 0.1, y1: y0 + 0.03, baseline: y0 + 0.025, size: 0.03, last, confidence: 90 });

test('OCR: espaço entre as palavras da linha e quebra de linha depois da última', () => {
  const words = [
    word('Contrato', 0.1, 0.1), word('de', 0.25, 0.1), word('aluguel', 0.4, 0.1, true),
    word('São', 0.1, 0.2), word('Paulo,', 0.25, 0.2, true),
    word('2026', 0.1, 0.3, true),
  ];
  assert.equal(plainText(words), 'Contrato de aluguel\nSão Paulo,\n2026');
  assert.equal(plainText([]), '');
  // Sem "last" na última palavra (lista cortada), a linha sai do mesmo jeito.
  assert.equal(plainText([word('Só', 0.1, 0.1), word('isso', 0.2, 0.1)]), 'Só isso');
});

test('OCR tarjado: a palavra sob a tarja não vai para o texto, e a linha quebra no lugar dela', () => {
  const words = [word('CPF', 0.1, 0.1), word('123.456.789-09', 0.25, 0.1), word('emitido', 0.4, 0.1, true)];
  const rects = [{ x0: 0.24, y0: 0.09, x1: 0.36, y1: 0.14 }];
  const text = plainText(filterWords(words, rects));
  assert.equal(text, 'CPF\nemitido');
  assert.ok(!text.includes('123'));
});

// Trecho do PDF.js (de 0 a 1), numa página de 600 × 800 pontos, com letra de 12 pontos.
const W = 600;
const H = 800;
const piece = (str, x, baseline, width = str.length * 6, size = 12) => ({
  str, x0: x / W, x1: (x + width) / W, y0: (baseline - size * 0.8) / H, y1: (baseline + size * 0.2) / H,
});

test('PDF: trechos na mesma altura formam uma linha, da esquerda para a direita, e as linhas vão de cima para baixo', () => {
  const boxes = [
    piece('segunda linha', 72, 120),
    piece('mundo', 72 + 6 * 6, 100), // fora de ordem: o PDF pode desenhar o fim da linha antes do começo
    piece('Olá,', 72, 100, 24),
    piece('terceira', 72, 140),
  ];
  assert.equal(linesText(boxes, { width: W, height: H }), 'Olá, mundo\nsegunda linha\nterceira');
});

test('PDF: trechos colados (a mesma palavra em pedaços) não ganham espaço; afastados, sim; espaços repetidos viram um', () => {
  const boxes = [
    piece('Contra', 72, 100, 36), piece('to', 72 + 36.5, 100, 12), // 0,5 ponto: ajuste entre letras
    piece('nº', 72 + 48 + 4, 100, 12), // 4 pontos: espaço
    piece('42   ', 72 + 64 + 4, 100, 30), piece(' fim', 72 + 98 + 3, 100, 24),
  ];
  assert.equal(linesText(boxes, { width: W, height: H }), 'Contrato nº 42 fim');
});

test('PDF: sobrescrito e letra maior na mesma linha ficam juntos; trecho vazio é ignorado', () => {
  const boxes = [
    piece('Título', 72, 100, 60, 18),
    piece('1', 133, 95, 4, 8), // nota de rodapé no alto da linha, colada na palavra
    piece('   ', 140, 100),
    piece('(cont.)', 150, 100, 42, 18),
    piece('texto', 72, 125),
  ];
  assert.equal(linesText(boxes, { width: W, height: H }), 'Título1 (cont.)\ntexto');
  assert.equal(linesText([], { width: W, height: H }), '');
});

const PAGE = { width: 600, height: 800 };
const line = (text, y, extra = {}) => ({ type: 'text', x: 72, y, text, font: 'Helvetica', size: 12, color: null, wordSpacing: 0, rise: 0, ...extra });

test('Word: caixas pela largura das fontes, e o texto linha por linha (trechos de estilos diferentes juntos)', () => {
  const bold = line('Nome: ', 100, { font: 'Helvetica-Bold' });
  const rest = line('Fulano de Tal', 100, { x: 72 + textWidth('Nome: ', 'Helvetica-Bold', 12) });
  const items = [bold, rest, line('Segunda linha', 114), { type: 'line', x1: 72, x2: 200, y: 116, width: 1, color: null }];
  const [box] = layoutBoxes({ ...PAGE, items });
  assert.equal(box.str, 'Nome: ');
  assert.ok(Math.abs(box.x1 * PAGE.width - (72 + textWidth('Nome: ', 'Helvetica-Bold', 12))) < 1e-9);
  assert.equal(documentText({ ...PAGE, items }), 'Nome: Fulano de Tal\nSegunda linha');
});

// Tarja (de 0 a 1) sobre um trecho de uma linha, pela largura das letras.
function over(item, start, end) {
  const x0 = item.x + textWidth(item.text.slice(0, start), item.font, item.size);
  const x1 = item.x + textWidth(item.text.slice(0, end), item.font, item.size);
  return { x0: x0 / PAGE.width, x1: x1 / PAGE.width, y0: (item.y - 10) / PAGE.height, y1: (item.y + 2) / PAGE.height };
}

test('Word tarjado: o texto sob a tarja não vai para o texto copiado, e o resto da linha fica', () => {
  const target = line('Nome: Fulano de Tal, CPF 123.456.789-09', 100);
  const items = [line('Linha de cima', 86), target, line('Linha de baixo', 114)];
  const rects = [over(target, 6, 12), over(target, 25, 39)]; // "Fulano" e o CPF
  const text = documentText({ ...PAGE, items }, rects);
  assert.equal(text, 'Linha de cima\nNome: de Tal, CPF\nLinha de baixo');
  assert.ok(!/Fulano|123|789/.test(text));
});

test('Word tarjado: a cópia segue a mesma régua do PDF (tarja rasa tira as letras; encostar na linha não tira)', () => {
  // Tarja que cobre só o alto das letras (2,5 de 11,6 pontos): o redactLayout tira as letras, e nada sobra.
  const target = line('Segredo', 100);
  const shallow = { ...over(target, 0, 7), y0: 91 / PAGE.height, y1: 93.5 / PAGE.height };
  assert.equal(documentText({ ...PAGE, items: [target] }, [shallow]), '');
  // Tarja na linha de cima que encosta 1 ponto nas letras de baixo: a de baixo fica inteira, e a conferência
  // (que barraria a cópia com TextUnderRedaction) não acusa nada.
  const above = line('Linha de cima', 86);
  const touching = { ...over(above, 0, 13), y0: 76 / PAGE.height, y1: 92 / PAGE.height };
  assert.equal(documentText({ ...PAGE, items: [above, target] }, [touching]), 'Segredo');
  // A página inteira tarjada não deixa texto nenhum.
  assert.equal(documentText({ ...PAGE, items: [above, target] }, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]), '');
  assert.equal(new TextUnderRedaction().name, 'CopyError');
});

test('do .docx ao texto copiado: negrito no meio da linha, texto justificado e a tarja sobre o CPF', async () => {
  const bold = '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Fulano</w:t></w:r>';
  const long = 'Texto justificado que ocupa mais de uma linha para o espaço entre as palavras ficar maior do que o normal no fim.';
  const files = docxFiles({
    body: `<w:p><w:r><w:t xml:space="preserve">Nome: </w:t></w:r>${bold}<w:r><w:t xml:space="preserve"> de Tal</w:t></w:r></w:p>`
      + p('CPF: 123.456.789-09') + p(long, { pPr: '<w:jc w:val="both"/>' }),
  });
  const { pages: [page] } = layoutDocument(await readDocx(makeZip(files)));
  const text = documentText(page);
  assert.equal(text.split('\n')[0], 'Nome: Fulano de Tal');
  assert.equal(text.split('\n')[1], 'CPF: 123.456.789-09');
  assert.equal(text.split('\n').slice(2).join(' '), long, 'o justificado sai com um espaço só entre as palavras');

  const cpf = page.items.find((item) => item.type === 'text' && item.text.includes('123.456'));
  const start = cpf.text.indexOf('123');
  const rect = {
    x0: (cpf.x + textWidth(cpf.text.slice(0, start), cpf.font, cpf.size)) / page.width,
    x1: (cpf.x + textWidth(cpf.text, cpf.font, cpf.size)) / page.width,
    y0: (cpf.y - cpf.size) / page.height, y1: (cpf.y + 3) / page.height,
  };
  const redacted = documentText(page, [rect]);
  assert.doesNotMatch(redacted, /123|456|789/);
  assert.equal(redacted.split('\n')[1], 'CPF:');
});

test('conta as palavras do texto', () => {
  assert.equal(wordCount('Olá, mundo\nsegunda  linha '), 4);
  assert.equal(wordCount(''), 0);
});
