// "Em todas as páginas" (all-pages.js): numerar as páginas ("1", "1 de 7" ou "Página 1 de 7"), cabeçalho e rodapé.
// A numeração usa a grade de seis lugares do carimbo; cabeçalho e rodapé ficam na linha de cima e na de baixo, à
// esquerda, no centro ou à direita. As edições saem de allPagesText (edit-text.js), contando dentro de cada arquivo.
// O texto e as escolhas ficam só na memória da aba.
import { addAllPagesOption, spotGrid } from './all-pages.js';
import { allPagesText, NUMBER_FORMATS, winAnsiText, droppedMessage } from './edit-text.js';
import { t } from './i18n.js';

const settings = {
  number: { on: false, format: 'n-of', spot: 'bottom-right' },
  header: { on: false, text: '', align: 'center' },
  footer: { on: false, text: '', align: 'center' },
};
const ALIGN = { left: t('À esquerda'), center: t('No centro'), right: t('À direita') };

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (/^(aria|data)-/.test(key) || key === 'role') node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

// O que está ligado, no formato de allPagesText.
const chosen = () => ({
  number: settings.number.on ? { format: settings.number.format, spot: settings.number.spot } : undefined,
  header: settings.header.on ? { text: settings.header.text, spot: `top-${settings.header.align}` } : undefined,
  footer: settings.footer.on ? { text: settings.footer.text, spot: `bottom-${settings.footer.align}` } : undefined,
});

// Caixa de marcar com os detalhes logo abaixo, que só aparecem com ela ligada.
function group(id, label, details, onToggle) {
  const input = el('input', { type: 'checkbox', id });
  const detail = el('div', { className: 'all-pages-detail', hidden: true }, details);
  input.addEventListener('change', () => {
    detail.hidden = !input.checked;
    onToggle(input.checked);
  });
  return el('div', { className: 'all-pages-group' }, [el('label', { className: 'check' }, [input, ` ${label}`]), detail]);
}

// Cabeçalho ou rodapé: texto livre, só com as letras das fontes do PDF, e o alinhamento.
function lineGroup(key, label, textLabel, changed) {
  const part = settings[key];
  const note = el('p', { className: 'field-note', role: 'status' });
  const input = el('input', { type: 'text', id: `${key}-text`, maxLength: 120, autocomplete: 'off', spellcheck: true });
  input.addEventListener('input', () => {
    const { text, dropped } = winAnsiText(input.value.replace(/\n/g, ' '));
    if (text !== input.value) {
      const caret = winAnsiText(input.value.slice(0, input.selectionStart)).text.length;
      input.value = text;
      input.setSelectionRange(caret, caret);
    }
    if (dropped.length) note.textContent = droppedMessage(dropped); // fica até a próxima letra recusada
    part.text = text;
    changed();
  });
  const align = el('select', { id: `${key}-align` }, Object.entries(ALIGN).map(([value, name]) => el('option', { value, textContent: name, selected: value === part.align })));
  align.addEventListener('change', () => {
    part.align = align.value;
    changed();
  });
  return group(`${key}-on`, label, [
    el('label', { className: 'field' }, [el('span', { textContent: textLabel }), input]),
    note,
    el('label', { className: 'field' }, [el('span', { textContent: t('Alinhamento') }), align]),
  ], (on) => {
    part.on = on;
    changed();
    if (on) input.focus();
  });
}

addAllPagesOption({
  id: 'texto',
  build(container, changed) {
    const format = el('select', { id: 'number-format' }, Object.entries(NUMBER_FORMATS).map(([value, name]) => el('option', { value, textContent: name, selected: value === settings.number.format })));
    format.addEventListener('change', () => {
      settings.number.format = format.value;
      changed();
    });
    const grid = el('div', { className: 'stamp-grid' });
    spotGrid(grid, 'number-spot', settings.number.spot);
    grid.addEventListener('change', (event) => {
      settings.number.spot = event.target.value;
      changed();
    });
    container.append(
      group('number-on', t('Numerar as páginas'), [
        el('label', { className: 'field' }, [el('span', { textContent: t('Formato') }), format]),
        el('fieldset', { className: 'stamp-positions' }, [el('legend', { textContent: t('Lugar na página') }), grid]),
        el('p', { className: 'field-note', textContent: t('Cada PDF gerado começa do 1, também com "um PDF por página" e por intervalos.') }),
      ], (on) => {
        settings.number.on = on;
        changed();
      }),
      lineGroup('header', t('Cabeçalho'), t('Texto do cabeçalho'), changed),
      lineGroup('footer', t('Rodapé'), t('Texto do rodapé'), changed),
    );
  },
  active: () => settings.number.on || (settings.header.on && !!settings.header.text.trim()) || (settings.footer.on && !!settings.footer.text.trim()),
  produce: (context) => allPagesText(chosen(), context),
});
