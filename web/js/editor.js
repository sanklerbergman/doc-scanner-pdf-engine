// Modo "Editar" da tela cheia: acrescentar desenho à mão, retângulo, seta, ✓ e ✗ por cima da página (edits.js).
// Carregado na primeira vez que a pessoa toca em "Editar" (viewer.js). Separado das tarjas: a tarja apaga, a edição
// acrescenta; as duas usam as mesmas coordenadas, e a tarja fica por cima de tudo.
//
// Tocar seleciona; arrastar move; as alças dos cantos mudam o tamanho; a barra junto da edição selecionada tem Remover
// e Duplicar. Pelo teclado: "Novo" cria a edição da ferramenta no meio da página; cada edição é um grupo com foco, e
// as setas movem 1%, Shift e setas mudam o tamanho, Delete remove. Desfazer volta qualquer passo da sessão. Nada muda
// na página até "Aplicar".
//
// Pontos de encaixe das próximas fases:
// - registerTool: a ferramenta na barra, as propriedades que valem para ela, a criação pelo ponteiro (pointer) e pelo
//   teclado (keyboard), e o que Enter faz numa edição dela (open). Ferramenta nova: registerTool no módulo dela, que
//   entra na lista TOOL_MODULES (carregada por loadTools antes de a barra ser montada) e no APP_FILES do sw.js.
// - registerProperty: um controle a mais no painel de propriedades (tamanho da letra, família…).
// - api (o que pointer, keyboard e open recebem): a página, as edições e as propriedades, mais add, replace, select,
//   say, point e preview (a edição em andamento, desenhada por cima enquanto o dedo arrasta; null tira).
import {
  editType, paintEdits, cloneEdits, normalizeBox, moveEdit, resizeEdit, growEdit, duplicateEdit, boxAround, prepareStroke,
} from './edits.js';
import { arrowFromLine, inkFromStrokes, inkStrokes, DEFAULT_COLOR, DEFAULT_WIDTH } from './edit-shapes.js';
import './edit-types.js';

/**
 * @typedef {object} Tool
 * @property {string} id
 * @property {string} label nome na barra
 * @property {string} [title] nome completo (dica do mouse e leitor de tela), quando o da barra é curto
 * @property {string} icon símbolo do sprite do index.html (#i-…)
 * @property {string} [type] o tipo de edição que ela cria (edits.js)
 * @property {'select' | 'box' | 'mark' | 'line' | 'stroke' | ((api: object) => PointerHandler)} pointer como cria pelo
 *   ponteiro: box arrasta a caixa; mark também, e o toque cria no tamanho do tipo; line arrasta da cauda à ponta;
 *   stroke desenha à mão; uma função recebe a api e devolve {move?, up?, cancel?} para aquele toque
 * @property {true | ((api: object) => void)} [keyboard] "Novo": true cria o tipo no meio da página, no tamanho dele
 *   (EditType.size); uma função faz o que a ferramenta precisa (abrir o painel de texto, escolher a imagem)
 * @property {(api: object, index: number) => void} [open] Enter, ou um toque a mais, numa edição do tipo da ferramenta
 *   (reabrir o painel)
 * @property {string[]} [props] as propriedades (registerProperty) que valem para ela
 * @property {string} hint o que aparece ao escolher a ferramenta
 *
 * @typedef {{move?: (point: number[], event: PointerEvent) => void, up?: (point: number[], event: PointerEvent) => void,
 *   cancel?: () => void}} PointerHandler
 *
 * @typedef {object} Property
 * @property {string} label legenda no painel
 * @property {Array<[string | number, string]>} options valor e nome de cada opção
 * @property {string | number} value o valor das edições novas (muda com a escolha da pessoa, só na memória)
 * @property {'swatch' | 'line' | 'text'} [look] como as opções aparecem
 */

const TOOLS = [];
const PROPERTIES = new Map();

// Módulos das ferramentas das próximas fases (texto, marcações, imagem), um por linha. Cada um importa registerTool
// daqui; por isso entram depois deste arquivo, por loadTools, e não por import no topo (o import circular rodaria
// antes de TOOLS existir).
const TOOL_MODULES = [
  './edit-text-tool.js', // texto (fase 2)
  './edit-mark-tools.js', // marca-texto, sublinhar e riscar (fase 3)
];

/** Carrega as ferramentas de TOOL_MODULES. Quem monta o editor espera por ela antes de setupEditor. */
export const loadTools = () => Promise.all(TOOL_MODULES.map((path) => import(path)));

/** @param {Tool & {after?: string}} tool after: a ferramenta depois da qual ela entra na barra (sem isso, no fim) */
export function registerTool(tool) {
  if (TOOLS.some(({ id }) => id === tool.id)) throw new Error(`Ferramenta repetida: ${tool.id}`);
  const at = TOOLS.findIndex(({ id }) => id === tool.after);
  if (at >= 0) TOOLS.splice(at + 1, 0, tool);
  else TOOLS.push(tool);
}

/** @param {string} id @param {Property} property */
export function registerProperty(id, property) {
  PROPERTIES.set(id, property);
}

/** Uma propriedade registrada (as opções de cor, por exemplo, para o painel de uma ferramenta). */
export const propertyOf = (id) => PROPERTIES.get(id);

registerProperty('color', {
  label: 'Cor', look: 'swatch', value: DEFAULT_COLOR,
  options: [['#1d4ed8', 'Azul'], ['#000000', 'Preto'], ['#dc2626', 'Vermelho'], ['#15803d', 'Verde']],
});
registerProperty('width', {
  label: 'Espessura', look: 'line', value: DEFAULT_WIDTH,
  options: [[1, 'Fina'], [2, 'Média'], [4, 'Grossa']],
});

const SHAPE = ['color', 'width'];
registerTool({
  id: 'select', label: 'Selecionar', icon: 'select', pointer: 'select',
  hint: 'Toque numa edição para selecionar. Arraste para mover; as alças dos cantos mudam o tamanho.',
});
registerTool({
  id: 'ink', label: 'Desenho', title: 'Desenho à mão', icon: 'draw', type: 'ink', pointer: 'stroke', props: SHAPE,
  hint: 'Desenhe com o dedo, a caneta ou o mouse. Traços perto um do outro viram um desenho só.',
});
registerTool({
  id: 'rect', label: 'Retângulo', icon: 'rect', type: 'rect', pointer: 'box', keyboard: true, props: SHAPE,
  hint: 'Arraste sobre a página para desenhar o retângulo. Pelo teclado, use "Novo".',
});
registerTool({
  id: 'arrow', label: 'Seta', icon: 'arrow', type: 'arrow', pointer: 'line', keyboard: true, props: SHAPE,
  hint: 'Arraste de onde a seta sai até onde ela aponta. Pelo teclado, use "Novo".',
});
registerTool({
  id: 'check', label: 'Certo', title: 'Marca de certo (✓)', icon: 'check-mark', type: 'check', pointer: 'mark', keyboard: true, props: SHAPE,
  hint: 'Toque onde vai o ✓, ou arraste para escolher o tamanho. Pelo teclado, use "Novo".',
});
registerTool({
  id: 'cross', label: 'Xis', title: 'Marca de xis (✗)', icon: 'remove', type: 'cross', pointer: 'mark', keyboard: true, props: SHAPE,
  hint: 'Toque onde vai o ✗, ou arraste para escolher o tamanho. Pelo teclado, use "Novo".',
});

const $ = (selector) => document.querySelector(selector);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const TAP = 6; // px da tela: menos que isso é um toque, não um arrasto
const INK_JOIN = 24; // pontos: traço que começa até essa distância do desenho anterior entra nele
const KEY_STEP = 0.01; // as setas movem 1% da página
const MAX_PIXELS = 6e6; // canvas das edições: no iPhone, mais que isso pesa na memória

// Cria um elemento. Chaves "aria-*" e "data-*" viram atributos; o resto, propriedades.
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (/^(aria|data)-/.test(key) || key === 'role') node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

// Ícone do sprite do index.html, decorativo.
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const done = (type, word) => `${type.label} ${word}${type.gender === 'f' ? 'a' : 'o'}`; // "Seta criada"

/**
 * @param {object} deps
 * @param {HTMLElement} deps.stage área da página na tela cheia (para caber nela)
 * @param {HTMLElement} deps.hint aviso da tela cheia (role=status): o que o leitor de tela ouve
 * @param {(page: object, edits: object[]) => Promise<void>} deps.save grava as edições na página
 * @param {(message: string) => Promise<boolean>} deps.confirm confirmação dentro do app (descartar o que não foi aplicado)
 * @param {() => void} deps.leave volta para a página em tela cheia
 */
export function setupEditor({ stage, hint, save, confirm, leave }) {
  const surface = $('#edit');
  const image = $('#edit-image');
  const canvas = $('#edit-canvas');
  const cover = $('#edit-cover');
  const boxes = $('#edit-boxes');
  const toolbar = $('#edit-tools');
  const actions = $('#viewer-edit-actions');
  const panel = $('#edit-props');
  const fields = $('#edit-props-fields');
  const addButton = $('#edit-add');
  const undoButton = $('#edit-undo');
  const applyButton = $('#edit-apply');

  let page = null;
  let size = { width: 595.28, height: 841.89 }; // a página como aparece, em pontos
  let items = [];
  let initial = '[]';
  let history = [];
  let selected = -1;
  let tool = TOOLS[0];
  let drag = null; // o toque em andamento
  let lastInk = null; // o último desenho criado: o próximo traço perto dele entra nele
  let penSeen = false; // com caneta, o dedo (a palma da mão) não desenha
  let lastKey = null; // passos seguidos das setas na mesma edição viram um passo só do Desfazer
  let url = '';
  const current = Object.fromEntries([...PROPERTIES].map(([id, property]) => [id, property.value]));

  const say = (message) => { hint.textContent = message; };
  const aspect = () => size.width / size.height;
  const typeOf = (item) => editType(item.type);
  const toolOf = (item) => TOOLS.find((candidate) => candidate.type === item.type);
  const propsFor = (target) => Object.fromEntries((target.props ?? []).map((id) => [id, current[id]]));

  // ---------- Barra de ferramentas e propriedades ----------

  const toolButtons = TOOLS.map((item) => el('button', {
    type: 'button', className: 'edit-tool', title: item.title ?? item.label, 'aria-pressed': 'false', 'data-tool': item.id,
  }, [icon(item.icon), el('span', { textContent: item.label })]));
  const swatch = el('span', { className: 'edit-tool-swatch' });
  const propsButton = el('button', {
    type: 'button', className: 'edit-tool', title: 'Cor e espessura', 'aria-expanded': 'false', 'aria-controls': 'edit-props',
  }, [swatch, el('span', { textContent: 'Cor' })]);
  toolbar.replaceChildren(...toolButtons, propsButton);

  // Um grupo de opções (rádios) por propriedade; só aparecem as que valem para a ferramenta ou a edição selecionada.
  const groups = new Map([...PROPERTIES].map(([id, property]) => {
    const group = el('fieldset', { className: `edit-prop edit-prop-${property.look ?? 'text'}`, 'data-prop': id }, [
      el('legend', { textContent: property.label }),
      ...property.options.map(([value, name]) => {
        const sample = el('span', { className: 'edit-sample', 'aria-hidden': 'true' });
        if (property.look === 'swatch') sample.style.background = value;
        if (property.look === 'line') sample.style.height = `${Math.max(1, value * 1.5)}px`;
        return el('label', { className: 'edit-option', title: name }, [
          el('input', { type: 'radio', name: `edit-${id}`, value: String(value) }),
          sample, el('span', { className: property.look === 'swatch' ? 'sr-only' : '', textContent: name }),
        ]);
      }),
    ]);
    return [id, group];
  }));
  fields.replaceChildren(...groups.values());

  function showProps() {
    const target = selected >= 0 ? toolOf(items[selected]) ?? tool : tool;
    const values = selected >= 0 ? items[selected] : current;
    for (const [id, group] of groups) {
      group.hidden = !(target.props ?? []).includes(id);
      for (const input of group.querySelectorAll('input')) input.checked = input.value === String(values[id] ?? current[id]);
    }
    // A bolinha do botão mostra a cor da ferramenta (a caneta ou o marca-texto).
    const tint = (target.props ?? []).find((id) => PROPERTIES.get(id)?.look === 'swatch') ?? 'color';
    swatch.style.background = values[tint] ?? current[tint];
    propsButton.disabled = !(target.props ?? []).length;
    if (propsButton.disabled) togglePanel(false);
  }

  function togglePanel(open = panel.hidden) {
    panel.hidden = !open;
    propsButton.setAttribute('aria-expanded', String(open));
    if (open) (panel.querySelector('input:checked') ?? panel.querySelector('input'))?.focus();
  }

  propsButton.addEventListener('click', () => togglePanel());
  $('#edit-props-done').addEventListener('click', () => {
    togglePanel(false);
    propsButton.focus();
  });
  fields.addEventListener('change', (event) => {
    const group = event.target.closest('[data-prop]');
    if (!group) return;
    const id = group.dataset.prop;
    const value = typeof PROPERTIES.get(id).value === 'number' ? Number(event.target.value) : event.target.value;
    current[id] = value;
    if (selected >= 0 && items[selected][id] !== value) {
      remember();
      items[selected] = { ...items[selected], [id]: value };
      render();
    }
    showProps();
  });

  function chooseTool(next, { announce = true } = {}) {
    tool = next;
    lastInk = null;
    for (const button of toolButtons) button.setAttribute('aria-pressed', String(button.dataset.tool === tool.id));
    surface.dataset.tool = tool.pointer === 'select' ? 'select' : 'create';
    // Outra ferramenta de criar: a seleção (alças e barra) sai da frente da página.
    if (tool.pointer !== 'select') selected = -1;
    addButton.disabled = !tool.keyboard;
    addButton.setAttribute('aria-label', tool.keyboard && tool.type ? `Novo: ${editType(tool.type).label.toLowerCase()} no meio da página` : 'Novo');
    render();
    if (announce) say(tool.hint);
  }

  toolbar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tool]');
    if (button) chooseTool(TOOLS.find(({ id }) => id === button.dataset.tool));
  });

  // ---------- Abrir, sair e caber na tela ----------

  /**
   * @param {object} target a página
   * @param {{blob: Blob, width: number, height: number, redactions: object[]}} base a página como vai sair no PDF,
   *   sem as edições; o tamanho dela em pontos; as tarjas de 0 a 1 nela (mostradas por cima das edições)
   * @param {() => boolean} still false se a pessoa já saiu da tela enquanto a imagem carregava
   */
  async function open(target, base, still = () => true) {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(base.blob);
    image.src = url;
    await image.decode().catch(() => {});
    if (!still()) return;
    page = target;
    size = { width: base.width, height: base.height };
    items = cloneEdits(page.edits);
    initial = JSON.stringify(items);
    history = [];
    selected = -1;
    drag = null;
    lastKey = null;
    cover.replaceChildren(...(base.redactions ?? []).map((rect) => {
      const box = el('div');
      place(box, rect);
      return box;
    }));
    surface.hidden = false;
    toolbar.hidden = false;
    actions.hidden = false;
    togglePanel(false);
    fit();
    chooseTool(tool, { announce: false }); // a ferramenta da página anterior continua (marcar ✓ em várias páginas)
    say(items.length
      ? 'Toque numa edição para selecionar, ou escolha uma ferramenta. O que você acrescenta fica fixo no PDF.'
      : 'Escolha uma ferramenta e desenhe na página. O que você acrescenta fica fixo no PDF.');
    toolButtons.find((button) => button.dataset.tool === tool.id)?.focus();
  }

  // Esconde o modo Editar, sem gravar nada.
  function close() {
    drag?.handler?.cancel?.();
    drag = null;
    page = null;
    items = [];
    history = [];
    selected = -1;
    surface.hidden = toolbar.hidden = actions.hidden = panel.hidden = true;
    boxes.replaceChildren();
    cover.replaceChildren();
    image.removeAttribute('src');
    if (url) URL.revokeObjectURL(url);
    url = '';
    canvas.width = canvas.height = 0;
  }

  const active = () => !!page && !surface.hidden;
  const dirty = () => active() && JSON.stringify(items) !== initial;

  // A área tem exatamente o tamanho da página na tela, como a das tarjas; o canvas, a densidade da tela.
  function fit() {
    if (!active()) return;
    const margin = 12;
    const scale = Math.min((stage.clientWidth - margin * 2) / size.width, (stage.clientHeight - margin * 2) / size.height);
    const width = Math.max(40, size.width * scale);
    const height = Math.max(40, size.height * scale);
    surface.style.width = `${width}px`;
    surface.style.height = `${height}px`;
    let ratio = window.devicePixelRatio || 1;
    if (width * height * ratio * ratio > MAX_PIXELS) ratio = Math.sqrt(MAX_PIXELS / (width * height));
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    render(-1, { keepFocus: true });
  }
  new ResizeObserver(fit).observe(stage);

  // ---------- Desenho e caixas ----------

  const place = (element, { x0, y0, x1, y1 }) => {
    element.style.left = `${x0 * 100}%`;
    element.style.top = `${y0 * 100}%`;
    element.style.width = `${(x1 - x0) * 100}%`;
    element.style.height = `${(y1 - y0) * 100}%`;
  };

  function paint() {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paintEdits(ctx, drag?.preview ? [...items, drag.preview] : items, size);
  }

  // Recria as caixas (grupos com foco) e, na selecionada, as alças e a barra de Remover e Duplicar.
  // focus: a posição da edição que recebe o foco.
  function render(focus = -1, { keepFocus = false } = {}) {
    if (!active()) return;
    paint();
    const had = keepFocus ? boxes.contains(document.activeElement) && Number(document.activeElement.closest('[data-index]')?.dataset.index) : null;
    const list = items.map((item, i) => {
      const type = typeOf(item);
      const box = el('div', {
        className: `edit-box${i === selected ? ' selected' : ''}`, tabIndex: 0, role: 'group', 'data-index': i,
        'aria-label': `${type.describe?.(item) ?? type.label} (edição ${i + 1} de ${items.length}): as setas movem, Shift e setas mudam o tamanho, Delete remove`,
      });
      place(box, item);
      if (i === selected) box.append(...handles(item));
      return box;
    });
    if (selected >= 0 && tool.pointer !== 'stroke') list.splice(selected + 1, 0, bar);
    boxes.replaceChildren(...list);
    if (selected >= 0) placeBar();
    undoButton.disabled = !history.length;
    const target = focus >= 0 ? focus : typeof had === 'number' ? had : -1;
    if (target >= 0) boxes.querySelector(`[data-index="${target}"]`)?.focus({ preventScroll: true });
    showProps();
  }

  // Alças de 44 px nos cantos. Caixa pequena na tela: só a de baixo à direita, por fora, para sobrar onde arrastar.
  function handles(item) {
    const small = Math.min((item.x1 - item.x0) * surface.clientWidth, (item.y1 - item.y0) * surface.clientHeight) < 56;
    return (small ? [2] : [0, 1, 2, 3]).map((corner) => el('span', {
      className: `edit-handle${small ? ' edit-handle-out' : ''}`, 'data-corner': corner, 'aria-hidden': 'true',
    }));
  }

  const bar = el('div', { className: 'edit-bar', role: 'group', 'aria-label': 'Edição selecionada' }, [
    el('button', { type: 'button', className: 'btn', 'data-act': 'remove' }, [icon('remove'), ' Remover']),
    el('button', { type: 'button', className: 'btn', 'data-act': 'duplicate' }, [icon('copy'), ' Duplicar']),
  ]);

  // A barra fica acima da edição; sem espaço, embaixo; sem espaço também, dentro dela, no alto. Sempre na página.
  function placeBar() {
    const item = items[selected];
    const width = surface.clientWidth;
    const height = surface.clientHeight;
    const gap = 8;
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    const top = item.y0 * height;
    const bottom = item.y1 * height;
    let y = top - h - gap;
    if (y < 0) y = bottom + gap + h <= height ? bottom + gap : Math.max(0, Math.min(height - h, top + gap));
    const x = Math.max(0, Math.min(width - w, ((item.x0 + item.x1) / 2) * width - w / 2));
    bar.style.left = `${x}px`;
    bar.style.top = `${y}px`;
  }

  // ---------- Mudanças (com Desfazer) ----------

  function remember() {
    history.push(cloneEdits(items));
    lastKey = null;
  }

  function select(index, { focus = false } = {}) {
    if (index === selected && !focus) return;
    selected = index;
    render(focus ? index : -1);
  }

  function add(item, message) {
    remember();
    items.push(item);
    selected = tool.pointer === 'stroke' ? -1 : items.length - 1;
    render(selected >= 0 ? selected : -1);
    say(message ?? `${done(typeOf(item), 'criad')}. ${items.length === 1 ? 'Toque em "Aplicar" quando terminar.' : `Ficam ${items.length} edições.`}`);
    return items.length - 1;
  }

  function replace(index, item) {
    remember();
    items[index] = item;
    render();
  }

  function remove(index) {
    const type = typeOf(items[index]);
    remember();
    items.splice(index, 1);
    selected = -1;
    render(Math.min(index, items.length - 1));
    if (!items.length) addButton.disabled ? toolButtons[0].focus() : addButton.focus();
    say(`${done(type, 'removid')}. ${items.length ? `Ficam ${items.length === 1 ? '1 edição' : `${items.length} edições`}.` : 'Nenhuma edição nesta página.'}`);
  }

  function duplicate(index) {
    remember();
    items.push(duplicateEdit(items[index]));
    selected = items.length - 1;
    render(selected);
    say(`${done(typeOf(items[selected]), 'duplicad')}: a cópia fica um pouco abaixo e à direita.`);
  }

  function undo() {
    if (!history.length) {
      say('Nada para desfazer.');
      return;
    }
    items = history.pop();
    selected = -1;
    lastInk = null;
    render();
    say(items.length ? 'Desfeito.' : 'Desfeito. Nenhuma edição nesta página.');
  }

  // Interface para as ferramentas das próximas fases (pointer, keyboard e open).
  const api = {
    get page() { return { ...size }; },
    get items() { return items; },
    get selected() { return selected; },
    props: () => propsFor(tool),
    add, replace, say,
    select: (index) => select(index, { focus: true }),
    point: (event) => pointIn(event),
    preview(item) {
      if (drag) drag.preview = item ?? undefined;
      paint();
    },
  };

  bar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (!button || selected < 0) return;
    if (button.dataset.act === 'remove') remove(selected);
    else duplicate(selected);
  });

  addButton.addEventListener('click', () => {
    if (!tool.keyboard) return;
    if (typeof tool.keyboard === 'function') {
      tool.keyboard(api);
      return;
    }
    const type = editType(tool.type);
    const box = boxAround(0.5, 0.5, type.size ?? [72, 72], size);
    add({ type: tool.type, ...type.create(box, propsFor(tool)) },
      `${done(type, 'criad')} no meio da página: as setas movem, Shift e setas mudam o tamanho, Delete remove.`);
  });
  undoButton.addEventListener('click', undo);
  $('#edit-cancel').addEventListener('click', async () => {
    if (dirty() && !(await confirm('As edições desta página ainda não foram aplicadas. Se sair agora, elas se perdem.'))) return;
    leave();
  });
  applyButton.addEventListener('click', async () => {
    if (!page) return;
    applyButton.disabled = true;
    say('Aplicando as edições…');
    try {
      await save(page, cloneEdits(items));
    } finally {
      applyButton.disabled = false;
    }
    leave();
  });

  // ---------- Teclado ----------

  boxes.addEventListener('focusin', (event) => {
    const box = event.target.closest('.edit-box');
    if (box && event.target === box && tool.pointer !== 'stroke') select(Number(box.dataset.index), { focus: Number(box.dataset.index) !== selected });
  });
  boxes.addEventListener('keydown', (event) => {
    const box = event.target.closest('.edit-box');
    if (!box || event.target !== box) return;
    const index = Number(box.dataset.index);
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove(index);
      return;
    }
    if (event.key === 'Enter') {
      const owner = toolOf(items[index]);
      if (owner?.open) {
        event.preventDefault();
        owner.open(api, index);
      }
      return;
    }
    const move = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] }[event.key];
    if (!move) return;
    event.preventDefault();
    const kind = event.shiftKey ? 'grow' : 'move';
    // As setas seguidas na mesma edição (até 1 s entre uma e outra) viram um passo só do Desfazer.
    const now = performance.now();
    if (!(lastKey && lastKey.index === index && lastKey.kind === kind && now - lastKey.time < 1000)) remember();
    lastKey = { index, kind, time: now };
    items[index] = kind === 'grow' ? growEdit(items[index], move[0], move[1], aspect()) : moveEdit(items[index], move[0], move[1]);
    selected = index;
    render(index);
  });
  // Ctrl+Z (⌘Z no Mac) desfaz, com o foco em qualquer lugar do modo Editar.
  surface.closest('dialog').addEventListener('keydown', (event) => {
    if (!active() || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== 'z') return;
    if (event.target.matches('input[type="text"], textarea')) return; // no texto, o Ctrl+Z é do campo
    event.preventDefault();
    undo();
  });

  /** Esc no modo Editar: fecha o painel ou para o traço em andamento. true se fez alguma coisa. */
  function escape() {
    if (!panel.hidden) {
      togglePanel(false);
      propsButton.focus();
      return true;
    }
    if (drag) {
      cancelDrag();
      return true;
    }
    return false;
  }

  // ---------- Ponteiro ----------
  // Um toque por vez. Caneta reconhecida: depois que ela aparece, o dedo não desenha (a palma da mão encostada na
  // tela). Os pontos intermediários que o navegador junta num evento só (getCoalescedEvents) entram no traço: no
  // iPhone, a curva sai lisa mesmo com o dedo rápido.

  function pointIn(event) {
    const box = surface.getBoundingClientRect();
    return [clamp01((event.clientX - box.left) / box.width), clamp01((event.clientY - box.top) / box.height)];
  }
  const screenDistance = ([ax, ay], [bx, by]) => Math.hypot((bx - ax) * surface.clientWidth, (by - ay) * surface.clientHeight);

  surface.addEventListener('pointerdown', (event) => {
    if (drag || !active() || event.button > 0 || event.target.closest('.edit-bar')) return;
    if (event.pointerType === 'pen') penSeen = true;
    if (tool.pointer === 'stroke' && event.pointerType === 'touch' && penSeen) return;
    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    const point = pointIn(event);
    const base = { id: event.pointerId, from: point, moved: false };
    const handle = event.target.closest('.edit-handle');
    const owner = event.target.closest('.edit-box');
    const index = owner ? Number(owner.dataset.index) : -1;
    if (tool.pointer === 'stroke') {
      drag = { ...base, kind: 'stroke', points: [point] };
      strokeStart(point);
    } else if (handle && index === selected) {
      drag = { ...base, kind: 'resize', corner: Number(handle.dataset.corner), start: items[index] };
    } else if (index >= 0 && (tool.pointer === 'select' || index === selected)) {
      drag = { ...base, kind: 'move', start: items[index], again: index === selected };
      select(index);
    } else if (tool.pointer === 'select') {
      select(-1);
      drag = null;
      surface.releasePointerCapture(event.pointerId);
    } else if (typeof tool.pointer === 'function') {
      drag = { ...base, kind: 'custom', handler: tool.pointer(api, point, event) ?? {} };
    } else {
      drag = { ...base, kind: 'create', to: point };
    }
  });

  surface.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    const point = pointIn(event);
    if (!drag.moved && screenDistance(drag.from, point) < TAP && drag.kind !== 'stroke') return;
    if (!drag.moved && (drag.kind === 'move' || drag.kind === 'resize')) remember();
    drag.moved = true;
    if (drag.kind === 'stroke') {
      const events = event.getCoalescedEvents?.() ?? [];
      for (const each of events.length ? events : [event]) strokeTo(pointIn(each));
    } else if (drag.kind === 'move') {
      items[selected] = moveEdit(drag.start, point[0] - drag.from[0], point[1] - drag.from[1]);
      render();
    } else if (drag.kind === 'resize') {
      items[selected] = resizeEdit(drag.start, drag.corner, point[0], point[1], aspect());
      render();
    } else if (drag.kind === 'create') {
      drag.to = point;
      drag.preview = created(drag.from, point, false);
      paint();
    } else {
      drag.handler.move?.(point, event);
    }
  });

  surface.addEventListener('pointerup', (event) => {
    if (drag?.id !== event.pointerId) return;
    const finished = drag;
    drag = null;
    const point = pointIn(event);
    if (finished.kind === 'stroke') {
      strokeTo(point);
      strokeEnd(finished.points);
    } else if (finished.kind === 'create') {
      const item = created(finished.from, point, !finished.moved);
      if (item) add(item);
      else {
        paint();
        const type = editType(tool.type);
        say(tool.pointer === 'line' ? 'Arraste para desenhar a seta: de onde ela sai até onde aponta.'
          : `Arraste sobre a página para desenhar ${type.gender === 'f' ? 'a' : 'o'} ${type.label.toLowerCase()}.`);
      }
    } else if (finished.kind === 'custom') {
      finished.handler.up?.(point, event);
    } else if (finished.moved) {
      const type = typeOf(items[selected]);
      say(finished.kind === 'move' ? `${done(type, 'movid')}.` : `${type.label}: tamanho mudado.`);
      render();
    } else if (finished.kind === 'move' && finished.again) {
      // Tocar de novo na edição selecionada faz o mesmo que Enter: a ferramenta dela reabre o painel (o do texto).
      toolOf(items[selected])?.open?.(api, selected);
    }
  });

  // O navegador cancelou o toque (rolagem do sistema, chamada): o que estava sendo arrastado volta ao lugar.
  function cancelDrag() {
    const finished = drag;
    drag = null;
    if (!finished) return;
    if ((finished.kind === 'move' || finished.kind === 'resize') && finished.moved) items = history.pop();
    if (finished.kind === 'custom') finished.handler.cancel?.();
    render();
  }
  surface.addEventListener('pointercancel', (event) => {
    if (drag?.id === event.pointerId) cancelDrag();
  });
  surface.addEventListener('lostpointercapture', (event) => {
    if (drag?.id === event.pointerId) cancelDrag();
  });

  // Edição criada pelo arrasto de a até b (ou pelo toque em a, quando tap). null: pequena demais.
  function created(a, b, tap) {
    const type = editType(tool.type);
    const props = propsFor(tool);
    if (tool.pointer === 'line') return tap ? null : arrowFromLine(a, b, props, size);
    if (tap) return tool.pointer === 'mark' ? { type: tool.type, ...type.create(boxAround(a[0], a[1], type.size ?? [24, 24], size), props) } : null;
    const box = normalizeBox({ x0: a[0], y0: a[1], x1: b[0], y1: b[1] });
    if ((box.x1 - box.x0) * size.width < 4 || (box.y1 - box.y0) * size.height < 4) return null;
    return { type: tool.type, ...type.create(box, props) };
  }

  // Traço à mão: desenhado direto no canvas enquanto o dedo anda (rápido), e de novo, liso, ao soltar.
  function strokeStart(point) {
    const ctx = canvas.getContext('2d');
    const k = canvas.width / size.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = current.width * k;
    ctx.strokeStyle = ctx.fillStyle = current.color;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.arc(point[0] * canvas.width, point[1] * canvas.height, (current.width * k) / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function strokeTo(point) {
    const points = drag?.points;
    if (!points) return;
    const last = points[points.length - 1];
    if (last[0] === point[0] && last[1] === point[1]) return;
    points.push(point);
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(last[0] * canvas.width, last[1] * canvas.height);
    ctx.lineTo(point[0] * canvas.width, point[1] * canvas.height);
    ctx.stroke();
  }

  function strokeEnd(points) {
    const stroke = prepareStroke(points, size);
    const props = propsFor(tool);
    const near = lastInk && items.includes(lastInk) && !lastInk.turn && lastInk.color === props.color && lastInk.width === props.width
      && nearBox(stroke, lastInk);
    if (near) {
      const index = items.indexOf(lastInk);
      remember();
      items[index] = lastInk = inkFromStrokes([...inkStrokes(lastInk), stroke], props, size);
      render();
      say('Traço acrescentado ao desenho.');
      return;
    }
    lastInk = inkFromStrokes([stroke], props, size);
    add(lastInk, 'Desenho criado. Os próximos traços perto dele entram no mesmo desenho. Toque em "Aplicar" quando terminar.');
  }

  // O traço passa perto (INK_JOIN pontos) da caixa do desenho?
  function nearBox(stroke, item) {
    const dx = INK_JOIN / size.width;
    const dy = INK_JOIN / size.height;
    return stroke.some(([x, y]) => x >= item.x0 - dx && x <= item.x1 + dx && y >= item.y0 - dy && y <= item.y1 + dy);
  }

  return { open, close, active, dirty, escape, fit };
}
