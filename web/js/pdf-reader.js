// Leitor de PDF mínimo, sem dependências: o necessário para juntar e dividir PDFs que já existem.
// Lê a estrutura (objetos, tabela xref clássica ou em stream, object streams, atualizações incrementais,
// árvore de páginas) e copia páginas inteiras para um PDF novo. Não desenha nada: o conteúdo das páginas
// (texto, fontes, imagens) vai para o PDF novo byte a byte, sem ser interpretado.
//
// Segurança: nada do PDF é executado. Da página só são copiados o conteúdo e os recursos dele; ficam de fora
// anotações (links, comentários, campos de formulário), ações (/AA, /OpenAction, JavaScript), metadados
// (/Info, XMP) e a árvore de estrutura. Limites de objetos, páginas e tamanho descompactado evitam que um
// arquivo malicioso trave o navegador. PDF criptografado (com senha) é recusado.
import { inflate, InflateError } from './inflate.js';

export class PdfError extends Error {}

export const PDF_LIMITS = {
  maxObjects: 500000,
  maxPages: 5000,
  maxStreamSize: 64 * 1024 * 1024, // por stream descompactado (xref e object streams)
  maxTotalSize: 256 * 1024 * 1024,
};

// ---------- Valores ----------

export class PdfName {
  constructor(value) { this.value = value; }
}
export class PdfRef {
  constructor(num, gen) { this.num = num; this.gen = gen; }
}
export class PdfString {
  constructor(bytes) { this.bytes = bytes; }
}
export class PdfStream {
  constructor(dict, data) { this.dict = dict; this.data = data; }
}
// Dicionário: Map com os nomes das chaves (sem a barra).
export class PdfDict extends Map {}
class Keyword {
  constructor(value) { this.value = value; }
}

const isName = (value, name) => value instanceof PdfName && (name === undefined || value.value === name);

// ---------- Análise léxica ----------

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isRegular = (b) => !WHITESPACE.has(b) && !DELIMITERS.has(b);
const latin1 = (bytes, start, end) => {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
};

class Parser {
  constructor(bytes, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }

  skip() {
    const { bytes } = this;
    while (this.pos < bytes.length) {
      const b = bytes[this.pos];
      if (WHITESPACE.has(b)) this.pos++;
      else if (b === 0x25) { // comentário até o fim da linha
        while (this.pos < bytes.length && bytes[this.pos] !== 10 && bytes[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  token() {
    const start = this.pos;
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos])) this.pos++;
    return latin1(this.bytes, start, this.pos);
  }

  // Lê um valor. Números inteiros seguidos de "gen R" viram referência.
  value(depth = 0) {
    if (depth > 100) throw new PdfError('PDF aninhado demais.');
    this.skip();
    const { bytes } = this;
    if (this.pos >= bytes.length) throw new PdfError('Fim inesperado do arquivo.');
    const b = bytes[this.pos];

    if (b === 0x2f) { // /Nome
      this.pos++;
      const raw = this.token();
      return new PdfName(raw.replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
    }
    if (b === 0x3c && bytes[this.pos + 1] === 0x3c) { // << dicionário >>
      this.pos += 2;
      const dict = new PdfDict();
      for (;;) {
        this.skip();
        if (bytes[this.pos] === 0x3e && bytes[this.pos + 1] === 0x3e) { this.pos += 2; return dict; }
        if (this.pos >= bytes.length) throw new PdfError('Dicionário sem fim.');
        const key = this.value(depth + 1);
        if (!(key instanceof PdfName)) throw new PdfError('Chave de dicionário inválida.');
        dict.set(key.value, this.value(depth + 1));
      }
    }
    if (b === 0x3c) { // <hex>
      const end = bytes.indexOf(0x3e, this.pos);
      if (end < 0) throw new PdfError('Texto hexadecimal sem fim.');
      const hex = latin1(bytes, this.pos + 1, end).replace(/[^0-9a-f]/gi, '');
      this.pos = end + 1;
      const out = new Uint8Array(Math.ceil(hex.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = parseInt((hex.slice(i * 2, i * 2 + 2) + '0').slice(0, 2), 16);
      return new PdfString(out);
    }
    if (b === 0x28) return this.literal();
    if (b === 0x5b) { // [ lista ]
      this.pos++;
      const list = [];
      for (;;) {
        this.skip();
        if (bytes[this.pos] === 0x5d) { this.pos++; return list; }
        if (this.pos >= bytes.length) throw new PdfError('Lista sem fim.');
        list.push(this.value(depth + 1));
      }
    }
    if (b === 0x29 || b === 0x3e || b === 0x5d || b === 0x7b || b === 0x7d) {
      this.pos++;
      return new Keyword(String.fromCharCode(b));
    }

    const word = this.token();
    if (!word) { this.pos++; return new Keyword(''); }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const number = Number(word);
      if (/^\d+$/.test(word)) { // talvez "num gen R"
        const save = this.pos;
        this.skip();
        const gen = this.token();
        if (/^\d+$/.test(gen)) {
          this.skip();
          if (this.token() === 'R') return new PdfRef(number, Number(gen));
        }
        this.pos = save;
      }
      return number;
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new Keyword(word);
  }

  literal() {
    const { bytes } = this;
    this.pos++;
    const out = [];
    let depth = 1;
    while (this.pos < bytes.length) {
      let b = bytes[this.pos++];
      if (b === 0x5c) { // barra invertida
        b = bytes[this.pos++];
        const simple = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c }[b];
        if (simple !== undefined) out.push(simple);
        else if (b >= 0x30 && b <= 0x37) {
          let code = b - 0x30;
          for (let k = 0; k < 2 && bytes[this.pos] >= 0x30 && bytes[this.pos] <= 0x37; k++) code = code * 8 + bytes[this.pos++] - 0x30;
          out.push(code & 0xff);
        } else if (b === 13) {
          if (bytes[this.pos] === 10) this.pos++; // continuação de linha
        } else if (b !== 10) out.push(b);
        continue;
      }
      if (b === 0x28) depth++;
      else if (b === 0x29 && --depth === 0) return new PdfString(Uint8Array.from(out));
      out.push(b);
    }
    throw new PdfError('Texto sem fim.');
  }
}

// ---------- Filtros (só o necessário para ler a estrutura) ----------

// Preditores PNG (/Predictor 10 a 15), usados nas tabelas xref em stream.
function unpredict(data, params) {
  const predictor = params?.get('Predictor') ?? 1;
  if (predictor < 10) return data;
  const colors = params.get('Colors') ?? 1;
  const bpc = params.get('BitsPerComponent') ?? 8;
  const columns = params.get('Columns') ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLength = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLength + 1)];
    const src = r * (rowLength + 1) + 1;
    const dst = r * rowLength;
    for (let i = 0; i < rowLength; i++) {
      const raw = data[src + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = r > 0 ? out[dst - rowLength + i] : 0;
      const upLeft = r > 0 && i >= bpp ? out[dst - rowLength + i - bpp] : 0;
      let value;
      switch (type) {
        case 1: value = raw + left; break;
        case 2: value = raw + up; break;
        case 3: value = raw + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: value = raw;
      }
      out[dst + i] = value & 0xff;
    }
  }
  return out;
}

// ---------- Documento ----------

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
const A4_BOX = [0, 0, 595.28, 841.89];

/**
 * Abre um PDF.
 * @param {Uint8Array} bytes
 * @param {Partial<typeof PDF_LIMITS>} [limits]
 */
export async function openPdf(bytes, limits = {}) {
  const doc = new PdfDocument(bytes, { ...PDF_LIMITS, ...limits });
  try {
    await doc.load();
  } catch (err) {
    if (err instanceof InflateError) throw new PdfError(err.reason === 'too-big' ? err.message : 'O PDF está corrompido.');
    throw err;
  }
  return doc;
}

class PdfDocument {
  constructor(bytes, limits) {
    this.bytes = bytes;
    this.limits = limits;
    this.entries = new Map(); // num → {type: 1, offset} | {type: 2, stream, index}
    this.cache = new Map();
    this.objectStreams = new Map(); // num do object stream → Map(num → valor)
    this.decoded = 0;
    this.trailer = new PdfDict();
  }

  async load() {
    const { bytes } = this;
    const head = latin1(bytes, 0, Math.min(bytes.length, 1024));
    if (!head.includes('%PDF-')) throw new PdfError('Não parece um arquivo PDF.');

    let ok = false;
    try {
      ok = await this.readXref();
      if (ok) await this.preloadObjectStreams(); // daqui em diante, a leitura dos objetos é síncrona
    } catch (err) {
      if (err instanceof InflateError && err.reason === 'too-big') throw err;
      ok = false;
    }
    if (!ok || !this.catalog()) {
      this.entries.clear();
      this.cache.clear();
      this.objectStreams.clear();
      await this.rebuild();
    }
    if (this.trailer.has('Encrypt')) throw new PdfError('O PDF está protegido por senha (criptografado). Abra-o num leitor de PDF e salve uma cópia sem senha.');
    if (!this.catalog()) throw new PdfError('O PDF está corrompido.');
    this.pages = this.readPages();
    if (!this.pages.length) throw new PdfError('O PDF não tem nenhuma página.');
  }

  // Tabelas xref, da mais nova (startxref) para as mais antigas (/Prev). A mais nova vence.
  async readXref() {
    const { bytes } = this;
    const tail = latin1(bytes, Math.max(0, bytes.length - 2048), bytes.length);
    const match = /startxref\s+(\d+)/g;
    let last = null;
    for (let m; (m = match.exec(tail));) last = m;
    if (!last) return false;
    let offset = Number(last[1]);
    const seen = new Set();
    let first = true;
    while (offset !== undefined && offset !== null && !seen.has(offset)) {
      if (offset < 0 || offset >= bytes.length) return false;
      seen.add(offset);
      const trailer = await this.readXrefSection(offset);
      if (!trailer) return false;
      if (first) { this.trailer = trailer; first = false; }
      const stm = trailer.get('XRefStm'); // arquivo híbrido: tabela clássica + stream
      if (typeof stm === 'number' && !seen.has(stm)) {
        seen.add(stm);
        await this.readXrefSection(stm);
      }
      offset = trailer.get('Prev');
      if (typeof offset !== 'number') break;
    }
    return this.entries.size > 0;
  }

  async readXrefSection(offset) {
    const parser = new Parser(this.bytes, offset);
    parser.skip();
    if (latin1(this.bytes, parser.pos, parser.pos + 4) === 'xref') {
      parser.pos += 4;
      for (;;) {
        parser.skip();
        const word = parser.token();
        if (word === 'trailer') {
          const trailer = parser.value();
          return trailer instanceof PdfDict ? trailer : null;
        }
        if (!/^\d+$/.test(word)) return null;
        parser.skip();
        const count = Number(parser.token());
        if (!Number.isFinite(count)) return null;
        for (let i = 0; i < count; i++) {
          parser.skip();
          const off = Number(parser.token());
          parser.skip();
          parser.token(); // geração
          parser.skip();
          const kind = parser.token();
          const num = Number(word) + i;
          if (kind === 'n' && !this.entries.has(num) && off > 0) this.addEntry(num, { type: 1, offset: off });
          else if (kind === 'f' && !this.entries.has(num)) this.entries.set(num, { type: 0 });
        }
      }
    }
    // Tabela em stream (PDF 1.5+)
    const object = this.parseObjectAt(offset);
    if (!(object?.value instanceof PdfStream) || !isName(object.value.dict.get('Type'), 'XRef')) return null;
    const { dict } = object.value;
    const data = await this.decode(object.value);
    const widths = dict.get('W');
    if (!Array.isArray(widths) || widths.length < 3) return null;
    const [w0, w1, w2] = widths;
    const size = dict.get('Size') ?? 0;
    const index = dict.get('Index') ?? [0, size];
    const rowLength = w0 + w1 + w2;
    const field = (pos, width) => {
      let value = 0;
      for (let i = 0; i < width; i++) value = value * 256 + data[pos + i];
      return value;
    };
    let pos = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      for (let i = 0; i < index[s + 1] && pos + rowLength <= data.length; i++, pos += rowLength) {
        const num = index[s] + i;
        const type = w0 ? field(pos, w0) : 1;
        const a = field(pos + w0, w1);
        const b = field(pos + w0 + w1, w2);
        if (this.entries.has(num)) continue;
        if (type === 1) this.addEntry(num, { type: 1, offset: a });
        else if (type === 2) this.addEntry(num, { type: 2, stream: a, index: b });
        else this.entries.set(num, { type: 0 });
      }
    }
    return dict;
  }

  addEntry(num, entry) {
    if (this.entries.size >= this.limits.maxObjects) throw new PdfError('O PDF tem objetos demais.');
    this.entries.set(num, entry);
  }

  // Xref quebrada: procura "n g obj" no arquivo inteiro. O último de cada número vence (atualizações).
  async rebuild() {
    const text = latin1(this.bytes, 0, this.bytes.length);
    const pattern = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g;
    for (let m; (m = pattern.exec(text));) {
      const offset = m.index + m[0].indexOf(m[1]);
      this.addEntry(Number(m[1]), { type: 1, offset });
    }
    // Objetos dentro de object streams
    for (const [num, entry] of [...this.entries]) {
      const value = this.parseObjectAt(entry.offset)?.value;
      if (value instanceof PdfStream && isName(value.dict.get('Type'), 'ObjStm')) {
        const objects = await this.loadObjectStream(num, value);
        for (const inner of objects.keys()) if (!this.entries.has(inner)) this.addEntry(inner, { type: 2, stream: num });
      }
    }
    // Trailer: o último "trailer" do arquivo, ou o catálogo achado na varredura.
    const trailers = [...text.matchAll(/trailer\s*<</g)];
    for (const m of trailers.reverse()) {
      try {
        const dict = new Parser(this.bytes, m.index + 7).value();
        if (dict instanceof PdfDict && dict.get('Root') instanceof PdfRef) { this.trailer = dict; break; }
      } catch { /* tenta o anterior */ }
    }
    if (!this.catalog()) {
      for (const num of this.entries.keys()) {
        const value = this.object(num);
        if (value instanceof PdfDict && isName(value.get('Type'), 'Catalog')) {
          this.trailer = new PdfDict([['Root', new PdfRef(num, 0)]]);
          break;
        }
      }
    }
  }

  parseObjectAt(offset) {
    try {
      const parser = new Parser(this.bytes, offset);
      const num = parser.value();
      const gen = parser.value();
      const keyword = parser.value();
      if (typeof num !== 'number' || typeof gen !== 'number' || !(keyword instanceof Keyword) || keyword.value !== 'obj') return null;
      const value = parser.value();
      if (value instanceof PdfDict) {
        const save = parser.pos;
        parser.skip();
        if (latin1(this.bytes, parser.pos, parser.pos + 6) === 'stream') {
          return { num, value: this.readStream(value, parser.pos + 6) };
        }
        parser.pos = save;
      }
      return { num, value };
    } catch {
      return null;
    }
  }

  readStream(dict, pos) {
    const { bytes } = this;
    if (bytes[pos] === 13) pos++;
    if (bytes[pos] === 10) pos++;
    let length = dict.get('Length');
    if (length instanceof PdfRef) length = this.resolve(length);
    const fits = (end) => latin1(bytes, end, Math.min(bytes.length, end + 12)).trimStart().startsWith('endstream');
    if (typeof length !== 'number' || length < 0 || pos + length > bytes.length || !fits(pos + length)) {
      // /Length errado ou ausente: procura o "endstream".
      const text = latin1(bytes, pos, Math.min(bytes.length, pos + 256 * 1024 * 1024));
      const end = text.indexOf('endstream');
      if (end < 0) throw new PdfError('Stream sem fim.');
      length = end;
      while (length > 0 && (bytes[pos + length - 1] === 10 || bytes[pos + length - 1] === 13)) length--;
    }
    return new PdfStream(dict, bytes.subarray(pos, pos + length));
  }

  // Dados de um stream de estrutura (xref ou object stream) descompactados.
  async decode(stream) {
    let filters = stream.dict.get('Filter');
    let params = stream.dict.get('DecodeParms');
    if (filters instanceof PdfName) { filters = [filters]; params = [params]; }
    let data = stream.data;
    for (const [i, filter] of (filters ?? []).entries()) {
      if (!isName(filter, 'FlateDecode')) throw new PdfError(`Filtro não suportado na estrutura do PDF: ${filter?.value}`);
      const limit = Math.min(this.limits.maxStreamSize, this.limits.maxTotalSize - this.decoded);
      data = await inflate(data, 'deflate', limit, { lenient: true });
      this.decoded += data.length;
      const param = this.resolve(Array.isArray(params) ? params[i] : params);
      data = unpredict(data, param instanceof PdfDict ? param : null);
    }
    return data;
  }

  async loadObjectStream(num, stream) {
    if (this.objectStreams.has(num)) return this.objectStreams.get(num);
    const objects = new Map();
    this.objectStreams.set(num, objects);
    const data = await this.decode(stream);
    const count = stream.dict.get('N') ?? 0;
    const first = stream.dict.get('First') ?? 0;
    const parser = new Parser(data);
    const offsets = [];
    for (let i = 0; i < count; i++) offsets.push([parser.value(), parser.value()]);
    for (const [objNum, offset] of offsets) {
      if (typeof objNum !== 'number' || typeof offset !== 'number') continue;
      try {
        objects.set(objNum, new Parser(data, first + offset).value());
      } catch { /* objeto quebrado: fica null */ }
    }
    return objects;
  }

  // Carrega antes, de forma assíncrona, os object streams usados (o resto da leitura é síncrono).
  async preloadObjectStreams() {
    const streams = new Set([...this.entries.values()].filter((entry) => entry.type === 2).map((entry) => entry.stream));
    for (const num of streams) {
      const entry = this.entries.get(num);
      const value = entry?.type === 1 ? this.parseObjectAt(entry.offset)?.value : null;
      if (value instanceof PdfStream) await this.loadObjectStream(num, value);
    }
  }

  object(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const entry = this.entries.get(num);
    let value = null;
    if (entry?.type === 1) {
      const parsed = this.parseObjectAt(entry.offset);
      value = parsed && parsed.num === num ? parsed.value : null;
    } else if (entry?.type === 2) {
      value = this.objectStreams.get(entry.stream)?.get(num) ?? null;
    }
    this.cache.set(num, value);
    return value;
  }

  resolve(value, depth = 0) {
    while (value instanceof PdfRef && depth++ < 32) value = this.object(value.num);
    return value instanceof PdfRef ? null : value;
  }

  catalog() {
    const root = this.resolve(this.trailer.get('Root'));
    return root instanceof PdfDict && this.resolve(root.get('Pages')) instanceof PdfDict ? root : null;
  }

  // Árvore de páginas, com Resources, MediaBox, CropBox e Rotate herdados dos nós de cima.
  readPages() {
    const pages = [];
    const seen = new Set();
    const walk = (ref, inherited, depth) => {
      if (depth > 64 || pages.length >= this.limits.maxPages) {
        if (pages.length >= this.limits.maxPages) throw new PdfError(`O PDF passa de ${this.limits.maxPages} páginas.`);
        return;
      }
      if (ref instanceof PdfRef) {
        if (seen.has(ref.num)) return;
        seen.add(ref.num);
      }
      const node = this.resolve(ref);
      if (!(node instanceof PdfDict)) return;
      const attrs = { ...inherited };
      for (const key of INHERITED) if (node.has(key)) attrs[key] = node.get(key);
      const kids = this.resolve(node.get('Kids'));
      if (Array.isArray(kids) && !isName(node.get('Type'), 'Page')) {
        for (const kid of kids) walk(kid, attrs, depth + 1);
      } else {
        pages.push(this.pageInfo(node, attrs));
      }
    };
    walk(this.catalog().get('Pages'), {}, 0);
    return pages;
  }

  box(value) {
    const box = this.resolve(value);
    if (!Array.isArray(box) || box.length !== 4) return null;
    const n = box.map((v) => this.resolve(v));
    if (!n.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    return [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
  }

  pageInfo(node, attrs) {
    const media = this.box(attrs.MediaBox) ?? A4_BOX;
    let crop = this.box(attrs.CropBox);
    if (crop) crop = [Math.max(crop[0], media[0]), Math.max(crop[1], media[1]), Math.min(crop[2], media[2]), Math.min(crop[3], media[3])];
    if (!crop || crop[2] - crop[0] <= 0 || crop[3] - crop[1] <= 0) crop = media;
    const rotate = ((Math.round((this.resolve(attrs.Rotate) ?? 0) / 90) * 90) % 360 + 360) % 360;
    const width = crop[2] - crop[0];
    const height = crop[3] - crop[1];
    const sideways = rotate % 180 !== 0;
    return {
      node, attrs, media, crop: crop === media ? null : crop, rotate,
      width: sideways ? height : width,
      height: sideways ? width : height,
    };
  }

  // PDF assinado digitalmente (gov.br, ICP-Brasil): a assinatura não sobrevive a juntar ou dividir.
  isSigned() {
    const form = this.resolve(this.catalog().get('AcroForm'));
    if (!(form instanceof PdfDict)) return false;
    if ((this.resolve(form.get('SigFlags')) ?? 0) & 1) return true;
    const seen = new Set();
    const stack = [...(this.resolve(form.get('Fields')) ?? [])];
    while (stack.length && seen.size < 10000) {
      const ref = stack.pop();
      if (ref instanceof PdfRef) {
        if (seen.has(ref.num)) continue;
        seen.add(ref.num);
      }
      const field = this.resolve(ref);
      if (!(field instanceof PdfDict)) continue;
      if (isName(this.resolve(field.get('FT')), 'Sig') && field.get('V') != null) return true;
      const kids = this.resolve(field.get('Kids'));
      if (Array.isArray(kids)) stack.push(...kids);
    }
    return false;
  }

  // Páginas com links, comentários ou campos de formulário (que não vão para o PDF novo).
  hasAnnotations() {
    return this.pages.some((page) => {
      const annots = this.resolve(page.node.get('Annots'));
      return Array.isArray(annots) && annots.length > 0;
    });
  }
}

// ---------- Cópia de páginas ----------

// Aparências visíveis das anotações de uma página, já posicionadas: [{stream, matrix}].
// matrix leva a caixa da aparência (BBox, transformada pela Matrix dela) até o retângulo da anotação (Rect).
function flattenAnnotations(doc, page) {
  const annots = doc.resolve(page.node.get('Annots'));
  if (!Array.isArray(annots)) return [];
  const out = [];
  for (const ref of annots.slice(0, 2000)) {
    const annot = doc.resolve(ref);
    if (!(annot instanceof PdfDict)) continue;
    const flags = doc.resolve(annot.get('F')) ?? 0;
    const subtype = doc.resolve(annot.get('Subtype'));
    if (flags & (2 | 32) || isName(subtype, 'Popup') || isName(subtype, 'Link')) continue; // oculta, sem exibição, ou só clique
    let appearance = doc.resolve(doc.resolve(annot.get('AP'))?.get?.('N'));
    if (appearance instanceof PdfDict) { // um estado por valor (caixa de seleção marcada ou não)
      const state = doc.resolve(annot.get('AS'));
      appearance = state instanceof PdfName ? doc.resolve(appearance.get(state.value)) : null;
    }
    if (!(appearance instanceof PdfStream)) continue;
    const rect = doc.box(annot.get('Rect'));
    const bbox = doc.box(appearance.dict.get('BBox'));
    if (!rect || !bbox) continue;
    const m = doc.resolve(appearance.dict.get('Matrix'));
    const [a, b, c, d, e, f] = Array.isArray(m) && m.length === 6 && m.every((v) => typeof v === 'number') ? m : [1, 0, 0, 1, 0, 0];
    const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]]
      .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (box[2] - box[0] <= 0 || box[3] - box[1] <= 0) continue;
    const sx = (rect[2] - rect[0]) / (box[2] - box[0]);
    const sy = (rect[3] - rect[1]) / (box[3] - box[1]);
    // Aparência sem /Subtype /Form não pode ser desenhada com Do: completa o dicionário.
    const dict = new PdfDict(appearance.dict);
    dict.set('Type', new PdfName('XObject'));
    dict.set('Subtype', new PdfName('Form'));
    out.push({ stream: new PdfStream(dict, appearance.data), matrix: [sx, 0, 0, sy, rect[0] - box[0] * sx, rect[1] - box[1] * sy] });
  }
  return out;
}

// Chaves que não vão para o PDF novo, em qualquer objeto copiado: metadados, ações e estrutura.
const DROPPED_KEYS = new Set(['Metadata', 'PieceInfo', 'AA', 'OpenAction', 'JS', 'JavaScript', 'StructParent', 'StructParents', 'Parent', 'Annots', 'B', 'Thumb', 'OCProperties']);

function formatNumber(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(6)));
}

function formatName(name) {
  let out = '/';
  for (const char of name) {
    const code = char.charCodeAt(0);
    out += code < 0x21 || code > 0x7e || code === 0x23 || DELIMITERS.has(code) ? `#${code.toString(16).padStart(2, '0')}` : char;
  }
  return out;
}

function formatString(bytes) {
  let out = '<';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return `${out}>`;
}

/**
 * Copia páginas de um PDF aberto, com tudo o que elas usam (conteúdo, fontes, imagens), renumerando os objetos.
 * Objetos compartilhados entre as páginas (uma fonte usada em todas, por exemplo) são copiados uma vez só.
 * @param {PdfDocument} doc
 * @param {number[]} indices posições das páginas (a partir de 0)
 * Anotações (links, comentários, campos de formulário) não são copiadas como anotações: o que elas mostram
 * (o valor preenchido num campo, um carimbo, o selo de uma assinatura) é desenhado na própria página.
 * Assim o PDF novo fica igual ao que se via, mas sem nada clicável nem editável.
 * @returns {{objects: Array<Array<string | Uint8Array | {ref: number}>>, pages: Map<number, object>}}
 *   objects: cada objeto como uma lista de partes; {ref: i} aponta para objects[i].
 *   pages: por página, {mediaBox, cropBox, rotate, resources, contents, group}, também em partes.
 */
export function copyPages(doc, indices) {
  const objects = [];
  const local = new Map(); // num no PDF de origem → posição em objects
  const queue = [];

  // Objeto novo, que não existe no PDF de origem.
  function add(value) {
    const index = objects.push(null) - 1;
    objects[index] = write(value, [], true);
    return { ref: index };
  }

  const refTo = (ref) => {
    if (!local.has(ref.num)) {
      local.set(ref.num, objects.length);
      objects.push(null);
      queue.push(ref.num);
    }
    return { ref: local.get(ref.num) };
  };

  // Valor → partes. Referência a objeto que não existe vira null. Stream só existe como objeto próprio:
  // um stream novo dentro de outro valor (top = false) vira um objeto à parte, e no lugar fica a referência.
  function write(value, out, top = false) {
    if (value instanceof PdfRef) {
      if (doc.resolve(value) === null) out.push('null');
      else out.push(refTo(value));
    } else if (value instanceof PdfName) out.push(formatName(value.value));
    else if (value instanceof PdfString) out.push(formatString(value.bytes));
    else if (typeof value === 'number') out.push(formatNumber(value));
    else if (typeof value === 'boolean') out.push(String(value));
    else if (value === null || value === undefined || value instanceof Keyword) out.push('null');
    else if (Array.isArray(value)) {
      out.push('[');
      value.forEach((item, i) => { if (i) out.push(' '); write(item, out); });
      out.push(']');
    } else if (value instanceof PdfDict) {
      out.push('<<');
      for (const [key, item] of value) {
        if (DROPPED_KEYS.has(key)) continue;
        out.push(formatName(key), ' ');
        write(item, out);
        out.push(' ');
      }
      out.push('>>');
    } else if (value instanceof PdfStream) {
      if (!top) {
        out.push(add(value));
        return out;
      }
      const dict = new PdfDict(value.dict);
      dict.set('Length', value.data.length);
      dict.delete('DL');
      write(dict, out);
      out.push('\nstream\n', value.data, '\nendstream');
    }
    return out;
  }


  const pages = new Map();
  for (const index of indices) {
    const page = doc.pages[index];
    const group = page.node.get('Group');
    const appearances = flattenAnnotations(doc, page);
    let resources = page.attrs.Resources ?? new PdfDict();
    let contents = page.node.has('Contents') ? write(page.node.get('Contents'), []) : null;

    if (appearances.length) {
      // Recursos: cópia só desta página, com as aparências como XObjects /Annot0, /Annot1…
      const own = new PdfDict(doc.resolve(resources) instanceof PdfDict ? doc.resolve(resources) : []);
      const xobjects = new PdfDict(doc.resolve(own.get('XObject')) instanceof PdfDict ? doc.resolve(own.get('XObject')) : []);
      let ops = 'Q';
      appearances.forEach(({ stream, matrix }, i) => {
        xobjects.set(`Annot${i}`, stream);
        ops += `
q ${matrix.map(formatNumber).join(' ')} cm /Annot${i} Do Q`;
      });
      own.set('XObject', xobjects);
      resources = own;
      // O conteúdo original fica entre q e Q: o que ele mudar no estado gráfico não afeta as aparências.
      const original = doc.resolve(page.node.get('Contents'));
      const list = Array.isArray(original) ? page.node.get('Contents') : contents ? [page.node.get('Contents')] : [];
      const before = add(new PdfStream(new PdfDict(), new TextEncoder().encode('q')));
      const after = add(new PdfStream(new PdfDict(), new TextEncoder().encode(ops)));
      contents = ['[', before];
      for (const item of Array.isArray(list) ? list : []) contents.push(' ', ...write(item, []));
      contents.push(' ', after, ']');
    }

    pages.set(index, {
      mediaBox: page.media,
      cropBox: page.crop,
      rotate: page.rotate,
      resources: write(resources, []),
      contents,
      group: group ? write(group, []) : null,
      userUnit: doc.resolve(page.node.get('UserUnit')) ?? null,
    });
  }
  while (queue.length) {
    const num = queue.shift();
    objects[local.get(num)] = write(doc.object(num), [], true);
  }
  return { objects, pages };
}
