// Trocar texto (#38): os textos que já estão na página viram alvos de toque no Tarjar; tocar num deles cria uma tarja
// branca com o texto original por cima, para a pessoa corrigir (o "Substituir texto" do #24, sem marcar a área à mão).
// Código puro, sem DOM: os pedaços de texto vêm do PDF.js, do layout do Word ou do OCR (app.js, textTargets).
//
// Os pedaços chegam na página como aparece (de 0 a 1, origem no canto de cima à esquerda):
// {str, x0, y0, x1, y1, size?, family?, line?, words?}. size é o tamanho da letra, em fração da altura da página;
// family é 'sans', 'serif' ou 'mono'; line junta as palavras que o OCR leu na mesma linha; words diz que cada pedaço
// é uma palavra (OCR), e aí as palavras vizinhas da linha se juntam com espaço.
//
// No PDF, um trecho do PDF.js já é uma frase na mesma letra, e o trecho vizinho costuma ser outra letra (o rótulo em
// negrito e o valor ao lado). Só se juntam os trechos colados, sem espaço entre eles (uma palavra partida pelo
// espaçamento entre letras), para o toque no valor não pegar o rótulo junto.

import { textBox } from './edit-text.js';

const GAP_WORDS = 0.6; // palavras do OCR a menos que isso (em alturas de letra) são a mesma frase
const GAP_PIECES = 0.08; // trechos do PDF a menos que isso estão colados (sem espaço)
const SAME_SIZE = 1.35; // letra até 35% maior ou menor ainda é a mesma frase
const PAD = 0.12; // folga da tarja em volta do texto, em alturas da linha
const TEXT_PAD = 0.2; // a folga do texto dentro da tarja, em tamanhos de letra (PAD de edit-text.js)
const TOUCH = 0.35; // folga do toque em volta do texto, em alturas da linha (o dedo é grosso)

const height = (box) => box.y1 - box.y0;
const middle = (box) => (box.y0 + box.y1) / 2;

// Mesma linha: a linha que o OCR leu ou, sem ela, o meio de um dentro da altura do outro.
function sameLine(a, b) {
  if (a.line !== undefined && b.line !== undefined) return a.line === b.line;
  return (middle(b) > a.y0 && middle(b) < a.y1) || (middle(a) > b.y0 && middle(a) < b.y1);
}

function similarSize(a, b) {
  const ratio = height(a) / height(b);
  return ratio < SAME_SIZE && ratio > 1 / SAME_SIZE;
}

/**
 * Os alvos de toque da página: os pedaços de texto da mesma frase juntos, em ordem de leitura.
 * @param {Array<{str: string, x0: number, y0: number, x1: number, y1: number, size?: number, family?: string,
 *   line?: number, words?: boolean}>} pieces
 * @returns {Array<{text: string, x0: number, y0: number, x1: number, y1: number, size?: number, family?: string}>}
 */
export function textTargets(pieces) {
  const list = (pieces ?? [])
    .filter((piece) => piece.str?.trim() && piece.x1 > piece.x0 && piece.y1 > piece.y0)
    .map((piece) => ({ ...piece, str: piece.str.replace(/\s+/g, ' ').trim() }));
  const lines = [];
  for (const piece of list) {
    const line = lines.find((items) => sameLine(items[0], piece));
    if (line) line.push(piece);
    else lines.push([piece]);
  }
  const targets = [];
  for (const line of lines) {
    line.sort((a, b) => a.x0 - b.x0);
    let current = null;
    for (const piece of line) {
      const h = Math.min(height(piece), current ? height(current) : Infinity);
      const gap = current ? piece.x0 - current.x1 : Infinity;
      const limit = (piece.words && current?.words ? GAP_WORDS : GAP_PIECES) * h;
      if (current && gap < limit && similarSize(current, piece) && current.family === piece.family) {
        current.text += gap > 0.15 * h || (piece.words && current.words) ? ` ${piece.str}` : piece.str;
        current.x1 = Math.max(current.x1, piece.x1);
        current.y0 = Math.min(current.y0, piece.y0);
        current.y1 = Math.max(current.y1, piece.y1);
        if (piece.size > current.size) current.size = piece.size;
        continue;
      }
      current = {
        text: piece.str, x0: piece.x0, y0: piece.y0, x1: piece.x1, y1: piece.y1, words: !!piece.words,
        ...(piece.size > 0 ? { size: piece.size } : {}), family: piece.family,
      };
      targets.push(current);
    }
  }
  targets.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return targets.map(({ words, family, ...target }) => ({ ...target, ...(family && family !== 'sans' ? { family } : {}) }));
}

/**
 * O alvo sob o ponto (x, y) da página (de 0 a 1), com uma folga para o dedo. Com dois perto, o mais próximo.
 * @param {{width: number, height: number}} page a página como aparece, em qualquer unidade (a folga é a mesma nos dois eixos)
 */
export function targetAt(targets, x, y, page = { width: 1, height: 1 }) {
  let best = null;
  let bestDistance = Infinity;
  for (const target of targets ?? []) {
    const reach = height(target) * TOUCH;
    const reachX = (reach * page.height) / page.width;
    const dx = Math.max(target.x0 - x, 0, x - target.x1);
    const dy = Math.max(target.y0 - y, 0, y - target.y1);
    if (dx > reachX || dy > reach) continue;
    const distance = Math.hypot((dx * page.width) / page.height, dy);
    if (distance < bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * A tarja que troca o alvo: branca, um pouco maior que o texto, com o texto original por cima, na mesma letra e no
 * mesmo tamanho (replacementEdits, em edit-text.js, usa size e family).
 * @param {{width: number, height: number}} page a página como aparece, em qualquer unidade
 */
export function replacementMark(target, page = { width: 1, height: 1 }) {
  const pad = height(target) * PAD;
  // Do lado, a folga é a mesma que o texto escrito na tarja deixa antes da primeira letra (PAD de edit-text.js, 0,2
  // da letra): assim o texto novo começa onde o original começava.
  const padX = ((target.size > 0 ? target.size * TEXT_PAD : pad) * page.height) / page.width;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return {
    x0: clamp(target.x0 - padX), y0: clamp(target.y0 - pad), x1: clamp(target.x1 + padX), y1: clamp(target.y1 + pad),
    color: 'white', text: target.text,
    ...(target.size > 0 ? { size: target.size } : {}), ...(target.family ? { family: target.family } : {}),
  };
}

/**
 * A tarja da troca depois de a pessoa escrever: se o texto novo não cabe na largura com a letra do original, a tarja
 * cresce para a direita até caber (sem sair da página), em vez de a letra encolher. Nunca diminui: o original continua
 * coberto. grew diz se cresceu (o aviso pede para conferir o que ficou embaixo).
 * @param {{width: number, height: number}} page a página como aparece, em qualquer unidade
 * @returns {{mark: object, grew: boolean}}
 */
export function fitMark(mark, page = { width: 1, height: 1 }) {
  if (!(mark?.size > 0) || !mark.text?.trim()) return { mark, grew: false };
  const [width] = textBox(mark.text, mark.family ?? 'sans', mark.size * page.height);
  const x1 = Math.min(1, mark.x0 + width / page.width);
  return x1 > mark.x1 + 1e-9 ? { mark: { ...mark, x1 }, grew: true } : { mark, grew: false };
}

/** A família da letra ('sans', 'serif' ou 'mono') pelo nome da fonte (do PDF.js ou do Word). */
export function familyOf(name = '') {
  if (/mono|courier/i.test(name)) return 'mono';
  if (/sans|helvetica|arial/i.test(name)) return 'sans';
  if (/serif|times|roman|georgia|garamond/i.test(name)) return 'serif';
  return 'sans';
}
