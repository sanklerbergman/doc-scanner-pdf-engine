// Comprimir PDF: prepara versões menores dos objetos que as páginas copiadas usam.
// - Imagens: recodificadas em JPEG, com o lado maior limitado (níveis de qualidade do app). Entram as JPEG
//   (DCTDecode) e as sem perda (FlateDecode, 8 bits, RGB ou cinza). CMYK, paleta (Indexed), máscaras,
//   /Decode, JPEG 2000, JBIG2 e CCITT ficam como estão: recodificar mudaria a imagem ou nem diminuiria.
// - Streams sem compressão nenhuma (conteúdo de página, por exemplo): ganham FlateDecode.
// Uma troca só vale se diminuir de verdade. O resultado é um Map(número do objeto → stream novo) para o
// copyPages (pdf-reader.js). Objetos que nenhuma página usa já ficam de fora na própria cópia.
//
// O codificador de JPEG vem de fora (no app, um canvas; nos testes, um falso): este módulo roda no Node.
import { PdfDict, PdfName, PdfRef, PdfStream, NAME_MAPS, keptEntries, unpredict } from './pdf-reader.js';
import { readJpegInfo } from './pdf.js';
import { inflate } from './inflate.js';

const MAX_PIXELS = 40 * 1000 * 1000; // imagem maior que isso fica como está (memória do celular)
const MIN_GAIN = 0.9; // a versão nova precisa ter no máximo 90% do tamanho da original

const name = (value) => (value instanceof PdfName ? value.value : null);

// Streams que as páginas usam (conteúdo, recursos, fontes, imagens, formulários), pelo número do objeto.
function reachableStreams(doc, indices) {
  const seen = new Set();
  const streams = new Set();
  const stack = []; // [valor, é um dicionário de nomes de recursos]
  for (const index of indices) {
    const page = doc.pages[index];
    stack.push([page.attrs.Resources], [page.node.get('Contents')], [page.node.get('Group')]);
  }
  while (stack.length) {
    const [value, names] = stack.pop();
    if (value instanceof PdfRef) {
      if (seen.has(value.num)) continue;
      seen.add(value.num);
      const target = doc.object(value.num);
      if (target instanceof PdfStream) streams.add(value.num);
      stack.push([target, names]);
    } else if (Array.isArray(value)) {
      for (const item of value) stack.push([item]);
    } else if (value instanceof PdfDict) {
      for (const [key, item] of keptEntries(value, names)) stack.push([item, NAME_MAPS.has(key)]);
    } else if (value instanceof PdfStream) {
      stack.push([value.dict]);
    }
  }
  return [...streams];
}

// RGB ou cinza (contando os perfis de cor equivalentes); o resto não é recodificado.
function channelsOf(doc, value) {
  const space = doc.resolve(value);
  const kind = name(space) ?? (Array.isArray(space) ? name(doc.resolve(space[0])) : null);
  if (kind === 'DeviceRGB' || kind === 'CalRGB') return 3;
  if (kind === 'DeviceGray' || kind === 'CalGray') return 1;
  if (kind === 'ICCBased') {
    const profile = doc.resolve(space[1]);
    const n = profile instanceof PdfStream ? doc.resolve(profile.dict.get('N')) : null;
    return n === 3 || n === 1 ? n : null;
  }
  return null;
}

function filtersOf(doc, dict) {
  const filter = doc.resolve(dict.get('Filter'));
  const list = filter == null ? [] : Array.isArray(filter) ? filter.map((f) => name(doc.resolve(f))) : [name(filter)];
  const params = doc.resolve(dict.get('DecodeParms'));
  return { list, params: doc.resolve(Array.isArray(params) ? params[0] : params) };
}

// Amostras do PDF (RGB ou cinza, 8 bits) → RGBA, como o canvas espera.
export function toRgba(samples, width, height, channels) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const o = i * 4;
    if (channels === 3) {
      out[o] = samples[p];
      out[o + 1] = samples[p + 1];
      out[o + 2] = samples[p + 2];
    } else {
      out[o] = out[o + 1] = out[o + 2] = samples[p];
    }
    out[o + 3] = 255;
  }
  return out;
}

async function deflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {object} doc documento aberto pelo pdf-reader
 * @param {number[]} indices páginas que vão para o PDF novo
 * @param {{encode: (input: {jpeg?: Uint8Array, pixels?: {data: Uint8ClampedArray, width: number, height: number}})
 *   => Promise<{data: Uint8Array, width: number, height: number} | null>, onProgress?: (done: number, total: number) => void}} options
 *   encode: recodifica a imagem em JPEG (já reduzida), ou devolve null para deixar como está
 * @returns {Promise<Map<number, PdfStream>>}
 */
export async function compressObjects(doc, indices, { encode, onProgress }) {
  const replace = new Map();
  const nums = reachableStreams(doc, indices);
  const masks = maskNums(doc, nums);
  for (const [done, num] of nums.entries()) {
    onProgress?.(done, nums.length);
    const stream = doc.object(num);
    const { dict, data } = stream;
    const { list: filters, params } = filtersOf(doc, dict);
    try {
      if (name(doc.resolve(dict.get('Subtype'))) === 'Image') {
        if (masks.has(num)) continue;
        const image = await recodeImage(doc, stream, filters, params, encode);
        if (image) replace.set(num, image);
      } else if (!filters.length && data.length >= 256) {
        const packed = await deflate(data);
        if (packed.length <= data.length * MIN_GAIN) {
          const next = new PdfDict(dict);
          next.set('Filter', new PdfName('FlateDecode'));
          next.delete('DecodeParms');
          replace.set(num, new PdfStream(next, packed));
        }
      }
    } catch (err) {
      console.warn(`Objeto ${num} ficou como estava:`, err.message); // imagem quebrada: copia a original
    }
  }
  onProgress?.(nums.length, nums.length);
  return replace;
}

// Máscaras de transparência (SMask) ficam como estão: em JPEG, as bordas da transparência borrariam.
function maskNums(doc, nums) {
  const masks = new Set();
  for (const num of nums) {
    const mask = doc.object(num).dict.get('SMask');
    if (mask instanceof PdfRef) masks.add(mask.num);
  }
  return masks;
}

// Que tipo de imagem dá para recodificar: 'jpeg', 'raw' (sem perda, 8 bits) ou null (fica como está).
function recodable(doc, stream, filters, params) {
  const { dict, data } = stream;
  const get = (key) => doc.resolve(dict.get(key));
  if (get('ImageMask') === true || dict.has('Mask') || dict.has('Decode')) return null;
  const width = get('Width');
  const height = get('Height');
  const channels = channelsOf(doc, dict.get('ColorSpace'));
  if (!(width > 0 && height > 0) || width * height > MAX_PIXELS || !channels) return null;
  if (filters.length === 1 && filters[0] === 'DCTDecode') {
    return readJpegInfo(data).components === channels ? 'jpeg' : null; // CMYK ou cor que não bate com o JPEG
  }
  if (filters.every((f) => f === 'FlateDecode') && filters.length <= 1 && get('BitsPerComponent') === 8) {
    const predictor = params instanceof PdfDict ? doc.resolve(params.get('Predictor')) ?? 1 : 1;
    return predictor > 1 && predictor < 10 ? null : 'raw'; // preditor TIFF: raro, fica como está
  }
  return null;
}

/**
 * Quantos bytes do PDF são imagens que a compressão consegue recodificar. Rápido: não decodifica nada.
 * Serve para o app sugerir (e já ligar) a compressão quando o PDF é pesado.
 * @param {object} doc documento do pdf-reader
 * @param {number[]} [indices] páginas (todas, se faltar)
 */
export function compressibleBytes(doc, indices = doc.pages.map((_, i) => i)) {
  let total = 0;
  const nums = reachableStreams(doc, indices);
  const masks = maskNums(doc, nums);
  for (const num of nums) {
    if (masks.has(num)) continue;
    const stream = doc.object(num);
    if (name(doc.resolve(stream.dict.get('Subtype'))) !== 'Image') continue;
    const { list, params } = filtersOf(doc, stream.dict);
    try {
      if (recodable(doc, stream, list, params)) total += stream.data.length;
    } catch { /* imagem quebrada: não conta */ }
  }
  return total;
}

async function recodeImage(doc, stream, filters, params, encode) {
  const { dict, data } = stream;
  const get = (key) => doc.resolve(dict.get(key));
  const kind = recodable(doc, stream, filters, params);
  if (!kind) return null;
  const width = get('Width');
  const height = get('Height');
  const channels = channelsOf(doc, dict.get('ColorSpace'));

  let input;
  if (kind === 'jpeg') {
    input = { jpeg: data };
  } else {
    let samples = filters.length ? await inflate(data, 'deflate', width * height * channels + height + 1024, { lenient: true }) : data;
    if (filters.length) samples = unpredict(samples, params instanceof PdfDict ? params : null);
    if (samples.length < width * height * channels) return null;
    input = { pixels: { data: toRgba(samples, width, height, channels), width, height } };
  }

  const result = await encode(input);
  if (!result || result.data.length > data.length * MIN_GAIN) return null;
  const next = new PdfDict(dict);
  for (const key of ['Filter', 'DecodeParms', 'DL', 'Length']) next.delete(key);
  next.set('Width', result.width);
  next.set('Height', result.height);
  next.set('ColorSpace', new PdfName(readJpegInfo(result.data).components === 1 ? 'DeviceGray' : 'DeviceRGB'));
  next.set('BitsPerComponent', 8);
  next.set('Filter', new PdfName('DCTDecode'));
  return new PdfStream(next, result.data);
}
