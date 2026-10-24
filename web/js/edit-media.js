// Imagem e rubrica (fase 4 da edição, #14): os tipos de edição (edits.js) que levam um objeto inteiro para o PDF, gravado
// uma vez por arquivo e chamado em cada página que o usa.
// - Imagem: PNG ou JPEG escolhido pela pessoa e recodificado pelo canvas (edit-image.js), sem os metadados do arquivo
//   original. Com transparência de verdade, vai como Flate com a máscara /SMask em cinza; sem, como JPEG. Os bytes já
//   ficam prontos (comprimidos) na memória, porque o assemble (pdf.js) é síncrono.
// - Rubrica: o desenho à mão (o tipo "ink", de edit-shapes.js) feito uma vez num painel (rubric.js) e repetido em todas
//   as páginas como um Form XObject.
// As imagens ficam só na memória da aba, por uma chave tirada do conteúdo (a mesma imagem escolhida duas vezes ocupa um
// lugar só), e saem ao limpar a lista (forgetMedia). Código puro, sem DOM: a prévia de cada imagem chega pronta.
import { registerEditType, editType, pdfNumber, spotBox, cutRedact } from './edits.js';
import { inkFromStrokes } from './edit-shapes.js';
import { inflate } from './inflate.js';

const encoder = new TextEncoder();

// ---------- Imagens na memória ----------

/**
 * @typedef {object} ImageRecord
 * @property {number} width em pixels
 * @property {number} height
 * @property {'jpeg' | 'flate'} kind jpeg: o arquivo JPEG inteiro (DCTDecode); flate: as cores comprimidas, com o
 *   preditor PNG
 * @property {Uint8Array} data
 * @property {boolean} [gray] cores em cinza (um canal só), no Flate
 * @property {Uint8Array} [mask] a transparência (/SMask), em cinza, comprimida como as cores
 * @property {CanvasImageSource} [picture] a imagem para a prévia, reduzida (canvas)
 */

/** @type {Map<string, ImageRecord>} */
const IMAGES = new Map();
const forgetListeners = new Set();

/** Guarda uma imagem pronta. A chave "id#…" é a mesma imagem com partes apagadas pelas tarjas (cutKey). */
export function storeImage(id, record) {
  if (!/^[\w:#.,;-]+$/.test(id)) throw new Error('Chave de imagem inválida');
  if (!(record.width > 0 && record.height > 0) || !(record.data instanceof Uint8Array)) throw new Error('Imagem incompleta');
  IMAGES.set(id, record);
}

/** @returns {ImageRecord | undefined} */
export const imageRecord = (id) => IMAGES.get(id);

const baseId = (id) => id.split('#')[0];

// Devolve a memória da prévia (o canvas fica com zero pixel). A prévia da imagem é dividida com as versões tarjadas.
function release(id, record) {
  if (id.includes('#') || !record.picture) return;
  if (typeof record.picture.close === 'function') record.picture.close();
  else if ('width' in record.picture) record.picture.width = record.picture.height = 0;
}

/**
 * Tira da memória as imagens que nenhuma das edições usa mais (e as versões tarjadas delas).
 * @param {Iterable<object>} edits todas as edições que ainda existem
 */
export function keepImages(edits) {
  const used = new Set();
  for (const edit of edits) if (edit?.type === 'image') used.add(baseId(edit.image));
  for (const [id, record] of IMAGES) {
    if (used.has(baseId(id))) continue;
    release(id, record);
    IMAGES.delete(id);
  }
}

/** "Limpar tudo": as imagens saem da memória, e quem guarda outra coisa (a rubrica) é avisado. */
export function forgetMedia() {
  for (const [id, record] of IMAGES) release(id, record);
  IMAGES.clear();
  for (const listener of forgetListeners) listener();
}

/** @param {() => void} listener chamado por forgetMedia */
export const onForget = (listener) => forgetListeners.add(listener);

// ---------- Codificação ----------

/** Algum pixel com transparência de verdade (alfa abaixo de 255)? rgba: os pixels do canvas. */
export function hasTransparency(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}

/**
 * Preditor PNG (Paeth em todas as linhas), que o FlateDecode desfaz com /Predictor 15: em foto e em degradê, a
 * compressão fica bem menor que a dos bytes crus.
 * @param {Uint8Array} bytes as amostras, linha por linha
 * @param {number} channels amostras por pixel
 */
export function pngPredict(bytes, width, height, channels) {
  const row = width * channels;
  const out = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y++) {
    const s = y * row;
    const o = y * (row + 1);
    out[o] = 4;
    for (let i = 0; i < row; i++) {
      const a = i >= channels ? bytes[s + i - channels] : 0;
      const b = y ? bytes[s - row + i] : 0;
      const c = y && i >= channels ? bytes[s - row + i - channels] : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      out[o + 1 + i] = (bytes[s + i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
  }
  return out;
}

/**
 * Desfaz o preditor PNG (os cinco filtros, um por linha).
 * @returns {Uint8Array} as amostras, linha por linha
 */
export function pngUnpredict(bytes, width, height, channels) {
  const row = width * channels;
  if (bytes.length < (row + 1) * height) throw new Error('Imagem comprimida incompleta');
  const out = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) {
    const filter = bytes[y * (row + 1)];
    const s = y * row;
    for (let i = 0; i < row; i++) {
      const x = bytes[y * (row + 1) + 1 + i];
      const a = i >= channels ? out[s + i - channels] : 0;
      const b = y ? out[s - row + i] : 0;
      const c = y && i >= channels ? out[s - row + i - channels] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error('Filtro de linha desconhecido');
      out[s + i] = (x + p) & 255;
    }
  }
  return out;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Cores (1 ou 3 canais) e transparência já separadas → imagem Flate, com o preditor PNG.
async function flateFromChannels(color, alpha, width, height, gray) {
  const data = await deflate(pngPredict(color, width, height, gray ? 1 : 3));
  const mask = alpha ? await deflate(pngPredict(alpha, width, height, 1)) : undefined;
  return { kind: 'flate', width, height, gray, data, mask };
}

/**
 * Imagem com transparência (pixels RGBA do canvas, sem pré-multiplicar) → cores e máscara em cinza, comprimidas.
 * Quando todo pixel visível é cinza (rubrica escaneada, carimbo preto), as cores vão num canal só.
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @returns {Promise<ImageRecord>}
 */
export async function flateImage(rgba, width, height) {
  const count = width * height;
  let gray = true;
  for (let i = 0; i < rgba.length && gray; i += 4) {
    if (rgba[i + 3] && (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2])) gray = false;
  }
  const color = new Uint8Array(gray ? count : count * 3);
  const alpha = new Uint8Array(count);
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    alpha[p] = rgba[i + 3];
    if (gray) color[p] = rgba[i];
    else {
      color[p * 3] = rgba[i];
      color[p * 3 + 1] = rgba[i + 1];
      color[p * 3 + 2] = rgba[i + 2];
    }
  }
  return flateFromChannels(color, alpha, width, height, gray);
}

// ---------- Imagem sob as tarjas ----------
// A tarja apaga, não só cobre: a parte da imagem sob uma tarja sai dos pixels antes de montar o PDF (cutImages, em
// edit-image.js, que é assíncrono). Aqui, só o que é síncrono: onde cortar e a chave da versão cortada, que o tipo
// "image" procura na hora de montar.

// Ponto de 0 a 1 na caixa como aparece → na imagem de pé (o inverso do giro de edits.js).
const TURN_BACK = {
  0: ([u, v]) => [u, v],
  90: ([u, v]) => [v, 1 - u],
  180: ([u, v]) => [1 - u, 1 - v],
  270: ([u, v]) => [1 - v, u],
};
// Quatro casas, para fora; antes, o ruído das contas (0,49999999…) sai.
const snap = (v) => Math.round(v * 1e8) / 1e4;
const floor4 = (v) => Math.max(0, Math.floor(snap(v)) / 1e4);
const ceil4 = (v) => Math.min(1, Math.ceil(snap(v)) / 1e4);

/** A tarja cobre a edição inteira? (aí ela sai do arquivo, como as outras edições) */
export const underCover = (edit, rects) => (rects ?? []).some((r) => edit.x0 >= r.x0 && edit.y0 >= r.y0 && edit.x1 <= r.x1 && edit.y1 <= r.y1);

/**
 * As partes da imagem sob as tarjas, de 0 a 1 na imagem de pé (y para baixo), arredondadas para fora.
 * @param {object} edit a edição (caixa e giro)
 * @param {Array<{x0: number, y0: number, x1: number, y1: number}>} rects as tarjas, na página como aparece
 * @returns {number[][]} [x0, y0, x1, y1] de cada parte, em ordem
 */
export function imageCuts(edit, rects) {
  const bw = edit.x1 - edit.x0;
  const bh = edit.y1 - edit.y0;
  const back = TURN_BACK[(((edit.turn ?? 0) % 360) + 360) % 360];
  const cuts = [];
  for (const r of rects ?? []) {
    const x0 = Math.max(r.x0, edit.x0);
    const y0 = Math.max(r.y0, edit.y0);
    const x1 = Math.min(r.x1, edit.x1);
    const y1 = Math.min(r.y1, edit.y1);
    if (!(x1 > x0 && y1 > y0 && bw > 0 && bh > 0)) continue;
    const a = back([(x0 - edit.x0) / bw, (y0 - edit.y0) / bh]);
    const b = back([(x1 - edit.x0) / bw, (y1 - edit.y0) / bh]);
    cuts.push([floor4(Math.min(a[0], b[0])), floor4(Math.min(a[1], b[1])), ceil4(Math.max(a[0], b[0])), ceil4(Math.max(a[1], b[1]))]);
  }
  return cuts.sort((p, q) => p.join() < q.join() ? -1 : p.join() > q.join() ? 1 : 0);
}

/** Chave da versão da imagem com as partes cortadas. */
export const cutKey = (image, cuts) => `${baseId(image)}#${cuts.map((cut) => cut.join(',')).join(';')}`;

/** As partes em pixels, arredondadas para fora: [x0, y0, x1, y1]. */
export const pixelCuts = (cuts, width, height) => cuts.map(([x0, y0, x1, y1]) => [
  Math.floor(x0 * width), Math.floor(y0 * height), Math.min(width, Math.ceil(x1 * width)), Math.min(height, Math.ceil(y1 * height)),
]);

/**
 * Versão Flate da imagem com as partes cortadas pintadas de preto, sem transparência ali (a tarja vai por cima).
 * @param {ImageRecord} record
 * @param {number[][]} cuts de imageCuts
 * @returns {Promise<ImageRecord>}
 */
export async function cutFlate(record, cuts) {
  const { width, height, gray } = record;
  const channels = gray ? 1 : 3;
  const limit = (width * channels + 1) * height;
  const color = pngUnpredict(await inflate(record.data, 'deflate', limit), width, height, channels);
  const alpha = record.mask ? pngUnpredict(await inflate(record.mask, 'deflate', (width + 1) * height), width, height, 1) : null;
  for (const [x0, y0, x1, y1] of pixelCuts(cuts, width, height)) {
    for (let y = y0; y < y1; y++) {
      color.fill(0, (y * width + x0) * channels, (y * width + x1) * channels);
      alpha?.fill(255, y * width + x0, y * width + x1);
    }
  }
  return { ...(await flateFromChannels(color, alpha, width, height, gray)), picture: record.picture };
}

// ---------- Imagem ----------

// A imagem e a máscara viram recursos da página (uma vez por arquivo, pela chave). Devolve o nome para o Do.
function imageResource(id, res) {
  const record = IMAGES.get(id);
  if (!record) throw new Error('A imagem da edição não está mais na memória');
  const { width: Width, height: Height } = record;
  const flate = (channels) => ({ Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: channels, BitsPerComponent: 8, Columns: Width } });
  const mask = record.mask && res.object(`imagem:${id}:mascara`, {
    dict: { Type: 'XObject', Subtype: 'Image', Width, Height, ColorSpace: 'DeviceGray', BitsPerComponent: 8, ...flate(1) },
    data: record.mask,
  });
  return res.xObject(`imagem:${id}`, {
    dict: {
      Type: 'XObject', Subtype: 'Image', Width, Height, ColorSpace: record.gray ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8,
      ...(record.kind === 'jpeg' ? { Filter: 'DCTDecode' } : flate(record.gray ? 1 : 3)),
      ...(mask ? { SMask: mask } : {}),
    },
    data: record.data,
  });
}

// {type: 'image', x0, y0, x1, y1, turn?, image}: image é a chave da imagem na memória (storeImage). A imagem ocupa a
// caixa inteira; a proporção fica travada ao mudar o tamanho.
registerEditType('image', {
  label: 'Imagem', gender: 'f', keepRatio: true,
  paint(ctx, edit, { w, h }) {
    const picture = IMAGES.get(edit.image)?.picture;
    if (picture) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(picture, 0, 0, w, h);
      return;
    }
    // Sem a prévia (não deveria acontecer): um quadro cinza no lugar, para a edição continuar visível.
    ctx.fillStyle = '#d0d5dd';
    ctx.fillRect(0, 0, w, h);
  },
  pdf(edit, { w, h }, res) {
    return `${pdfNumber(w)} 0 0 ${pdfNumber(-h)} 0 ${pdfNumber(h)} cm ${imageResource(edit.image, res)} Do`;
  },
  // Imagem inteira sob uma tarja sai; a que a tarja pega só em parte vai na versão com essa parte apagada dos pixels,
  // preparada antes (cutImages). Sem ela, nada sai: a tarja nunca fica só cobrindo uma imagem. O corte é medido na
  // caixa da edição, de 0 a 1: o tamanho da página (o terceiro argumento do hook) não muda nada nele.
  redact(edit, rects) {
    if (underCover(edit, rects)) return [];
    const cuts = imageCuts(edit, rects);
    if (!cuts.length) return [edit];
    const id = cutKey(edit.image, cuts);
    if (!IMAGES.has(id)) throw new Error('A parte da imagem sob a tarja não foi apagada antes de montar o PDF');
    return [{ ...edit, image: id }];
  },
});

// ---------- Rubrica ----------

/**
 * @typedef {object} Rubric
 * @property {number} id muda a cada desenho novo: a chave do Form XObject
 * @property {number} w largura do desenho, nas unidades do painel em que foi feito
 * @property {number} h
 * @property {number[][][]} strokes os traços, de 0 a 1 no desenho (como os do tipo "ink")
 * @property {string} color
 * @property {number} width espessura do traço, nas unidades do painel
 */

/** Tamanhos da rubrica: o lado maior, em pontos (1 cm = 72 / 2,54 pontos). */
export const RUBRIC_SIZES = {
  small: { label: 'Pequena (2 cm)', side: (2 * 72) / 2.54 },
  medium: { label: 'Média (3 cm)', side: (3 * 72) / 2.54 },
  large: { label: 'Grande (4,5 cm)', side: (4.5 * 72) / 2.54 },
};

/**
 * Rubrica a partir dos traços desenhados no painel (pontos de 0 a 1 nele, já preparados com prepareStroke): a caixa
 * envolve os traços, com folga para a espessura, como no desenho à mão.
 * @param {number[][][]} strokes
 * @param {{color: string, width: number}} props width na unidade do painel (pixels da tela)
 * @param {{width: number, height: number}} pad o tamanho do painel
 * @param {number} id
 * @returns {Rubric}
 */
export function rubricFromStrokes(strokes, props, pad, id) {
  const ink = inkFromStrokes(strokes, props, pad);
  return {
    id, w: (ink.x1 - ink.x0) * pad.width, h: (ink.y1 - ink.y0) * pad.height,
    strokes: ink.strokes, color: ink.color, width: ink.width,
  };
}

const RUBRIC_GAP = 4; // pontos entre a rubrica e o texto que ela evita

/**
 * A rubrica num dos seis lugares da página, com o lado maior de `side` pontos. Se o lugar já tem numeração, cabeçalho
 * ou rodapé (placed), ela sai de cima deles: para dentro da página, logo depois do último. A marca d'água (a página
 * inteira, transparente) não conta.
 * @param {Rubric} rubric
 * @param {string} spot 'bottom-right'…
 * @param {number} side em pontos
 * @param {{width: number, height: number}} page a página como aparece, em pontos
 * @param {object[]} [placed] as edições que já estão na página (de 0 a 1)
 */
export function rubricEdit(rubric, spot, side, page, placed = []) {
  const scale = side / Math.max(rubric.w, rubric.h);
  const box = spotBox(spot, [rubric.w * scale, rubric.h * scale], page);
  const height = box.y1 - box.y0;
  const gap = RUBRIC_GAP / page.height;
  const down = spot.startsWith('top');
  const others = placed.filter((edit) => edit.type !== 'watermark' && !(edit.x0 <= 0 && edit.y0 <= 0 && edit.x1 >= 1 && edit.y1 >= 1));
  // Cada passo passa do que ela cobre; para quando não cobre mais nada (no máximo um passo por edição).
  for (let step = 0; step < others.length; step++) {
    const hit = others.filter((o) => o.x0 < box.x1 && o.x1 > box.x0 && o.y0 < box.y1 && o.y1 > box.y0);
    if (!hit.length) break;
    box.y0 = down ? Math.max(...hit.map((o) => o.y1)) + gap : Math.min(...hit.map((o) => o.y0)) - gap - height;
    box.y0 = Math.min(1 - height, Math.max(0, box.y0));
    box.y1 = box.y0 + height;
  }
  return { type: 'rubric', ...box, rubric };
}

// O desenho da rubrica como um desenho à mão, no quadro dela (w × h).
const inkOf = (rubric) => ({ type: 'ink', strokes: rubric.strokes, color: rubric.color, width: rubric.width });

// {type: 'rubric', x0, y0, x1, y1, rubric}: criada por "em todas as páginas" (rubric.js), não pelo editor. O desenho
// vai uma vez para o arquivo, como um Form XObject no quadro dela, e cada página só o chama, na escala da caixa. Na
// página em que uma tarja pega a rubrica em parte (cutRedact), ela vai num Form XObject só dessa página, com os traços
// cortados na tarja: o desenho que as outras páginas usam não leva nada para baixo dela.
registerEditType('rubric', {
  label: 'Rubrica', gender: 'f', keepRatio: true, redact: cutRedact,
  paint(ctx, edit, { w, h }) {
    const { rubric } = edit;
    ctx.scale(w / rubric.w, h / rubric.h);
    editType('ink').paint(ctx, inkOf(rubric), { w: rubric.w, h: rubric.h });
  },
  pdf(edit, { w, h }, res) {
    const { rubric } = edit;
    const sx = w / rubric.w;
    const sy = h / rubric.h;
    // As tarjas no quadro da rubrica (a caixa é a rubrica na escala da página).
    const cuts = edit.cuts?.map(([x0, y0, x1, y1]) => [x0 / sx, y0 / sy, x1 / sx, y1 / sy]);
    const content = editType('ink').pdf({ ...inkOf(rubric), cuts }, { w: rubric.w, h: rubric.h });
    if (!content) return '';
    const key = cuts ? `rubrica:${rubric.id}:${cuts.map((cut) => cut.map((v) => v.toFixed(3)).join(',')).join(';')}` : `rubrica:${rubric.id}`;
    const name = res.xObject(key, {
      dict: { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, rubric.w, rubric.h], Resources: {} },
      data: encoder.encode(content),
    });
    return `${pdfNumber(sx, 6)} 0 0 ${pdfNumber(sy, 6)} 0 0 cm ${name} Do`;
  },
});
