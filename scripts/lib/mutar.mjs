// Variações de um PDF para o fuzzing: bytes trocados, arquivo cortado, números absurdos, palavras da estrutura
// trocadas ou apagadas, pedaços repetidos ou apagados. Determinístico: a mesma semente dá sempre a mesma
// variação, para um caso que falhou poder ser repetido.

// Gerador pseudoaleatório pequeno (mulberry32): números entre 0 e 1.
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NUMBERS = ['0', '-1', '1', '255', '65535', '2147483647', '2147483648', '4294967296', '9007199254740993',
  '99999999999999999999', '1e308', '-0', '0.0000001', '3.5', '-2147483649', ''];
const WORDS = ['obj', 'endobj', 'stream', 'endstream', 'xref', 'trailer', 'startxref', 'R', 'n', 'f', 'null', 'true',
  '<<', '>>', '[', ']', '(', ')', '<', '>', '/Length', '/Kids', '/Count', '/Parent', '/Prev', '/Root', '/Pages',
  '/Page', '/Type', '/Filter', '/FlateDecode', '/DecodeParms', '/Predictor', '/Columns', '/Resources', '/Contents',
  '/ObjStm', '/XRef', '/W', '/Index', '/Size', '/N', '/First', '/MediaBox', '/CropBox', '/Rotate', '/Annots', '/AP',
  '/OCProperties', '/OC', '/OCGs', '/VE', '/Encrypt', '/SMask', '/Width', '/Height', '/BitsPerComponent',
  'BT', 'ET', 'Tj', 'q', 'Q', 'cm', 'BDC', 'BMC', 'EMC', 'BI', 'ID', 'EI', 'Do'];
const escape = (word) => word.replace(/[[\]()<>/]/g, '\\$&');
const WORD_PATTERN = new RegExp(`(?<![A-Za-z0-9])(?:${[...WORDS].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![A-Za-z0-9])`, 'g');

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const fromLatin1 = (text) => new Uint8Array(Buffer.from(text, 'latin1'));
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

// Troca uma ocorrência (escolhida ao acaso) de pattern por replacement(match).
function replaceOne(bytes, rand, pattern, replacement) {
  const text = latin1(bytes);
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return bytes;
  const m = pick(rand, matches);
  return fromLatin1(text.slice(0, m.index) + replacement(m[0]) + text.slice(m.index + m[0].length));
}

const OPERATORS = {
  // Alguns bytes trocados (bits ou o byte inteiro): pega também os dados compactados dos streams.
  flip(bytes, rand) {
    const out = bytes.slice();
    const count = 1 + Math.floor(rand() * 8);
    for (let i = 0; i < count; i++) {
      const pos = Math.floor(rand() * out.length);
      out[pos] = rand() < 0.5 ? out[pos] ^ (1 << Math.floor(rand() * 8)) : Math.floor(rand() * 256);
    }
    return out;
  },
  // Arquivo cortado (download incompleto).
  cut(bytes, rand) {
    return bytes.slice(0, Math.floor(rand() * bytes.length));
  },
  // Número absurdo no lugar de outro (tamanhos, offsets, contagens, referências).
  number(bytes, rand) {
    return replaceOne(bytes, rand, /-?\d+(?:\.\d+)?/g, () => pick(rand, NUMBERS));
  },
  // Palavra da estrutura trocada por outra, ou apagada.
  word(bytes, rand) {
    return replaceOne(bytes, rand, WORD_PATTERN, () => (rand() < 0.3 ? '' : pick(rand, WORDS)));
  },
  // Pedaço repetido em outro lugar.
  repeat(bytes, rand) {
    const start = Math.floor(rand() * bytes.length);
    const piece = bytes.subarray(start, start + 1 + Math.floor(rand() * 256));
    const at = Math.floor(rand() * bytes.length);
    const out = new Uint8Array(bytes.length + piece.length);
    out.set(bytes.subarray(0, at));
    out.set(piece, at);
    out.set(bytes.subarray(at), at + piece.length);
    return out;
  },
  // Pedaço apagado.
  remove(bytes, rand) {
    const start = Math.floor(rand() * bytes.length);
    const end = Math.min(bytes.length, start + 1 + Math.floor(rand() * 256));
    const out = new Uint8Array(bytes.length - (end - start));
    out.set(bytes.subarray(0, start));
    out.set(bytes.subarray(end), start);
    return out;
  },
};

/**
 * Uma variação do PDF: de 1 a 3 alterações, escolhidas pela semente.
 * @param {Uint8Array} bytes
 * @param {number} seed
 * @returns {{bytes: Uint8Array, applied: string[]}} applied: as alterações, na ordem
 */
export function mutate(bytes, seed) {
  const rand = random(seed);
  const names = Object.keys(OPERATORS);
  const applied = [];
  let out = bytes;
  const count = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < count && out.length; i++) {
    const name = pick(rand, names);
    out = OPERATORS[name](out, rand);
    applied.push(name);
  }
  return { bytes: out, applied };
}

/**
 * Os casos de uma rodada: o caso i usa a amostra i % (número de amostras) e a semente base + i.
 * @param {string[]} names nomes das amostras
 * @param {{seed: number, count: number}} options
 * @returns {Array<{sample: string, seed: number}>}
 */
export function fuzzCases(names, { seed, count }) {
  return Array.from({ length: count }, (_, i) => ({ sample: names[i % names.length], seed: seed + i }));
}
