// Fontes embutidas do PDF/A nas páginas do Word e no carimbo da assinatura: o PDF/A exige a fonte dentro do arquivo, e
// as fontes padrão do PDF (Helvetica, Times e Courier) não vão embutidas. No lugar delas vão as Liberation (SIL OFL 1.1,
// em vendor/liberation), que têm as mesmas larguras em toda a WinAnsi, menos ¯ ± µ · ÷: o texto distribuído pelo
// layout.js e o carimbo (stamp.js) continuam no lugar (nesses cinco símbolos, a diferença é de até 0,4 ponto em letra
// 12). Vai só o subconjunto das letras usadas (ttf.js), comprimido.
// Carregado só quando o PDF/A está ligado e há página de Word ou carimbo; cada fonte só quando é usada.
import { readTrueType } from './ttf.js';
import { winAnsiCode } from './fonts.js';
import { md5 } from './md5.js';
import { OCR_FONT, ocrText } from './ocr-layer.js';

// Fonte padrão do PDF → arquivo da Liberation equivalente.
const FILES = {
  Helvetica: 'LiberationSans-Regular', 'Helvetica-Bold': 'LiberationSans-Bold',
  'Helvetica-Oblique': 'LiberationSans-Italic', 'Helvetica-BoldOblique': 'LiberationSans-BoldItalic',
  'Times-Roman': 'LiberationSerif-Regular', 'Times-Bold': 'LiberationSerif-Bold',
  'Times-Italic': 'LiberationSerif-Italic', 'Times-BoldItalic': 'LiberationSerif-BoldItalic',
  Courier: 'LiberationMono-Regular', 'Courier-Bold': 'LiberationMono-Bold',
  'Courier-Oblique': 'LiberationMono-Italic', 'Courier-BoldOblique': 'LiberationMono-BoldItalic',
};

// WinAnsi: código → caractere (o inverso de winAnsiCode).
const WIN_ANSI = new Map();
for (let cp = 0x20; cp <= 0x2122; cp++) {
  const char = String.fromCodePoint(cp);
  const code = winAnsiCode(char);
  if (code !== undefined && !WIN_ANSI.has(code)) WIN_ANSI.set(code, char);
}

const loaded = new Map(); // fonte → promessa da fonte lida (uma vez por aba)

function loadFont(font) {
  if (!loaded.has(font)) {
    const promise = import(`../vendor/liberation/${FILES[font]}.ttf.js`).then(({ default: base64 }) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return readTrueType(bytes);
    });
    promise.catch(() => loaded.delete(font)); // sem rede e sem cache: tenta de novo na próxima vez
    loaded.set(font, promise);
  }
  return loaded.get(font);
}

/**
 * Letras usadas por fonte: o texto das páginas do Word, as letras a mais (o carimbo da assinatura) e, na Helvetica, o
 * da camada do OCR das fotos (que divide a mesma fonte no PDF quando ela vai embutida para o Word ou para o carimbo).
 * @param {object[]} pages as páginas de buildPdf (pdf.js)
 * @param {Map<string, string>} [extra] letras a mais, pela fonte padrão (stampCharacters, em stamp.js)
 * @returns {Map<string, Set<string>>}
 */
export function usedCharacters(pages, extra = new Map()) {
  const used = new Map();
  const add = (font, text) => {
    if (!used.has(font)) used.set(font, new Set());
    for (const char of text) used.get(font).add(char);
  };
  for (const [font, text] of extra) add(font, text);
  for (const page of pages) {
    if (page.copy) continue;
    if (page.jpeg) {
      page.ocr?.forEach((word, i) => add(OCR_FONT, ocrText(word.text) + (word.last || i === page.ocr.length - 1 ? '' : ' ')));
      continue;
    }
    for (const item of page.items) if (item.type === 'text') add(item.font, item.text);
  }
  // Fonte usada só na camada do OCR (sem página de Word nem carimbo com ela) continua sem embutir: texto invisível não
  // precisa.
  const visible = extra.has(OCR_FONT)
    || pages.some((page) => !page.jpeg && !page.copy && page.items.some((item) => item.type === 'text' && item.font === OCR_FONT));
  if (!visible) used.delete(OCR_FONT);
  return used;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Tag de subconjunto (seis letras maiúsculas antes do nome), tirada do próprio conteúdo: o mesmo documento dá
// sempre o mesmo PDF.
function subsetTag(font, chars) {
  return [...md5(new TextEncoder().encode(`${font}:${chars.join('')}`)).subarray(0, 6)].map((b) => String.fromCharCode(65 + (b % 26))).join('');
}

// ToUnicode: de cada código usado para o caractere, para o texto copiado e pesquisado sair certo.
function toUnicode(chars) {
  const hex = (n, size) => n.toString(16).toUpperCase().padStart(size, '0');
  const lines = chars.map((char) => `<${hex(winAnsiCode(char), 2)}> <${hex(char.codePointAt(0), 4)}>`);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 100) {
    const block = lines.slice(i, i + 100);
    blocks.push(`${block.length} beginbfchar\n${block.join('\n')}\nendbfchar`);
  }
  return '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
    + '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
    + '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n'
    + '1 begincodespacerange\n<00> <FF>\nendcodespacerange\n'
    + `${blocks.join('\n')}\n`
    + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
}

/**
 * @typedef {{baseFont: string, chars: string, firstChar: number, lastChar: number, widths: number[],
 *   program: Uint8Array, length1: number, toUnicode: string, descriptor: {flags: number, bbox: number[],
 *   italicAngle: number, ascent: number, descent: number, capHeight: number, stemV: number}}} EmbeddedFont
 *   chars: as letras do subconjunto
 */

/**
 * Prepara as fontes embutidas das páginas: para cada fonte padrão usada no texto, o subconjunto da Liberation
 * equivalente, comprimido (FlateDecode), com as larguras dela (o /Widths precisa bater com a fonte embutida).
 * @param {object[]} pages as páginas de buildPdf
 * @param {Map<string, string>} [extra] letras a mais, pela fonte padrão: as do carimbo da assinatura
 *   (stampCharacters, em stamp.js), que divide com o Word o mesmo objeto de fonte
 * @returns {Promise<Map<string, EmbeddedFont>>} pela fonte padrão (buildPdf, opção fonts)
 */
export async function embedFonts(pages, extra) {
  const out = new Map();
  for (const [font, set] of usedCharacters(pages, extra)) {
    if (!FILES[font]) throw new Error(`Fonte sem equivalente para o PDF/A: ${font}`);
    const ttf = await loadFont(font);
    const chars = [...set].filter((char) => winAnsiCode(char) !== undefined).sort((a, b) => winAnsiCode(a) - winAnsiCode(b));
    if (!chars.length) continue;
    const program = ttf.subset(chars.map((char) => char.codePointAt(0)));
    const firstChar = winAnsiCode(chars[0]);
    const lastChar = winAnsiCode(chars[chars.length - 1]);
    // Largura de cada código, como na fonte embutida: o que não é usado vai com 0, como no subconjunto.
    const usedCodes = new Set(chars.map(winAnsiCode));
    const widths = [];
    for (let code = firstChar; code <= lastChar; code++) {
      widths.push(usedCodes.has(code) ? ttf.width(WIN_ANSI.get(code).codePointAt(0)) : 0);
    }
    const scale = (v) => Math.round((v * 1000) / ttf.unitsPerEm);
    const bold = /Bold/.test(font);
    const italic = /Oblique|Italic/.test(font);
    out.set(font, {
      baseFont: `${subsetTag(font, chars)}+${ttf.postScriptName}`,
      chars: chars.join(''),
      firstChar, lastChar, widths,
      program: await deflate(program),
      length1: program.length,
      toUnicode: toUnicode(chars),
      descriptor: {
        // Não simbólica (32), mais serifa (2), largura fixa (1) e itálico (64) conforme a fonte.
        flags: 32 | (font.startsWith('Times') ? 2 : 0) | (font.startsWith('Courier') ? 1 : 0) | (italic ? 64 : 0),
        bbox: ttf.bbox.map(scale),
        italicAngle: ttf.italicAngle,
        ascent: scale(ttf.ascent),
        descent: scale(ttf.descent),
        capHeight: scale(ttf.capHeight),
        stemV: bold ? 140 : 80, // a TrueType não informa; o valor só orienta quem substitui a fonte
      },
    });
  }
  return out;
}
