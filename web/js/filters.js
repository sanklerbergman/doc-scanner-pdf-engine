// Filtros de pixel (Documento, Cor realçada, Preto e branco). Código puro, sem DOM:
// roda tanto na thread principal quanto no Web Worker (filter-worker.js).
//
// A ideia dos três: estimar o brilho do PAPEL em cada ponto da foto e dividir cada pixel por ele.
// Sombra e iluminação desigual somem (papel ≈ 1 em todo lugar) e sobra a tinta (< 1).

// Curva de tons aplicada ao valor normalizado (0 = preto, 1 = papel):
// abaixo de `black` vira preto, acima de `white` vira branco, e `gamma` > 1 escurece o meio (reforça texto fraco).
const TONES = {
  document: { black: 0.4, white: 0.9, gamma: 1.5 },
  enhance: { black: 0.12, white: 0.95, gamma: 1.1 },
};
const BW_INK = 0.75; // preto e branco: tudo abaixo de 75% do brilho do papel é tinta

const STEPS = 1024; // resolução da tabela da curva; cobre valores normalizados de 0 a 1,5
const SCALE = (STEPS - 1) / 1.5;

export function applyFilter({ data, width, height }, filter) {
  const n = width * height;
  const gray = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  const paper = paperBrightness(gray, width, height);

  if (filter === 'bw') {
    for (let i = 0, p = 0; i < n; i++, p += 4) data[p] = data[p + 1] = data[p + 2] = gray[i] < paper[i] * BW_INK ? 0 : 255;
    return;
  }

  const curve = toneCurve(TONES[filter]);
  if (filter === 'document') {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      data[p] = data[p + 1] = data[p + 2] = curve[Math.min(STEPS - 1, (gray[i] / paper[i]) * SCALE) | 0];
    }
  } else {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const k = SCALE / paper[i];
      data[p] = curve[Math.min(STEPS - 1, data[p] * k) | 0];
      data[p + 1] = curve[Math.min(STEPS - 1, data[p + 1] * k) | 0];
      data[p + 2] = curve[Math.min(STEPS - 1, data[p + 2] * k) | 0];
    }
  }
}

function toneCurve({ black, white, gamma }) {
  const curve = new Uint8ClampedArray(STEPS);
  for (let i = 0; i < STEPS; i++) {
    const t = Math.min(1, Math.max(0, (i / SCALE - black) / (white - black)));
    curve[i] = Math.round(255 * t ** gamma);
  }
  return curve;
}

/**
 * Brilho do papel em cada pixel (Float32Array, mínimo 1).
 * Calculado numa versão reduzida da imagem (~320 px), em três passos:
 *  1. "fechamento" (máximo local seguido de mínimo local): apaga o que é fino e escuro (a tinta)
 *     sem deslocar bordas grandes, então a borda de uma sombra continua no lugar certo;
 *  2. suavização leve, para não criar degraus;
 *  3. piso regional: no meio de uma área preta grande (logotipo, tarja) o máximo local também é preto;
 *     aí vale uma fração do brilho médio da região, para a área continuar preta em vez de "lavar".
 */
function paperBrightness(gray, width, height) {
  const block = Math.max(1, Math.round(Math.max(width, height) / 320));
  const sw = Math.ceil(width / block);
  const sh = Math.ceil(height / block);

  // Reduz pegando o máximo de cada bloco (já elimina traços finos).
  let small = new Float32Array(sw * sh);
  for (let y = 0; y < height; y++) {
    const row = ((y / block) | 0) * sw;
    for (let x = 0; x < width; x++) {
      const v = gray[y * width + x];
      const i = row + ((x / block) | 0);
      if (v > small[i]) small[i] = v;
    }
  }

  small = boxBlur(extremeFilter(extremeFilter(small, sw, sh, 2, true), sw, sh, 2, false), sw, sh, 1);
  const regional = boxBlur(small, sw, sh, Math.max(4, Math.round(Math.max(sw, sh) / 4)));
  let brightest = 1;
  for (let i = 0; i < small.length; i++) if (regional[i] > brightest) brightest = regional[i];
  for (let i = 0; i < small.length; i++) small[i] = Math.max(small[i], regional[i] * 0.6, brightest * 0.35, 1);

  // Amplia de volta com interpolação bilinear.
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const top = small[y0 * sw + x0] + (small[y0 * sw + x1] - small[y0 * sw + x0]) * tx;
      const bottom = small[y1 * sw + x0] + (small[y1 * sw + x1] - small[y1 * sw + x0]) * tx;
      out[y * width + x] = top + (bottom - top) * ty;
    }
  }
  return out;
}

// Máximo (ou mínimo) numa janela quadrada, feito em duas passadas (linhas, depois colunas).
function extremeFilter(values, width, height, radius, takeMax) {
  const pass = (src, horizontal) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let best = takeMax ? -Infinity : Infinity;
        for (let d = -radius; d <= radius; d++) {
          const xx = horizontal ? x + d : x;
          const yy = horizontal ? y : y + d;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const v = src[yy * width + xx];
          if (takeMax ? v > best : v < best) best = v;
        }
        out[y * width + x] = best;
      }
    }
    return out;
  };
  return pass(pass(values, true), false);
}

// Média numa janela quadrada (soma acumulada: custo independe do raio).
function boxBlur(values, width, height, radius) {
  const stride = width + 1;
  const table = new Float64Array(stride * (height + 1));
  for (let y = 1; y <= height; y++) {
    let row = 0;
    for (let x = 1; x <= width; x++) {
      row += values[(y - 1) * width + x - 1];
      table[y * stride + x] = table[(y - 1) * stride + x] + row;
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(width, x + radius + 1);
      const sum = table[y1 * stride + x1] - table[y0 * stride + x1] - table[y1 * stride + x0] + table[y0 * stride + x0];
      out[y * width + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}
