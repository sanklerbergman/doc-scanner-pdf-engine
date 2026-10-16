// Carimbo visível da assinatura ("Assinado digitalmente por NOME em dd/mm/aaaa às hh:mm"), opcional e desligado
// por padrão. Ele é a aparência do próprio campo de assinatura (uma anotação), não um desenho no conteúdo da
// página: assim serve tanto para o PDF que o app monta quanto para assinar um PDF que já existe sem mexer nas
// páginas dele (as assinaturas anteriores continuam valendo).
// Só o nome vai no carimbo: no e-CPF e no e-CNPJ o número vem depois do ":" no nome do certificado e fica de fora
// (displayName, em x509.js). O texto entra como string hexadecimal, então nenhum caractere do nome quebra o PDF.
import { textWidth, winAnsiCode } from './fonts.js';
import { visibleToPdf, uprightMatrix } from './geometry.js';

// Os seis lugares, com o nome que aparece na tela (e para leitores de tela).
export const STAMP_POSITIONS = {
  'top-left': 'Em cima, à esquerda',
  'top-center': 'Em cima, no centro',
  'top-right': 'Em cima, à direita',
  'bottom-left': 'Embaixo, à esquerda',
  'bottom-center': 'Embaixo, no centro',
  'bottom-right': 'Embaixo, à direita',
};

const MARGIN = 24; // distância da borda da página, em pontos
const PADDING = 6;
const MIN_WIDTH = 150;
const MAX_WIDTH = 260;
const LINE = 1.25; // altura da linha, em relação ao tamanho da letra
const BORDER = [0.16, 0.29, 0.55]; // azul-acinzentado, legível em cima de foto e de texto

const num = (v) => String(Math.round(v * 100) / 100);
const pad = (v) => String(v).padStart(2, '0');

// Só o que as fontes padrão do PDF têm (WinAnsi): o resto vira "?". Caracteres de controle saem.
const winAnsi = (text) => [...text.replace(/[\u0000-\u001f\u007f]/g, '')].map((char) => (winAnsiCode(char) === undefined ? '?' : char)).join('');
const hexString = (text) => `<${[...text].map((char) => winAnsiCode(char).toString(16).padStart(2, '0')).join('')}>`;

// Fuso do aparelho, como no relógio: UTC-3, UTC-4, UTC+5:30.
function zone(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  return offset === 0 ? 'UTC' : `UTC${sign}${hours}${minutes ? `:${pad(minutes)}` : ''}`;
}

/**
 * Linhas do carimbo, com a fonte e o tamanho de cada uma, e o tamanho da caixa.
 * A caixa acompanha o nome (entre 150 e 260 pontos de largura); nome comprido diminui a letra e, no limite,
 * é cortado com reticências. Página estreita diminui a caixa.
 * @param {string} name nome do titular, sem o CPF ou CNPJ
 * @param {Date} time hora da assinatura (a mesma do /M)
 * @param {number} pageWidth largura da página como ela aparece, em pontos
 * @returns {{width: number, height: number, lines: Array<{text: string, font: string, size: number}>}}
 */
export function stampLayout(name, time, pageWidth) {
  const date = `${pad(time.getDate())}/${pad(time.getMonth() + 1)}/${time.getFullYear()}`;
  const hour = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
  const lines = [
    { text: 'Assinado digitalmente por', font: 'Helvetica', size: 7 },
    { text: winAnsi(name.trim()) || '?', font: 'Helvetica-Bold', size: 9 },
    { text: `em ${date} às ${hour} (${zone(time)})`, font: 'Helvetica', size: 7 },
  ];
  const room = Math.max(40, pageWidth - MARGIN * 2);
  const natural = Math.max(...lines.map((line) => textWidth(line.text, line.font, line.size))) + PADDING * 2;
  const width = Math.min(room, Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, natural)));
  const inner = width - PADDING * 2;
  for (const line of lines) {
    const full = textWidth(line.text, line.font, line.size);
    if (full > inner) line.size = Math.max(5, (line.size * inner) / full);
    while (line.text.length > 1 && textWidth(line.text, line.font, line.size) > inner) {
      line.text = `${line.text.slice(0, -2).trimEnd()}…`;
    }
  }
  const height = PADDING * 2 + lines.reduce((sum, line) => sum + line.size * LINE, 0);
  return { width, height, lines };
}

/**
 * Página do carimbo dentro do PDF: 'first', 'last' ou o número (a partir de 1).
 * @returns {number} posição da página (a partir de 0)
 */
export function stampPageIndex(page, count) {
  if (page === 'first') return 0;
  if (Number.isInteger(page)) return Math.min(Math.max(page, 1), count) - 1;
  return count - 1;
}

/**
 * Lugar do carimbo na página. A posição é escolhida na página como ela aparece (com o giro do /Rotate) e
 * convertida para as coordenadas do PDF. A aparência ganha a matriz que desfaz o giro, para o texto ficar de pé.
 * @param {{box: number[], rotate: number}} page box: a área visível [x1 y1 x2 y2] (CropBox ou MediaBox);
 *   rotate: 0, 90, 180 ou 270
 * @param {string} position uma das chaves de STAMP_POSITIONS
 * @param {{width: number, height: number}} size tamanho do carimbo (stampLayout)
 * @returns {{rect: number[], matrix: number[], visible: {x: number, y: number, w: number, h: number}}}
 *   visible: a caixa na página como ela aparece, com a origem no canto superior esquerdo (para a prévia)
 */
export function placeStamp({ box, rotate }, position, { width: w, height: h }) {
  const [x1, y1, x2, y2] = box;
  const sideways = rotate % 180 !== 0;
  const pageW = sideways ? y2 - y1 : x2 - x1;
  const pageH = sideways ? x2 - x1 : y2 - y1;
  const [row, column] = (STAMP_POSITIONS[position] ? position : 'bottom-right').split('-');
  const marginX = Math.max(0, Math.min(MARGIN, (pageW - w) / 2));
  const marginY = Math.max(0, Math.min(MARGIN, (pageH - h) / 2));
  const u = column === 'left' ? marginX : column === 'center' ? (pageW - w) / 2 : pageW - w - marginX;
  const v = row === 'top' ? marginY : pageH - h - marginY;
  const [ax, ay] = visibleToPdf(box, rotate, u, v);
  const [bx, by] = visibleToPdf(box, rotate, u + w, v + h);
  const rect = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  return { rect, matrix: uprightMatrix(rotate), visible: { x: u, y: v, w, h } };
}

/**
 * Carimbo pronto para o PDF: o retângulo do campo e a aparência (um formulário, Form XObject), como texto do
 * objeto, com o stream. Só ASCII: o tamanho em caracteres é o tamanho em bytes.
 * @param {{name: string, time: Date, position: string}} stamp
 * @param {{box: number[], rotate: number}} page
 * @returns {{rect: number[], appearance: string}}
 */
export function buildStamp({ name, time, position }, page) {
  const sideways = page.rotate % 180 !== 0;
  const pageWidth = sideways ? page.box[3] - page.box[1] : page.box[2] - page.box[0];
  const layout = stampLayout(name, time, pageWidth);
  const { rect, matrix } = placeStamp(page, position, layout);
  const { width, height, lines } = layout;
  const fonts = { Helvetica: '/F1', 'Helvetica-Bold': '/F2' };
  const ops = [`q ${BORDER.map(num).join(' ')} RG 0.75 w 0.5 0.5 ${num(width - 1)} ${num(height - 1)} re S Q`, 'BT', '0 0 0 rg'];
  let top = height - PADDING;
  for (const line of lines) {
    ops.push(`${fonts[line.font]} ${num(line.size)} Tf 1 0 0 1 ${PADDING} ${num(top - line.size * 0.95)} Tm ${hexString(line.text)} Tj`);
    top -= line.size * LINE;
  }
  ops.push('ET');
  const content = ops.join('\n');
  const font = (base) => `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`;
  const appearance = `<< /Type /XObject /Subtype /Form /BBox [0 0 ${num(width)} ${num(height)}] /Matrix [${matrix.join(' ')}]`
    + ` /Resources << /Font << /F1 ${font('Helvetica')} /F2 ${font('Helvetica-Bold')} >> >> /Length ${content.length} >>`
    + `\nstream\n${content}\nendstream`;
  return { rect: rect.map((v) => Math.round(v * 100) / 100), appearance };
}
