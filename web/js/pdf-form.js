// Formulários de PDF (#15): os campos (AcroForm), lidos pelo leitor do app, e o valor de cada um desenhado como a
// aparência do widget, fixa na página do PDF novo (copyPages, opção fill). O PDF novo não leva campo nenhum: nem o
// /AcroForm, nem o /V, nem a aparência antiga do campo preenchido.
// Lógica pura, sem DOM: o app carrega este módulo só quando o PDF tem campos (pdf-open.js); os testes, no Node.
// Segurança: nenhum script do PDF roda. As ações (/AA) ficam guardadas como texto, para os formatos do Acrobat serem
// reconhecidos sem executar nada; a aparência do texto (/DA) é lida pelo Parser do leitor.
// Os valores ficam só na memória da aba, no formulário de cada PDF aberto (doc.form), e somem com ele.
import { Parser, PdfDict, PdfName, PdfRef, PdfStream, PdfString, Keyword, isName, textString } from './pdf-reader.js';
import { textWidth, winAnsiCode, pdfFont } from './fonts.js';
import { editType, circlePath, pathOps, pdfNumber, pageMatrix } from './edits.js';
import './edit-shapes.js'; // ✓ e ✗ (os caminhos da v4.0.0)
import { readFieldFormat, formatFieldValue, fieldInputHints } from './pdf-form-format.js';

const encoder = new TextEncoder();

// Opções do campo (/Ff, ISO 32000-1, 12.7.3.1 e 12.7.4): o bit n vale 2^(n-1).
const bit = (n) => 2 ** (n - 1);
const FF = {
  readOnly: bit(1), required: bit(2), multiline: bit(13), password: bit(14), radio: bit(16), pushButton: bit(17),
  combo: bit(18), edit: bit(19), file: bit(21), multiSelect: bit(22), comb: bit(25),
};
const HIDDEN = 2 | 32; // widget oculto (/F 2) ou que não aparece na tela (/F 32)

const MIN_SIZE = 6; // texto que não cabe: a letra diminui até aqui; se ainda não couber, sai cortado
// PDF malicioso: /MaxLen absurdo não vira um maxlength inválido no controle nem um pente de bilhões de casas. O pente
// tem até 1000 casas, de 1 pt ou mais; fora disso, o campo é desenhado como uma linha.
const MAX_LENGTH = 100000;
const MAX_COMB = 1000;
const MIN_CELL = 1;
const MAX_NEARBY = 300; // letras de cada trecho do texto da página considerado para o rótulo
const LINE = 1.35; // entrelinha, em tamanhos de letra (a mesma do PDF.js)
const MULTILINE_AUTO = 12; // tamanho 0 em várias linhas: a maior letra até esta em que tudo cabe
const PAD = 2; // folga do texto até a borda, em pontos
const ASCENT = 0.72; // altura das maiúsculas e descida, em tamanhos de letra: o texto fica centrado entre as duas
const DESCENT = 0.21;
const HIGHLIGHT = '0.6 0.75 0.86 rg'; // opção escolhida na lista, como no Acrobat

// ---------- Leitura ----------

/**
 * Lê o formulário de um PDF aberto (pdf-reader.js), com o caminhamento do leitor (formFields).
 * Mesmo nome é o mesmo campo, mesmo em várias páginas. Fica de fora o widget que não está no /Annots de nenhuma página,
 * o oculto e o botão de ação; o campo sem widget nenhum também.
 * @param {object} doc documento do pdf-reader
 * @returns {Promise<PdfForm>}
 */
export async function readForm(doc) {
  const acro = doc.acroForm();
  const nodes = doc.formFields();
  const r = (value) => doc.resolve(value);

  // Página de cada widget, pelo /Annots (até 2000 por página, como o achatamento).
  const pageOf = new Map();
  doc.pages.forEach((page, index) => {
    const annots = r(page.node.get('Annots'));
    if (!Array.isArray(annots)) return;
    for (const ref of annots.slice(0, 2000)) if (ref instanceof PdfRef && !pageOf.has(ref.num)) pageOf.set(ref.num, index);
  });

  const dr = acro ? r(acro.get('DR')) : null;
  const order = new Set((Array.isArray(r(acro?.get('CO'))) ? r(acro.get('CO')) : []).filter((ref) => ref instanceof PdfRef).map((ref) => ref.num));
  const locks = lockRules(doc, nodes);

  const groups = new Map(); // nome e tipo → campo
  const fields = [];
  for (const node of nodes) {
    if (!node.terminal || !node.widgets.length) continue;
    const kind = fieldKind(node);
    if (!kind) continue;
    const widgets = [];
    for (const { ref, dict } of node.widgets) {
      if (!(ref instanceof PdfRef) || !pageOf.has(ref.num)) continue; // fora do /Annots: não aparece em página nenhuma
      const widget = readWidget(doc, ref.num, dict, doc.pages[pageOf.get(ref.num)], pageOf.get(ref.num), node, dr);
      if (widget) widgets.push(widget);
    }
    if (!widgets.length) continue;
    const key = node.name ? `${node.name}\u0000${kind}` : null;
    const same = key && groups.get(key);
    if (same) {
      same.widgets.push(...widgets);
      same.nodes.push(node);
      continue;
    }
    const field = { kind, node, nodes: [node], widgets };
    if (key) groups.set(key, field);
    fields.push(field);
  }

  const built = [];
  for (const [id, item] of fields.entries()) built.push(await buildField(doc, id, item, { order, locks }));
  const catalog = doc.catalog();
  const xfa = acro?.has('XFA') ? (r(catalog.get('NeedsRendering')) === true || !built.length ? 'pure' : 'hybrid') : null;
  return new PdfForm(built, { xfa, needAppearances: acro ? r(acro.get('NeedAppearances')) === true : false });
}

// Tipo do campo para o app: texto, caixa, rádio, lista suspensa, lista ou assinatura. Botão de ação fica de fora.
function fieldKind({ type, flags }) {
  if (type === 'Tx') return 'text';
  if (type === 'Ch') return flags & FF.combo ? 'combo' : 'list';
  if (type === 'Sig') return 'signature';
  if (type === 'Btn') return flags & FF.pushButton ? null : flags & FF.radio ? 'radio' : 'checkbox';
  return null;
}

// Widget: onde fica (página, retângulo, a caixa de 0 a 1 na página como aparece), a moldura (/MK, /BS), o texto
// (/DA, /Q) e os estados da aparência (/AP /N), sem guardar os objetos do PDF.
function readWidget(doc, num, dict, page, index, node, dr) {
  const r = (value) => doc.resolve(value);
  const flags = r(dict.get('F'));
  if (Number.isInteger(flags) && flags & HIDDEN) return null;
  if (doc.layers?.isHidden(dict.get('OC'))) return null; // numa camada oculta, como no achatamento
  const rect = doc.box(dict.get('Rect'));
  if (!rect || rect[2] - rect[0] <= 0 || rect[3] - rect[1] <= 0) return null;
  const mk = r(dict.get('MK'));
  const color = (key) => {
    const value = mk instanceof PdfDict ? r(mk.get(key)) : null;
    if (!Array.isArray(value) || ![1, 3, 4].includes(value.length)) return null; // [] = transparente
    const parts = value.map((item) => r(item));
    return parts.every((v) => typeof v === 'number' && Number.isFinite(v)) ? parts.map((v) => Math.min(1, Math.max(0, v))) : null;
  };
  const turn = mk instanceof PdfDict ? r(mk.get('R')) : 0;
  const rotation = typeof turn === 'number' && Number.isFinite(turn) ? ((Math.round(turn / 90) % 4 + 4) % 4) * 90 : 0;

  // Borda: /BS (largura, estilo, tracejado) ou, sem ele, o /Border antigo ([h v largura]).
  const bs = r(dict.get('BS'));
  let borderWidth = 1;
  let borderStyle = 'S';
  let dash = [3];
  if (bs instanceof PdfDict) {
    const w = r(bs.get('W'));
    if (typeof w === 'number' && Number.isFinite(w)) borderWidth = Math.min(100, Math.max(0, w));
    const s = r(bs.get('S'));
    if (s instanceof PdfName && ['S', 'D', 'B', 'I', 'U'].includes(s.value)) borderStyle = s.value;
    const d = r(bs.get('D'));
    if (Array.isArray(d) && d.length && d.length <= 8 && d.every((v) => typeof v === 'number' && v >= 0 && v < 1000) && d.some((v) => v > 0)) dash = d;
  } else {
    const border = r(dict.get('Border'));
    if (Array.isArray(border) && typeof r(border[2]) === 'number' && Number.isFinite(r(border[2]))) borderWidth = Math.min(100, Math.max(0, r(border[2])));
  }

  // Estados da aparência: a caixa e o rádio têm um por valor (o "marcado" e o /Off).
  const ap = r(dict.get('AP'));
  const normal = ap instanceof PdfDict ? r(ap.get('N')) : null;
  const down = ap instanceof PdfDict ? r(ap.get('D')) : null;
  const states = normal instanceof PdfDict
    ? [...normal.keys()].slice(0, 100).filter((key) => r(normal.get(key)) instanceof PdfStream)
    : [];
  const onState = states.find((s) => s !== 'Off')
    ?? (down instanceof PdfDict ? [...down.keys()].slice(0, 100).find((s) => s !== 'Off') : undefined) ?? null;
  const as = r(dict.get('AS'));

  // Texto: /DA e /Q do próprio widget, ou os do campo.
  const ownDa = r(dict.get('DA'));
  const da = parseDA(ownDa instanceof PdfString ? String.fromCharCode(...ownDa.bytes.subarray(0, 1000)) : node.da);
  const resources = [dr, ...(normal instanceof PdfStream ? [normal] : states.map((s) => r(normal.get(s))))
    .map((stream) => stream?.dict?.get('Resources'))].slice(0, 4);
  da.font = standardFont(da.font ? baseFontName(doc, da.font, resources) ?? da.font : 'Helv');
  const q = dict.has('Q') ? r(dict.get('Q')) : node.q;

  return {
    num, page: index, rect, box: visibleBox(rect, page), rotation,
    background: color('BG'), borderColor: color('BC'), borderWidth, borderStyle, dash,
    caption: mk instanceof PdfDict ? textString(r(mk.get('CA')), 10) : '',
    states, onState, current: as instanceof PdfName ? as.value : null,
    hasAppearance: normal instanceof PdfStream || states.length > 0,
    da, align: [0, 1, 2].includes(q) ? q : 0,
    redraw: false,
  };
}

// Caixa do retângulo na página como aparece (de 0 a 1, origem no canto superior esquerdo, com o /Rotate da página):
// a mesma medida do texto da página (pageTextItems, em pdf-render.js), para achar o rótulo em volta do campo.
function visibleBox(rect, page) {
  const box = page.crop ?? page.media;
  const [a, b, c, d, e, f] = pageMatrix(box, page.rotate);
  const det = a * d - b * c;
  const toVisible = (x, y) => [(d * (x - e) - c * (y - f)) / det, (a * (y - f) - b * (x - e)) / det];
  const corners = [[rect[0], rect[1]], [rect[2], rect[3]]].map(([x, y]) => toVisible(x, y));
  const xs = corners.map(([x]) => x / page.width);
  const ys = corners.map(([, y]) => y / page.height);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// O resto do campo: valor, opções, rótulos, ações e por que não dá para preencher.
async function buildField(doc, id, { kind, node, nodes, widgets }, { order, locks }) {
  const r = (value) => doc.resolve(value);
  const own = (key) => {
    for (let n = node; n; n = n.parent) if (n.dict.has(key)) return r(n.dict.get(key));
    return undefined;
  };
  const flags = node.flags;
  const maxLen = Number.isInteger(node.maxLen) && node.maxLen > 0 ? Math.min(node.maxLen, MAX_LENGTH) : null;
  const field = {
    id, name: node.name, kind,
    tooltip: generic(tidy(textString(own('TU'), 500))) ? '' : tidy(textString(own('TU'), 500)),
    label: '',
    pages: [...new Set(widgets.map((w) => w.page))].sort((a, b) => a - b),
    widgets,
    readOnly: !!(flags & FF.readOnly), required: !!(flags & FF.required),
    multiline: kind === 'text' && !!(flags & FF.multiline),
    password: kind === 'text' && !!(flags & FF.password),
    file: kind === 'text' && !!(flags & FF.file),
    comb: kind === 'text' && !!(flags & FF.comb) && maxLen !== null && maxLen <= MAX_COMB && !(flags & (FF.multiline | FF.password | FF.file)),
    editable: false,
    multiSelect: kind === 'list' && !!(flags & FF.multiSelect),
    custom: kind === 'combo' && !!(flags & FF.edit), // lista suspensa que aceita texto livre
    maxLen,
    topIndex: 0,
    options: [],
    value: null,
    defaultValue: null,
    scripts: {},
    calculated: false,
    locked: false,
    fillable: true,
    reason: null,
  };

  // Opções: das listas pelo /Opt (texto, ou par [valor de exportação, nome]); da caixa e do rádio, pelos estados.
  const opt = own('Opt');
  const optList = Array.isArray(opt) ? opt.slice(0, 1000).map((item) => {
    const value = r(item);
    if (Array.isArray(value)) {
      const [exported, shown] = value.map((v) => textString(r(v), 1000));
      return { value: exported, label: shown || exported };
    }
    const text = value instanceof PdfName ? value.value : textString(value, 1000);
    return { value: text, label: text };
  }) : null;
  if (kind === 'combo' || kind === 'list') {
    field.options = optList ?? [];
    const ti = own('TI');
    field.topIndex = Number.isInteger(ti) && ti >= 0 && ti < field.options.length ? ti : 0;
  } else if (kind === 'checkbox' || kind === 'radio') {
    field.options = buttonOptions(kind, widgets, optList);
  }

  field.value = await readValue(doc, field, node.value, optList);
  field.defaultValue = await readValue(doc, field, node.defaultValue, optList);

  // Ações (/AA): o texto do script de cálculo (C), formato (F), teclado (K) e validação (V). Nenhum roda.
  for (const { dict } of nodes) {
    const aa = r(dict.get('AA'));
    if (!(aa instanceof PdfDict)) continue;
    for (const [key, name] of [['C', 'calculate'], ['F', 'format'], ['K', 'keystroke'], ['V', 'validate']]) {
      if (field.scripts[name] === undefined && aa.has(key)) {
        const text = await actionScript(doc, aa.get(key));
        if (text !== null) field.scripts[name] = text;
      }
    }
  }
  field.calculated = field.scripts.calculate !== undefined || nodes.some((n) => n.ref && order.has(n.ref.num));
  // Formato do Acrobat (número, data, máscara…), reconhecido pelo texto da chamada (pdf-form-format.js): o valor vai
  // formatado para a aparência. null: sai como digitado.
  field.format = kind === 'text' ? readFieldFormat(field.scripts.format, field.scripts.keystroke) : null;
  field.locked = kind !== 'signature' && locks(node.name);

  // Quem não dá para preencher, e por quê (o painel mostra o motivo).
  if (kind === 'signature') field.reason = 'signature';
  else if (field.password) field.reason = 'password';
  else if (field.file) field.reason = 'file';
  field.fillable = !field.reason;
  field.editable = field.fillable && !field.locked && (!field.readOnly || field.calculated);
  if (field.fillable && !field.editable) field.reason = field.locked ? 'locked' : 'readOnly';

  field.label = field.tooltip || cleanName(node.partial || nodes.find((n) => n.partial)?.partial || node.name) || `Campo ${id + 1}`;
  return field;
}

// Opções da caixa e do rádio, uma por estado "marcado" dos widgets: [{value: estado, label}]. Widget sem aparência
// ganha um estado ("0", "1"… no rádio, pela posição; "Yes" na caixa, como o Acrobat).
function buttonOptions(kind, widgets, optList) {
  const options = [];
  const seen = new Set();
  widgets.forEach((widget, i) => {
    widget.onState ??= kind === 'checkbox' && !optList ? 'Yes' : String(i);
    const state = widget.onState;
    if (seen.has(state)) return; // rádios em uníssono: o mesmo estado em vários widgets
    seen.add(state);
    const index = /^\d+$/.test(state) && optList && Number(state) < optList.length ? Number(state) : i;
    options.push({ value: state, label: optList?.[index]?.label || nameText(state) });
  });
  return options;
}

// Valor do campo no formato do app: texto; estado escolhido (caixa e rádio, null = nenhum); texto ou lista de textos
// (lista com várias escolhas).
async function readValue(doc, field, raw, optList) {
  const value = doc.resolve(raw);
  const text = async (item) => {
    const v = doc.resolve(item);
    if (v instanceof PdfString) return textString(v);
    if (v instanceof PdfName) return nameText(v.value);
    if (v instanceof PdfStream) return streamText(doc, v); // texto longo guardado num stream
    return null;
  };
  if (field.kind === 'checkbox' || field.kind === 'radio') {
    const state = value instanceof PdfName ? value.value : value instanceof PdfString ? textString(value, 1000) : null;
    if (state === null || state === 'Off') return null;
    if (field.options.some((o) => o.value === state)) return state;
    // Alguns programas gravam o valor de exportação (/Opt) no lugar do nome do estado.
    const index = optList?.findIndex((o) => o.value === nameText(state)) ?? -1;
    return index >= 0 ? field.options.find((o) => o.value === String(index))?.value ?? null : null;
  }
  if (field.kind === 'signature') return value != null ? 'signed' : null;
  if (field.kind === 'list') {
    const list = Array.isArray(value) ? value.slice(0, 1000) : value == null ? [] : [value];
    const out = [];
    for (const item of list) {
      const t = await text(item);
      if (t !== null) out.push(t);
    }
    return field.multiSelect ? out : out[0] ?? '';
  }
  if (Array.isArray(value)) return (await text(value[0])) ?? '';
  return (await text(value)) ?? '';
}

async function streamText(doc, stream) {
  try {
    const data = await doc.decode(stream);
    return textString(new PdfString(data.subarray(0, 200000)));
  } catch {
    return null; // filtro que o leitor não lê: o campo fica sem valor
  }
}

// Texto do script de uma ação JavaScript (/S /JavaScript, /JS em texto ou stream), até 64 KB, ou null.
async function actionScript(doc, action) {
  const dict = doc.resolve(action);
  if (!(dict instanceof PdfDict) || !isName(doc.resolve(dict.get('S')), 'JavaScript')) return null;
  const js = doc.resolve(dict.get('JS'));
  if (js instanceof PdfString) return textString(js, 65536);
  if (js instanceof PdfStream) return (await streamText(doc, js))?.slice(0, 65536) ?? null;
  return null;
}

// Campos travados por assinatura (/Lock do campo de assinatura assinado e /FieldMDP da assinatura): uma função que diz
// se o nome está travado.
function lockRules(doc, nodes) {
  const rules = [];
  const add = (dict) => {
    if (!(dict instanceof PdfDict)) return;
    const action = doc.resolve(dict.get('Action'));
    const list = doc.resolve(dict.get('Fields'));
    const names = Array.isArray(list) ? list.slice(0, 1000).map((item) => textString(doc.resolve(item), 1000)).filter(Boolean) : [];
    if (isName(action, 'All') || isName(action, 'Include') || isName(action, 'Exclude')) rules.push({ action: action.value, names });
  };
  for (const node of nodes) {
    if (node.type !== 'Sig' || !(doc.resolve(node.value) instanceof PdfDict)) continue; // só depois de assinado
    add(doc.resolve(node.dict.get('Lock')));
    const references = doc.resolve(doc.resolve(node.value).get('Reference'));
    for (const item of Array.isArray(references) ? references.slice(0, 100) : []) {
      const reference = doc.resolve(item);
      if (reference instanceof PdfDict && isName(doc.resolve(reference.get('TransformMethod')), 'FieldMDP')) add(doc.resolve(reference.get('TransformParams')));
    }
  }
  const matches = (name, names) => names.some((n) => name === n || name.startsWith(`${n}.`));
  return (name) => rules.some(({ action, names }) => action === 'All' || (action === 'Include' ? matches(name, names) : !matches(name, names)));
}

// ---------- /DA e fontes ----------

/**
 * Aparência do texto (/DA, como "0 0 0 rg /F4 11 Tf"), lida pelo Parser do leitor: a cor pode vir antes ou depois
 * da fonte. Tamanho 0 = automático.
 * @param {string | null} da
 * @returns {{font: string | null, size: number, color: number[] | null}} font: o nome do recurso (/Helv, /F4…)
 */
export function parseDA(da) {
  const out = { font: null, size: 0, color: null };
  if (!da) return out;
  const parser = new Parser(Uint8Array.from(da.slice(0, 1000), (c) => c.charCodeAt(0) & 0xff));
  const operands = [];
  for (let i = 0; i < 200; i++) {
    parser.skip();
    if (parser.pos >= parser.bytes.length) break;
    let value;
    try {
      value = parser.value();
    } catch {
      break;
    }
    if (!(value instanceof Keyword)) {
      operands.push(value);
      continue;
    }
    const numbers = operands.filter((v) => typeof v === 'number' && Number.isFinite(v)).map((v) => Math.min(1, Math.max(0, v)));
    if (value.value === 'Tf' && operands.at(-2) instanceof PdfName && typeof operands.at(-1) === 'number') {
      out.font = operands.at(-2).value;
      const size = Math.abs(operands.at(-1));
      out.size = Number.isFinite(size) && size <= 1000 ? size : 0;
    } else if (value.value === 'g' && numbers.length >= 1) out.color = numbers.slice(-1);
    else if (value.value === 'rg' && numbers.length >= 3) out.color = numbers.slice(-3);
    else if (value.value === 'k' && numbers.length >= 4) out.color = numbers.slice(-4);
    operands.length = 0;
  }
  return out;
}

// Nomes curtos das fontes padrão que o Acrobat põe no /DR.
const SHORT_NAMES = {
  Helv: 'Helvetica', HeBo: 'Helvetica-Bold', HeOb: 'Helvetica-Oblique', HeBO: 'Helvetica-BoldOblique',
  TiRo: 'Times-Roman', TiBo: 'Times-Bold', TiIt: 'Times-Italic', TiBI: 'Times-BoldItalic',
  Cour: 'Courier', CoBo: 'Courier-Bold', CoOb: 'Courier-Oblique', CoBO: 'Courier-BoldOblique',
};

/**
 * A fonte padrão do PDF (sem embutir) mais parecida com a do formulário: Arial, Calibri e as outras sem serifa →
 * Helvetica; Times New Roman e as com serifa → Times; Courier New e as de largura fixa → Courier; negrito e itálico
 * pelo nome. A fonte do formulário costuma ser um subconjunto (BAAAAA+ArialMT), sem as letras novas.
 * @param {string} name a BaseFont (ou o nome do recurso, quando não há fonte)
 */
export function standardFont(name) {
  if (Object.hasOwn(SHORT_NAMES, name)) return SHORT_NAMES[name]; // nunca uma propriedade herdada ("constructor")
  const text = String(name).replace(/^[A-Z]{6}\+/, '').toLowerCase();
  const family = /courier|mono|consol|typewriter|lucidaconsole/.test(text) ? 'mono'
    : !/sans/.test(text) && /times|serif|georgia|garamond|cambria|minion|palatino|schoolbook|bodoni|baskerville|constantia/.test(text) ? 'serif'
    : 'sans';
  return pdfFont(family, /bold|black|heavy|semibold|demi|,bd\b|-bd\b/.test(text), /italic|oblique|ital\b|,it\b|-it\b/.test(text));
}

// BaseFont do recurso de fonte do /DA: no /DR do formulário ou nos recursos da aparência guardada.
function baseFontName(doc, name, list) {
  for (const resources of list) {
    const fonts = doc.resolve(doc.resolve(resources)?.get?.('Font'));
    const font = fonts instanceof PdfDict ? doc.resolve(fonts.get(name)) : null;
    const base = font instanceof PdfDict ? doc.resolve(font.get('BaseFont')) : null;
    if (base instanceof PdfName) return base.value;
  }
  return null;
}

// ---------- Rótulos ----------

// Texto de um nome do PDF: os bytes dele, em UTF-8 quando forem (estado "Sim" ou "Não" gravado com #C3#A3).
function nameText(name) {
  if (![...name].every((c) => c.charCodeAt(0) < 256) || !/[\x80-\xff]/.test(name)) return name;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(name, (c) => c.charCodeAt(0)));
  } catch {
    return name;
  }
}

const tidy = (text) => text.replace(/\s+/g, ' ').trim();

// Tira do fim os caracteres da lista, num laço (uma expressão regular como /[:-]+$/ fica quadrática num texto com
// muitos ":" que não terminam nele).
function trimEnd(text, chars) {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

// Nome genérico, que o programa deu sozinho ("Caixa de texto 1_2", "Text3", "Check Box12"): não serve de rótulo.
const GENERIC = /^(text|texto|textfield|text field|campo|campo de texto|caixa|caixa de texto|caixa de seleção|caixa de selecao|caixa de verificação|check box|checkbox|botão de opção|radio button|field|fill|untitled|undefined|group)[\s\d._-]*$/i;

/**
 * Nome do campo (/T) como rótulo: "#20" e "#C3#A7" gravados por extenso viram as letras, os índices do XFA ("[0]")
 * saem, "_" vira espaço e "NomeCompleto" vira "Nome Completo". Nome genérico ou sem letra vira vazio.
 * @param {string} name
 */
export function cleanName(name) {
  let text = String(name ?? '');
  if (/#[0-9a-f]{2}/i.test(text)) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '#' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
        bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(...encoder.encode(text[i]));
    }
    text = new TextDecoder().decode(Uint8Array.from(bytes));
  }
  text = text.replace(/\[\d+\]/g, '').split('.').filter(Boolean).at(-1) ?? '';
  text = tidy(text.replace(/([a-zà-ÿ])([A-ZÀ-Þ])/g, '$1 $2').replace(/_+/g, ' '));
  return generic(text) ? '' : text.slice(0, 120);
}

// Sem letra nenhuma, ou nome que o programa deu sozinho.
const generic = (text) => !/\p{L}/u.test(text) || GENERIC.test(text);

/**
 * Rótulo pelo texto da página em volta do widget: o trecho à esquerda na mesma linha ou, sem ele, logo acima (texto,
 * lista); à direita na caixa e no rádio. Trechos colados na mesma linha se juntam ("Nome do" + "segurado:").
 * @param {{x0: number, y0: number, x1: number, y1: number}} box o widget na página como aparece (de 0 a 1)
 * @param {Array<{str: string, x0: number, y0: number, x1: number, y1: number}>} items o texto da página, na mesma
 *   medida (pageTextItems, em pdf-render.js)
 * @param {'left' | 'right'} [side]
 * @returns {string} vazio quando não acha
 */
export function nearbyText(box, items, side = 'left') {
  const height = Math.max(box.y1 - box.y0, 0.005);
  const list = (items ?? []).filter((item) => item?.str?.trim() && item.x1 > item.x0 && item.y1 > item.y0
    && item.y1 - item.y0 < Math.max(height * 3, 0.05));
  const sameLine = (item) => {
    const center = (item.y0 + item.y1) / 2;
    return center >= box.y0 - height * 0.25 && center <= box.y1 + height * 0.25;
  };
  const line = list.filter(sameLine);
  // Junta os trechos vizinhos, de um em um, enquanto estiverem colados (até 2% da largura da página).
  const join = (first, step) => {
    const parts = [first];
    for (let current = first; parts.length < 12;) {
      const next = line.find((item) => !parts.includes(item) && (step < 0
        ? item.x1 <= current.x0 + 0.002 && current.x0 - item.x1 < 0.02
        : item.x0 >= current.x1 - 0.002 && item.x0 - current.x1 < 0.02));
      if (!next) break;
      parts[step < 0 ? 'unshift' : 'push'](next);
      current = next;
    }
    return parts.map((item) => item.str.slice(0, MAX_NEARBY)).join(' ');
  };
  const label = (text) => {
    const clean = trimEnd(tidy(text.slice(0, MAX_NEARBY * 12)), ' :–—-');
    return clean.length > 80 ? `${clean.slice(0, 79).replace(/\s+\S*$/, '')}…` : clean;
  };
  if (side === 'right') {
    const right = line.filter((item) => item.x0 >= box.x1 - 0.005 && item.x0 - box.x1 < 0.2).sort((a, b) => a.x0 - b.x0)[0];
    return right ? label(join(right, 1)) : '';
  }
  const left = line.filter((item) => item.x1 <= box.x0 + 0.005 && box.x0 - item.x1 < 0.25).sort((a, b) => b.x1 - a.x1)[0];
  if (left) return label(join(left, -1));
  const above = list.filter((item) => item.y1 <= box.y0 + height * 0.25 && box.y0 - item.y1 < Math.max(height * 1.5, 0.03)
    && item.x1 > box.x0 - 0.01 && item.x0 < box.x1).sort((a, b) => b.y1 - a.y1 || a.x0 - b.x0)[0];
  return above ? label(above.str.slice(0, MAX_NEARBY)) : '';
}

// ---------- Estado dos valores ----------

/**
 * Formulário de um PDF aberto, com os valores preenchidos no app (só na memória da aba). Fica em doc.form: o mesmo
 * campo vale em todas as páginas e em todos os arquivos gerados a partir desse PDF.
 */
export class PdfForm {
  /**
   * @param {object[]} fields os campos (readForm)
   * @param {{xfa: null | 'hybrid' | 'pure', needAppearances: boolean}} info xfa: formulário XFA híbrido (a parte
   *   AcroForm é preenchida e o /XFA não vai para o PDF novo) ou puro (não dá para preencher)
   */
  constructor(fields, { xfa = null, needAppearances = false } = {}) {
    this.fields = fields;
    this.xfa = xfa;
    this.needAppearances = needAppearances;
    this.fillable = xfa !== 'pure';
    this.values = new Map(); // id do campo → valor preenchido no app
    this.versions = new Map(); // página → versão, que muda a cada valor gravado nela
    this.cache = new Map(); // número do widget → {key, result}
    this.listeners = new Set();
    this.pending = null;
    if (!this.fillable) for (const field of fields) Object.assign(field, { fillable: false, editable: false, reason: 'xfa' });
    // Já preenchido em outro programa, sem a aparência do valor (#16): o widget é desenhado de novo, para o PDF novo
    // sair igual à tela.
    for (const field of fields) for (const widget of field.widgets) widget.redraw = this.fillable && needsRedraw(field, widget, needAppearances);
  }

  /** O campo pelo id (a posição em fields). */
  field(id) {
    return this.fields[id] ?? null;
  }

  /**
   * Campos com widget na página, em ordem de leitura (de cima para baixo e, na mesma linha, da esquerda para a
   * direita), pela página como aparece.
   * @param {number} index a página no PDF (a partir de 0)
   */
  pageFields(index) {
    const items = this.fields.flatMap((field) => {
      const widget = field.widgets.find((w) => w.page === index);
      return widget ? [{ field, box: widget.box }] : [];
    });
    items.sort((a, b) => a.box.y0 - b.box.y0);
    const rows = [];
    for (const item of items) {
      const center = (item.box.y0 + item.box.y1) / 2;
      const row = rows.find((each) => center >= each.y0 && center <= each.y1);
      if (row) row.items.push(item);
      else rows.push({ y0: item.box.y0, y1: item.box.y1, items: [item] });
    }
    return rows.flatMap((row) => row.items.sort((a, b) => a.box.x0 - b.box.x0).map(({ field }) => field));
  }

  /** O valor do campo: o preenchido no app ou, sem ele, o que o PDF já tinha. */
  value(id) {
    return this.values.has(id) ? this.values.get(id) : this.fields[id]?.value ?? null;
  }

  /**
   * Grava o valor de um campo (todas as páginas e arquivos com ele). Voltar ao valor que o PDF tinha tira o
   * preenchimento. Avisa quem acompanha (onChange) logo depois.
   * @param {number} id
   * @param {string | boolean | string[] | null} value texto; caixa: true/false ou o estado; rádio: o estado (o value
   *   de uma das options) ou null; lista suspensa: o value da opção (ou texto livre, se custom); lista: o value ou,
   *   com várias escolhas, uma lista deles
   * @returns {{clipped: boolean, missing: string}} clipped: o texto não coube no campo nem com a letra de 6 pt e sai
   *   cortado; missing: letras fora das fontes padrão do PDF (WinAnsi), que ficam de fora
   */
  setValue(id, value) {
    const field = this.fields[id];
    if (!field) throw new Error(`Campo inexistente: ${id}`);
    if (!field.editable) throw new Error(`O campo ${field.label} não pode ser preenchido (${field.reason}).`);
    const normal = normalizeValue(field, value);
    if (sameValue(normal, field.value)) this.values.delete(id);
    else this.values.set(id, normal);
    this.changed(field);
    return this.check(id);
  }

  /**
   * O que acontece com o valor de um campo no PDF novo, sem mudar nada: o atual ou, com value, um que ainda não foi
   * gravado (o que a pessoa está digitando no painel).
   * @returns {{clipped: boolean, missing: string}}
   */
  check(id, value = this.value(id)) {
    const field = this.fields[id];
    let clipped = false;
    const missing = new Set();
    if (!field?.fillable) return { clipped, missing: '' };
    for (const widget of field.widgets) {
      const result = this.appearance(field, widget, value);
      clipped ||= result.clipped;
      for (const char of result.missing) missing.add(char);
    }
    return { clipped, missing: [...missing].join('') };
  }

  /**
   * Há valor preenchido no app? Com index, só nos campos daquela página.
   * @param {number} [index]
   */
  hasValues(index) {
    if (index === undefined) return this.values.size > 0;
    return [...this.values.keys()].some((id) => this.fields[id].pages.includes(index));
  }

  /**
   * Tira os valores preenchidos no app (de todos os campos ou dos que têm widget na página index): voltam os do PDF.
   * @param {number} [index]
   */
  clear(index) {
    for (const id of [...this.values.keys()]) {
      const field = this.fields[id];
      if (index !== undefined && !field.pages.includes(index)) continue;
      this.values.delete(id);
      this.changed(field);
    }
  }

  /** Versão da página: muda cada vez que um valor de campo dela muda (para a miniatura e o OCR saberem). */
  pageVersion(index) {
    return this.versions.get(index) ?? 0;
  }

  /**
   * Avisa quando valores mudam: listener(pages), com as páginas afetadas, uma vez depois de uma série de mudanças
   * seguidas (as do "Aplicar" do painel, por exemplo).
   * @param {(pages: Set<number>) => void} listener
   * @returns {() => void} para parar de acompanhar
   */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(field) {
    for (const page of field.pages) this.versions.set(page, this.pageVersion(page) + 1);
    if (!this.pending) {
      this.pending = new Set();
      queueMicrotask(() => {
        const pages = this.pending;
        this.pending = null;
        for (const listener of this.listeners) listener(pages);
      });
    }
    for (const page of field.pages) this.pending.add(page);
  }

  /**
   * A opção fill do copyPages: por número do widget, a aparência nova ou o estado escolhido. Entram os campos
   * preenchidos no app e os já preenchidos em outro programa sem a aparência do valor (#16).
   * @param {number[]} [pages] só os widgets dessas páginas (todas, sem a lista)
   * @returns {Map<number, {stream: PdfStream} | {state: string}>}
   */
  fill(pages) {
    const out = new Map();
    if (!this.fillable) return out;
    const wanted = pages ? new Set(pages) : null;
    for (const field of this.fields) {
      const typed = this.values.has(field.id);
      for (const widget of field.widgets) {
        if ((wanted && !wanted.has(widget.page)) || (!typed && !widget.redraw)) continue;
        const { stream, state } = this.appearance(field, widget, this.value(field.id));
        if (stream) out.set(widget.num, { stream });
        else if (state !== undefined) out.set(widget.num, { state });
      }
    }
    return out;
  }

  /**
   * Os campos já preenchidos em outro programa que o app desenha de novo (#16), para a nota ao abrir.
   * @returns {{fields: number, clipped: number, missing: string}}
   */
  redrawn() {
    let fields = 0;
    let clipped = 0;
    const missing = new Set();
    for (const field of this.fields) {
      const widgets = field.widgets.filter((w) => w.redraw);
      if (!widgets.length) continue;
      fields++;
      let cut = false;
      for (const widget of widgets) {
        const result = this.appearance(field, widget, field.value);
        cut ||= result.clipped;
        for (const char of result.missing) missing.add(char);
      }
      if (cut) clipped++;
    }
    return { fields, clipped, missing: [...missing].join('') };
  }

  /**
   * Rótulos dos campos de uma página: /TU; o texto da página em volta do campo (nearbyText); o nome (/T) limpo;
   * "Campo 12". Sem o texto da página (o PDF.js não carregou), fica o rótulo de cada campo (field.label).
   * @param {number} index
   * @param {Array<{str: string, x0: number, y0: number, x1: number, y1: number}>} [items] o texto da página
   *   (pdfPageTextItems, em pdf-open.js), de 0 a 1 na página como aparece
   * @returns {Map<number, string>} id → rótulo
   */
  pageLabels(index, items = []) {
    const out = new Map();
    for (const field of this.pageFields(index)) {
      const widget = field.widgets.find((w) => w.page === index);
      const side = field.kind === 'checkbox' || field.kind === 'radio' ? 'right' : 'left';
      out.set(field.id, field.tooltip || nearbyText(widget.box, items, side) || field.label);
    }
    return out;
  }

  // Aparência de um widget com um valor, guardada enquanto o valor não muda.
  appearance(field, widget, value) {
    const key = JSON.stringify(value);
    const cached = this.cache.get(widget.num);
    if (cached?.key === key) return cached.result;
    const result = widgetAppearance(field, widget, value);
    this.cache.set(widget.num, { key, result });
    return result;
  }
}

// Widget já preenchido em outro programa que o app desenha de novo (#16). Texto e listas: com valor e com
// /NeedAppearances (a aparência guardada pode estar vazia ou velha), ou sem aparência nenhuma. Caixa e rádio: sem um
// /AS válido (um dos estados, ou /Off), quando o /V pede um desenho (o PDF.js mostra pelo /V). Senha nunca.
function needsRedraw(field, widget, needAppearances) {
  if (field.kind === 'checkbox' || field.kind === 'radio') {
    if (widget.current === 'Off' || widget.states.includes(widget.current)) return false;
    return field.value === widget.onState || widget.states.includes('Off');
  }
  if (field.kind === 'signature' || field.password) return false;
  const filled = Array.isArray(field.value) ? field.value.some((v) => v.trim()) : !!field.value?.trim();
  return filled && (needAppearances || !widget.hasAppearance);
}

function normalizeValue(field, value) {
  switch (field.kind) {
    case 'checkbox':
      if (value === true) return field.options[0]?.value ?? null;
      if (value === false || value == null) return null;
      if (!field.options.some((o) => o.value === value)) throw new Error(`Estado inexistente: ${value}`);
      return value;
    case 'radio':
      if (value == null) return null;
      if (!field.options.some((o) => o.value === value)) throw new Error(`Opção inexistente: ${value}`);
      return value;
    case 'combo':
      if (value == null) return '';
      if (!field.custom && value !== '' && !field.options.some((o) => o.value === value)) throw new Error(`Opção inexistente: ${value}`);
      return String(value);
    case 'list': {
      const list = (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]).map(String);
      if (list.some((v) => !field.options.some((o) => o.value === v))) throw new Error('Opção inexistente');
      return field.multiSelect ? list : list[0] ?? '';
    }
    default:
      return value == null ? '' : String(value);
  }
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------- Painel de preenchimento ----------
// Lógica do painel (form-panel.js) que não depende da tela: o contador, a dica e o teclado do campo, a formatação ao
// sair do campo e os obrigatórios vazios.

/** "12 de 34": a posição do campo entre os da página. */
export const counterText = (position, total) => `${position} de ${total}`;

/**
 * Dica (placeholder), teclado do celular (inputmode) e limite do que se digita (maxlength) de um campo de texto.
 * @returns {{placeholder: string, inputMode: string, maxLength: number | null}}
 */
export function inputHints(field) {
  const hints = field.format ? fieldInputHints(field.format) : { placeholder: '', inputMode: 'text' };
  return { ...hints, maxLength: field.maxLen ?? null };
}

/**
 * O que o controle do painel mostra quando a pessoa sai do campo: o valor formatado pelo formato do Acrobat ou, se não
 * serve para o formato, o digitado, com o aviso (sem bloquear). O negativo que o PDF mostra em vermelho, sem o sinal,
 * fica com o sinal no controle: formatado de novo na aparência, ele continua negativo (e vermelho).
 * @param {object} field
 * @param {string} typed
 * @returns {{ok: boolean, text: string, message?: string, red?: boolean}}
 */
export function formatTyped(field, typed) {
  if (!field.format) return { ok: true, text: String(typed ?? '') };
  const result = formatFieldValue(field.format, typed);
  if (result.ok && result.red && !/\(.*\)/.test(result.text)) return { ...result, text: `-${result.text}` };
  return result;
}

const isEmpty = (value) => value == null || (Array.isArray(value) ? !value.length : !String(value).trim());

/**
 * Campos obrigatórios que ficaram vazios (avisados ao aplicar, sem bloquear).
 * @param {object[]} fields
 * @param {(field: object) => unknown} valueOf o valor de cada campo (o do painel ou o gravado)
 */
export function requiredEmpty(fields, valueOf) {
  return fields.filter((field) => field.required && field.editable && isEmpty(valueOf(field)));
}

// Nome de opção que não diz nada: número, estado padrão ("On", "Yes", "Escolha1") ou repetido entre as opções.
const MEANINGLESS = /^(\d+|on|off|yes|choice\s*\d*|escolha\s*\d*|op[cç][aã]o\s*\d*|option\s*\d*)$/i;

/**
 * Nomes das opções da caixa e do rádio para o painel: o do /Opt ou do estado e, quando ele não diz nada, o texto da
 * página à direita do widget daquela opção (nearbyText).
 * @param {object} field
 * @param {number} index a página
 * @param {Array<{str: string, x0: number, y0: number, x1: number, y1: number}>} [items] o texto da página
 * @returns {Map<string, string>} estado → nome
 */
export function optionLabels(field, index, items = []) {
  const counts = new Map();
  for (const option of field.options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
  const out = new Map();
  field.options.forEach((option, i) => {
    const { label } = option;
    const blank = MEANINGLESS.test(label.trim());
    if (!blank && counts.get(label) === 1) {
      out.set(option.value, label);
      return;
    }
    const widget = field.widgets.find((w) => w.page === index && w.onState === option.value);
    out.set(option.value, (widget && nearbyText(widget.box, items, 'right')) || (blank ? `Opção ${i + 1}` : `${label} (${i + 1})`));
  });
  return out;
}

// ---------- Aparências ----------

/**
 * Aparência de um widget com um valor, para o copyPages (opção fill).
 * - texto: Form XObject com /Tx BMC … EMC, recortado na área útil, com o fundo (/MK /BG), a borda (/MK /BC e /BS) e
 *   o giro (/MK /R); uma linha, várias linhas (/Ff 13) ou pente (/Ff 25 com /MaxLen); tamanho 0 = automático; o
 *   texto que não cabe diminui até 6 pt e, se ainda não couber, sai cortado (clipped);
 * - caixa e rádio: o estado do próprio widget no /AP /N (state) ou, sem esse desenho, ✓, ✗, ● ou ■ (/MK /CA);
 * - lista suspensa: o nome da opção, numa linha; lista: as opções visíveis a partir do /TI, a escolhida em destaque.
 * Fonte padrão do PDF, sem embutir; só as letras da WinAnsi (as outras saem e vão em missing).
 * @returns {{stream?: PdfStream, state?: string, clipped: boolean, missing: string}}
 */
export function widgetAppearance(field, widget, value) {
  if (field.kind === 'checkbox' || field.kind === 'radio') return buttonAppearance(field, widget, value);
  const frame = frameOf(widget);
  if (field.kind === 'list') return listAppearance(field, widget, frame, value);
  let text = value ?? '';
  if (field.kind === 'combo') text = field.options.find((o) => o.value === text)?.label ?? text;
  if (Array.isArray(text)) text = text[0] ?? '';
  return textAppearance(field, widget, frame, String(text));
}

// Tamanho da área desenhada (w × h, já com o giro /MK /R), a matriz do giro e a folga da borda.
function frameOf(widget) {
  const [x1, y1, x2, y2] = widget.rect;
  const width = x2 - x1;
  const height = y2 - y1;
  const sideways = widget.rotation % 180 !== 0;
  const w = sideways ? height : width;
  const h = sideways ? width : height;
  const matrix = { 90: [0, 1, -1, 0, width, 0], 180: [-1, 0, 0, -1, width, height], 270: [0, -1, 1, 0, 0, height] }[widget.rotation] ?? null;
  const drawn = widget.borderColor && widget.borderWidth > 0;
  const bw = drawn ? widget.borderWidth : 0;
  const inner = Math.min(w / 2, h / 2, widget.borderStyle === 'B' || widget.borderStyle === 'I' ? 2 * bw : bw);
  return { w, h, matrix, bw, inner };
}

const n = (v) => pdfNumber(v, 3);

// Operador de cor (g, rg ou k; em maiúscula, a do traço).
function colorOp(color, stroke = false) {
  const op = { 1: 'g', 3: 'rg', 4: 'k' }[color.length];
  return `${color.map(n).join(' ')} ${stroke ? op.toUpperCase() : op}`;
}

// Fundo e borda do widget (/MK /BG, /MK /BC, /BS): sólida, tracejada, chanfrada, em baixo-relevo ou só embaixo.
function frameOps(widget, { w, h, bw }) {
  const out = [];
  if (widget.background) out.push(`${colorOp(widget.background)} 0 0 ${n(w)} ${n(h)} re f`);
  if (!bw) return out;
  const style = widget.borderStyle;
  if (style === 'B' || style === 'I') {
    const bg = widget.background;
    const light = style === 'B' ? '1 g' : '0.5 g';
    const shadow = style === 'I' ? '0.75 g' : bg && bg.length !== 4 ? colorOp(bg.map((v) => v / 2)) : '0.5 g';
    out.push(`${light} ${n(bw)} ${n(bw)} m ${n(bw)} ${n(h - bw)} l ${n(w - bw)} ${n(h - bw)} l ${n(w - 2 * bw)} ${n(h - 2 * bw)} l ${n(2 * bw)} ${n(h - 2 * bw)} l ${n(2 * bw)} ${n(2 * bw)} l f`);
    out.push(`${shadow} ${n(w - bw)} ${n(h - bw)} m ${n(w - bw)} ${n(bw)} l ${n(bw)} ${n(bw)} l ${n(2 * bw)} ${n(2 * bw)} l ${n(w - 2 * bw)} ${n(2 * bw)} l ${n(w - 2 * bw)} ${n(h - 2 * bw)} l f`);
  }
  const stroke = `${colorOp(widget.borderColor, true)} ${n(bw)} w`;
  if (style === 'U') out.push(`${stroke} 0 ${n(bw / 2)} m ${n(w)} ${n(bw / 2)} l S`);
  else out.push(`${stroke}${style === 'D' ? ` [${widget.dash.map(n).join(' ')}] 0 d` : ''} ${n(bw / 2)} ${n(bw / 2)} ${n(w - bw)} ${n(h - bw)} re S`);
  return out;
}

// Só as letras da WinAnsi (as das fontes padrão); tabulação vira espaço. missing: as que ficaram de fora.
function winAnsi(text) {
  let out = '';
  const missing = new Set();
  for (const char of text.normalize('NFC')) {
    if (char === '\t') out += ' ';
    else if (char === '\n' || char === '\r') out += char;
    else if (char.codePointAt(0) < 0x20 || char === '\u007f') continue; // controle: não aparece em lugar nenhum
    else if (winAnsiCode(char) !== undefined) out += char;
    else missing.add(char);
  }
  return { text: out, missing: [...missing].join('') };
}

// String literal do PDF só com ASCII: parênteses e barra invertida escapados, o resto da WinAnsi em octal.
function pdfString(text) {
  let out = '(';
  for (const char of text) {
    const code = winAnsiCode(char);
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${char}`;
    else if (code > 0x7e) out += `\\${code.toString(8)}`;
    else out += char;
  }
  return `${out})`;
}

// Form XObject da aparência, com a fonte padrão nos recursos.
function formStream({ w, h, matrix }, ops, font) {
  const dict = new PdfDict([['Type', new PdfName('XObject')], ['Subtype', new PdfName('Form')], ['BBox', [0, 0, w, h]]]);
  if (matrix) dict.set('Matrix', matrix);
  dict.set('Resources', new PdfDict(font ? [['Font', new PdfDict([['F1', new PdfDict([
    ['Type', new PdfName('Font')], ['Subtype', new PdfName('Type1')], ['BaseFont', new PdfName(font)],
    ['Encoding', new PdfName('WinAnsiEncoding')],
  ])]])]] : []));
  const content = ops.join('\n');
  if (/[^\n\x20-\x7e]/.test(content)) throw new Error('Aparência do campo fora do ASCII');
  return new PdfStream(dict, encoder.encode(content));
}

// Texto posicionado, com a fonte, o tamanho e a cor do /DA (ou color), recortado na área útil, entre /Tx BMC e EMC.
function textBlock(frame, widget, size, runs, color = widget.da.color) {
  const { w, h, inner } = frame;
  const ops = ['/Tx BMC', 'q', `${n(inner)} ${n(inner)} ${n(w - 2 * inner)} ${n(h - 2 * inner)} re W n`];
  if (runs.length) {
    ops.push('BT', `/F1 ${n(size)} Tf`, color ? colorOp(color) : '0 g');
    for (const { x, y, text } of runs) ops.push(`1 0 0 1 ${n(x)} ${n(y)} Tm ${pdfString(text)} Tj`);
    ops.push('ET');
  }
  ops.push('Q', 'EMC');
  return ops;
}

// Posição x do texto pelo alinhamento (/Q): 0 esquerda, 1 centro, 2 direita.
function alignX(align, width, { w, inner }) {
  if (align === 1) return (w - width) / 2;
  if (align === 2) return w - inner - PAD - width;
  return inner + PAD;
}

function textAppearance(field, widget, frame, value) {
  const { w, h, inner } = frame;
  const font = widget.da.font;
  // Com formato do Acrobat, o texto formatado; o negativo pintado de vermelho (sem o sinal) sai em vermelho.
  const shown = field.format ? formatFieldValue(field.format, value) : { text: value };
  let { text, missing } = winAnsi(shown.text);
  let clipped = false;
  // /MaxLen limita o que se digita; o texto formatado pode passar dele (decisão do dono). No pente, as casas são as
  // do /MaxLen.
  const comb = field.comb && w / field.maxLen >= MIN_CELL; // casas estreitas demais: uma linha
  if (field.maxLen && (comb || !field.format) && [...text].length > field.maxLen) {
    text = [...text].slice(0, field.maxLen).join('');
    clipped = true;
  }
  const availW = w - 2 * (inner + PAD);
  const availH = h - 2 * inner;
  const runs = [];
  let size;
  if (field.multiline) {
    // Várias linhas: quebra por palavra; a letra diminui até tudo caber na altura.
    const start = widget.da.size > 0 ? widget.da.size : MULTILINE_AUTO;
    const floor = Math.min(MIN_SIZE, start);
    const blockHeight = (count, s) => s * (ASCENT + DESCENT + LINE * (count - 1));
    const layout = (s) => {
      const lines = wrapText(text, font, Math.max(availW, 1) / s);
      const fits = blockHeight(lines.length, s) <= availH + 0.01 && lines.every((l) => textWidth(l, font, s) <= availW + 0.01);
      return { size: s, lines, fits };
    };
    // A maior letra, de meio em meio ponto, em que tudo cabe (busca binária: o /DA pode pedir 72 pt).
    const steps = Math.ceil((start - floor) / 0.5);
    const sizeAt = (k) => Math.max(floor, start - k * 0.5);
    let best = layout(start);
    if (!best.fits) {
      let low = 1;
      let high = steps;
      best = layout(sizeAt(high));
      if (!best.fits) clipped = true;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const attempt = layout(sizeAt(middle));
        if (attempt.fits) {
          best = attempt;
          high = middle;
        } else low = middle + 1;
      }
    }
    size = best.size;
    const top = h - inner - Math.min(PAD, Math.max(0, (availH - blockHeight(best.lines.length, size)) / 2));
    best.lines.forEach((line, i) => {
      const y = top - ASCENT * size - i * LINE * size;
      if (y + ASCENT * size < inner) return; // abaixo da área: cortado
      if (line) runs.push({ x: alignX(widget.align, textWidth(line, font, size), frame), y, text: line });
    });
  } else if (comb) {
    // Pente: uma letra centrada em cada casa.
    const cells = field.maxLen;
    const cell = w / cells;
    const chars = [...text.replace(/[\r\n]+/g, ' ')];
    const widest = Math.max(0, ...chars.map((c) => textWidth(c, font, 1)));
    const start = widget.da.size > 0 ? widget.da.size : availH / LINE;
    const floor = Math.min(MIN_SIZE, start);
    size = Math.max(floor, Math.min(start, widest ? (cell - 1) / widest : start, availH / (ASCENT + DESCENT)));
    if (widest * size > cell + 0.01 || size * (ASCENT + DESCENT) > availH + 0.01) clipped = true;
    const align = widget.align;
    const offset = align === 1 ? Math.floor((cells - chars.length) / 2) : align === 2 ? cells - chars.length : 0;
    const y = h / 2 - ((ASCENT - DESCENT) / 2) * size;
    chars.forEach((char, i) => {
      runs.push({ x: (offset + i) * cell + (cell - textWidth(char, font, size)) / 2, y, text: char });
    });
  } else {
    // Uma linha: a letra do /DA (ou, com tamanho 0, a altura útil ÷ 1,35), reduzida até caber na largura.
    const line = text.replace(/\r\n|\r|\n/g, ' ');
    const unit = textWidth(line, font, 1);
    const start = widget.da.size > 0 ? widget.da.size : Math.max(availH, 1) / LINE;
    const floor = Math.min(MIN_SIZE, start);
    size = Math.min(start, availH / (ASCENT + DESCENT));
    if (unit * size > availW) size = availW / unit;
    size = Math.max(floor, size);
    const fits = unit * size <= availW + 0.01 && size * (ASCENT + DESCENT) <= availH + 0.01;
    if (!fits) clipped = true;
    const y = h / 2 - ((ASCENT - DESCENT) / 2) * size;
    // O que não cabe fica cortado no fim: o começo do texto aparece.
    const x = unit * size > availW + 0.01 ? inner + PAD : alignX(widget.align, unit * size, frame);
    if (line) runs.push({ x, y, text: line });
  }
  const ops = ['q', ...frameOps(widget, frame), 'Q'];
  if (comb && widget.borderColor && frame.bw) {
    // As divisórias do pente, na cor da borda.
    const lines = [];
    for (let i = 1; i < field.maxLen; i++) lines.push(`${n((i * w) / field.maxLen)} 0 m ${n((i * w) / field.maxLen)} ${n(h)} l`);
    ops.push(`q ${colorOp(widget.borderColor, true)} ${n(frame.bw)} w ${lines.join(' ')} S Q`);
  }
  ops.push(...textBlock(frame, widget, size, runs, shown.red ? [1, 0, 0] : widget.da.color));
  return { stream: formStream(frame, ops, font), clipped, missing };
}

/**
 * Quebra o texto em linhas de até maxWidth (medida com a letra de 1 pt), por palavra; palavra maior que a linha é
 * quebrada por letra. As quebras que a pessoa fez ficam.
 */
export function wrapText(text, font, maxWidth) {
  const lines = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, font, 1) <= maxWidth || !line && !word) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      // Palavra maior que a linha: por letra.
      let piece = '';
      for (const char of word) {
        if (piece && textWidth(piece + char, font, 1) > maxWidth) {
          lines.push(piece);
          piece = '';
        }
        piece += char;
      }
      line = piece;
      if (lines.length > 2000) return lines;
    }
    lines.push(line);
  }
  return lines;
}

function listAppearance(field, widget, frame, value) {
  const { w, h, inner } = frame;
  const font = widget.da.font;
  const chosen = new Set(Array.isArray(value) ? value : value ? [value] : []);
  const availW = w - 2 * (inner + PAD);
  const availH = h - 2 * inner;
  const size = Math.max(Math.min(MIN_SIZE, availH / LINE), Math.min(widget.da.size > 0 ? widget.da.size : MULTILINE_AUTO, availH / LINE));
  const lineHeight = size * LINE;
  const visible = Math.max(1, Math.floor((availH + 0.01) / lineHeight));
  // A partir do /TI; a primeira escolhida sempre aparece.
  let top = field.topIndex;
  const first = field.options.findIndex((o) => chosen.has(o.value));
  if (first >= 0 && (first < top || first >= top + visible)) top = Math.max(0, Math.min(first, field.options.length - visible));
  const missing = new Set();
  const runs = [];
  const marks = [];
  let clipped = false;
  for (let i = top; i < Math.min(field.options.length, top + visible); i++) {
    const option = field.options[i];
    const clean = winAnsi(option.label.replace(/[\r\n]+/g, ' '));
    for (const char of clean.missing) missing.add(char);
    const bottom = h - inner - (i - top + 1) * lineHeight;
    const width = textWidth(clean.text, font, size);
    if (chosen.has(option.value)) {
      marks.push(`${n(inner)} ${n(bottom)} ${n(w - 2 * inner)} ${n(lineHeight)} re f`);
      if (width > availW + 0.01) clipped = true;
    }
    runs.push({ x: width > availW ? inner + PAD : alignX(widget.align, width, frame), y: bottom + (lineHeight - (ASCENT - DESCENT) * size) / 2, text: clean.text });
  }
  const ops = ['q', ...frameOps(widget, frame), 'Q'];
  const block = textBlock(frame, widget, size, runs);
  if (marks.length) block.splice(3, 0, `${HIGHLIGHT} ${marks.join(' ')}`);
  ops.push(...block);
  return { stream: formStream(frame, ops, font), clipped, missing: [...missing].join('') };
}

function buttonAppearance(field, widget, value) {
  const on = value != null && value === widget.onState;
  const none = { clipped: false, missing: '' };
  if (on && widget.states.includes(widget.onState)) return { state: widget.onState, ...none };
  if (!on && (widget.states.includes('Off') || widget.hasAppearance)) return { state: 'Off', ...none }; // sem desenho de desligado: nada
  const frame = frameOf(widget);
  const ops = ['q', ...frameOps(widget, frame), 'Q'];
  if (on) ops.push(symbolOps(field, widget, frame));
  return { stream: formStream(frame, ops, null), ...none };
}

// Caractere da ZapfDingbats (/MK /CA) → marca. Map: o /CA vem do PDF e não pode cair em propriedade herdada.
const SYMBOLS = new Map([['4', 'check'], ['3', 'check'], ['8', 'cross'], ['7', 'cross'], ['l', 'circle'], ['n', 'square'], ['u', 'diamond']]);

// Marca da caixa ou do rádio sem o desenho do estado marcado, pelo caractere da ZapfDingbats em /MK /CA: ✓ (4), ✗ (8),
// ● (l), ■ (n) ou ◆ (u). Caminhos, como os ✓ e ✗ da v4.0.0: a ZapfDingbats não é embutida.
function symbolOps(field, widget, { w, h, inner }) {
  const avail = Math.max(0, Math.min(w, h) - 2 * inner - 2);
  const side = widget.da.size > 0 ? Math.min(widget.da.size, avail) : avail * 0.8;
  const color = widget.da.color ?? [0];
  const x = (w - side) / 2;
  const y = (h - side) / 2;
  const caption = widget.caption || (field.kind === 'radio' ? 'l' : '4');
  const kind = SYMBOLS.get(caption) ?? (field.kind === 'radio' ? 'circle' : 'check');
  if (kind === 'check' || kind === 'cross') {
    const hex = `#${rgbOf(color).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
    const stroke = editType(kind).pdf({ color: hex, width: Math.max(0.5, side * 0.12) }, { w: side, h: side });
    return `q 1 0 0 -1 ${n(x)} ${n(y + side)} cm ${stroke} Q`; // o caminho da edição tem y para baixo
  }
  const cx = w / 2;
  const cy = h / 2;
  const path = kind === 'circle' ? circlePath(cx, cy, side * 0.3)
    : kind === 'diamond' ? [['M', cx, cy + side * 0.4], ['L', cx + side * 0.4, cy], ['L', cx, cy - side * 0.4], ['L', cx - side * 0.4, cy], ['Z']]
    : [['M', cx - side * 0.3, cy - side * 0.3], ['L', cx + side * 0.3, cy - side * 0.3], ['L', cx + side * 0.3, cy + side * 0.3], ['L', cx - side * 0.3, cy + side * 0.3], ['Z']];
  return `q ${colorOp(color)} ${pathOps(path)} f Q`;
}

// Cor do /DA em RGB (para o traço do ✓ e do ✗, que a v4.0.0 desenha em RGB).
function rgbOf(color) {
  if (color.length === 1) return [color[0], color[0], color[0]];
  if (color.length === 4) return color.slice(0, 3).map((c) => (1 - c) * (1 - color[3]));
  return color;
}
