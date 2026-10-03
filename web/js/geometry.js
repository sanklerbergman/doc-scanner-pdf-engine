// Geometria do recorte: achar o papel na foto e "desentortar" a perspectiva.
// Código puro, sem DOM. Um "quad" são 4 cantos [x, y] na ordem: superior esquerdo,
// superior direito, inferior direito, inferior esquerdo.

/**
 * Procura o papel numa imagem pequena em tons de cinza (lado maior até ~320 px).
 * Parte de uma premissa simples: o papel é a maior região clara da foto.
 * @returns {number[][] | null} cantos normalizados (0 a 1), ou null quando não há um papel claro
 *   (fundo claro, papel ocupando a foto inteira, forma que não parece um quadrilátero).
 */
export function detectDocument(gray, width, height) {
  const smooth = boxMean(gray, width, height, 1);
  const base = otsu(smooth);
  // Um limiar só não basta: papel na sombra fica mais escuro que o limiar "ideal" e seria cortado.
  // Testa limiares mais baixos também e fica com o maior quadrilátero que ainda parece um papel.
  let best = null;
  // Só vale o candidato cujas bordas separam mesmo papel de fundo; entre os que passam, o maior.
  const consider = (found) => {
    if (found && edgeSupport(smooth, width, height, found.quad) >= 0.75 && (!best || found.area > best.area)) best = found;
  };
  for (const factor of [0.55, 0.65, 0.75, 0.85, 1]) consider(quadAbove(smooth, width, height, base * factor));

  // Sombra forte atravessando o papel engana qualquer limiar fixo. Segunda tentativa: comparar cada ponto
  // com o mais claro da vizinhança. Papel na sombra ainda é "quase tão claro quanto o papel ao lado";
  // fundo escuro encostado no papel não é.
  const brightest = localMax(smooth, width, height, Math.round(Math.max(width, height) / 6));
  const relative = new Uint8Array(smooth.length);
  for (let i = 0; i < smooth.length; i++) relative[i] = (255 * smooth[i]) / Math.max(brightest[i], 1);
  for (const share of [0.4, 0.5, 0.6]) consider(quadAbove(relative, width, height, 255 * share));

  // Centro do pixel, normalizado.
  return best && best.quad.map(([x, y]) => [(x + 0.5) / width, (y + 0.5) / height]);
}

// Maior região mais clara que `threshold`, se ela tiver cara de papel (quadrilátero convexo bem preenchido).
function quadAbove(gray, width, height, threshold) {
  const n = width * height;
  let mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = gray[i] > threshold ? 1 : 0;
  // Abertura (erosão + dilatação): corta "pontes" finas entre o papel e reflexos do fundo.
  const radius = Math.max(1, Math.round(Math.max(width, height) / 160));
  mask = morph(morph(mask, width, height, radius, true), width, height, radius, false);

  const region = largestRegion(mask, width, height);
  if (!region) return null;
  const fraction = region.area / n;
  if (fraction < 0.2 || fraction > 0.92) return null;

  // Cantos = pontos extremos nas diagonais (vale para papel inclinado até ~45°).
  let tl, tr, br, bl;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (const i of region.pixels) {
    const x = i % width;
    const y = (i - x) / width;
    if (x + y < minSum) { minSum = x + y; tl = [x, y]; }
    if (x + y > maxSum) { maxSum = x + y; br = [x, y]; }
    if (x - y < minDiff) { minDiff = x - y; bl = [x, y]; }
    if (x - y > maxDiff) { maxDiff = x - y; tr = [x, y]; }
  }
  const quad = [tl, tr, br, bl];

  // A região tem que preencher o quadrilátero: senão não é um papel (ou os cantos estão errados).
  const fill = region.area / polygonArea(quad);
  if (!(fill > 0.88 && fill < 1.12) || !isConvex(quad)) return null;
  const minSide = Math.min(width, height) * 0.15;
  for (let i = 0; i < 4; i++) if (distance(quad[i], quad[(i + 1) % 4]) < minSide) return null;
  return { quad, area: region.area };
}

/**
 * Confere as bordas de um candidato: ao longo de cada lado, o ponto logo para dentro tem que ser
 * bem mais claro que o ponto logo para fora. Devolve a pior fração entre os lados (0 a 1).
 * Pega dois erros comuns: quadrilátero "inchado" que engoliu fundo claro (o lado passa no meio do fundo)
 * e papel "cortado" numa área mais escura (o lado passa no meio do papel).
 * Lado encostado na borda da foto não tem "fora" para comparar e não conta.
 */
function edgeSupport(gray, width, height, quad) {
  const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
  const cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
  const reach = Math.max(3, Math.round(Math.min(width, height) * 0.03));
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? -1 : gray[Math.round(y) * width + Math.round(x)]);
  let worst = 1;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i];
    const [bx, by] = quad[(i + 1) % 4];
    const length = Math.hypot(bx - ax, by - ay);
    let nx = -(by - ay) / length, ny = (bx - ax) / length; // normal ao lado...
    if (nx * (cx - ax) + ny * (cy - ay) < 0) { nx = -nx; ny = -ny; } // ...apontando para dentro
    let supported = 0, total = 0;
    for (let step = 2; step <= 22; step++) {
      const x = ax + ((bx - ax) * step) / 24;
      const y = ay + ((by - ay) * step) / 24;
      const inside = at(x + nx * reach, y + ny * reach);
      const outside = at(x - nx * reach, y - ny * reach);
      if (inside < 0 || outside < 0) continue;
      total++;
      if (inside > outside * 1.25 + 6) supported++;
    }
    if (total >= 6) worst = Math.min(worst, supported / total);
  }
  return worst;
}

// Limiar de Otsu: separa a imagem em "claro" e "escuro" maximizando a diferença entre os dois grupos.
function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let total = 0;
  for (let v = 0; v < 256; v++) total += v * hist[v];
  let best = 0, bestScore = -1, countBelow = 0, sumBelow = 0;
  for (let v = 0; v < 256; v++) {
    countBelow += hist[v];
    sumBelow += v * hist[v];
    const countAbove = gray.length - countBelow;
    if (!countBelow || !countAbove) continue;
    const diff = sumBelow / countBelow - (total - sumBelow) / countAbove;
    const score = countBelow * countAbove * diff * diff;
    if (score > bestScore) { bestScore = score; best = v; }
  }
  return best;
}

// Soma de qualquer retângulo em O(1).
function integral(values, width, height) {
  const stride = width + 1;
  const table = new Float64Array(stride * (height + 1));
  for (let y = 1; y <= height; y++) {
    let row = 0;
    for (let x = 1; x <= width; x++) {
      row += values[(y - 1) * width + x - 1];
      table[y * stride + x] = table[(y - 1) * stride + x] + row;
    }
  }
  return table;
}

function windowSums(values, width, height, radius, each) {
  const stride = width + 1;
  const table = integral(values, width, height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(width, x + radius + 1);
      const sum = table[y1 * stride + x1] - table[y0 * stride + x1] - table[y1 * stride + x0] + table[y0 * stride + x0];
      each(y * width + x, sum, (x1 - x0) * (y1 - y0));
    }
  }
}

function boxMean(gray, width, height, radius) {
  const out = new Uint8Array(width * height);
  windowSums(gray, width, height, radius, (i, sum, count) => { out[i] = sum / count; });
  return out;
}

// Máximo numa janela quadrada, em duas passadas (linhas, depois colunas).
function localMax(values, width, height, radius) {
  const pass = (src, horizontal) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let best = 0;
        const from = Math.max(0, (horizontal ? x : y) - radius);
        const to = Math.min((horizontal ? width : height) - 1, (horizontal ? x : y) + radius);
        for (let k = from; k <= to; k++) {
          const v = horizontal ? src[y * width + k] : src[k * width + x];
          if (v > best) best = v;
        }
        out[y * width + x] = best;
      }
    }
    return out;
  };
  return pass(pass(values, true), false);
}

// Erosão (todos os vizinhos acesos) ou dilatação (algum vizinho aceso) de uma máscara 0/1.
function morph(mask, width, height, radius, erode) {
  const out = new Uint8Array(width * height);
  windowSums(mask, width, height, radius, (i, sum, count) => { out[i] = erode ? (sum === count ? 1 : 0) : (sum > 0 ? 1 : 0); });
  return out;
}

// Maior região conectada (vizinhança de 4) da máscara.
function largestRegion(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let best = null;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const pixels = [];
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const i = stack[--top];
      pixels.push(i);
      const x = i % width;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < width - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (i >= width && mask[i - width] && !seen[i - width]) { seen[i - width] = 1; stack[top++] = i - width; }
      if (i < mask.length - width && mask[i + width] && !seen[i + width]) { seen[i + width] = 1; stack[top++] = i + width; }
    }
    if (!best || pixels.length > best.area) best = { area: pixels.length, pixels };
  }
  return best;
}

const distance = ([ax, ay], [bx, by]) => Math.hypot(bx - ax, by - ay);

function polygonArea(points) {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    twice += x0 * y1 - x1 * y0;
  }
  return Math.abs(twice) / 2;
}

export function isConvex(quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i], [bx, by] = quad[(i + 1) % 4], [cx, cy] = quad[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-9) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

// Tamanho da página recortada, em pixels da foto: média dos lados opostos.
export function quadSize(quad) {
  const [tl, tr, br, bl] = quad;
  return {
    width: (distance(tl, tr) + distance(bl, br)) / 2,
    height: (distance(tl, bl) + distance(tr, br)) / 2,
  };
}

// Coeficientes da transformação projetiva que leva o retângulo (0..width, 0..height) ao quad.
function homography(quad, width, height) {
  const from = [[0, 0], [width, 0], [width, height], [0, height]];
  // Sistema 8×8: para cada canto, x' = (a·x + b·y + c) / (g·x + h·y + 1), e o mesmo para y'.
  const m = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = quad[i];
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    m.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) { // eliminação de Gauss com pivô
    let pivot = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = m[row][col] / m[col][col];
      for (let k = col; k < 9; k++) m[row][k] -= factor * m[col][k];
    }
  }
  return m.map((row, i) => row[8] / row[i]);
}

/**
 * Recorta o quad da imagem de origem e o estica num retângulo width × height (pixels RGBA).
 * Amostragem bilinear; o que cair fora da foto fica branco.
 */
export function warpPixels(src, srcWidth, srcHeight, quad, width, height) {
  const [a, b, c, d, e, f, g, h] = homography(quad, width, height);
  const out = new Uint8ClampedArray(width * height * 4);
  const maxX = srcWidth - 1, maxY = srcHeight - 1;
  for (let y = 0, p = 0; y < height; y++) {
    const py = y + 0.5;
    for (let x = 0; x < width; x++, p += 4) {
      const px = x + 0.5;
      const w = g * px + h * py + 1;
      const sx = (a * px + b * py + c) / w - 0.5;
      const sy = (d * px + e * py + f) / w - 0.5;
      if (sx < -1 || sy < -1 || sx > srcWidth || sy > srcHeight) {
        out[p] = out[p + 1] = out[p + 2] = out[p + 3] = 255;
        continue;
      }
      const cx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
      const cy = sy < 0 ? 0 : sy > maxY ? maxY : sy;
      const x0 = cx | 0, y0 = cy | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = cx - x0, fy = cy - y0;
      const i00 = (y0 * srcWidth + x0) * 4, i10 = (y0 * srcWidth + x1) * 4;
      const i01 = (y1 * srcWidth + x0) * 4, i11 = (y1 * srcWidth + x1) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = src[i00 + ch] + (src[i10 + ch] - src[i00 + ch]) * fx;
        const bottom = src[i01 + ch] + (src[i11 + ch] - src[i01 + ch]) * fx;
        out[p + ch] = top + (bottom - top) * fy;
      }
      out[p + 3] = 255;
    }
  }
  return out;
}

// ---------- Rotação ----------
// O recorte é guardado nas coordenadas da foto original; a tela de ajuste mostra a foto já girada.

const ROTATE = {
  0: ([x, y]) => [x, y],
  90: ([x, y]) => [1 - y, x],
  180: ([x, y]) => [1 - x, 1 - y],
  270: ([x, y]) => [y, 1 - x],
};

/** Quad da foto original → quad como aparece depois de girar `rotation` graus (horário). */
export function toRotated(quad, rotation) {
  const shift = rotation / 90;
  return [0, 1, 2, 3].map((i) => ROTATE[rotation](quad[(i - shift + 4) % 4]));
}

/** Quad marcado sobre a foto girada → quad na foto original. */
export function fromRotated(quad, rotation) {
  const shift = rotation / 90;
  const back = ROTATE[(360 - rotation) % 360];
  return [0, 1, 2, 3].map((i) => back(quad[(i + shift) % 4]));
}

export const FULL_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** O quad cobre (quase) a foto toda? Então não há o que recortar. */
export function isFullFrame(quad, tolerance = 0.01) {
  return quad.every(([x, y], i) => Math.abs(x - FULL_QUAD[i][0]) <= tolerance && Math.abs(y - FULL_QUAD[i][1]) <= tolerance);
}
