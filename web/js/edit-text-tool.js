// Ferramenta Texto do modo Editar (editor.js), carregada pela lista TOOL_MODULES. O texto é escrito num painel que
// abre de baixo e fica acima do teclado virtual (keyboard-panel.js): textarea com letra de 16 px (abaixo disso o iPhone
// dá zoom), tamanho, letra e cor. "Pôr na página" cria a caixa onde a pessoa tocou, ou no meio da página pelo "Novo";
// Enter na caixa, ou um toque a mais nela, reabre o painel. A caixa anda e muda de tamanho como as outras edições.
// Letra que as fontes do PDF não têm (emoji, alfabetos não latinos) é avisada na hora e não entra (edit-text.js).
// O que a pessoa escreve fica só na memória da aba.
import { registerTool, propertyOf } from './editor.js';
import { winAnsiText, droppedMessage, textEdit, retext, editTextSize, TEXT_FAMILIES, TEXT_SIZES, TEXT_MAX } from './edit-text.js';
import { followKeyboard } from './keyboard-panel.js';
import { t } from './i18n.js';

const state = { size: 14, family: 'sans', color: '#000000' }; // a última escolha, para o próximo texto
let ui = null; // o painel, montado na primeira vez
let target = null; // {api, index, at}: a edição que o painel muda (index -1: texto novo, no ponto at)
let stop = null; // para de acompanhar o teclado
let before = null; // o que tinha o foco antes de o painel abrir

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (/^(aria|data)-/.test(key) || key === 'role') node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

function build() {
  const viewer = document.querySelector('#viewer');
  const title = el('p', { id: 'text-panel-title', className: 'edit-props-title' });
  const area = el('textarea', {
    id: 'text-input', className: 'text-input', rows: 3, maxLength: TEXT_MAX, spellcheck: true,
    'aria-labelledby': 'text-panel-title', 'aria-describedby': 'text-warning',
  });
  const warning = el('p', { id: 'text-warning', className: 'field-note text-warning', role: 'status' });
  const size = el('select', { id: 'text-size' }, TEXT_SIZES.map((value) => el('option', { value: String(value), textContent: `${value} pt` })));
  const family = el('select', { id: 'text-family' }, Object.entries(TEXT_FAMILIES).map(([value, name]) => el('option', { value, textContent: name })));
  const colors = el('fieldset', { className: 'edit-prop edit-prop-swatch' }, [
    el('legend', { textContent: t('Cor') }),
    ...propertyOf('color').options.map(([value, name]) => {
      const sample = el('span', { className: 'edit-sample', 'aria-hidden': 'true' });
      sample.style.background = value;
      return el('label', { className: 'edit-option', title: name }, [
        el('input', { type: 'radio', name: 'text-color', value }), sample, el('span', { className: 'sr-only', textContent: name }),
      ]);
    }),
  ]);
  const cancel = el('button', { type: 'button', className: 'btn', textContent: t('Cancelar') });
  const put = el('button', { type: 'button', id: 'text-put', className: 'btn btn-primary' });
  const panel = el('section', { id: 'text-panel', className: 'text-panel', role: 'group', 'aria-labelledby': 'text-panel-title', hidden: true }, [
    title, area, warning,
    el('div', { className: 'text-options' }, [
      el('label', { className: 'field' }, [el('span', { textContent: t('Tamanho') }), size]),
      el('label', { className: 'field' }, [el('span', { textContent: t('Letra') }), family]),
      colors,
    ]),
    el('div', { className: 'sheet-actions' }, [cancel, put]),
  ]);
  viewer.append(panel);

  // Só as letras que as fontes do PDF têm: o resto sai na hora, com o aviso, e o cursor fica onde estava.
  area.addEventListener('input', () => {
    const { text, dropped } = winAnsiText(area.value);
    if (text !== area.value) {
      const caret = winAnsiText(area.value.slice(0, area.selectionStart)).text.length;
      area.value = text;
      area.setSelectionRange(caret, caret);
    }
    // O aviso fica até a próxima letra recusada (ou até o painel abrir de novo): digitando rápido, dá para ler.
    if (dropped.length) warning.textContent = droppedMessage(dropped);
  });
  // Ctrl+Enter (⌘Enter no Mac) põe na página; Enter sozinho quebra a linha.
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      apply();
    }
  });
  put.addEventListener('click', apply);
  cancel.addEventListener('click', () => close(true));
  // Esc fecha só o painel (antes que a tela cheia pergunte se descarta as edições).
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel.hidden || !event.target.closest?.('#viewer')) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }, true);
  // O modo Editar fechou (Aplicar, Cancelar, outra página): o painel fecha junto, sem guardar nada.
  const surface = document.querySelector('#edit');
  new MutationObserver(() => {
    if (surface.hidden) close(false);
  }).observe(surface, { attributes: true, attributeFilter: ['hidden'] });
  return { panel, title, area, warning, size, family, colors, put };
}

// O tamanho da lista mais perto do tamanho de agora (a caixa pode ter sido aumentada pelas alças).
const nearest = (value) => TEXT_SIZES.reduce((best, size) => (Math.abs(size - value) < Math.abs(best - value) ? size : best));

function open(api, index = -1, at = null) {
  ui ??= build();
  const item = index >= 0 ? api.items[index] : null;
  const wasOpen = !ui.panel.hidden;
  // Painel aberto para um texto novo e um toque em outro lugar: o texto escrito continua, e vai para o lugar novo.
  if (!(wasOpen && target?.index < 0 && !item)) ui.area.value = item?.text ?? '';
  target = { api, index, at };
  ui.size.value = String(nearest(item ? editTextSize(item, api.page) : state.size));
  ui.family.value = item?.family ?? state.family;
  const color = item?.color ?? state.color;
  for (const input of ui.colors.querySelectorAll('input')) input.checked = input.value === color;
  ui.title.textContent = item ? t('Mudar o texto') : t('Texto novo');
  ui.put.textContent = item ? t('Trocar o texto') : t('Pôr na página');
  ui.warning.textContent = '';
  if (!wasOpen) {
    before = document.activeElement;
    ui.panel.hidden = false;
    stop = followKeyboard(ui.panel);
  }
  ui.area.focus();
  api.say(item ? t('Mude o texto e toque em "Trocar o texto".') : t('Escreva o texto e toque em "Pôr na página".'));
}

function close(restore) {
  if (!ui || ui.panel.hidden) return;
  ui.panel.hidden = true;
  stop?.();
  stop = null;
  target = null;
  if (restore && before?.isConnected) before.focus();
  before = null;
}

function apply() {
  if (!target) return;
  const text = ui.area.value.replace(/^\n+/, '').replace(/\s+$/, '');
  if (!text.trim()) {
    ui.warning.textContent = t('Escreva o texto antes.');
    ui.area.focus();
    return;
  }
  const content = {
    text, size: Number(ui.size.value), family: ui.family.value,
    color: ui.colors.querySelector('input:checked')?.value ?? state.color,
  };
  Object.assign(state, { size: content.size, family: content.family, color: content.color });
  const { api, index, at } = target;
  close(false);
  if (index >= 0) {
    api.replace(index, retext(api.items[index], content, api.page));
    api.select(index);
    api.say(t('Texto trocado.'));
  } else {
    api.add(textEdit(content, at ?? [0.5, 0.5], api.page), t('Texto na página. Para mudar, toque nele de novo ou use Enter.'));
  }
}

registerTool({
  id: 'text', after: 'select', label: t('Texto'), icon: 'text', type: 'text', props: [],
  // Tocar na página abre o painel para um texto novo naquele ponto; tocar num texto abre o painel com ele.
  pointer(api, point, event) {
    const box = event.target.closest?.('.edit-box');
    const index = box ? Number(box.dataset.index) : -1;
    return { up: () => (index >= 0 && api.items[index]?.type === 'text' ? open(api, index) : open(api, -1, point)) };
  },
  keyboard: (api) => open(api),
  open: (api, index) => open(api, index),
  hint: t('Toque onde vai o texto, ou use "Novo" para pôr no meio da página.'),
});
