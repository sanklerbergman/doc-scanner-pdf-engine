// Tipos de edição da fase 1 (edits.js): retângulo, seta, ✓, ✗ e desenho à mão. Todos são caminhos vetoriais, com a
// cor e a espessura da edição: no PDF não precisam de fonte nem de imagem (✓ e ✗ não existem na WinAnsi, e a
// ZapfDingbats sem embutir reprovaria o PDF/A). Código puro, sem DOM.
import { registerEditType, tracePath, pathOps, circlePath, strokePath, pdfNumber, cutRedact, cutPath } from './edits.js';

const COLOR = /^#[0-9a-f]{6}$/i;
export const DEFAULT_COLOR = '#1d4ed8'; // azul de caneta
export const DEFAULT_WIDTH = 2; // em pontos

const colorOf = (edit) => (COLOR.test(edit.color ?? '') ? edit.color : '#000000');
const widthOf = (edit) => Math.min(24, Math.max(0.25, Number(edit.width) || DEFAULT_WIDTH));
const rgb = (hex) => [1, 3, 5].map((i) => pdfNumber(parseInt(hex.slice(i, i + 2), 16) / 255, 3)).join(' ');
const CAPS = ['butt', 'round', 'square'];
const JOINS = ['miter', 'round', 'bevel'];
const round4 = (v) => Math.round(v * 1e4) / 1e4;

// Forma só de traço: o mesmo caminho no canvas e no PDF. Pega em parte por uma tarja, o caminho é cortado nela
// (cutRedact e cutPath, em edits.js): nenhum pedaço do desenho fica no arquivo sob a tarja.
function stroked({ label, gender, size, path, cap = 1, join = 1 }) {
  return {
    label, gender, size, redact: cutRedact,
    create: (box, props) => ({ ...box, ...props }),
    paint(ctx, edit, box) {
      ctx.lineWidth = widthOf(edit);
      ctx.strokeStyle = colorOf(edit);
      ctx.lineCap = CAPS[cap];
      ctx.lineJoin = JOINS[join];
      tracePath(ctx, path(edit, box));
      ctx.stroke();
    },
    pdf(edit, box) {
      const kept = cutPath(path(edit, box), edit.cuts);
      return kept.length ? `${pdfNumber(widthOf(edit), 2)} w ${cap} J ${join} j ${rgb(colorOf(edit))} RG\n${pathOps(kept)} S` : '';
    },
  };
}

// Ponto (u, v), de 0 a 1, dentro da caixa encolhida meia espessura: o traço não passa da borda da edição.
const inset = (edit, { w, h }) => {
  const i = Math.min(widthOf(edit) / 2, w / 2, h / 2);
  return (u, v) => [i + u * (w - 2 * i), i + v * (h - 2 * i)];
};

registerEditType('rect', stroked({
  label: 'Retângulo', gender: 'm', size: [150, 80], cap: 0, join: 0,
  path(edit, box) {
    const at = inset(edit, box);
    return [['M', ...at(0, 0)], ['L', ...at(1, 0)], ['L', ...at(1, 1)], ['L', ...at(0, 1)], ['Z']];
  },
}));

registerEditType('check', stroked({
  label: 'Marca de certo', gender: 'f', size: [24, 24],
  path(edit, box) {
    const at = inset(edit, box);
    return [['M', ...at(0.08, 0.55)], ['L', ...at(0.38, 0.88)], ['L', ...at(0.94, 0.1)]];
  },
}));

registerEditType('cross', stroked({
  label: 'Marca de xis', gender: 'f', size: [24, 24],
  path(edit, box) {
    const at = inset(edit, box);
    return [['M', ...at(0.1, 0.1)], ['L', ...at(0.9, 0.9)], ['M', ...at(0.9, 0.1)], ['L', ...at(0.1, 0.9)]];
  },
}));

// ---------- Seta ----------
// from e to: a cauda e a ponta, de 0 a 1 no quadro da edição. A ponta é um triângulo cheio; a linha acaba dentro dele.

export const arrowHead = (width) => 3 * width + 7; // comprimento da ponta, em pontos

/** A linha (traço) e a ponta (cheia) da seta, no quadro da edição, ou null se a seta não tem comprimento. */
export function arrowParts(edit, { w, h }) {
  const p0 = [edit.from[0] * w, edit.from[1] * h];
  const p1 = [edit.to[0] * w, edit.to[1] * h];
  const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (length < 0.01) return null;
  const ux = (p1[0] - p0[0]) / length;
  const uy = (p1[1] - p0[1]) / length;
  const head = Math.min(length, arrowHead(widthOf(edit)));
  const half = head / 2;
  const base = [p1[0] - ux * head, p1[1] - uy * head];
  const end = [p1[0] - ux * head * 0.7, p1[1] - uy * head * 0.7];
  return {
    line: [['M', ...p0], ['L', ...end]],
    head: [['M', ...p1], ['L', base[0] - uy * half, base[1] + ux * half], ['L', base[0] + uy * half, base[1] - ux * half], ['Z']],
  };
}

registerEditType('arrow', {
  label: 'Seta', gender: 'f', size: [120, 60], redact: cutRedact,
  create: (box, props) => ({ ...box, ...props, from: [0.06, 0.88], to: [0.94, 0.12] }),
  paint(ctx, edit, box) {
    const parts = arrowParts(edit, box);
    if (!parts) return;
    ctx.lineWidth = widthOf(edit);
    ctx.strokeStyle = ctx.fillStyle = colorOf(edit);
    ctx.lineCap = 'butt';
    tracePath(ctx, parts.line);
    ctx.stroke();
    tracePath(ctx, parts.head);
    ctx.fill();
  },
  pdf(edit, box) {
    const parts = arrowParts(edit, box);
    if (!parts) return '';
    const color = rgb(colorOf(edit));
    const line = cutPath(parts.line, edit.cuts);
    const head = cutPath(parts.head, edit.cuts, { fill: true });
    if (!line.length && !head.length) return '';
    return [`${pdfNumber(widthOf(edit), 2)} w 0 J ${color} RG ${color} rg`, ...(line.length ? [`${pathOps(line)} S`] : []),
      ...(head.length ? [`${pathOps(head)} f`] : [])].join('\n');
  },
});

/**
 * Seta arrastada de a até b (de 0 a 1 na página como aparece). A caixa envolve a seta com folga para a ponta.
 * @param {{width: number, height: number}} page em pontos
 * @returns {object | null} null se a seta ficou curta demais (um toque)
 */
export function arrowFromLine(a, b, props, page) {
  const pa = [a[0] * page.width, a[1] * page.height];
  const pb = [b[0] * page.width, b[1] * page.height];
  if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) < 8) return null;
  const pad = arrowHead(props.width ?? DEFAULT_WIDTH) / 2 + (props.width ?? DEFAULT_WIDTH);
  const box = paddedBox([pa, pb], pad, page);
  const local = ([x, y]) => [round4((x - box.left) / box.w), round4((y - box.top) / box.h)];
  return { type: 'arrow', ...box.edit, ...props, from: local(pa), to: local(pb) };
}

// Caixa em volta dos pontos (em pontos da página), com folga e dentro da página.
function paddedBox(points, pad, page) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.max(0, Math.min(...xs) - pad);
  const top = Math.max(0, Math.min(...ys) - pad);
  const right = Math.min(page.width, Math.max(...xs) + pad);
  const bottom = Math.min(page.height, Math.max(...ys) + pad);
  const w = Math.max(right - left, 1);
  const h = Math.max(bottom - top, 1);
  return {
    left, top, w, h,
    edit: { x0: left / page.width, y0: top / page.height, x1: (left + w) / page.width, y1: (top + h) / page.height },
  };
}

// ---------- Desenho à mão ----------
// strokes: os traços, cada um uma lista de pontos de 0 a 1 no quadro da edição, já suavizados e simplificados
// (prepareStroke, em edits.js). Um traço de um ponto só (um toque) vira um ponto redondo.

const isDot = (stroke) => stroke.every(([u, v]) => u === stroke[0][0] && v === stroke[0][1]);

function inkPaths(edit, { w, h }) {
  const lines = [];
  const dots = [];
  for (const stroke of edit.strokes ?? []) {
    if (!stroke.length) continue;
    const points = stroke.map(([u, v]) => [u * w, v * h]);
    if (isDot(stroke)) dots.push(circlePath(...points[0], widthOf(edit) / 2));
    else lines.push(strokePath(points));
  }
  return { lines, dots };
}

registerEditType('ink', {
  label: 'Desenho', gender: 'm', keepRatio: true, redact: cutRedact,
  paint(ctx, edit, box) {
    const { lines, dots } = inkPaths(edit, box);
    ctx.lineWidth = widthOf(edit);
    ctx.strokeStyle = ctx.fillStyle = colorOf(edit);
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const path of lines) {
      tracePath(ctx, path);
      ctx.stroke();
    }
    for (const path of dots) {
      tracePath(ctx, path);
      ctx.fill();
    }
  },
  pdf(edit, box) {
    const paths = inkPaths(edit, box);
    const lines = paths.lines.map((path) => cutPath(path, edit.cuts)).filter((path) => path.length);
    const dots = paths.dots.map((path) => cutPath(path, edit.cuts, { fill: true })).filter((path) => path.length);
    if (!lines.length && !dots.length) return '';
    const color = rgb(colorOf(edit));
    const out = [`${pdfNumber(widthOf(edit), 2)} w 1 J 1 j ${color} RG ${color} rg`];
    for (const path of lines) out.push(`${pathOps(path)} S`);
    for (const path of dots) out.push(`${pathOps(path)} f`);
    return out.join('\n');
  },
});

/**
 * Desenho com os traços dados (pontos de 0 a 1 na página como aparece). A caixa envolve os traços, com meia espessura
 * de folga.
 * @param {number[][][]} strokes
 * @param {{color?: string, width?: number}} props
 * @param {{width: number, height: number}} page em pontos
 */
export function inkFromStrokes(strokes, props, page) {
  const all = strokes.flat().map(([x, y]) => [x * page.width, y * page.height]);
  const box = paddedBox(all, (props.width ?? DEFAULT_WIDTH) / 2 + 1, page);
  return {
    type: 'ink', ...box.edit, ...props,
    strokes: strokes.map((stroke) => stroke.map(([x, y]) => [
      round4((x * page.width - box.left) / box.w), round4((y * page.height - box.top) / box.h),
    ])),
  };
}

/** Traços de um desenho (sem giro) de volta na página como aparece, de 0 a 1. */
export function inkStrokes(edit) {
  const w = edit.x1 - edit.x0;
  const h = edit.y1 - edit.y0;
  return edit.strokes.map((stroke) => stroke.map(([u, v]) => [edit.x0 + u * w, edit.y0 + v * h]));
}
