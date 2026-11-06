// Mover e mudar o tamanho com toques, sem arrastar (WCAG 2.5.7): as quatro setas e o botão "Tamanho", na barra da
// edição selecionada (editor.js) e nas opções da tarja selecionada (viewer.js). Um componente só para os dois modos.
//
// Cada seta faz o mesmo que a seta do teclado na caixa: move 1% da página. Com "Tamanho" ligado, faz o mesmo que
// Shift e a seta: o canto de baixo à direita anda 1% (→ mais largo, ← mais estreito, ↓ mais alto, ↑ mais baixo).
import { t } from './i18n.js';

const SVG = 'http://www.w3.org/2000/svg';

/** O passo das setas, na tela e no teclado: 1% da página. */
export const NUDGE_STEP = 0.01;

// Traços dos ícones (viewBox 24), no estilo do sprite do index.html.
const PATHS = {
  left: ['M19 12H5', 'M12 19l-7-7 7-7'],
  up: ['M12 19V5', 'M5 12l7-7 7 7'],
  down: ['M12 5v14', 'M19 12l-7 7-7-7'],
  right: ['M5 12h14', 'M12 5l7 7-7 7'],
  size: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
};

/** As setas: o deslocamento de cada uma (o mesmo das teclas) e o nome nos dois modos. */
export const NUDGES = [
  { key: 'ArrowLeft', icon: 'left', dx: -1, dy: 0, move: t('Mover para a esquerda'), grow: t('Diminuir a largura') },
  { key: 'ArrowUp', icon: 'up', dx: 0, dy: -1, move: t('Mover para cima'), grow: t('Diminuir a altura') },
  { key: 'ArrowDown', icon: 'down', dx: 0, dy: 1, move: t('Mover para baixo'), grow: t('Aumentar a altura') },
  { key: 'ArrowRight', icon: 'right', dx: 1, dy: 0, move: t('Mover para a direita'), grow: t('Aumentar a largura') },
];

/** A seta do teclado como deslocamento ([dx, dy], de 0 a 1), ou null para outra tecla. */
export function nudgeOf(key, step = NUDGE_STEP) {
  const nudge = NUDGES.find((each) => each.key === key);
  return nudge ? [nudge.dx * step, nudge.dy * step] : null;
}

function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * Os botões de mover e de mudar o tamanho.
 * @param {object} options
 * @param {(kind: 'move' | 'grow', dx: number, dy: number) => void} options.act move (ou muda o tamanho de) o que está
 *   selecionado; dx e dy de 0 a 1, como as setas do teclado
 * @param {(message: string) => void} options.say o aviso da tela (role=status)
 * @returns {{element: HTMLElement, setDisabled: (disabled: boolean) => void}}
 */
export function nudgeControls({ act, say }) {
  const element = document.createElement('div');
  element.className = 'nudge';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', t('Mover e mudar o tamanho'));
  let sizing = false;

  const arrows = NUDGES.map((nudge) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn nudge-btn';
    button.append(icon(nudge.icon));
    button.addEventListener('click', () => act(sizing ? 'grow' : 'move', nudge.dx * NUDGE_STEP, nudge.dy * NUDGE_STEP));
    return button;
  });

  const sizeButton = document.createElement('button');
  sizeButton.type = 'button';
  sizeButton.className = 'btn nudge-size';
  sizeButton.title = t('As setas mudam o tamanho, em vez de mover');
  sizeButton.append(icon('size'), ` ${t('Tamanho')}`);
  sizeButton.addEventListener('click', () => {
    sizing = !sizing;
    label();
    say(sizing ? t('Tamanho: as setas mudam a largura e a altura.') : t('As setas movem.'));
  });

  // Nome e dica de cada seta conforme o modo; o botão "Tamanho" diz se está ligado.
  function label() {
    arrows.forEach((button, i) => {
      const name = sizing ? NUDGES[i].grow : NUDGES[i].move;
      button.setAttribute('aria-label', name);
      button.title = name;
    });
    sizeButton.setAttribute('aria-pressed', String(sizing));
  }
  label();

  element.append(...arrows, sizeButton);
  return {
    element,
    setDisabled(disabled) {
      for (const button of [...arrows, sizeButton]) button.disabled = disabled;
    },
  };
}
