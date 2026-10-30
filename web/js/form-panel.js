// Modo "Preencher" da tela cheia (#15, fase 5.3): os campos do formulário da página, um por vez, com os controles do
// próprio navegador, num painel que abre de baixo e fica acima do teclado virtual (keyboard-panel.js). Carregado na
// primeira vez que a pessoa toca em "Preencher" (viewer.js).
//
// A página aparece como vai sair, com uma caixa sobre cada campo: tocar numa caixa escolhe o campo. O campo em foco
// aparece ampliado e destacado na parte de cima da tela ("Mostrar na página"). Anterior e Próximo andam pelos campos
// em ordem de leitura, com o contador ("12 de 34"); Enter vai para o próximo. Nada muda no PDF até "Aplicar": os
// valores ficam num rascunho, e Cancelar ou Esc com mudança perguntam antes. Obrigatório vazio é avisado ao aplicar,
// sem bloquear.
// Formatos do Acrobat (pdf-form-format.js): a dica e o teclado do celular seguem o formato, o valor é formatado ao sair
// do campo, e o que não serve para o formato é avisado, sem bloquear.
// Privacidade: os controles ficam fora de <form>, sem name (menos os rádios, que precisam do grupo para as setas e o
// leitor de tela) e com o preenchimento automático e o corretor desligados. Os valores ficam só na memória da aba.
import { counterText, inputHints, formatTyped, requiredEmpty, optionLabels } from './pdf-form.js';
import { toRotatedRects } from './redact.js';
import { winAnsiText, droppedMessage } from './edit-text.js';
import { followKeyboard } from './keyboard-panel.js';
import { t } from './i18n.js';

const $ = (selector) => document.querySelector(selector);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (/^(aria|data)-/.test(key) || key === 'role') node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children.filter((child) => child != null));
  return node;
}

// Por que o campo não pode ser preenchido (field.reason, em pdf-form.js).
const REASONS = {
  signature: t('Campo de assinatura: para assinar, use "Assinar com certificado digital" depois de preencher.'),
  password: t('Campo de senha: o app não preenche.'),
  file: t('Campo para anexar um arquivo: o app não preenche.'),
  readOnly: t('Somente leitura: o formulário não deixa mudar este campo.'),
  locked: t('Travado pela assinatura que o PDF já tem.'),
  xfa: t('Formulário XFA: só o Adobe Reader preenche.'),
};
const CALCULATED = t('O formulário fazia esta conta sozinho, mas aqui ela não é feita: confira o valor.');
const CLIPPED = t('O texto não cabe no campo: a letra diminui até 6 pt e o fim sai cortado.');
const MAX_ZOOM = 4;

/**
 * @param {object} deps
 * @param {HTMLElement} deps.stage o palco da tela cheia
 * @param {HTMLElement} deps.hint a dica da tela cheia (role="status")
 * @param {(page, changes: Map<number, unknown>, problems: {empty: string[], invalid: string[]}) => Promise<string>}
 *   deps.save grava os valores (por id do campo) e devolve o aviso para a tela; empty: os rótulos dos obrigatórios que
 *   ficaram vazios; invalid: os dos que não servem para o formato e saem como digitados
 * @param {(message: string) => Promise<boolean>} deps.confirm pergunta antes de descartar
 * @param {(message?: string) => void} deps.leave volta para a página como vai sair, com o aviso
 * @param {(page) => Promise<object[] | null>} deps.textItems o texto da página (para os rótulos), ou null
 */
export function setupFill({ stage, hint, save, confirm, leave, textItems }) {
  const surface = $('#fill');
  const image = $('#fill-image');
  const boxes = $('#fill-boxes');
  const panel = $('#fill-panel');
  const count = $('#fill-count');
  const holder = $('#fill-field');
  const note = $('#fill-note');
  const prevButton = $('#fill-prev');
  const nextButton = $('#fill-next');
  const zoomButton = $('#fill-zoom');
  const applyButton = $('#fill-apply');

  let page = null;
  let form = null;
  let index = 0; // a página no PDF de origem
  let fields = []; // os campos da página, em ordem de leitura
  let current = -1;
  let draft = new Map(); // id → valor no painel, ainda não gravado
  let labels = new Map(); // id → rótulo
  let items = []; // o texto da página (os rótulos das opções)
  let size = { width: 595.28, height: 841.89 }; // a página como aparece, em pontos
  let rotation = 0;
  let zoom = true;
  let url = '';
  let stop = null;
  let control = null; // o controle do campo atual (no rádio, o fieldset)
  let message = ''; // aviso das letras recusadas, até o campo mudar (select)
  let warnings = new Map(); // id → aviso do valor que não serve para o formato (sai como digitado)

  const active = () => !!page && !surface.hidden;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const valueOf = (field) => (draft.has(field.id) ? draft.get(field.id) : form.value(field.id));
  const dirty = () => active() && [...draft].some(([id, value]) => !same(value, form.value(id)));
  const say = (text) => { hint.textContent = text; };

  async function open(target, base, still = () => true) {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(base.blob);
    image.src = url;
    await image.decode().catch(() => {});
    if (!still()) return;
    page = target;
    form = base.form;
    index = base.index;
    rotation = base.rotation ?? 0;
    size = { width: base.width, height: base.height };
    fields = form.pageFields(index);
    draft = new Map();
    warnings = new Map();
    labels = new Map(fields.map((field) => [field.id, field.label]));
    items = [];
    current = -1;
    message = '';
    zoom = true;
    surface.hidden = false;
    panel.hidden = false;
    stage.classList.add('filling');
    stop = followKeyboard(panel);
    drawBoxes();
    say(t('Toque num campo da página ou use Anterior e Próximo. Os valores ficam fixos no PDF.'));
    select(0);
    // Rótulos pelo texto em volta do campo (PDF.js): chegam depois; até lá (ou sem eles), o /TU ou o nome do campo.
    textItems(target).then((list) => {
      if (page !== target || !list?.length) return;
      items = list;
      labels = form.pageLabels(index, list);
      const focused = holder.contains(document.activeElement);
      renderControl({ focus: focused });
    }, () => {});
  }

  // Esconde o modo Preencher, sem gravar nada.
  function close() {
    stop?.();
    stop = null;
    page = null;
    form = null;
    fields = [];
    draft = new Map();
    warnings = new Map();
    control = null;
    surface.hidden = true;
    panel.hidden = true;
    stage.classList.remove('filling');
    stage.style.paddingBottom = '';
    stage.scrollTo(0, 0); // a página ampliada rolou o palco: a próxima tela começa do zero
    boxes.replaceChildren();
    holder.replaceChildren();
    note.textContent = '';
    image.removeAttribute('src');
    if (url) URL.revokeObjectURL(url);
    url = '';
  }

  // ---------- Caixas sobre a página ----------

  const place = (element, { x0, y0, x1, y1 }) => {
    element.style.left = `${x0 * 100}%`;
    element.style.top = `${y0 * 100}%`;
    element.style.width = `${(x1 - x0) * 100}%`;
    element.style.height = `${(y1 - y0) * 100}%`;
  };
  // O widget na página como aparece no app (com o giro escolhido na lista).
  const boxOf = (widget) => toRotatedRects([widget.box], rotation)[0];

  // Uma caixa por widget, só para o toque e o mouse: pelo teclado e pelo leitor de tela, o caminho é o painel.
  function drawBoxes() {
    boxes.replaceChildren(...fields.flatMap((field, i) => field.widgets.filter((w) => w.page === index).map((widget) => {
      const box = el('div', { className: 'fill-box', 'aria-hidden': 'true', 'data-field': String(i), 'data-state': widget.onState ?? '' });
      place(box, boxOf(widget));
      return box;
    })));
    markBoxes();
  }

  function markBoxes() {
    for (const box of boxes.children) {
      const field = fields[Number(box.dataset.field)];
      box.classList.toggle('current', Number(box.dataset.field) === current);
      box.classList.toggle('filled', draft.has(field.id) && !same(draft.get(field.id), form.value(field.id)));
      box.classList.toggle('locked', !field.editable);
      box.classList.toggle('warning', warnings.has(field.id));
    }
  }

  boxes.addEventListener('click', (event) => {
    const box = event.target.closest('.fill-box');
    if (!box || !active()) return;
    select(Number(box.dataset.field), { option: box.dataset.state });
  });

  // ---------- Campo atual ----------

  // Vai para o campo i (o valor do que estava aberto já fica no rascunho, formatado). option: o estado da caixa ou do
  // rádio tocado na página, que recebe o foco.
  function select(i, { option = null, focus = true } = {}) {
    if (!fields.length) return;
    commit();
    current = Math.max(0, Math.min(fields.length - 1, i));
    message = '';
    count.textContent = counterText(current + 1, fields.length);
    prevButton.disabled = current === 0;
    nextButton.disabled = current === fields.length - 1;
    renderControl({ focus, option });
    markBoxes();
    requestAnimationFrame(layout);
  }

  function renderControl({ focus = false, option = null } = {}) {
    const field = fields[current];
    if (!field) return;
    const label = labels.get(field.id) || field.label;
    const required = field.required && field.editable ? el('span', { className: 'fill-required', textContent: t('obrigatório') }) : null;
    const value = valueOf(field);
    const disabled = !field.editable;
    const common = (node) => {
      node.id = 'fill-input';
      node.disabled = disabled;
      node.setAttribute('aria-describedby', 'fill-count fill-note');
      if (field.required && field.editable) node.setAttribute('aria-required', 'true');
      return node;
    };
    let parts;
    let target;
    if (field.kind === 'signature') {
      // Assinatura: só o rótulo e o aviso (a assinatura entra pelo "Assinar com certificado digital").
      target = null;
      parts = [el('p', { className: 'fill-label', textContent: label })];
    } else if (field.kind === 'checkbox' && field.options.length <= 1) {
      // Caixa de marcar: o rótulo ao lado, alvo de 44 px.
      target = common(el('input', { type: 'checkbox', checked: value != null && value !== false }));
      parts = [el('label', { className: 'check' }, [target, el('span', { textContent: label }), required])];
    } else if (field.kind === 'radio' || field.kind === 'checkbox') {
      // Rádio (ou caixas que se excluem): um grupo, com a legenda, e "Nenhuma" para desmarcar.
      const names = optionLabels(field, index, items);
      const choices = [...field.options.map((o) => [o.value, names.get(o.value) ?? o.label]), [null, t('Nenhuma')]];
      const inputs = choices.map(([state, text]) => {
        const input = el('input', { type: 'radio', name: 'fill-choice', checked: (value ?? null) === state, disabled });
        input.dataset.state = state ?? '';
        input.setAttribute('aria-describedby', 'fill-count fill-note');
        return el('label', { className: 'check' }, [input, el('span', { textContent: text })]);
      });
      target = el('fieldset', { id: 'fill-input' }, [el('legend', {}, [label, required]), ...inputs]);
      if (field.required && field.editable) target.setAttribute('aria-required', 'true');
      parts = [target];
    } else if (field.kind === 'list' || (field.kind === 'combo' && !field.custom)) {
      target = common(el('select', { className: 'fill-input', multiple: field.multiSelect }));
      const chosen = new Set(Array.isArray(value) ? value : [value]);
      if (!field.multiSelect) target.append(el('option', { value: '', textContent: t('Nenhuma') }));
      target.append(...field.options.map((o) => el('option', { value: o.value, textContent: o.label, selected: chosen.has(o.value) })));
      if (field.multiSelect) target.size = Math.min(6, Math.max(2, field.options.length));
      parts = [el('label', { className: 'fill-label', htmlFor: 'fill-input' }, [label, required]), target];
    } else {
      // Texto (uma linha, várias linhas ou pente), lista suspensa com texto livre e os que não dá para preencher.
      const hints = field.kind === 'text' ? inputHints(field) : { placeholder: '', inputMode: 'text', maxLength: null };
      target = common(field.multiline ? el('textarea', { className: 'fill-input', rows: 3 }) : el('input', { type: 'text', className: 'fill-input' }));
      target.value = typeof value === 'string' ? value : '';
      target.autocomplete = 'off';
      target.spellcheck = false;
      target.setAttribute('autocorrect', 'off');
      if (field.format) target.setAttribute('autocapitalize', 'off');
      target.inputMode = hints.inputMode;
      if (hints.placeholder) target.placeholder = hints.placeholder;
      if (hints.maxLength) target.maxLength = hints.maxLength;
      parts = [el('label', { className: 'fill-label', htmlFor: 'fill-input' }, [label, required]), target];
      if (field.kind === 'combo') {
        const list = el('datalist', { id: 'fill-options' }, field.options.map((o) => el('option', { value: o.value, label: o.label })));
        target.setAttribute('list', 'fill-options');
        parts.push(list);
      }
    }
    holder.replaceChildren(...parts);
    control = target;
    showNote();
    relayout(); // o painel pode ter mudado de altura
    if (!focus || !target) return;
    const focusable = field.kind === 'radio' || (field.kind === 'checkbox' && field.options.length > 1)
      ? [...target.querySelectorAll('input')].find((input) => input.dataset.state === (option ?? valueOf(field) ?? '')) ?? target.querySelector('input')
      : target;
    focusable?.focus({ preventScroll: true });
  }

  // O aviso do campo: as letras recusadas (até o campo mudar), o valor que não serve para o formato, o texto que não
  // cabe, o motivo de não dar para preencher e o campo calculado.
  function showNote() {
    const field = fields[current];
    let text = message || (field ? warnings.get(field.id) ?? '' : '');
    let warning = !!text;
    if (!text && field && !field.editable) text = REASONS[field.reason] ?? REASONS.readOnly;
    if (!text && field?.editable && (field.kind === 'text' || field.kind === 'combo')) {
      const value = valueOf(field);
      if (typeof value === 'string' && value && form.check(field.id, value).clipped) {
        text = CLIPPED;
        warning = true;
      }
    }
    if (!text && field?.calculated) text = CALCULATED;
    note.textContent = text;
    note.dataset.kind = warning ? 'warning' : '';
  }

  // O valor do controle vai para o rascunho; no texto, formatado ao sair do campo.
  function commit() {
    const field = fields[current];
    if (!field || !control || !field.editable) return;
    if (field.kind === 'text' || (field.kind === 'combo' && field.custom)) {
      const typed = control.value;
      const result = field.kind === 'text' ? formatTyped(field, typed) : { ok: true, text: typed };
      if (result.text !== typed) control.value = result.text;
      draft.set(field.id, result.text);
      if (result.ok) warnings.delete(field.id);
      else warnings.set(field.id, t('{problem} Ele sai como foi digitado.', { problem: result.message ?? t('O valor não serve para o formato do formulário.') }));
    }
  }

  holder.addEventListener('input', (event) => {
    const field = fields[current];
    if (!field || event.target.type === 'radio' || event.target.type === 'checkbox' || event.target.tagName === 'SELECT') return;
    // Só as letras que as fontes do PDF têm: o resto sai na hora, com o aviso, e o cursor fica onde estava.
    const input = event.target;
    const { text, dropped } = winAnsiText(input.value);
    const clean = field.multiline ? text : text.replace(/\n/g, ' ');
    if (clean !== input.value) {
      const caret = winAnsiText(input.value.slice(0, input.selectionStart ?? input.value.length)).text.length;
      input.value = clean;
      input.setSelectionRange?.(caret, caret);
    }
    draft.set(field.id, clean);
    warnings.delete(field.id); // o aviso do formato volta ao sair do campo, se ainda valer
    // O aviso das letras recusadas fica até o campo mudar: digitando rápido, dá para ler.
    if (dropped.length) message = droppedMessage(dropped);
    showNote();
    markBoxes();
  });

  holder.addEventListener('change', (event) => {
    const field = fields[current];
    if (!field?.editable) return;
    const input = event.target;
    if (input.type === 'checkbox') draft.set(field.id, input.checked ? field.options[0]?.value ?? null : null);
    else if (input.type === 'radio') draft.set(field.id, input.dataset.state || null);
    else if (input.tagName === 'SELECT') {
      draft.set(field.id, input.multiple ? [...input.selectedOptions].map((o) => o.value) : input.value);
    } else {
      commit(); // texto: formatado ao sair do campo
      showNote();
    }
    markBoxes();
  });

  // Enter vai para o próximo campo (no texto de várias linhas, Ctrl+Enter ou ⌘Enter: o Enter quebra a linha).
  holder.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    if (event.target.tagName === 'TEXTAREA' && !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (current < fields.length - 1) select(current + 1);
    else {
      commit();
      showNote();
      applyButton.focus();
    }
  });

  prevButton.addEventListener('click', () => select(current - 1));
  nextButton.addEventListener('click', () => select(current + 1));
  zoomButton.addEventListener('click', () => {
    zoom = !zoom;
    zoomButton.setAttribute('aria-pressed', String(zoom));
    layout();
  });

  // ---------- Página ampliada no campo ----------

  // A página cabe no que sobra do palco acima do painel; com "Mostrar na página", amplia até o campo em foco ficar
  // legível (até 4×) e rola até ele.
  function layout() {
    if (!active()) return;
    const frame = stage.getBoundingClientRect();
    const covered = Math.max(0, Math.min(frame.height, frame.bottom - panel.getBoundingClientRect().top));
    stage.style.paddingBottom = `${covered + 8}px`;
    const width = stage.clientWidth - 16;
    const height = Math.max(40, stage.clientHeight - covered - 16);
    const fit = Math.min(width / size.width, height / size.height);
    const field = fields[current];
    const widget = field?.widgets.find((w) => w.page === index);
    const box = widget ? boxOf(widget) : null;
    let scale = 1;
    if (zoom && box) {
      const w = (box.x1 - box.x0) * size.width * fit;
      const h = (box.y1 - box.y0) * size.height * fit;
      scale = Math.max(1, Math.min(MAX_ZOOM, (width * 0.85) / Math.max(w, 1), (height * 0.45) / Math.max(h, 1)));
    }
    surface.style.width = `${Math.max(40, size.width * fit * scale)}px`;
    surface.style.height = `${Math.max(40, size.height * fit * scale)}px`;
    if (!box) return;
    // O centro do campo, na área que rola do palco.
    const shown = surface.getBoundingClientRect();
    const cx = shown.left - frame.left + stage.scrollLeft + ((box.x0 + box.x1) / 2) * shown.width;
    const cy = shown.top - frame.top + stage.scrollTop + ((box.y0 + box.y1) / 2) * shown.height;
    stage.scrollTo({ left: cx - stage.clientWidth / 2, top: cy - (stage.clientHeight - covered) / 2 });
  }
  // No quadro seguinte, fora do aviso do ResizeObserver (como no editor.js); o observador também começa no quadro
  // seguinte, pelo mesmo motivo do editor.js (módulo carregado sob demanda). O painel muda de altura com o controle do
  // campo e sobe com o teclado virtual: renderControl e o resize do visualViewport refazem a página.
  const relayout = () => requestAnimationFrame(layout);
  requestAnimationFrame(() => new ResizeObserver(relayout).observe(stage));
  window.visualViewport?.addEventListener('resize', relayout);
  window.addEventListener('resize', relayout);

  // ---------- Aplicar e Cancelar ----------

  applyButton.addEventListener('click', async () => {
    if (!page) return;
    commit();
    const changes = new Map([...draft].filter(([id, value]) => !same(value, form.value(id))));
    // Os avisos vão com os rótulos do painel (o texto da página em volta do campo, quando o PDF não tem /TU).
    const named = (list) => list.map((field) => labels.get(field.id) || field.label);
    const empty = named(requiredEmpty(fields, valueOf));
    const invalid = named(fields.filter((field) => warnings.has(field.id) && changes.has(field.id)));
    applyButton.disabled = true;
    say(t('Aplicando os valores…'));
    let result = '';
    try {
      result = await save(page, changes, { empty, invalid });
    } finally {
      applyButton.disabled = false;
    }
    leave(result);
  });
  $('#fill-cancel').addEventListener('click', async () => {
    if (dirty() && !(await confirm(t('Os valores desta página ainda não foram aplicados. Se sair agora, eles se perdem.')))) return;
    leave();
  });

  /** Esc no modo Preencher: nada a fechar antes (o viewer pergunta se há valor não aplicado). */
  const escape = () => false;

  return { open, close, active, dirty, escape };
}
