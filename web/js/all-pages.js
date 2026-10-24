// "Em todas as páginas", no painel de opções do PDF: o que entra em toda página de cada arquivo gerado. As opções
// chegam nas próximas fases (numeração, cabeçalho e rodapé, marca d'água e rubrica); enquanto não houver nenhuma, a
// seção fica escondida.
//
// Ponto de encaixe das fases 2 a 4: addAllPagesOption, chamado pelo módulo da opção (importado em app.js).
// - build(container, changed): monta os controles dentro da seção; changed() avisa que algo mudou (o PDF gerado é
//   descartado e a prévia, redesenhada). Os lugares na página usam a grade de seis do carimbo (spotGrid).
// - active(): true quando a opção está ligada (aí não dá para assinar sem reescrever, e o aviso das assinaturas vale).
// - produce({position, total, file, files, index, page, size}): as edições (edits.js) a mais numa página. position e
//   total contam dentro do arquivo: com "um PDF por página" ou por intervalos, cada arquivo começa do 1 (fileExtras,
//   em edits.js). index e page: a página na lista; size: ela como aparece, em pontos (para spotBox, em edits.js).
// - characters (opcional, no tipo de edição que a opção produz): as letras do PDF/A, como nas outras edições.
import { STAMP_POSITIONS } from './stamp.js';

/**
 * @typedef {object} AllPagesOption
 * @property {string} id
 * @property {(container: HTMLElement, changed: () => void) => void} build
 * @property {() => boolean} active
 * @property {(context: {position: number, total: number, file: number, files: number, index: number, page: object,
 *   size: {width: number, height: number}}) => object[]} produce
 */

const OPTIONS = [];
let mounted = null; // {section, container, changed}, depois de setupAllPages

/** @param {AllPagesOption} option */
export function addAllPagesOption(option) {
  if (OPTIONS.some(({ id }) => id === option.id)) throw new Error(`Opção repetida: ${option.id}`);
  OPTIONS.push(option);
  if (mounted) mount(option);
}

function mount(option) {
  const box = document.createElement('div');
  box.className = 'all-pages-option';
  box.dataset.option = option.id;
  mounted.container.append(box);
  option.build(box, mounted.changed);
  mounted.section.hidden = false;
}

/**
 * @param {{section: HTMLElement, container: HTMLElement, changed: () => void}} elements section: a seção (escondida
 *   sem opção); container: onde os controles entram; changed: chamado quando uma opção muda
 */
export function setupAllPages({ section, container, changed }) {
  mounted = { section, container, changed };
  for (const option of OPTIONS) mount(option);
  section.hidden = !OPTIONS.length;
  const on = () => OPTIONS.filter((option) => option.active());
  return {
    /** Alguma opção ligada? */
    active: () => on().length > 0,
    /** As edições a mais de uma página (ver produce acima). */
    produce: (context) => on().flatMap((option) => option.produce(context) ?? []),
  };
}

/**
 * Os seis lugares numa folha em miniatura (três em cima e três embaixo), cada um com alvo de 44 px: a grade do carimbo
 * da assinatura, para quem mais precisar escolher um lugar na página. O valor é a chave de STAMP_POSITIONS.
 * @param {HTMLElement} container a folha (classe stamp-grid)
 * @param {string} name nome do grupo de rádios
 * @param {string} [checked] o lugar marcado no começo
 */
export function spotGrid(container, name, checked = 'bottom-right') {
  container.replaceChildren(...Object.entries(STAMP_POSITIONS).map(([value, label]) => {
    const input = document.createElement('input');
    Object.assign(input, { type: 'radio', name, value, checked: value === checked });
    const text = document.createElement('span');
    text.className = 'sr-only';
    text.textContent = label;
    const spot = document.createElement('label');
    spot.className = 'stamp-spot';
    spot.title = label;
    spot.append(input, text);
    return spot;
  }));
}
