// Texto de uma página para o botão "Copiar texto" da tela cheia: monta as linhas a partir das palavras do OCR ou
// dos trechos de texto do PDF (PDF.js) e do Word (layout.js). Código puro, sem DOM.
import { textWidth } from './fonts.js';
import { redactLayout, textUnderRedactions } from './redact.js';

const SPACE_GAP = 0.15; // distância entre dois trechos, em relação à altura da linha, a partir da qual entra um espaço

export class TextUnderRedaction extends Error {
  name = 'CopyError';
  constructor() {
    super('Não deu para separar o texto das tarjas nesta página: nada foi copiado.');
  }
}

/**
 * Texto das palavras do OCR: espaço entre as palavras da mesma linha e quebra de linha depois da última (last).
 * Onde uma tarja tirou palavras, a linha também quebra (filterWords marca a palavra de antes como última).
 * @param {import('./ocr.js').OcrWord[]} words
 */
export function plainText(words) {
  const lines = [];
  let line = [];
  for (const word of words) {
    const text = word.text?.trim();
    if (text) line.push(text);
    if (word.last && line.length) {
      lines.push(line.join(' '));
      line = [];
    }
  }
  if (line.length) lines.push(line.join(' '));
  return lines.join('\n');
}

/**
 * Texto de trechos posicionados na página, linha por linha: os trechos na mesma altura formam uma linha, lida da
 * esquerda para a direita, e entre dois trechos afastados entra um espaço. Colunas lado a lado saem na mesma linha.
 * @param {Array<{str: string, x0: number, y0: number, x1: number, y1: number}>} boxes de 0 a 1, origem no canto
 *   superior esquerdo
 * @param {{width?: number, height?: number}} [size] tamanho da página, para comparar distâncias nos dois eixos
 */
export function linesText(boxes, { width = 1, height = 1 } = {}) {
  const pieces = boxes
    .filter((box) => box.str?.trim())
    .map((box) => ({ str: box.str, x0: box.x0 * width, x1: box.x1 * width, y0: box.y0 * height, y1: box.y1 * height }))
    .map((piece) => ({ ...piece, middle: (piece.y0 + piece.y1) / 2, size: piece.y1 - piece.y0 }))
    .sort((a, b) => a.middle - b.middle);
  const lines = [];
  for (const piece of pieces) {
    // Mesma linha: o meio dos dois fica a menos de meia altura (a do menor) um do outro. Assim sobrescrito e letra
    // maior na mesma linha ficam juntos, e a linha de baixo (uma altura inteira abaixo) não.
    const line = lines.at(-1);
    if (line && Math.abs(piece.middle - line.middle) < Math.min(piece.size, line.size) / 2) line.pieces.push(piece);
    else lines.push({ middle: piece.middle, size: piece.size, pieces: [piece] });
  }
  return lines.map(({ pieces: list }) => {
    let text = '';
    let end = -Infinity;
    for (const piece of list.sort((a, b) => a.x0 - b.x0)) {
      const gap = piece.x0 - end;
      if (text && gap > SPACE_GAP * piece.size && !/\s$/.test(text) && !/^\s/.test(piece.str)) text += ' ';
      text += piece.str;
      end = Math.max(end, piece.x1);
    }
    return text.replace(/\s+/g, ' ').trim();
  }).filter(Boolean).join('\n');
}

/**
 * Caixa de cada trecho de texto de uma página do Word (layout.js), de 0 a 1: a largura sai das fontes padrão (as
 * mesmas do PDF), e a altura vai de perto do topo das maiúsculas até abaixo das letras como "g".
 * @param {{width: number, height: number, items: object[]}} layout
 */
export function layoutBoxes({ width, height, items }) {
  return items.filter((item) => item.type === 'text').map((item) => {
    let advance = 0;
    for (const char of item.text) advance += textWidth(char, item.font, item.size) + (char === ' ' ? item.wordSpacing ?? 0 : 0);
    const baseline = item.y - (item.rise ?? 0);
    return {
      str: item.text,
      x0: item.x / width, x1: (item.x + advance) / width,
      y0: (baseline - item.size * 0.85) / height, y1: (baseline + item.size * 0.25) / height,
    };
  });
}

/**
 * Texto de uma página do Word sem o que está sob as tarjas: o mesmo redactLayout que monta o PDF tira as letras, e
 * a mesma conferência do PDF montado (textUnderRedactions) confere o que sobrou. Se algum trecho ainda ficar sob uma
 * tarja, dá erro (TextUnderRedaction) e nada é copiado.
 * @param {{width: number, height: number, items: object[]}} layout
 * @param {Array<{x0: number, y0: number, x1: number, y1: number}>} [rects] tarjas na página antes do giro
 */
export function documentText(layout, rects = []) {
  const items = rects.length ? redactLayout(layout, rects).items : layout.items;
  const boxes = layoutBoxes({ ...layout, items });
  if (rects.length && textUnderRedactions(boxes, rects).length) throw new TextUnderRedaction();
  return linesText(boxes, layout);
}

/** Quantas palavras tem o texto (para a mensagem de "copiado"). */
export const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

// "Formulário" sem campos (#15): linhas para preencher (____ ou ........, menos o pontilhado de sumário, que termina em
// número de página) e quadrinhos de marcar; e palavras de formulário.
const BLANK = /_{5,}|\.{8,}|…{3,}|\(\s?\)|\[\s?\]|[☐□]/g;
const FORM_WORDS = /\b(formul[aá]rio|requerimento|preencha|preencher|ficha|solicita[çc][aã]o)\b/i;

/**
 * A página parece um formulário para preencher à mão: três linhas ou quadrinhos, ou um com uma palavra de formulário
 * ("requerimento", "preencha"). Para o PDF sem campos, a tela cheia aponta para o Texto da v4.0.0 só nesse caso, e não
 * em todo PDF (uma linha de assinatura sozinha não faz formulário). Cada trecho conta até 2000 letras.
 * @param {Array<{str: string}>} items o texto da página (pageTextItems, em pdf-render.js)
 */
export function looksLikeForm(items) {
  let blanks = 0;
  let words = false;
  for (const item of items ?? []) {
    const text = String(item?.str ?? '').slice(0, 2000);
    for (const match of text.matchAll(BLANK)) {
      // Pontilhado que termina num número é sumário, não espaço para preencher (olhado à mão: com (?!\s*\d), a
      // expressão voltaria um ponto e casaria assim mesmo).
      const end = match.index + match[0].length;
      if (match[0][0] === '.' && /^\s{0,3}\d/.test(text.slice(end, end + 4))) continue;
      blanks++;
    }
    words ||= FORM_WORDS.test(text);
    if (blanks >= 3 || (words && blanks >= 1)) return true;
  }
  return false;
}
