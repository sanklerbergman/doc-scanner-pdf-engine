// Marca d'água "em todas as páginas" (all-pages.js): "CÓPIA", "CONFIDENCIAL" ou um texto livre, na diagonal de cada
// página, cinza e transparente. O desenho e os operadores do PDF ficam em edit-marks.js. Importado por app.js.
import { addAllPagesOption } from './all-pages.js';
import { winAnsiCode } from './fonts.js';
import { watermarkEdit, watermarkText, WATERMARK_MAX } from './edit-marks.js';
import { t } from './i18n.js';

// O texto vai para o PDF no idioma da página ("COPY" no /en/).
const PRESETS = [t('CÓPIA'), t('CONFIDENCIAL')];

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

let toggle = null; // a caixa "Marca d'água"
let chosen = () => '';

addAllPagesOption({
  id: 'watermark',
  build(container, changed) {
    toggle = el('input', { type: 'checkbox', id: 'watermark', 'aria-describedby': 'watermark-note' });
    const note = el('p', {
      id: 'watermark-note', className: 'field-note',
      textContent: t('Texto grande na diagonal de cada página, claro e transparente: o que está embaixo continua legível.'),
    });
    const radios = [...PRESETS, ''].map((value, i) => el('label', { className: 'check' }, [
      el('input', { type: 'radio', name: 'watermark-text', value, checked: i === 0 }),
      value || t('Outro texto'),
    ]));
    const own = el('input', { type: 'text', maxLength: WATERMARK_MAX, autocomplete: 'off', spellcheck: false });
    const ownField = el('label', { className: 'field watermark-own', hidden: true }, [el('span', { textContent: t('Texto da marca d\'água') }), own]);
    const status = el('p', { className: 'field-note', role: 'status' });
    const choices = el('fieldset', { className: 'watermark-choices', hidden: true }, [
      el('legend', { className: 'sr-only', textContent: t('Texto da marca d\'água') }), ...radios, ownField, status,
    ]);
    container.append(el('label', { className: 'check' }, [toggle, t('Marca d\'água')]), note, choices);

    const preset = () => choices.querySelector('input[name="watermark-text"]:checked')?.value ?? '';
    chosen = () => watermarkText(preset() || own.value);
    const update = () => {
      ownField.hidden = !!preset();
      status.textContent = toggle.checked && !preset() && !chosen() ? t('Escreva o texto da marca d\'água.') : '';
    };

    toggle.addEventListener('change', () => {
      choices.hidden = !toggle.checked;
      update();
      changed();
    });
    choices.addEventListener('change', (event) => {
      if (event.target.name !== 'watermark-text') return;
      update();
      if (!preset()) own.focus();
      changed();
    });
    // Letra que as fontes do PDF não têm (emoji, alfabetos não latinos) é avisada na hora e não entra.
    own.addEventListener('input', () => {
      const typed = [...own.value];
      const kept = typed.filter((char) => /\s/.test(char) || winAnsiCode(char) !== undefined);
      update();
      if (kept.length !== typed.length) {
        const left = [...new Set(typed.filter((char) => !kept.includes(char)))];
        const caret = Math.max(0, (own.selectionStart ?? own.value.length) - (own.value.length - kept.join('').length));
        own.value = kept.join('');
        own.setSelectionRange(caret, caret);
        const chars = left.map((char) => `“${char}”`).join(', ');
        status.textContent = left.length === 1 ? t('{chars} não existe nas fontes do PDF e ficou de fora.', { chars })
          : t('{chars} não existem nas fontes do PDF e ficaram de fora.', { chars });
      }
      changed();
    });
  },
  active: () => !!toggle?.checked && !!chosen(),
  produce: () => [watermarkEdit(chosen())],
});
