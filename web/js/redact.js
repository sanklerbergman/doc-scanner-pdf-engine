// Tarjas: cobrir partes do documento APAGANDO o que está embaixo, e não só pintando por cima.
// - Foto: os pixels sob a tarja são pintados antes de a imagem ir para o PDF (imaging.js), e o OCR roda na foto
//   já tarjada.
// - Documento do Word: o texto sob a tarja sai da página, letra por letra, e a caixa é desenhada no lugar. Imagem
//   do documento sob a tarja tem os pixels pintados (app.js).
// - Página de outro PDF: vira imagem, e os pixels são pintados (app.js).
// Depois de montar, o app relê o PDF novo com o PDF.js e confere que não há texto sob nenhuma tarja
// (textUnderRedactions); se houver, o PDF não sai.
//
// Cada tarja é {x0, y0, x1, y1}, de 0 a 1, na página como ela aparece na tela (depois do giro), com a origem no
// canto superior esquerdo. Código puro, sem DOM.
import { ROTATE } from './geometry.js';
import { textWidth } from './fonts.js';

export const REDACTION_COLOR = '#000';
const MIN_SIZE = 0.005; // tarja menor que isso (meio por cento da página) é um toque sem querer

// Retângulo com os cantos em ordem, cortado na página. null se ficar pequeno demais.
export function normalizeRect({ x0, y0, x1, y1 }) {
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const rect = { x0: clamp(Math.min(x0, x1)), y0: clamp(Math.min(y0, y1)), x1: clamp(Math.max(x0, x1)), y1: clamp(Math.max(y0, y1)) };
  return rect.x1 - rect.x0 >= MIN_SIZE && rect.y1 - rect.y0 >= MIN_SIZE ? rect : null;
}

function mapRect(rect, rotation) {
  const map = ROTATE[((rotation % 360) + 360) % 360];
  const a = map([rect.x0, rect.y0]);
  const b = map([rect.x1, rect.y1]);
  return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
}

/** Tarjas de uma página que acabou de girar `degrees` graus no sentido horário: acompanham o conteúdo. */
export const rotateRedactions = (list, degrees) => list.map((rect) => mapRect(rect, degrees));

/** Tarjas como aparecem na tela → na página antes do giro (o que o layout do Word e o PDF usam). */
export const toUnrotated = (list, rotation) => list.map((rect) => mapRect(rect, (360 - (rotation % 360)) % 360));

/** Tarjas na página antes do giro → como aparecem na tela. */
export const toRotatedRects = (list, rotation) => list.map((rect) => mapRect(rect, rotation % 360));

const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Pinta as tarjas num canvas (2D) que mostra a página como ela aparece na tela.
 * @param {CanvasRenderingContext2D} ctx
 */
export function paintRedactions(ctx, list, width, height) {
  if (!list?.length) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = REDACTION_COLOR;
  for (const { x0, y0, x1, y1 } of list) {
    // Arredonda para fora: nenhum pixel da borda fica meio coberto.
    const left = Math.floor(x0 * width);
    const top = Math.floor(y0 * height);
    ctx.fillRect(left, top, Math.ceil(x1 * width) - left, Math.ceil(y1 * height) - top);
  }
  ctx.restore();
}

/**
 * Tira de uma página do Word (layout.js) tudo o que fica sob as tarjas.
 * - Texto: sai letra por letra; o que sobra de cada trecho vira trechos menores, no mesmo lugar. A caixa de cada
 *   letra vai do topo das maiúsculas até abaixo das letras como "g".
 * - Imagem sob a tarja: fica na página, e vem na lista `images` com as áreas a pintar (de 0 a 1 na imagem).
 * - No fim, uma caixa preta ({type: 'redaction'}) por tarja, desenhada por cima de tudo (pdf.js).
 * @param {{width: number, height: number, items: object[]}} page
 * @param {Array<{x0: number, y0: number, x1: number, y1: number}>} rects tarjas na página antes do giro
 * @returns {{items: object[], images: Array<{item: object, areas: object[]}>}}
 */
export function redactLayout(page, rects) {
  const boxes = rects.map(({ x0, y0, x1, y1 }) => ({ x0: x0 * page.width, y0: y0 * page.height, x1: x1 * page.width, y1: y1 * page.height }));
  const items = [];
  const images = [];
  for (const item of page.items) {
    if (item.type === 'text') {
      items.push(...redactText(item, boxes));
    } else if (item.type === 'image') {
      const area = { x0: item.x, y0: item.y, x1: item.x + item.w, y1: item.y + item.h };
      const hits = boxes.filter((box) => overlaps(box, area));
      if (hits.length) {
        const copy = { ...item };
        images.push({
          item: copy,
          areas: hits.map((box) => ({
            x0: Math.max(0, (box.x0 - item.x) / item.w), y0: Math.max(0, (box.y0 - item.y) / item.h),
            x1: Math.min(1, (box.x1 - item.x) / item.w), y1: Math.min(1, (box.y1 - item.y) / item.h),
          })),
        });
        items.push(copy);
      } else {
        items.push(item);
      }
    } else {
      items.push(item); // linhas e fundos de tabela: não carregam texto, e a caixa vai por cima
    }
  }
  for (const box of boxes) items.push({ type: 'redaction', x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 });
  return { items, images };
}

// Uma letra sai quando a tarja cobre pelo menos 20% da altura dela (encostar na linha de cima ou de baixo não
// tira nada) e entra nela na largura. Fica coerente com a conferência (textUnderRedactions), que acusa 30%.
const LETTER_TOP = 0.75; // altura das maiúsculas, em relação ao tamanho da letra
const LETTER_BOTTOM = 0.22; // abaixo da linha de base (letras como "g" e "p")
const MIN_COVER = 0.2;
const MIN_WIDTH = 0.01; // em pontos: só encostar de lado não conta

function redactText(item, boxes) {
  const baseline = item.y - (item.rise ?? 0);
  const top = baseline - item.size * LETTER_TOP;
  const bottom = baseline + item.size * LETTER_BOTTOM;
  const minHeight = (bottom - top) * MIN_COVER;
  const hits = boxes.filter((box) => Math.min(bottom, box.y1) - Math.max(top, box.y0) >= minHeight);
  if (!hits.length) return [item];
  const out = [];
  let run = '';
  let runX = item.x;
  let x = item.x;
  for (const char of item.text) {
    const advance = textWidth(char, item.font, item.size) + (char === ' ' ? item.wordSpacing ?? 0 : 0);
    const covered = hits.some((box) => Math.min(x + Math.max(advance, MIN_WIDTH * 2), box.x1) - Math.max(x, box.x0) > MIN_WIDTH);
    if (covered) {
      if (run.trim()) out.push({ ...item, x: runX, text: run });
      run = '';
    } else {
      if (!run) runX = x;
      run += char;
    }
    x += advance;
  }
  if (run.trim()) out.push({ ...item, x: runX, text: run });
  return out;
}

/**
 * Palavras do OCR fora das tarjas. A palavra antes de uma que saiu passa a fechar a linha: assim o espaço
 * esticado até a próxima palavra (pdf.js) não atravessa a tarja. Também fecha a linha a palavra que tem uma tarja
 * entre ela e a próxima: na foto lida já tarjada, o OCR nem sempre lê a caixa preta como palavra (na página torta,
 * quase nunca), e o espaço esticado passaria por cima dela.
 * @param {import('./ocr.js').OcrWord[]} words medidas de 0 a 1 na imagem (que é a página como aparece na tela)
 */
export function filterWords(words, rects) {
  if (!rects?.length) return words;
  const out = [];
  for (const word of words) {
    if (rects.some((rect) => overlaps(rect, word))) {
      if (out.length && !out[out.length - 1].last) out[out.length - 1] = { ...out[out.length - 1], last: true };
      continue;
    }
    const previous = out[out.length - 1];
    if (previous && !previous.last && rects.some((rect) => overlaps(rect, span(previous, word)))) {
      out[out.length - 1] = { ...previous, last: true };
    }
    out.push(word);
  }
  return out;
}

// Caixa que cobre duas palavras vizinhas e o espaço entre elas.
const span = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

/**
 * Conferência: texto que o PDF.js leu no PDF novo e que fica sob alguma tarja. Lista vazia = tudo certo.
 * Conta como "sob a tarja" o trecho que entra nela com pelo menos 30% da altura (encostar na borda não conta).
 * @param {Array<{str: string, x0: number, y0: number, x1: number, y1: number, quad?: number[][]}>} boxes texto da
 *   página, de 0 a 1; quad: os quatro cantos do trecho inclinado (pdf-render.js), medido ao longo da linha
 */
export function textUnderRedactions(boxes, rects) {
  return boxes.filter((box) => rects.some((rect) => {
    if (box.quad) return tiltedUnder(box.quad, rect);
    const width = Math.min(box.x1, rect.x1) - Math.max(box.x0, rect.x0);
    const height = Math.min(box.y1, rect.y1) - Math.max(box.y0, rect.y0);
    return width > 0.001 && height > 0.3 * (box.y1 - box.y0);
  }));
}

// Trecho inclinado: a parte dele dentro da tarja (o quadrilátero cortado pelas quatro bordas dela), medida ao longo
// da linha e na altura das letras. Mesma regra do trecho reto: pelo menos 30% da altura, e alguma largura.
// quad: [começo embaixo, fim embaixo, fim em cima, começo em cima].
function tiltedUnder(quad, rect) {
  let inside = quad;
  for (const [axis, limit, keep] of [[0, rect.x0, 1], [0, rect.x1, -1], [1, rect.y0, 1], [1, rect.y1, -1]]) {
    const out = [];
    inside.forEach((p, i) => {
      const q = inside[(i + 1) % inside.length];
      const pIn = (p[axis] - limit) * keep >= 0;
      const qIn = (q[axis] - limit) * keep >= 0;
      if (pIn) out.push(p);
      if (pIn !== qIn) {
        const t = (limit - p[axis]) / (q[axis] - p[axis]);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    });
    inside = out;
    if (!inside.length) return false;
  }
  // Cada ponto em (s, t): s ao longo da linha e t na altura, os dois de 0 a 1 no trecho.
  const [o, end, , top] = quad;
  const u = [end[0] - o[0], end[1] - o[1]];
  const v = [top[0] - o[0], top[1] - o[1]];
  const det = u[0] * v[1] - u[1] * v[0];
  if (!det) return false;
  const ss = inside.map(([x, y]) => ((x - o[0]) * v[1] - (y - o[1]) * v[0]) / det);
  const ts = inside.map(([x, y]) => (u[0] * (y - o[1]) - u[1] * (x - o[0])) / det);
  return (Math.max(...ss) - Math.min(...ss)) * Math.hypot(...u) > 0.001 && Math.max(...ts) - Math.min(...ts) > 0.3;
}
