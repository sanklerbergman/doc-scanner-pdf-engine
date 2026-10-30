// Tipos de edição da fase 3 (edits.js): marca-texto, sublinhado, riscado e marca d'água. Código puro, sem DOM.
// - Marca-texto: retângulo translúcido em Multiply (/BM /Multiply com /ca no ExtGState): multiplica a cor da página,
//   então o texto embaixo continua preto e o papel fica colorido, como a caneta. No canvas, globalAlpha e multiply.
//   No editor, o canvas das edições fica por cima da imagem da página e não tem com o que multiplicar: lá a marca
//   aparece só translúcida, um pouco mais escura sobre o texto. Na miniatura, na tela cheia e no PDF, ela multiplica.
// - Sublinhado e riscado: uma linha arrastada à mão, com a cor e a espessura da caneta. Só muda o nome.
// - Marca d'água ("em todas as páginas", watermark.js): texto grande na diagonal da página, cinza e transparente, em
//   Helvetica-Bold (com o PDF/A, a Liberation embutida, pelas letras de characters). Sob uma tarja, saem do arquivo as
//   letras que ela pega (redact): a conferência das tarjas lê o texto do PDF montado, e a marca d'água é texto.
import { registerEditType, tracePath, pathOps, pdfNumber, cutRedact, cutPath } from './edits.js';
import { textWidth, winAnsiCode } from './fonts.js';
import { t } from './i18n.js';

const COLOR = /^#[0-9a-f]{6}$/i;
const rgb = (hex) => [1, 3, 5].map((i) => pdfNumber(parseInt(hex.slice(i, i + 2), 16) / 255, 3)).join(' ');
const round4 = (v) => Math.round(v * 1e4) / 1e4;

// ---------- Marca-texto ----------

export const MARK_ALPHA = 0.55; // sobre o branco, a cor fica clara como a da caneta; sobre o preto, continua preto
export const MARK_TINTS = [['#ffcc00', t('Amarelo')], ['#33cc66', t('Verde')], ['#ff3399', t('Rosa')], ['#3399ff', t('Azul')]];
export const DEFAULT_TINT = MARK_TINTS[0][0];
const tintOf = (edit) => (COLOR.test(edit.tint ?? '') ? edit.tint : DEFAULT_TINT);

// Pegos em parte por uma tarja, marca-texto, sublinhado e riscado são cortados nela (cutRedact e cutPath, em
// edits.js): nada deles fica no arquivo sob a tarja.
registerEditType('highlight', {
  label: t('Marca-texto'), gender: 'm', size: [160, 16], redact: cutRedact,
  create: (box, props) => ({ ...box, ...props }),
  paint(ctx, edit, { w, h }) {
    ctx.globalAlpha = MARK_ALPHA;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = tintOf(edit);
    ctx.fillRect(0, 0, w, h);
  },
  pdf(edit, { w, h }, res) {
    const area = edit.cuts && cutPath([['M', 0, 0], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z']], edit.cuts, { fill: true });
    if (area && !area.length) return '';
    const state = res.extGState({ Type: 'ExtGState', ca: MARK_ALPHA, CA: MARK_ALPHA, BM: 'Multiply' });
    return `${state} gs ${rgb(tintOf(edit))} rg ${area ? pathOps(area) : `0 0 ${pdfNumber(w, 2)} ${pdfNumber(h, 2)} re`} f`;
  },
});

// ---------- Sublinhado e riscado ----------
// from e to: as pontas, de 0 a 1 no quadro da edição, como na seta (edit-shapes.js).

const PEN = '#1d4ed8';
const colorOf = (edit) => (COLOR.test(edit.color ?? '') ? edit.color : PEN);
const widthOf = (edit) => Math.min(24, Math.max(0.25, Number(edit.width) || 2));
const SNAP = Math.tan((4 * Math.PI) / 180); // até 4° da horizontal, a linha fica reta

const linePath = (edit, { w, h }) => [['M', edit.from[0] * w, edit.from[1] * h], ['L', edit.to[0] * w, edit.to[1] * h]];

function lineType(label) {
  return {
    label, gender: 'm', size: [160, 6], redact: cutRedact,
    create: (box, props) => ({ ...box, ...props, from: [0, 0.5], to: [1, 0.5] }),
    paint(ctx, edit, box) {
      ctx.lineWidth = widthOf(edit);
      ctx.strokeStyle = colorOf(edit);
      ctx.lineCap = 'butt';
      tracePath(ctx, linePath(edit, box));
      ctx.stroke();
    },
    pdf(edit, box) {
      const line = cutPath(linePath(edit, box), edit.cuts);
      return line.length ? `${pdfNumber(widthOf(edit), 2)} w 0 J ${rgb(colorOf(edit))} RG\n${pathOps(line)} S` : '';
    },
  };
}

registerEditType('underline', lineType(t('Sublinhado')));
registerEditType('strike', lineType(t('Riscado')));

/**
 * Sublinhado ou riscado arrastado de a até b (de 0 a 1 na página como aparece). Perto da horizontal (até 4°), a linha
 * fica reta, na altura de onde o arrasto começou. A caixa envolve a linha com meia espessura e um ponto de folga.
 * @param {'underline' | 'strike'} type
 * @param {{color?: string, width?: number}} props
 * @param {{width: number, height: number}} page em pontos
 * @returns {object | null} null se a linha ficou curta demais (um toque)
 */
export function lineFromDrag(type, a, b, props, page) {
  const pa = [a[0] * page.width, a[1] * page.height];
  const pb = [b[0] * page.width, b[1] * page.height];
  if (Math.abs(pb[1] - pa[1]) <= SNAP * Math.abs(pb[0] - pa[0])) pb[1] = pa[1];
  if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) < 8) return null;
  const pad = widthOf(props) / 2 + 1;
  const left = Math.max(0, Math.min(pa[0], pb[0]) - pad);
  const top = Math.max(0, Math.min(pa[1], pb[1]) - pad);
  const right = Math.min(page.width, Math.max(pa[0], pb[0]) + pad);
  const bottom = Math.min(page.height, Math.max(pa[1], pb[1]) + pad);
  const w = Math.max(right - left, 1);
  const h = Math.max(bottom - top, 1);
  const local = ([x, y]) => [round4((x - left) / w), round4((y - top) / h)];
  return {
    type, x0: left / page.width, y0: top / page.height, x1: (left + w) / page.width, y1: (top + h) / page.height,
    ...props, from: local(pa), to: local(pb),
  };
}

// ---------- Marca d'água ----------
// {type: 'watermark', x0: 0, y0: 0, x1: 1, y1: 1, text, hide?}: a página inteira; hide: as letras tiradas pelas tarjas.

export const WATERMARK_FONT = 'Helvetica-Bold';
export const WATERMARK_ALPHA = 0.3;
const WATERMARK_COLOR = '#666666'; // sobre o branco, fica um cinza claro; o texto da página continua legível
const CAP = 0.718; // altura das maiúsculas da Helvetica-Bold, em relação ao tamanho da letra (AFM)
const FILL = 0.8; // a marca ocupa até 80% da largura e da altura da página
export const WATERMARK_MAX = 40; // letras

/** O texto só com as letras que as fontes do PDF têm (WinAnsi), numa linha só, sem espaços repetidos nem nas pontas. */
export const watermarkText = (text) => [...String(text ?? '')]
  .map((char) => (/\s/.test(char) ? ' ' : char)).filter((char) => winAnsiCode(char) !== undefined).join('')
  .replace(/ {2,}/g, ' ').trim().slice(0, WATERMARK_MAX);

/**
 * Onde vai cada letra da marca d'água, no quadro w × h (em pontos, y para baixo): na diagonal de baixo à esquerda
 * para cima à direita, centrada, do maior tamanho que cabe em 80% da página.
 * @returns {{size: number, u: number[], up: number[], start: number[], letters: Array<{char: string, a: number,
 *   b: number}>} | null} u: a direção da linha de base; up: a do alto das letras; start: o começo da linha de base;
 *   a e b: onde cada letra começa e termina ao longo da linha. null sem texto
 */
export function watermarkLayout(text, w, h) {
  const length = textWidth(text, WATERMARK_FONT, 1);
  if (!(length > 0) || !(w > 0 && h > 0)) return null;
  const angle = Math.atan2(h, w);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const size = Math.min((FILL * w) / (length * cos + CAP * sin), (FILL * h) / (length * sin + CAP * cos));
  const u = [cos, -sin];
  const up = [-sin, -cos];
  const along = (length * size) / 2;
  const across = (CAP * size) / 2;
  const start = [w / 2 - along * u[0] - across * up[0], h / 2 - along * u[1] - across * up[1]];
  let at = 0;
  const letters = [...text].map((char) => {
    const a = at;
    at += textWidth(char, WATERMARK_FONT, size);
    return { char, a, b: at };
  });
  return { size, u, up, start, letters };
}

// Trechos seguidos de letras que ficam (fora das tiradas pelas tarjas), sem os só de espaço.
function runs(layout, hide = []) {
  const out = [];
  let run = null;
  layout.letters.forEach((letter, i) => {
    if (hide.includes(i)) {
      run = null;
      return;
    }
    if (!run) out.push((run = { a: letter.a, b: letter.b, text: '' }));
    run.text += letter.char;
    run.b = letter.b;
  });
  return out.filter((item) => item.text.trim());
}

// String literal do PDF só com ASCII: parênteses e barra invertida escapados, o que passa do ASCII em octal.
function pdfString(text) {
  let out = '(';
  for (const char of text) {
    const code = winAnsiCode(char);
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${char}`;
    else if (code > 0x7e) out += `\\${code.toString(8)}`;
    else out += char;
  }
  return `${out})`;
}

// O quadrilátero (convexo) e a caixa reta se encostam? Eixos separadores: os da caixa e os lados do quadrilátero.
function touches(quad, [x0, y0, x1, y1]) {
  const box = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const axes = [[1, 0], [0, 1], ...quad.map((p, i) => {
    const q = quad[(i + 1) % quad.length];
    return [q[1] - p[1], p[0] - q[0]];
  })];
  return axes.every(([ax, ay]) => {
    const project = (points) => points.map(([x, y]) => x * ax + y * ay);
    const a = project(quad);
    const b = project(box);
    return Math.min(...a) < Math.max(...b) && Math.min(...b) < Math.max(...a);
  });
}

registerEditType('watermark', {
  label: t('Marca d\'água'), gender: 'f',
  // Só as letras que ficam: as tiradas pelas tarjas (hide) não entram nem no subconjunto da fonte embutida do PDF/A.
  characters: (edit) => new Map([[WATERMARK_FONT, [...watermarkText(edit.text)].filter((_, i) => !edit.hide?.includes(i)).join('')]]),
  paint(ctx, edit, { w, h }) {
    const layout = watermarkLayout(watermarkText(edit.text), w, h);
    if (!layout) return;
    const { size, u, up, start } = layout;
    ctx.globalAlpha = WATERMARK_ALPHA;
    ctx.fillStyle = WATERMARK_COLOR;
    ctx.font = `bold ${size}px Helvetica, Arial, "Liberation Sans", sans-serif`;
    ctx.textBaseline = 'alphabetic';
    for (const run of runs(layout, edit.hide)) {
      ctx.save();
      // No canvas, o y das letras cresce para baixo: o oposto de up.
      ctx.transform(u[0], u[1], -up[0], -up[1], start[0] + run.a * u[0], start[1] + run.a * u[1]);
      // A fonte do aparelho pode ter outras larguras: a letra é esticada até a largura da Helvetica, a do PDF.
      const measured = ctx.measureText(run.text).width;
      if (measured > 0) ctx.scale((run.b - run.a) / measured, 1);
      ctx.fillText(run.text, 0, 0);
      ctx.restore();
    }
  },
  pdf(edit, { w, h }, res) {
    const layout = watermarkLayout(watermarkText(edit.text), w, h);
    if (!layout) return '';
    const parts = runs(layout, edit.hide);
    if (!parts.length) return '';
    const { size, u, up, start } = layout;
    const n = (v) => pdfNumber(v, 4);
    const state = res.extGState({ Type: 'ExtGState', ca: WATERMARK_ALPHA, CA: WATERMARK_ALPHA });
    const out = [`${state} gs ${rgb(WATERMARK_COLOR)} rg BT ${res.font(WATERMARK_FONT)} ${n(size)} Tf`];
    // Do último trecho para o primeiro: o leitor que junta o texto (PDF.js) não emenda dois trechos por cima do
    // buraco das letras tiradas, que fica sob a tarja.
    for (const run of parts.reverse()) {
      const x = start[0] + run.a * u[0];
      const y = start[1] + run.a * u[1];
      out.push(`${n(u[0])} ${n(u[1])} ${n(up[0])} ${n(up[1])} ${n(x)} ${n(y)} Tm ${pdfString(run.text)} Tj`);
    }
    out.push('ET');
    return out.join('\n');
  },
  // Sai cada letra que encosta numa tarja, com folga: a conferência mede o texto de 20% do tamanho da letra abaixo da
  // linha de base até 80% acima, e aqui a conta vai de 30% abaixo a 90% acima. Medidas em pontos, na página como
  // aparece (page).
  redact(edit, rects, { width, height }) {
    const layout = watermarkLayout(watermarkText(edit.text), (edit.x1 - edit.x0) * width, (edit.y1 - edit.y0) * height);
    if (!layout) return [];
    const { size, u, up, start } = layout;
    const at = (s, t) => [edit.x0 * width + start[0] + s * u[0] + t * up[0], edit.y0 * height + start[1] + s * u[1] + t * up[1]];
    const boxes = rects.map((r) => [r.x0 * width, r.y0 * height, r.x1 * width, r.y1 * height]);
    const pad = size * 0.05;
    const hide = [];
    layout.letters.forEach((letter, i) => {
      if (!letter.char.trim()) return;
      const quad = [at(letter.a - pad, -0.3 * size), at(letter.b + pad, -0.3 * size), at(letter.b + pad, 0.9 * size), at(letter.a - pad, 0.9 * size)];
      if (boxes.some((box) => touches(quad, box))) hide.push(i);
    });
    if (!hide.length) return [edit];
    if (layout.letters.every((letter, i) => hide.includes(i) || !letter.char.trim())) return [];
    return [{ ...edit, hide }];
  },
});

/** Marca d'água de uma página: a página inteira, com o texto que as fontes do PDF têm. */
export const watermarkEdit = (text) => ({ type: 'watermark', x0: 0, y0: 0, x1: 1, y1: 1, text: watermarkText(text) });
