// Fonte TrueType: o que o PDF/A precisa para embutir as fontes do texto do Word (pdf.js). Lê as larguras, o mapa de
// caracteres (cmap) e as medidas da fonte, e gera o subconjunto só com as letras usadas no documento, para o PDF não
// carregar centenas de KB por fonte. Código puro, sem DOM, testado em Node.
//
// O subconjunto mantém os números das letras (glyph IDs) do original: as que não são usadas ficam vazias na tabela
// glyf, e as tabelas que dependem desses números (hmtx, loca) seguem válidas. O cmap é refeito só com as letras
// usadas (Unicode, plataforma 3 e codificação 1), que é o que o PDF/A pede para fonte TrueType não simbólica com
// WinAnsiEncoding. Ficam de fora as tabelas de tipografia avançada (GSUB, GPOS, kern…) e os nomes das letras (post
// formato 3): o PDF não usa nenhuma delas.

export class TrueTypeError extends Error {
  name = 'TrueTypeError';
}

// Tabelas que vão para o subconjunto. cvt, fpgm e prep são as instruções de hinting (nitidez em tela pequena).
const KEEP = ['OS/2', 'cmap', 'cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post', 'prep'];
const REQUIRED = ['cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp'];

/**
 * @param {Uint8Array} bytes o arquivo .ttf
 * @returns {{unitsPerEm: number, numGlyphs: number, bbox: number[], ascent: number, descent: number,
 *   capHeight: number, italicAngle: number, weight: number, fixedPitch: boolean, postScriptName: string,
 *   glyphOf: (codePoint: number) => number, advance: (glyph: number) => number,
 *   width: (codePoint: number) => number, subset: (codePoints: Iterable<number>) => Uint8Array}}
 *   width: largura em milésimos de em (como no /Widths do PDF); glyphOf devolve 0 para o que a fonte não tem
 */
export function readTrueType(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at) => view.getUint16(at);
  const i16 = (at) => view.getInt16(at);
  const u32 = (at) => view.getUint32(at);
  if (bytes.length < 12 || ![0x00010000, 0x74727565].includes(u32(0))) throw new TrueTypeError('Não é uma fonte TrueType.');

  const tables = new Map();
  const count = u16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (at + 16 > bytes.length) throw new TrueTypeError('Fonte TrueType cortada.');
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    const offset = u32(at + 8);
    const length = u32(at + 12);
    if (offset + length > bytes.length) throw new TrueTypeError(`Tabela ${tag} fora do arquivo.`);
    tables.set(tag, { offset, length });
  }
  for (const tag of REQUIRED) if (!tables.has(tag)) throw new TrueTypeError(`Fonte sem a tabela ${tag}.`);
  const table = (tag) => tables.get(tag);
  const data = (tag) => bytes.subarray(table(tag).offset, table(tag).offset + table(tag).length);

  const head = table('head').offset;
  const unitsPerEm = u16(head + 18);
  const bbox = [i16(head + 36), i16(head + 38), i16(head + 40), i16(head + 42)];
  const longLoca = i16(head + 50) === 1;
  const numGlyphs = u16(table('maxp').offset + 4);
  const hhea = table('hhea').offset;
  const numberOfHMetrics = u16(hhea + 34);
  let ascent = i16(hhea + 4);
  let descent = i16(hhea + 6);
  let capHeight = ascent;
  let weight = 400;
  const os2 = table('OS/2');
  if (os2 && os2.length >= 78) {
    weight = u16(os2.offset + 4);
    ascent = i16(os2.offset + 68);
    descent = i16(os2.offset + 70);
    if (u16(os2.offset) >= 2 && os2.length >= 90) capHeight = i16(os2.offset + 88);
  }
  const post = table('post');
  const italicAngle = post ? view.getInt32(post.offset + 4) / 65536 : 0;
  const fixedPitch = post ? u32(post.offset + 12) !== 0 : false;

  const hmtx = table('hmtx').offset;
  const advance = (glyph) => u16(hmtx + 4 * Math.min(glyph, numberOfHMetrics - 1));
  const glyphOf = readCmap(bytes, view, table('cmap'));
  const toThousandths = (units) => Math.round((units * 1000) / unitsPerEm);

  const loca = table('loca').offset;
  const glyf = table('glyf');
  const glyphRange = (glyph) => {
    if (glyph >= numGlyphs) return [0, 0];
    const start = longLoca ? u32(loca + glyph * 4) : u16(loca + glyph * 2) * 2;
    const end = longLoca ? u32(loca + glyph * 4 + 4) : u16(loca + glyph * 2 + 2) * 2;
    if (end < start || end > glyf.length) throw new TrueTypeError('Tabela loca inválida.');
    return [glyf.offset + start, glyf.offset + end];
  };

  // Letras compostas (como "á", feita de "a" e do acento) apontam para outras letras, que também vão junto.
  const components = (glyph) => {
    const [start, end] = glyphRange(glyph);
    if (end - start < 10 || i16(start) >= 0) return [];
    const out = [];
    let at = start + 10;
    for (let guard = 0; guard < 64 && at + 4 <= end; guard++) {
      const flags = u16(at);
      out.push(u16(at + 2));
      at += 4 + (flags & 0x0001 ? 4 : 2); // ARG_1_AND_2_ARE_WORDS
      if (flags & 0x0008) at += 2; // WE_HAVE_A_SCALE
      else if (flags & 0x0040) at += 4; // WE_HAVE_AN_X_AND_Y_SCALE
      else if (flags & 0x0080) at += 8; // WE_HAVE_A_TWO_BY_TWO
      if (!(flags & 0x0020)) break; // MORE_COMPONENTS
    }
    return out;
  };

  return {
    unitsPerEm, numGlyphs, bbox, ascent, descent, capHeight, italicAngle, weight, fixedPitch,
    postScriptName: readPostScriptName(bytes, view, table('name')),
    glyphOf,
    advance,
    width: (codePoint) => toThousandths(advance(glyphOf(codePoint))),
    subset(codePoints) {
      const used = new Map(); // código Unicode → letra
      for (const cp of codePoints) {
        const glyph = glyphOf(cp);
        if (glyph) used.set(cp, glyph);
      }
      const keep = new Set([0, ...used.values()]);
      for (const glyph of [...keep]) {
        const stack = [glyph];
        while (stack.length) {
          for (const part of components(stack.pop())) {
            if (part < numGlyphs && !keep.has(part)) {
              keep.add(part);
              stack.push(part);
            }
          }
        }
      }
      // glyf e loca novas: a letra que não vai fica vazia (início igual ao fim). Cada letra começa em múltiplo de 4.
      const pieces = [];
      const newLoca = new Uint8Array((numGlyphs + 1) * 4);
      const locaView = new DataView(newLoca.buffer);
      let size = 0;
      for (let glyph = 0; glyph < numGlyphs; glyph++) {
        locaView.setUint32(glyph * 4, size);
        if (!keep.has(glyph)) continue;
        const [start, end] = glyphRange(glyph);
        const padded = (end - start + 3) & ~3;
        const piece = new Uint8Array(padded);
        piece.set(bytes.subarray(start, end));
        pieces.push(piece);
        size += padded;
      }
      locaView.setUint32(numGlyphs * 4, size);
      const newGlyf = concat(pieces);

      // hmtx: a letra que não vai fica com largura e recuo zerados (a tabela comprime quase toda). Quem monta o PDF
      // põe 0 no /Widths dos códigos que não usa, para as duas larguras baterem.
      const newHmtx = Uint8Array.from(data('hmtx'));
      const hmtxView = new DataView(newHmtx.buffer);
      for (let glyph = 0; glyph < numGlyphs; glyph++) {
        if (keep.has(glyph)) continue;
        const at = glyph < numberOfHMetrics ? glyph * 4 : numberOfHMetrics * 4 + (glyph - numberOfHMetrics) * 2;
        if (glyph < numberOfHMetrics && at + 4 <= newHmtx.length) hmtxView.setUint32(at, 0);
        else if (at + 2 <= newHmtx.length) hmtxView.setUint16(at, 0);
      }

      const newHead = Uint8Array.from(data('head'));
      new DataView(newHead.buffer).setUint32(8, 0); // checkSumAdjustment, refeito no fim
      new DataView(newHead.buffer).setInt16(50, 1); // loca com posições de 32 bits

      const out = new Map([
        ['cmap', buildCmap(used)],
        ['glyf', newGlyf],
        ['head', newHead],
        ['hmtx', newHmtx],
        ['loca', newLoca],
      ]);
      if (post) out.set('post', postFormat3(data('post')));
      for (const tag of KEEP) if (!out.has(tag) && tables.has(tag)) out.set(tag, data(tag));
      return writeFont(out);
    },
  };
}

// Mapa de caracteres: subtabela Unicode (3,10 formato 12, 3,1 ou 0,x formato 4). Devolve código → letra.
function readCmap(bytes, view, { offset }) {
  const count = view.getUint16(offset + 2);
  const subtables = [];
  for (let i = 0; i < count; i++) {
    const at = offset + 4 + i * 8;
    subtables.push({ platform: view.getUint16(at), encoding: view.getUint16(at + 2), at: offset + view.getUint32(at + 4) });
  }
  const pick = (platform, encoding, format) => subtables.find((s) => s.platform === platform && (encoding === null || s.encoding === encoding)
    && s.at + 2 <= bytes.length && view.getUint16(s.at) === format);
  const twelve = pick(3, 10, 12) ?? pick(0, null, 12);
  if (twelve) {
    const groups = view.getUint32(twelve.at + 12);
    return (cp) => {
      let low = 0;
      let high = groups - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const at = twelve.at + 16 + mid * 12;
        const start = view.getUint32(at);
        const end = view.getUint32(at + 4);
        if (cp < start) high = mid - 1;
        else if (cp > end) low = mid + 1;
        else return view.getUint32(at + 8) + (cp - start);
      }
      return 0;
    };
  }
  const four = pick(3, 1, 4) ?? pick(0, null, 4);
  if (!four) throw new TrueTypeError('Fonte sem mapa de caracteres Unicode.');
  const segments = view.getUint16(four.at + 6) / 2;
  const ends = four.at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    for (let i = 0; i < segments; i++) {
      if (cp > view.getUint16(ends + i * 2)) continue;
      const start = view.getUint16(starts + i * 2);
      if (cp < start) return 0;
      const delta = view.getUint16(deltas + i * 2);
      const range = view.getUint16(ranges + i * 2);
      if (!range) return (cp + delta) & 0xffff;
      const at = ranges + i * 2 + range + (cp - start) * 2;
      const glyph = at + 2 <= bytes.length ? view.getUint16(at) : 0;
      return glyph ? (glyph + delta) & 0xffff : 0;
    }
    return 0;
  };
}

// Nome PostScript (nameID 6), em Unicode (plataforma 3) ou Mac (plataforma 1).
function readPostScriptName(bytes, view, table) {
  if (!table) return '';
  const { offset } = table;
  const count = view.getUint16(offset + 2);
  const strings = offset + view.getUint16(offset + 4);
  for (let i = 0; i < count; i++) {
    const at = offset + 6 + i * 12;
    if (view.getUint16(at + 6) !== 6) continue;
    const platform = view.getUint16(at);
    const length = view.getUint16(at + 8);
    const start = strings + view.getUint16(at + 10);
    const raw = bytes.subarray(start, start + length);
    let name = '';
    if (platform === 3 || platform === 0) for (let j = 0; j + 1 < raw.length; j += 2) name += String.fromCharCode((raw[j] << 8) | raw[j + 1]);
    else name = String.fromCharCode(...raw);
    if (name) return name;
  }
  return '';
}

// cmap só com a subtabela (3,1) formato 4: um segmento por letra usada (idDelta leva o código até a letra).
function buildCmap(used) {
  const codes = [...used.keys()].filter((cp) => cp <= 0xfffe).sort((a, b) => a - b);
  const segments = codes.length + 1; // mais o segmento final, 0xFFFF
  let power = 1;
  while (power * 2 <= segments) power *= 2;
  const length = 16 + segments * 8;
  const out = new Uint8Array(4 + 8 + length);
  const view = new DataView(out.buffer);
  view.setUint16(2, 1); // uma subtabela
  view.setUint16(4, 3); // plataforma Windows
  view.setUint16(6, 1); // Unicode BMP
  view.setUint32(8, 12);
  const at = 12;
  view.setUint16(at, 4);
  view.setUint16(at + 2, length);
  view.setUint16(at + 6, segments * 2);
  view.setUint16(at + 8, power * 2);
  view.setUint16(at + 10, Math.log2(power));
  view.setUint16(at + 12, segments * 2 - power * 2);
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  codes.forEach((cp, i) => {
    view.setUint16(ends + i * 2, cp);
    view.setUint16(starts + i * 2, cp);
    view.setUint16(deltas + i * 2, (used.get(cp) - cp) & 0xffff);
  });
  const last = codes.length;
  view.setUint16(ends + last * 2, 0xffff);
  view.setUint16(starts + last * 2, 0xffff);
  view.setUint16(deltas + last * 2, 1);
  return out;
}

// post formato 3: as medidas de sublinhado e itálico, sem os nomes das letras.
function postFormat3(post) {
  const out = Uint8Array.from(post.subarray(0, 32));
  new DataView(out.buffer).setUint32(0, 0x00030000);
  return out;
}

const checksum = (data) => {
  const padded = new Uint8Array((data.length + 3) & ~3);
  padded.set(data);
  const view = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
};

// Arquivo TrueType: diretório das tabelas (em ordem alfabética) e as tabelas alinhadas em 4 bytes.
function writeFont(tables) {
  const tags = [...tables.keys()].sort();
  let power = 1;
  while (power * 2 <= tags.length) power *= 2;
  const header = new Uint8Array(12 + tags.length * 16);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tags.length);
  view.setUint16(6, power * 16);
  view.setUint16(8, Math.log2(power));
  view.setUint16(10, tags.length * 16 - power * 16);
  const parts = [header];
  let offset = header.length;
  let headAt = 0;
  tags.forEach((tag, i) => {
    const data = tables.get(tag);
    const at = 12 + i * 16;
    for (let j = 0; j < 4; j++) header[at + j] = tag.charCodeAt(j);
    view.setUint32(at + 4, checksum(data));
    view.setUint32(at + 8, offset);
    view.setUint32(at + 12, data.length);
    if (tag === 'head') headAt = offset;
    const padded = new Uint8Array((data.length + 3) & ~3);
    padded.set(data);
    parts.push(padded);
    offset += padded.length;
  });
  const font = concat(parts);
  // checkSumAdjustment da head: 0xB1B0AFBA menos a soma do arquivo inteiro.
  new DataView(font.buffer).setUint32(headAt + 8, (0xb1b0afba - checksum(font)) >>> 0);
  return font;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
