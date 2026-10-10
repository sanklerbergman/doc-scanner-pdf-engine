// Leitura de documentos do Word (.docx), sem dependências. O .docx é um ZIP com arquivos XML:
// o texto fica em word/document.xml, os estilos (títulos, fonte padrão) em word/styles.xml e as listas
// em word/numbering.xml. Daqui sai um modelo simples (seções com parágrafos e trechos de texto formatado)
// que o layout.js distribui em páginas.
//
// Também entram tabelas (colunas, bordas, fundo, células mescladas), imagens (na linha do texto ou
// flutuantes) e cabeçalho e rodapé (com número de página). O que ainda não é desenhado (gráficos, formas,
// equações, notas de rodapé, imagens em formatos como EMF) é contado em `notes` para o app avisar.
// Nada do arquivo é executado, nenhum link externo é seguido (imagem só se estiver dentro do arquivo) e os
// metadados (docProps: autor, empresa, datas) nem são lidos.
import { openZip, ZipError } from './zip.js';
import { parseXml, elements, element, XmlError } from './xml.js';

export class DocxError extends Error {}

const NAMESPACES = {
  w: ['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'],
  r: ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'],
  a: ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'],
  m: ['http://schemas.openxmlformats.org/officeDocument/2006/math', 'http://purl.oclc.org/ooxml/officeDocument/math'],
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  v: 'urn:schemas-microsoft-com:vml',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
};

const A4 = { width: 595.28, height: 841.89 };
const DEFAULT_MARGIN = 70.87; // 2,5 cm
const ALIGN = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' };

// ---------- Valores ----------

const isOn = (value) => value === undefined || !['0', 'false', 'off', 'none'].includes(value);
const flag = (node) => (node ? isOn(node.attrs['w:val']) : undefined);
const val = (node) => node?.attrs['w:val'];

// Medida em twips (1/20 de ponto) ou com unidade ("2.5cm", formato Strict). Devolve pontos.
const UNITS = { mm: 72 / 25.4, cm: 72 / 2.54, in: 72, pt: 1, pc: 12, pi: 12 };
function twips(value, divisor = 20) {
  const match = /^\s*(-?\d*\.?\d+)\s*(mm|cm|in|pt|pc|pi)?\s*$/.exec(value ?? '');
  if (!match) return undefined;
  return match[2] ? Number(match[1]) * UNITS[match[2]] : Number(match[1]) / divisor;
}

// Cor "RRGGBB" → [r, g, b] de 0 a 1; "auto" ou inválida → null (preto no texto, nenhuma no fundo).
function rawColor(value) {
  if (!/^[0-9a-f]{6}$/i.test(value ?? '')) return null;
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
}

// Texto claro demais: sem um fundo escuro desenhado (o Word teria sombreamento), sumiria no papel.
const isLight = (rgb) => !!rgb && 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.85;

// Família da fonte pelo nome: as fontes padrão do PDF são uma sem serifa, uma serifada e uma monoespaçada.
export function fontFamily(name) {
  if (!name) return 'serif'; // sem fonte definida, o Word usa Times New Roman
  if (/mono|courier|consolas|menlo|lucida console|source code/i.test(name)) return 'mono';
  if (/sans|gothic|grotesk/i.test(name)) return 'sans';
  if (/times|georgia|garamond|cambria|book|palatino|serif|minion|baskerville|bodoni|century|constantia|caslon|charter|didot|merriweather|lora|crimson|gentium|sitka|bembo|perpetua|goudy|calisto|tinos/i.test(name)) return 'serif';
  return 'sans';
}

// Procura em profundidade o primeiro elemento com o nome dado.
function find(node, name) {
  for (const child of elements(node)) {
    if (child.name === name) return child;
    const found = find(child, name);
    if (found) return found;
  }
  return undefined;
}

// ---------- Propriedades de texto e de parágrafo ----------
// Cada função devolve só o que o elemento define; os níveis (padrão do documento, estilo, formatação
// direta) são somados depois, o de cima sobrescrevendo o de baixo.

function runProps(rPr, theme) {
  const props = {};
  if (!rPr) return props;
  const set = (key, value) => { if (value !== undefined) props[key] = value; };
  set('bold', flag(element(rPr, 'w:b')));
  set('italic', flag(element(rPr, 'w:i')));
  set('strike', flag(element(rPr, 'w:strike')) || flag(element(rPr, 'w:dstrike')) || undefined);
  set('caps', flag(element(rPr, 'w:caps')) || flag(element(rPr, 'w:smallCaps')) || undefined);
  set('hidden', flag(element(rPr, 'w:vanish')));
  const underline = element(rPr, 'w:u');
  if (underline) props.underline = (val(underline) ?? 'single') !== 'none';
  const size = twips(val(element(rPr, 'w:sz')), 2); // meios-pontos
  if (size > 0) props.size = size;
  const colorNode = element(rPr, 'w:color');
  if (colorNode) props.color = rawColor(val(colorNode));
  const fonts = element(rPr, 'w:rFonts');
  if (fonts) {
    const themed = fonts.attrs['w:asciiTheme'] ?? fonts.attrs['w:hAnsiTheme'];
    set('font', themed ? theme[themed.startsWith('major') ? 'major' : 'minor'] : fonts.attrs['w:ascii'] ?? fonts.attrs['w:hAnsi']);
  }
  set('vertAlign', val(element(rPr, 'w:vertAlign')));
  set('style', val(element(rPr, 'w:rStyle')));
  return props;
}

function paragraphProps(pPr) {
  const props = {};
  if (!pPr) return props;
  const set = (key, value) => { if (value !== undefined) props[key] = value; };
  set('style', val(element(pPr, 'w:pStyle')));
  const jc = val(element(pPr, 'w:jc'));
  if (jc) props.align = ALIGN[jc] ?? 'left';

  const ind = element(pPr, 'w:ind')?.attrs;
  if (ind) {
    set('indLeft', twips(ind['w:left'] ?? ind['w:start']));
    set('indRight', twips(ind['w:right'] ?? ind['w:end']));
    const hanging = twips(ind['w:hanging']);
    set('indFirst', hanging !== undefined ? -hanging : twips(ind['w:firstLine']));
  }

  const spacing = element(pPr, 'w:spacing')?.attrs;
  if (spacing) {
    // "Automático" (como numa página da web) equivale a 14 pt.
    const auto = (name) => spacing[name] !== undefined && isOn(spacing[name]);
    set('before', auto('w:beforeAutospacing') ? 14 : twips(spacing['w:before']));
    set('after', auto('w:afterAutospacing') ? 14 : twips(spacing['w:after']));
    if (spacing['w:line'] !== undefined) {
      const rule = spacing['w:lineRule'] === 'exact' || spacing['w:lineRule'] === 'atLeast' ? spacing['w:lineRule'] : 'auto';
      const line = rule === 'auto' ? Number(spacing['w:line']) / 240 : twips(spacing['w:line']);
      if (line > 0) Object.assign(props, { line, lineRule: rule });
    }
  }

  set('contextualSpacing', flag(element(pPr, 'w:contextualSpacing')));
  set('keepNext', flag(element(pPr, 'w:keepNext')));
  set('keepLines', flag(element(pPr, 'w:keepLines')));
  set('pageBreakBefore', flag(element(pPr, 'w:pageBreakBefore')));
  set('widowControl', flag(element(pPr, 'w:widowControl')));

  const numPr = element(pPr, 'w:numPr');
  if (numPr) {
    set('numId', val(element(numPr, 'w:numId')));
    const level = Number(val(element(numPr, 'w:ilvl')));
    if (level >= 0 && level <= 8) props.ilvl = level;
  }

  const tabs = element(pPr, 'w:tabs');
  if (tabs) {
    props.tabs = elements(tabs, 'w:tab')
      .map((tab) => ({ pos: twips(tab.attrs['w:pos']), clear: tab.attrs['w:val'] === 'clear' }))
      .filter((tab) => tab.pos !== undefined);
  }
  return props;
}

// Soma dois níveis de propriedades de parágrafo. Paradas de tabulação somam (ou são apagadas com "clear").
function mergeParagraph(base, top) {
  const merged = { ...base, ...top };
  if (base.tabs || top.tabs) {
    const stops = new Map((base.tabs ?? []).filter((tab) => !tab.clear).map((tab) => [tab.pos, tab]));
    for (const tab of top.tabs ?? []) {
      if (tab.clear) stops.delete(tab.pos);
      else stops.set(tab.pos, tab);
    }
    merged.tabs = [...stops.values()];
  }
  return merged;
}

// Propriedades finais de um trecho de texto, com os valores padrão do Word.
function finishRun(props) {
  return {
    bold: !!props.bold,
    italic: !!props.italic,
    underline: !!props.underline,
    strike: !!props.strike,
    size: props.size ?? 10,
    color: props.color ?? null,
    family: fontFamily(props.font),
    vertAlign: props.vertAlign === 'superscript' || props.vertAlign === 'subscript' ? props.vertAlign : null,
  };
}

// ---------- Estilos ----------

function readStyles(root, theme) {
  const styles = new Map();
  let defaultParagraph;
  let defaultTable;
  const defaults = root && element(root, 'w:docDefaults');
  for (const style of elements(root, 'w:style')) {
    const id = style.attrs['w:styleId'];
    styles.set(id, {
      basedOn: val(element(style, 'w:basedOn')),
      p: paragraphProps(element(style, 'w:pPr')),
      r: runProps(element(style, 'w:rPr'), theme),
      t: tableProps(element(style, 'w:tblPr')),
    });
    const isDefault = style.attrs['w:default'] && isOn(style.attrs['w:default']);
    if (style.attrs['w:type'] === 'paragraph' && isDefault) defaultParagraph = id;
    if (style.attrs['w:type'] === 'table' && isDefault) defaultTable = id;
  }

  const resolved = new Map();
  // Estilo com tudo o que herda (basedOn), do mais geral para o mais específico.
  function resolve(id, seen = new Set()) {
    if (!id || !styles.has(id) || seen.has(id)) return { p: {}, r: {}, t: {} };
    if (resolved.has(id)) return resolved.get(id);
    seen.add(id);
    const style = styles.get(id);
    const base = resolve(style.basedOn, seen);
    const result = { p: mergeParagraph(base.p, style.p), r: { ...base.r, ...style.r }, t: mergeTable(base.t, style.t) };
    resolved.set(id, result);
    return result;
  }

  return {
    defaults: {
      p: paragraphProps(element(element(defaults, 'w:pPrDefault'), 'w:pPr')),
      r: runProps(element(element(defaults, 'w:rPrDefault'), 'w:rPr'), theme),
    },
    defaultParagraph,
    defaultTable,
    resolve,
  };
}

// ---------- Listas ----------

function letters(n) {
  if (n < 1) return String(n);
  return String.fromCharCode(65 + ((n - 1) % 26)).repeat(Math.ceil(n / 26)); // 27 → AA, como no Word
}

function roman(n) {
  if (n < 1 || n > 3999) return String(n);
  const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [value, symbol] of table) while (n >= value) { out += symbol; n -= value; }
  return out;
}

export function formatNumber(n, format) {
  switch (format) {
    case 'upperLetter': return letters(n);
    case 'lowerLetter': return letters(n).toLowerCase();
    case 'upperRoman': return roman(n);
    case 'lowerRoman': return roman(n).toLowerCase();
    case 'decimalZero': return n >= 0 && n < 10 ? `0${n}` : String(n);
    case 'ordinal': return `${n}º`;
    case 'bullet':
    case 'none': return '';
    default: return String(n);
  }
}

function readLevel(lvl, theme) {
  const start = Number(val(element(lvl, 'w:start')));
  return {
    start: Number.isFinite(start) ? start : 1,
    format: val(element(lvl, 'w:numFmt')) ?? 'decimal',
    text: val(element(lvl, 'w:lvlText')) ?? '',
    suffix: val(element(lvl, 'w:suff')) ?? 'tab',
    legal: flag(element(lvl, 'w:isLgl')) ?? false,
    p: paragraphProps(element(lvl, 'w:pPr')),
    r: runProps(element(lvl, 'w:rPr'), theme),
  };
}

// Contadores das listas. Listas (w:num) que apontam para a mesma definição (w:abstractNum) continuam
// a mesma numeração, como no Word; "reiniciar em" (startOverride) recomeça.
function readNumbering(root, theme, styles) {
  const abstracts = new Map();
  for (const abstract of elements(root, 'w:abstractNum')) {
    const levels = [];
    for (const lvl of elements(abstract, 'w:lvl')) {
      const level = Number(lvl.attrs['w:ilvl']);
      if (level >= 0 && level <= 8) levels[level] = readLevel(lvl, theme);
    }
    abstracts.set(abstract.attrs['w:abstractNumId'], { levels, link: val(element(abstract, 'w:numStyleLink')) });
  }
  const nums = new Map();
  for (const num of elements(root, 'w:num')) {
    const overrides = [];
    for (const override of elements(num, 'w:lvlOverride')) {
      const level = Number(override.attrs['w:ilvl']);
      if (!(level >= 0 && level <= 8)) continue;
      const start = Number(val(element(override, 'w:startOverride')));
      const lvl = element(override, 'w:lvl');
      overrides[level] = { start: Number.isFinite(start) ? start : undefined, level: lvl ? readLevel(lvl, theme) : undefined };
    }
    nums.set(num.attrs['w:numId'], { abstractId: val(element(num, 'w:abstractNumId')), overrides });
  }

  // Definição da lista, seguindo o vínculo com um estilo de lista (numStyleLink), se houver.
  function abstractOf(num, depth = 0) {
    const abstract = abstracts.get(num.abstractId);
    if (!abstract?.link || depth > 3) return abstract;
    const linked = nums.get(styles.resolve(abstract.link).p.numId);
    return linked ? abstractOf(linked, depth + 1) : abstract;
  }

  const counters = new Map();
  const seen = new Set();

  // Rótulo do próximo item (ex.: "2.", "b)", "•") e a definição do nível. Avança o contador.
  return function next(numId, ilvl) {
    const num = nums.get(numId);
    const abstract = num && abstractOf(num);
    if (!abstract) return null;
    const levelOf = (i) => num.overrides[i]?.level ?? abstract.levels[i];
    const startOf = (i) => num.overrides[i]?.start ?? levelOf(i)?.start ?? 1;
    const level = levelOf(ilvl);
    if (!level) return null;

    const key = num.abstractId;
    if (!counters.has(key)) counters.set(key, []);
    const count = counters.get(key);
    if (!seen.has(numId)) {
      seen.add(numId);
      num.overrides.forEach((override, i) => {
        if (override?.start !== undefined) count.fill(undefined, i);
      });
    }
    count[ilvl] = count[ilvl] === undefined ? startOf(ilvl) : count[ilvl] + 1;
    count.fill(undefined, ilvl + 1);
    for (let i = 0; i < ilvl; i++) count[i] ??= startOf(i);

    const text = level.format === 'none' ? '' : level.text.replace(/%([1-9])/g, (_, n) => {
      const i = Number(n) - 1;
      return formatNumber(count[i] ?? startOf(i), level.legal ? 'decimal' : levelOf(i)?.format ?? 'decimal');
    });
    return { text, level };
  };
}

// ---------- Pacote (ZIP) e relações entre as partes ----------

function resolvePath(base, target) {
  let path = target;
  try { path = decodeURIComponent(target); } catch { /* fica como está */ }
  const parts = (path.startsWith('/') ? path : base + path).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

// Relações de uma parte (ex.: word/document.xml → word/_rels/document.xml.rels). Links externos ficam de fora.
async function readRelations(zip, part) {
  const slash = part.lastIndexOf('/') + 1;
  const dir = part.slice(0, slash);
  const relsPath = `${dir}_rels/${part.slice(slash)}.rels`;
  const relations = [];
  if (!zip.has(relsPath)) return relations;
  const root = parseXml(await zip.readText(relsPath), NAMESPACES);
  for (const rel of elements(root, 'rel:Relationship')) {
    if (rel.attrs.TargetMode === 'External' || !rel.attrs.Target) continue;
    relations.push({ id: rel.attrs.Id, type: rel.attrs.Type ?? '', target: resolvePath(dir, rel.attrs.Target) });
  }
  return relations;
}

const byType = (relations, suffix) => relations.find((rel) => rel.type.endsWith(`/${suffix}`))?.target;

async function readPart(zip, path) {
  return path && zip.has(path) ? parseXml(await zip.readText(path), NAMESPACES) : null;
}

async function readTheme(zip, path) {
  const root = await readPart(zip, path);
  return {
    major: find(find(root, 'a:majorFont'), 'a:latin')?.attrs.typeface,
    minor: find(find(root, 'a:minorFont'), 'a:latin')?.attrs.typeface,
  };
}

// ---------- Tabelas ----------

const BORDER_SIDES = { top: 'top', bottom: 'bottom', left: 'left', start: 'left', right: 'right', end: 'right', insideH: 'insideH', insideV: 'insideV' };

// Borda: null = sem borda; {width, color}. A espessura vem em oitavos de ponto.
function border(node) {
  const kind = node.attrs['w:val'];
  if (!kind || kind === 'none' || kind === 'nil') return null;
  const size = Number(node.attrs['w:sz']);
  return { width: Math.max(0.25, (Number.isFinite(size) && size > 0 ? size : 4) / 8), color: rawColor(node.attrs['w:color']) };
}

// Só os lados que o elemento define (undefined = herda; null = sem borda).
function readBorders(node) {
  const out = {};
  for (const child of elements(node)) {
    const side = BORDER_SIDES[child.name.slice(2)];
    if (side && child.name.startsWith('w:')) out[side] = border(child);
  }
  return out;
}

function readCellMargins(node) {
  const out = {};
  for (const child of elements(node)) {
    const side = BORDER_SIDES[child.name.slice(2)];
    const width = twips(child.attrs['w:w']);
    if (side && width !== undefined && child.attrs['w:type'] !== 'pct') out[side] = width;
  }
  return out;
}

function tableProps(tblPr) {
  if (!tblPr) return {};
  const props = { borders: readBorders(element(tblPr, 'w:tblBorders')), margins: readCellMargins(element(tblPr, 'w:tblCellMar')) };
  const style = val(element(tblPr, 'w:tblStyle'));
  if (style) props.style = style;
  const indent = element(tblPr, 'w:tblInd');
  if (indent && indent.attrs['w:type'] !== 'pct') props.indent = twips(indent.attrs['w:w']) ?? 0;
  const jc = val(element(tblPr, 'w:jc'));
  if (jc) props.align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left';
  return props;
}

function mergeTable(base = {}, top = {}) {
  return {
    ...base,
    ...top,
    borders: { ...base.borders, ...top.borders },
    margins: { ...base.margins, ...top.margins },
  };
}

// ---------- Imagens ----------

const EMU = 12700; // unidades de desenho do Office por ponto
const emu = (value) => Number(value) / EMU;

function imageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null; // EMF, WMF, TIFF, SVG…: o navegador não desenha num canvas
}

// Posição de imagem flutuante (wp:anchor): em relação à página, à margem ou ao parágrafo ("near").
function anchorPosition(node) {
  const from = node?.attrs.relativeFrom ?? '';
  const relative = from === 'page' ? 'page' : /margin/i.test(from) ? 'margin' : 'near';
  const offset = element(node, 'wp:posOffset');
  const align = element(node, 'wp:align');
  return {
    relative,
    offset: offset ? emu(offset.children.join('')) : 0,
    align: align ? align.children.join('').trim() : null,
  };
}

// Largura e altura do estilo de uma forma VML antiga ("width:120pt;height:40pt").
function vmlSize(style = '') {
  const read = (name) => {
    const match = new RegExp(`${name}\\s*:\\s*([\\d.]+)\\s*(pt|in|px|cm|mm)?`, 'i').exec(style);
    if (!match) return undefined;
    const factor = { pt: 1, in: 72, px: 0.75, cm: 72 / 2.54, mm: 72 / 25.4 }[(match[2] ?? 'px').toLowerCase()];
    return Number(match[1]) * factor;
  };
  return { width: read('width'), height: read('height') };
}

const SPECIAL_FIELDS = /^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i;

// ---------- Documento ----------

/**
 * Lê um .docx.
 * @param {Uint8Array} bytes
 * @returns {Promise<{sections: Array, defaultTab: number, evenAndOdd: boolean, notes: object,
 *   images: Map<string, {bytes: Uint8Array, type: string}>}>}
 */
export async function readDocx(bytes, limits) {
  // .doc (Word 97-2003) e .docx com senha são arquivos OLE, não ZIP.
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new DocxError('É um documento do Word antigo (.doc) ou protegido por senha. Abra no Word e salve como .docx, sem senha.');
  }
  try {
    return await read(bytes, limits);
  } catch (err) {
    if (err instanceof ZipError) throw new DocxError(err.message);
    if (err instanceof XmlError) throw new DocxError('O documento está corrompido.');
    throw err;
  }
}

async function read(bytes, limits) {
  const zip = openZip(bytes, limits);
  const main = byType(await readRelations(zip, ''), 'officeDocument');
  if (!main || !zip.has(main)) throw new DocxError('Não parece um documento do Word (.docx).');

  const relations = await readRelations(zip, main);
  const relsOf = (list) => new Map(list.map((rel) => [rel.id, rel.target]));
  const theme = await readTheme(zip, byType(relations, 'theme'));
  const styles = readStyles(await readPart(zip, byType(relations, 'styles')), theme);
  const nextLabel = readNumbering(await readPart(zip, byType(relations, 'numbering')), theme, styles);
  const settings = await readPart(zip, byType(relations, 'settings'));
  const defaultTab = twips(val(element(settings, 'w:defaultTabStop'))) || 36;
  const evenAndOdd = flag(element(settings, 'w:evenAndOddHeaders')) ?? false;

  const root = parseXml(await zip.readText(main), NAMESPACES);
  const body = element(root, 'w:body');
  if (!body) throw new DocxError('Não parece um documento do Word (.docx).');

  // Cabeçalhos e rodapés: as partes são lidas antes (é assíncrono), cada uma com as relações dela (imagens).
  const parts = new Map();
  const sectPrs = [];
  (function collect(node) {
    for (const child of elements(node)) {
      if (child.name === 'w:sectPr') sectPrs.push(child);
      else collect(child);
    }
  }(body));
  const mainRels = relsOf(relations);
  for (const sectPr of sectPrs) {
    for (const ref of [...elements(sectPr, 'w:headerReference'), ...elements(sectPr, 'w:footerReference')]) {
      const target = mainRels.get(ref.attrs['r:id']);
      if (target && !parts.has(target) && zip.has(target)) {
        parts.set(target, { root: await readPart(zip, target), rels: relsOf(await readRelations(zip, target)) });
      }
    }
  }

  const notes = { images: 0, charts: 0, shapes: 0, equations: 0, footnotes: 0, embedded: 0, columns: false };
  const imagePaths = new Set();
  const sections = [];
  let previousHeaders = { header: {}, footer: {} };

  // ctx: rels (relações da parte), target (lista onde vão os blocos), field (campos abertos),
  // table (estilo da tabela, dentro de célula), fill (fundo da célula), body (é o corpo do documento).
  const blocksOfPart = new Map();
  function partBlocks(target) {
    if (!blocksOfPart.has(target)) {
      const part = parts.get(target);
      const ctx = { rels: part?.rels ?? new Map(), target: [], field: [] };
      if (part?.root) readBlocks(part.root, ctx);
      blocksOfPart.set(target, ctx.target);
    }
    return blocksOfPart.get(target);
  }

  function sectionOf(sectPr) {
    const size = element(sectPr, 'w:pgSz')?.attrs ?? {};
    const margins = element(sectPr, 'w:pgMar')?.attrs ?? {};
    let width = twips(size['w:w']) || A4.width;
    let height = twips(size['w:h']) || A4.height;
    if (size['w:orient'] === 'landscape' && width < height) [width, height] = [height, width];
    width = Math.min(Math.max(width, 72), 14400); // limites do formato PDF
    height = Math.min(Math.max(height, 72), 14400);
    const margin = (name) => Math.abs(twips(margins[name]) ?? DEFAULT_MARGIN);
    const page = {
      width,
      height,
      margin: { top: margin('w:top'), right: margin('w:right'), bottom: margin('w:bottom'), left: margin('w:left') + Math.abs(twips(margins['w:gutter']) ?? 0) },
      headerDistance: Math.abs(twips(margins['w:header']) ?? 35.4),
      footerDistance: Math.abs(twips(margins['w:footer']) ?? 35.4),
    };
    // Margens que não deixam espaço para o texto: volta para o padrão (ou o que couber).
    if (page.margin.left + page.margin.right > width - 72) page.margin.left = page.margin.right = Math.min(DEFAULT_MARGIN, (width - 72) / 2);
    if (page.margin.top + page.margin.bottom > height - 72) page.margin.top = page.margin.bottom = Math.min(DEFAULT_MARGIN, (height - 72) / 2);
    if (Number(element(sectPr, 'w:cols')?.attrs['w:num']) > 1) notes.columns = true;

    // Cabeçalho e rodapé: o tipo que a seção não define vem da seção anterior, como no Word.
    const own = (name) => {
      const set = {};
      for (const ref of elements(sectPr, `w:${name}Reference`)) {
        const target = mainRels.get(ref.attrs['r:id']);
        if (target) set[ref.attrs['w:type'] ?? 'default'] = partBlocks(target);
      }
      return { ...previousHeaders[name], ...set };
    };
    const header = own('header');
    const footer = own('footer');
    previousHeaders = { header, footer };
    return {
      page,
      start: val(element(sectPr, 'w:type')) === 'continuous' ? 'continuous' : 'nextPage',
      header,
      footer,
      titlePg: flag(element(sectPr, 'w:titlePg')) ?? false,
    };
  }

  const alternative = (node) => element(node, 'mc:Choice') ?? element(node, 'mc:Fallback');

  function readDrawing(node, props, ctx, out) {
    const uri = find(node, 'a:graphicData')?.attrs.uri ?? '';
    if (!uri.endsWith('/picture')) {
      if (/chart|diagram/.test(uri)) notes.charts++;
      else notes.shapes++;
      return;
    }
    const container = element(node, 'wp:inline') ?? element(node, 'wp:anchor');
    const extent = element(container, 'wp:extent');
    const width = emu(extent?.attrs.cx);
    const height = emu(extent?.attrs.cy);
    const target = ctx.rels.get(find(node, 'a:blip')?.attrs['r:embed']); // r:link (imagem externa) nunca é seguido
    if (!target || !(width > 0) || !(height > 0)) {
      notes.images++;
      return;
    }
    imagePaths.add(target);
    if (container?.name === 'wp:anchor') {
      out.push({ ...props, float: { image: target, width, height, h: anchorPosition(element(container, 'wp:positionH')), v: anchorPosition(element(container, 'wp:positionV')) } });
    } else {
      out.push({ ...props, image: target, width, height });
    }
  }

  // Dentro do resultado de um campo de página (PAGE, NUMPAGES): o texto guardado no arquivo é trocado
  // pelo número de verdade na hora de montar cada página.
  const inPageField = (ctx) => ctx.field.some((field) => field.special && field.result);

  // Conteúdo de um w:r: texto, tabulação, quebras, imagens, campos.
  function readRunContent(node, props, ctx, out) {
    const text = (value) => {
      if (inPageField(ctx)) {
        const run = [...out].reverse().find((item) => item.field);
        if (run) run.text += value;
        return;
      }
      out.push({ ...props, text: props.caps ? value.toLocaleUpperCase('pt-BR') : value });
    };
    for (const child of elements(node)) {
      switch (child.name) {
        case 'w:t': text(child.children.filter((c) => typeof c === 'string').join('').replace(/[\t\r\n]/g, ' ')); break;
        case 'w:tab':
        case 'w:ptab': out.push({ ...props, tab: true }); break;
        case 'w:br': out.push({ ...props, break: child.attrs['w:type'] === 'page' ? 'page' : 'line' }); break;
        case 'w:cr': out.push({ ...props, break: 'line' }); break;
        case 'w:noBreakHyphen': text('-'); break;
        case 'w:sym': {
          const code = parseInt(child.attrs['w:char'] ?? '', 16);
          if (code > 0) text(String.fromCodePoint(code < 0x100 ? code + 0xf000 : code)); // símbolo de fonte (Symbol, Wingdings)
          break;
        }
        case 'w:fldChar': {
          const kind = child.attrs['w:fldCharType'];
          if (kind === 'begin') ctx.field.push({ instr: '', result: false, special: null });
          else if (kind === 'separate' && ctx.field.length) {
            const field = ctx.field[ctx.field.length - 1];
            field.result = true;
            field.special = SPECIAL_FIELDS.exec(field.instr)?.[1].toUpperCase() ?? null;
            if (field.special) out.push({ ...props, field: field.special, text: '' });
          } else if (kind === 'end') ctx.field.pop();
          break;
        }
        case 'w:instrText':
          if (ctx.field.length) ctx.field[ctx.field.length - 1].instr += child.children.join('');
          break;
        case 'w:drawing': readDrawing(child, props, ctx, out); break;
        case 'w:pict':
        case 'w:object': {
          const data = find(child, 'v:imagedata');
          const target = data && ctx.rels.get(data.attrs['r:id']);
          const { width, height } = vmlSize(find(child, 'v:shape')?.attrs.style);
          if (target && width > 0 && height > 0) {
            imagePaths.add(target);
            out.push({ ...props, image: target, width, height });
          } else if (data) notes.images++;
          else notes.shapes++;
          break;
        }
        case 'mc:AlternateContent': readRunContent(alternative(child), props, ctx, out); break;
        case 'w:footnoteReference':
        case 'w:endnoteReference': notes.footnotes++; break;
        // w:delText (texto apagado) e marcas de revisão: ficam de fora.
      }
    }
  }

  // Cor clara de texto vira preto, a não ser que a célula tenha fundo escuro (que é desenhado).
  const darkFill = (fill) => fill && 0.2126 * fill[0] + 0.7152 * fill[1] + 0.0722 * fill[2] < 0.6;

  function readInline(node, base, ctx, out) {
    for (const child of elements(node)) {
      switch (child.name) {
        case 'w:r': {
          const direct = runProps(element(child, 'w:rPr'), theme);
          const props = { ...base, ...(direct.style ? styles.resolve(direct.style).r : {}), ...direct };
          if (props.hidden) break; // texto oculto não sai na impressão
          const run = finishRun(props);
          if (isLight(run.color) && !darkFill(ctx.fill)) run.color = null;
          readRunContent(child, { ...run, caps: !!props.caps }, ctx, out);
          break;
        }
        case 'w:fldSimple': {
          const special = SPECIAL_FIELDS.exec(child.attrs['w:instr'] ?? '')?.[1].toUpperCase();
          if (!special) { readInline(child, base, ctx, out); break; }
          const inner = [];
          readInline(child, base, ctx, inner);
          const first = inner.find((run) => run.text !== undefined) ?? finishRun(base);
          out.push({ ...first, field: special, text: inner.map((run) => run.text ?? '').join('') });
          break;
        }
        case 'w:hyperlink':
        case 'w:smartTag':
        case 'w:customXml':
        case 'w:ins':
        case 'w:moveTo':
        case 'w:dir':
        case 'w:bdo':
          readInline(child, base, ctx, out);
          break;
        case 'w:sdt': readInline(element(child, 'w:sdtContent'), base, ctx, out); break;
        case 'mc:AlternateContent': readInline(alternative(child), base, ctx, out); break;
        case 'm:oMath':
        case 'm:oMathPara': notes.equations++; break;
        // w:del e w:moveFrom (revisões apagadas), comentários e indicadores: ficam de fora.
      }
    }
  }

  function readParagraph(p, ctx) {
    const pPr = element(p, 'w:pPr');
    const direct = paragraphProps(pPr);
    const styleId = direct.style ?? styles.defaultParagraph;
    const style = styles.resolve(styleId);
    // Ordem do Word: padrão do documento < estilo da tabela < estilo do parágrafo < lista < formatação direta.
    let props = mergeParagraph(mergeParagraph(styles.defaults.p, ctx.table?.p ?? {}), style.p);

    const numId = direct.numId ?? props.numId;
    const list = numId && numId !== '0' ? nextLabel(numId, direct.ilvl ?? props.ilvl ?? 0) : null;
    if (list) props = mergeParagraph(props, list.level.p);
    props = mergeParagraph(props, direct);

    const base = { ...styles.defaults.r, ...(ctx.table?.r ?? {}), ...style.r };
    const mark = { ...base, ...runProps(element(pPr, 'w:rPr'), theme) };
    const runs = [];
    readInline(p, base, ctx, runs);

    let label = null;
    if (list && list.text) {
      const { font, ...levelRun } = list.level.r; // fonte do marcador (Symbol, Wingdings) não vale aqui
      label = { ...finishRun({ ...mark, ...levelRun }), text: list.text, suffix: list.level.suffix };
    }

    ctx.target.push({
      type: 'paragraph',
      styleId: styleId ?? '',
      runs,
      label,
      mark: finishRun(mark),
      align: props.align ?? 'left',
      indent: { left: props.indLeft ?? 0, right: props.indRight ?? 0, firstLine: props.indFirst ?? 0 },
      spacing: { before: props.before ?? 0, after: props.after ?? 0, line: props.line ?? 1, lineRule: props.lineRule ?? 'auto' },
      tabs: (props.tabs ?? []).map((tab) => tab.pos).sort((a, b) => a - b),
      contextualSpacing: !!props.contextualSpacing,
      keepNext: !!props.keepNext,
      keepLines: !!props.keepLines,
      pageBreakBefore: !!props.pageBreakBefore,
      widowControl: props.widowControl ?? true,
    });

    const sectPr = element(pPr, 'w:sectPr');
    if (sectPr && ctx.body) {
      sections.push({ ...sectionOf(sectPr), blocks: ctx.target });
      ctx.target = [];
    }
  }

  // Linhas e células podem vir dentro de controles de conteúdo (w:sdt) ou de XML personalizado.
  function unwrap(node, name) {
    const out = [];
    for (const child of elements(node)) {
      if (child.name === name) out.push(child);
      else if (child.name === 'w:sdt') out.push(...unwrap(element(child, 'w:sdtContent'), name));
      else if (child.name === 'w:customXml') out.push(...unwrap(child, name));
    }
    return out;
  }

  function readTable(tbl, ctx) {
    const direct = tableProps(element(tbl, 'w:tblPr'));
    const style = styles.resolve(direct.style ?? styles.defaultTable);
    const props = mergeTable(style.t, direct);
    const margins = { top: 0, bottom: 0, left: 5.4, right: 5.4, ...props.margins };
    const grid = elements(element(tbl, 'w:tblGrid'), 'w:gridCol').map((col) => twips(col.attrs['w:w']) ?? 0);
    const rows = unwrap(tbl, 'w:tr').map((tr) => {
      const trPr = element(tr, 'w:trPr');
      const height = element(trPr, 'w:trHeight');
      return {
        minHeight: twips(height?.attrs['w:val']) ?? 0,
        exact: height?.attrs['w:hRule'] === 'exact',
        header: flag(element(trPr, 'w:tblHeader')) ?? false,
        skip: Number(val(element(trPr, 'w:gridBefore'))) || 0,
        cells: unwrap(tr, 'w:tc').map((tc) => {
          const tcPr = element(tc, 'w:tcPr');
          const merge = element(tcPr, 'w:vMerge');
          const fill = rawColor(element(tcPr, 'w:shd')?.attrs['w:fill']);
          const cell = { ...ctx, target: [], table: style, fill, body: false };
          readBlocks(tc, cell);
          return {
            span: Math.max(1, Number(val(element(tcPr, 'w:gridSpan'))) || 1),
            vMerge: merge ? (merge.attrs['w:val'] === 'restart' ? 'restart' : 'continue') : null,
            fill,
            borders: readBorders(element(tcPr, 'w:tcBorders')),
            vAlign: val(element(tcPr, 'w:vAlign')) ?? 'top',
            blocks: cell.target,
          };
        }),
      };
    }).filter((row) => row.cells.length);
    return {
      type: 'table', grid, rows, margins,
      borders: { top: null, bottom: null, left: null, right: null, insideH: null, insideV: null, ...props.borders },
      indent: props.indent ?? 0,
      align: props.align ?? 'left',
    };
  }

  function readBlocks(container, ctx) {
    for (const child of elements(container)) {
      switch (child.name) {
        case 'w:p': readParagraph(child, ctx); break;
        case 'w:tbl': ctx.target.push(readTable(child, ctx)); break;
        case 'w:sdt': readBlocks(element(child, 'w:sdtContent'), ctx); break;
        case 'w:customXml': readBlocks(child, ctx); break;
        case 'mc:AlternateContent': readBlocks(alternative(child), ctx); break;
        case 'w:altChunk': notes.embedded++; break;
      }
    }
  }

  const bodyCtx = { rels: mainRels, target: [], field: [], body: true };
  readBlocks(body, bodyCtx);
  if (bodyCtx.target.length || !sections.length) sections.push({ ...sectionOf(element(body, 'w:sectPr')), blocks: bodyCtx.target });

  // Imagens: só as usadas, e só nos formatos que o navegador desenha.
  const images = new Map();
  for (const path of imagePaths) {
    if (!zip.has(path)) { notes.images++; continue; }
    const data = await zip.read(path);
    const type = imageType(data);
    if (type) images.set(path, { bytes: data, type });
    else notes.images++;
  }

  return { sections, defaultTab, evenAndOdd, notes, images };
}
