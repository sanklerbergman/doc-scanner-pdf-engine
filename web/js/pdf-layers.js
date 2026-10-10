// Camadas de um PDF (conteúdo opcional, "OCG"): partes da página que o autor pode mostrar ou esconder, como
// anotações internas ou rascunhos. A tabela de camadas fica no catálogo (/OCProperties), que não vai para o
// PDF novo; sem ela, qualquer leitor mostraria tudo, inclusive o que estava escondido.
//
// Por isso, ao abrir um PDF com camadas, o conteúdo das camadas ocultas sai das páginas: texto, imagens e
// desenhos. O que muda o estado gráfico (posição, cor, recorte) continua, para o resto da página ficar no
// mesmo lugar. Quando não dá para garantir isso, o PDF é recusado, em vez de mostrar o que estava oculto.
//
// Importa do pdf-reader.js, que importa este arquivo de volta: os dois só se usam dentro das funções.
import { Parser, Keyword, PdfDict, PdfName, PdfRef, PdfStream, PdfError, isName } from './pdf-reader.js';

const MAX_DEPTH = 32;
const MAX_STREAMS = 20000;
const REFUSED = 'Este PDF tem camadas ocultas que o app não consegue separar com segurança';

const encoder = new TextEncoder();
const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);

// Desenho de caminho (vira "n": termina o caminho sem pintar, e um recorte com W continua valendo).
const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
// Mudam a posição do texto para um ponto que não depende do texto mostrado antes.
const MOVE = new Set(['BT', 'ET', 'Td', 'TD', 'T*', 'Tm', "'", '"']);

const names = (value, fallback) => {
  if (value instanceof PdfName) return [value.value];
  if (Array.isArray(value)) return value.filter((item) => item instanceof PdfName).map((item) => item.value);
  return fallback;
};

/**
 * Visibilidade das camadas como um leitor de PDF mostra na tela (configuração padrão /D).
 * @returns {((oc: unknown) => boolean) | null} null quando o PDF não tem camadas
 */
function visibility(doc) {
  const props = doc.resolve(doc.catalog().get('OCProperties'));
  if (!(props instanceof PdfDict)) return null;
  let config = doc.resolve(props.get('D'));
  if (!(config instanceof PdfDict)) config = new PdfDict();
  const refs = (value) => {
    const list = doc.resolve(value);
    return Array.isArray(list) ? list.filter((item) => item instanceof PdfRef) : [];
  };

  const base = !isName(doc.resolve(config.get('BaseState')), 'OFF');
  const state = new Map(); // número do OCG → visível
  for (const ref of refs(props.get('OCGs'))) state.set(ref.num, base);
  for (const ref of refs(config.get('ON'))) state.set(ref.num, true);
  for (const ref of refs(config.get('OFF'))) state.set(ref.num, false);
  // /AS: estado automático na tela (evento View, categoria View), pelo /Usage /View /ViewState de cada camada.
  const autos = doc.resolve(config.get('AS'));
  for (const item of Array.isArray(autos) ? autos : []) {
    const auto = doc.resolve(item);
    if (!(auto instanceof PdfDict) || !isName(doc.resolve(auto.get('Event')), 'View')) continue;
    if (!names(doc.resolve(auto.get('Category')), []).includes('View')) continue;
    for (const ref of refs(auto.get('OCGs'))) {
      const view = doc.resolve(doc.resolve(doc.resolve(ref)?.get?.('Usage'))?.get?.('View'));
      const viewState = view instanceof PdfDict ? doc.resolve(view.get('ViewState')) : null;
      if (isName(viewState, 'ON')) state.set(ref.num, true);
      if (isName(viewState, 'OFF')) state.set(ref.num, false);
    }
  }
  const intents = names(doc.resolve(config.get('Intent')), ['View']);

  function visible(oc, depth = 0) {
    if (depth > MAX_DEPTH) throw new PdfError(`${REFUSED} (camadas aninhadas demais).`);
    const dict = doc.resolve(oc);
    // Referência quebrada ou tipo desconhecido: os leitores mostram o conteúdo, e o app também.
    if (!(dict instanceof PdfDict)) return true;
    const type = doc.resolve(dict.get('Type'));
    if (isName(type, 'OCG')) {
      // Camada de outra finalidade (ex.: /Design numa configuração /View) não esconde nada na tela.
      const own = names(doc.resolve(dict.get('Intent')), ['View']);
      if (!intents.includes('All') && !own.some((intent) => intents.includes(intent))) return true;
      return oc instanceof PdfRef ? state.get(oc.num) ?? true : true;
    }
    if (!isName(type, 'OCMD')) return true;
    const expression = doc.resolve(dict.get('VE'));
    if (Array.isArray(expression)) return evaluate(expression, depth + 1);
    const groups = doc.resolve(dict.get('OCGs'));
    const list = (Array.isArray(groups) ? groups : groups ? [dict.get('OCGs')] : [])
      .filter((group) => doc.resolve(group) instanceof PdfDict)
      .map((group) => visible(group, depth + 1));
    if (!list.length) return true;
    const policy = doc.resolve(dict.get('P'))?.value ?? 'AnyOn';
    if (policy === 'AllOn') return list.every(Boolean);
    if (policy === 'AnyOn') return list.some(Boolean);
    if (policy === 'AnyOff') return list.some((on) => !on);
    if (policy === 'AllOff') return list.every((on) => !on);
    throw new PdfError(`${REFUSED} (regra de camada desconhecida).`);
  }

  // Expressão de visibilidade (/VE): [/And ...], [/Or ...] ou [/Not x], com camadas ou outras expressões.
  function evaluate(expression, depth) {
    if (depth > MAX_DEPTH) throw new PdfError(`${REFUSED} (camadas aninhadas demais).`);
    const [operator, ...args] = expression;
    const value = (arg) => {
      const resolved = doc.resolve(arg);
      return Array.isArray(resolved) ? evaluate(resolved, depth + 1) : visible(arg, depth + 1);
    };
    if (isName(operator, 'Not') && args.length === 1) return !value(args[0]);
    if (isName(operator, 'And') && args.length) return args.every(value);
    if (isName(operator, 'Or') && args.length) return args.some(value);
    throw new PdfError(`${REFUSED} (expressão de camada inválida).`);
  }

  return visible;
}

// Fim dos dados de uma imagem embutida (BI ... ID dados EI): "EI" entre espaços.
function inlineImageEnd(data, from) {
  for (let i = from; i + 1 < data.length; i++) {
    if (data[i] === 0x45 && data[i + 1] === 0x49 && WHITESPACE.has(data[i - 1])
      && (i + 2 === data.length || WHITESPACE.has(data[i + 2]))) return i + 2;
  }
  return -1;
}

const formatNumber = (n) => (typeof n === 'number' ? String(Number(n.toFixed(6))) : '0');

const NEWLINE = Uint8Array.of(10);

// Junta pedaços de bytes, com um separador entre eles.
function concat(parts, separator) {
  const all = parts.flatMap((part, i) => (i ? [separator, part] : [part]));
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let pos = 0;
  for (const part of all) { out.set(part, pos); pos += part.length; }
  return out;
}

/**
 * Tira de um conteúdo (página, formulário, padrão ou aparência) o que está em camadas ocultas.
 * Marcas de camada (/OC /nome BDC) viram /OC BMC, para nenhuma referência à camada ir para o PDF novo.
 * @param {Set<PdfStream>} drawn recebe as imagens e formulários que o conteúdo visível desenha
 * @returns {{data: Uint8Array, removed: boolean} | null} null quando nada muda; removed: algo oculto saiu
 */
function rewrite(doc, data, resources, visible, drawn) {
  const lookup = (category, name) => {
    const map = doc.resolve(doc.resolve(resources)?.get?.(category));
    return map instanceof PdfDict && name instanceof PdfName ? map.get(name.value) : undefined;
  };
  const parser = new Parser(data);
  const read = () => {
    try {
      return parser.value();
    } catch {
      throw new PdfError(`${REFUSED} (conteúdo da página mal formado).`);
    }
  };
  const out = [];
  const marked = []; // conteúdo marcado aberto: o valor de "hidden" de fora de cada um
  const textMode = [0]; // modo de renderização do texto (Tr), salvo e restaurado por q/Q
  let operands = [];
  let start = 0;
  let hidden = false;
  let changed = false;
  let removed = false;
  let lost = false; // texto oculto tirado no meio de uma linha: o próximo texto da linha perderia a posição

  for (;;) {
    parser.skip();
    if (parser.pos >= data.length) break;
    if (!operands.length) start = parser.pos;
    const value = read();
    if (!(value instanceof Keyword)) {
      operands.push(value);
      continue;
    }
    const op = value.value;
    const keep = () => out.push(data.subarray(start, parser.pos));
    const retag = (text) => { out.push(encoder.encode(text)); changed = true; };
    const replace = (text) => { retag(text); removed = true; };
    const drop = () => { changed = removed = true; };

    if (op === 'BI') {
      for (let n = 0; ; n++) { // dicionário da imagem até o ID
        parser.skip();
        if (parser.pos >= data.length || n > 1000) throw new PdfError(`${REFUSED} (imagem embutida sem fim).`);
        const item = read();
        if (item instanceof Keyword && item.value === 'ID') break;
      }
      const end = inlineImageEnd(data, parser.pos + 1);
      if (end < 0) throw new PdfError(`${REFUSED} (imagem embutida sem fim).`);
      parser.pos = end;
      if (hidden) drop(); else keep();
    } else if (op === 'BDC' && isName(operands[0], 'OC')) {
      const target = operands[1] instanceof PdfName ? lookup('Properties', operands[1]) : operands[1];
      marked.push(hidden);
      hidden = hidden || !visible(target);
      retag('/OC BMC');
    } else if (op === 'BDC' || op === 'BMC') {
      marked.push(hidden);
      keep();
    } else if (op === 'EMC') {
      if (marked.length) hidden = marked.pop(); // EMC sobrando: os leitores ignoram
      keep();
    } else if (op === 'q') {
      textMode.push(textMode.at(-1));
      keep();
    } else if (op === 'Q') {
      if (textMode.length > 1) textMode.pop();
      keep();
    } else if (op === 'Tr') {
      textMode[textMode.length - 1] = typeof operands[0] === 'number' ? operands[0] : 0;
      keep();
    } else if (op === 'Do') {
      const xobject = doc.resolve(lookup('XObject', operands[0]));
      const ownLayer = xobject instanceof PdfStream && xobject.dict.has('OC') && !visible(xobject.dict.get('OC'));
      if (hidden || ownLayer) {
        drop();
      } else {
        if (xobject instanceof PdfStream) drawn.add(xobject);
        keep();
      }
    } else if (!hidden) {
      if ((op === 'Tj' || op === 'TJ') && lost) {
        throw new PdfError(`${REFUSED} (um texto visível continua na mesma linha de um texto oculto).`);
      }
      if (MOVE.has(op)) lost = false;
      keep();
    } else if (PAINT.has(op)) {
      replace('n');
    } else if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
      // Texto que recorta (Tr 4 a 7) muda o que aparece depois: não dá para tirar sem mudar a página.
      if (textMode.at(-1) >= 4) throw new PdfError(`${REFUSED} (texto oculto usado como recorte).`);
      if (op === "'") replace('T*');
      else if (op === '"') replace(`${formatNumber(operands[0])} Tw ${formatNumber(operands[1])} Tc T*`);
      else drop();
      lost = true;
    } else if (op === 'sh') {
      drop();
    } else {
      if (MOVE.has(op)) lost = false;
      keep();
    }
    operands = [];
  }
  return changed ? { data: concat(out, NEWLINE), removed } : null;
}

async function deflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Stream novo, compactado, com o dicionário do original (sem os filtros dele).
async function newStream(dict, data) {
  const copy = new PdfDict(dict);
  for (const key of ['Filter', 'DecodeParms', 'DL', 'Length']) copy.delete(key);
  copy.set('Filter', new PdfName('FlateDecode'));
  return new PdfStream(copy, await deflate(data));
}

/**
 * Prepara a cópia de um PDF com camadas: conteúdos refeitos sem as camadas ocultas.
 * Deixa em doc.layers o que o copyPages usa:
 * - contents: conteúdo novo de cada página que mudou (os streams dela viram um só);
 * - streams: formulários, padrões e aparências que mudaram (o original → o novo);
 * - isHidden: se uma camada (/OC de uma anotação) está oculta;
 * - drawn: imagens e formulários que o conteúdo visível desenha. Os outros saem dos recursos, para uma imagem
 *   desenhada só numa camada oculta não ir junto no arquivo;
 * - removed: se alguma coisa foi tirada (para avisar a pessoa).
 */
export async function prepareLayers(doc) {
  const visible = visibility(doc);
  if (!visible) return;
  const layers = {
    contents: new Map(), streams: new Map(), drawn: new Set(), isHidden: (oc) => oc != null && !visible(oc), removed: false,
  };
  const done = new Map(); // stream → {resources, data}: o mesmo stream pode ser alcançado por vários caminhos
  const queue = [];

  const decode = async (stream) => {
    try {
      return await doc.decode(stream);
    } catch (err) {
      if (err instanceof PdfError) throw new PdfError(`${REFUSED} (conteúdo compactado num formato que o app não lê).`);
      throw err;
    }
  };

  // Formulários, padrões, máscaras e fontes Type3 usados por um conteúdo: têm conteúdo próprio, com camadas também.
  const visit = (resources) => {
    const dict = doc.resolve(resources);
    if (!(dict instanceof PdfDict)) return;
    const each = (category, fn) => {
      const map = doc.resolve(dict.get(category));
      if (map instanceof PdfDict) for (const item of map.values()) fn(doc.resolve(item));
    };
    each('XObject', (item) => {
      if (item instanceof PdfStream && isName(doc.resolve(item.dict.get('Subtype')), 'Form')) queue.push([item, resources]);
    });
    each('Pattern', (item) => {
      if (item instanceof PdfStream && doc.resolve(item.dict.get('PatternType')) === 1) queue.push([item, resources]);
    });
    each('ExtGState', (item) => {
      const group = doc.resolve(doc.resolve(item?.get?.('SMask'))?.get?.('G'));
      if (group instanceof PdfStream) queue.push([group, resources]);
    });
    each('Font', (font) => {
      if (!(font instanceof PdfDict) || !isName(doc.resolve(font.get('Subtype')), 'Type3')) return;
      const procs = doc.resolve(font.get('CharProcs'));
      if (!(procs instanceof PdfDict)) return;
      for (const proc of procs.values()) {
        const stream = doc.resolve(proc);
        if (stream instanceof PdfStream) queue.push([stream, font.get('Resources') ?? resources]);
      }
    });
  };

  // Conteúdos da fila (formulários, padrões, aparências), cada um uma vez só.
  let count = 0;
  const drain = async () => {
    while (queue.length) {
      const [stream, inherited] = queue.pop();
      const resources = stream.dict.get('Resources') ?? inherited;
      const seen = done.get(stream);
      if (seen && (seen.resources === resources || stream.dict.has('Resources'))) continue;
      if (++count > MAX_STREAMS) throw new PdfError(`${REFUSED} (conteúdos demais).`);
      const result = rewrite(doc, await decode(stream), resources, visible, layers.drawn);
      if (seen) {
        // Formulário sem recursos próprios, usado em lugares com recursos diferentes: o resultado tem que bater.
        const same = (a, b) => a === b || (a && b && a.length === b.length && a.every((byte, i) => byte === b[i]));
        if (!same(seen.data, result?.data ?? null)) throw new PdfError(`${REFUSED} (formulário com recursos diferentes).`);
        continue;
      }
      done.set(stream, { resources, data: result?.data ?? null });
      if (result) {
        layers.streams.set(stream, await newStream(stream.dict, result.data));
        layers.removed ||= result.removed;
      }
      visit(resources);
    }
  };

  for (const [index, page] of doc.pages.entries()) {
    const resources = page.attrs.Resources;
    const list = doc.resolve(page.node.get('Contents'));
    const parts = [];
    for (const ref of Array.isArray(list) ? list : list ? [page.node.get('Contents')] : []) {
      const stream = doc.resolve(ref);
      if (stream instanceof PdfStream) parts.push(await decode(stream));
    }
    const result = rewrite(doc, concat(parts, NEWLINE), resources, visible, layers.drawn);
    if (result) {
      layers.contents.set(index, await newStream(new PdfDict(), result.data));
      layers.removed ||= result.removed;
    }
    visit(resources);
    // Aparências das anotações, que o copyPages desenha na página.
    for (const ref of doc.resolve(page.node.get('Annots')) ?? []) {
      const annot = doc.resolve(ref);
      if (!(annot instanceof PdfDict) || layers.isHidden(annot.get('OC'))) continue;
      let appearance = doc.resolve(doc.resolve(annot.get('AP'))?.get?.('N'));
      if (appearance instanceof PdfDict) {
        const state = doc.resolve(annot.get('AS'));
        appearance = state instanceof PdfName ? doc.resolve(appearance.get(state.value)) : null;
      }
      if (appearance instanceof PdfStream) queue.push([appearance, resources]);
    }
    await drain();
  }

  doc.layers = layers;
}
