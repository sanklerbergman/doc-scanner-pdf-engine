// Camada de texto invisível do OCR: o texto reconhecido vai por cima da imagem, em modo invisível (3 Tr), para dar
// para buscar, selecionar e copiar. Serve para as fotos (pdf.js) e para as páginas de PDF escaneado copiadas para o
// PDF novo (pdf-reader.js). Só ASCII: o tamanho em caracteres é o tamanho em bytes.
import { textWidth, winAnsiCode } from './fonts.js';
import { visibleToPdf, uprightMatrix, unskew } from './geometry.js';

// A mesma Helvetica das páginas de texto, com WinAnsi, sem embutir: texto invisível não precisa de fonte embutida,
// nem no PDF/A.
export const OCR_FONT = 'Helvetica';

const num = (v) => String(Math.round(v * 100) / 100);
const clamp = (v) => Math.min(1, Math.max(0, v));

// Matriz do texto inclinado `angle` radianos (anti-horário) na página como ela aparece, depois a que o deixa de pé
// na página girada (uprightMatrix). Quatro casas: com duas, o seno de 5° perde 3% e a palavra longa sai da linha.
function tiltMatrix(angle, [a, b, c, d]) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cos * a + sin * c, cos * b + sin * d, cos * c - sin * a, cos * d - sin * b]
    .map((v) => String(Math.round(v * 10000) / 10000 || 0)).join(' ');
}

// Texto que veio do OCR, só com caracteres da WinAnsi: o que as fontes padrão não têm vira "?".
export const ocrText = (text) => [...text].map((char) => (winAnsiCode(char) === undefined ? '?' : char)).join('');

// String hexadecimal (<...>): o texto reconhecido na imagem nunca entra cru no conteúdo da página, então um ")"
// ou uma "\" lida na foto não tem como quebrar o PDF.
const hexString = (text) => `<${[...text].map((char) => winAnsiCode(char).toString(16).padStart(2, '0')).join('')}>`;

/**
 * Camada de texto invisível (3 Tr): cada palavra na posição em que aparece na imagem. O tamanho da letra sai da
 * altura da linha, e a largura é ajustada com Tz para a seleção cair em cima da palavra. Entre as palavras da
 * mesma linha vai um espaço, esticado até a próxima, para copiar e colar sair com espaços. Na página torta (palavra
 * com angle), o texto vai inclinado como a linha, em cima da palavra torta.
 * @param {import('./ocr.js').OcrWord[]} words medidas de 0 a 1 relativas à imagem
 * @param {{box: number[], rotate?: number, width?: number, height?: number}} area onde a imagem aparece: box
 *   [x1 y1 x2 y2] nas coordenadas do PDF e o giro da página (/Rotate). Na página girada, as palavras são medidas na
 *   página como ela aparece, e o texto ganha a matriz que o deixa de pé. width e height: o tamanho exato da imagem,
 *   quando quem chama já tem (as fotos).
 * @param {string} fontName nome da fonte nos recursos da página (/F1)
 */
export function ocrLayer(words, { box, rotate = 0, ...exact }, fontName) {
  const [x1, y1, x2, y2] = box;
  const sideways = rotate % 180 !== 0;
  const width = exact.width ?? (sideways ? y2 - y1 : x2 - x1);
  const height = exact.height ?? (sideways ? x2 - x1 : y2 - y1);
  const [a, b, c, d] = uprightMatrix(rotate);
  const ops = ['BT', '3 Tr'];
  let tf = '';
  let tz = '100';
  words.forEach((word, i) => {
    const next = word.last ? null : words[i + 1];
    const text = ocrText(word.text) + (next ? ' ' : '');
    const size = Math.max(1, word.size * height);
    // Página torta: as medidas ao longo da linha são as da imagem endireitada (straight, ocr.js).
    const at = word.angle ? word.straight : word;
    const x0 = clamp(at.x0);
    const end = clamp(next ? Math.max(at.x1, (next.angle ? next.straight : next).x0) : at.x1);
    const natural = textWidth(text, OCR_FONT, size);
    const scale = natural > 0 ? Math.min(1000, Math.max(1, (100 * (end - x0) * width) / natural)) : 100;
    const font = `${fontName} ${num(size)} Tf`;
    if (font !== tf) ops.push((tf = font));
    if (num(scale) !== tz) ops.push(`${(tz = num(scale))} Tz`);
    if (word.angle) {
      // O começo da linha de base volta para a imagem como ela está (torta), e o texto vai inclinado junto, para
      // a seleção cair em cima da palavra.
      const [u, v] = unskew(x0 * width, clamp(at.baseline) * height, word.angle, width, height);
      const [x, y] = visibleToPdf(box, rotate, Math.min(width, Math.max(0, u)), Math.min(height, Math.max(0, v)));
      ops.push(`${tiltMatrix(word.angle, [a, b, c, d])} ${num(x)} ${num(y)} Tm ${hexString(text)} Tj`);
      return;
    }
    // Sem giro, a conta é a de sempre (o PDF das fotos sai igual ao de antes).
    const [x, y] = rotate
      ? visibleToPdf(box, rotate, x0 * width, clamp(word.baseline) * height)
      : [x1 + x0 * width, y1 + (1 - clamp(word.baseline)) * height];
    ops.push(`${a} ${b} ${c} ${d} ${num(x)} ${num(y)} Tm ${hexString(text)} Tj`);
  });
  ops.push('ET');
  return ops.join('\n');
}
