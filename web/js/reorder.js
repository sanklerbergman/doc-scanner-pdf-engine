// Arrastar para reordenar as páginas. Em cima, as contas (funções puras, sem tela: test/reorder.test.js); embaixo, o
// arrasto pela alça do cartão, com Pointer Events, como nos cantos do recorte e nas tarjas. A API de arrastar do HTML
// (draggable) fica de fora: no Safari do iPhone ela não responde ao dedo do mesmo jeito, e no computador se
// confundiria com soltar arquivos na área de adicionar.

/** @typedef {{left: number, top: number, right: number, bottom: number}} Box */

export const EDGE = 80; // faixa, em px, perto da borda de cima e de baixo da tela em que a página rola sozinha
export const MAX_SPEED = 1.2; // px por milissegundo, com o dedo encostado na borda
// Com o dedo parado na faixa, a rolagem acelera até 3× em 2 s: numa lista de 20 páginas, ir de uma ponta à outra
// não leva mais de uns 5 s, e quem quer parar no meio afasta o dedo da borda.
export const BOOST = 3;
export const BOOST_MS = 2000;

/**
 * A lista com o item de `from` levado para `to` (a posição final dele). A lista original não muda.
 * @template T
 * @param {T[]} list
 * @param {number} from
 * @param {number} to
 * @returns {T[]}
 */
export function moveItem(list, from, to) {
  const copy = list.slice();
  copy.splice(to, 0, ...copy.splice(from, 1));
  return copy;
}

/** Onde fica o item que estava em `index` depois de levar o item de `from` para `to`. */
export function newIndex(index, from, to) {
  if (index === from) return to;
  if (from < to && index > from && index <= to) return index - 1;
  if (to < from && index >= to && index < from) return index + 1;
  return index;
}

/**
 * Lugar de soltar: a posição do cartão sob o ponto (o centro do cartão arrastado). A grade tem uma ou várias colunas,
 * conforme a largura da tela: primeiro a linha (os cartões que cobrem o ponto na vertical, ou os mais perto dele),
 * depois, nessa linha, o cartão com o centro mais perto. Depois do último cartão da última linha, vale o último.
 * @param {Box[]} rects lugar de cada cartão antes de arrastar, na ordem da lista
 * @param {{x: number, y: number}} point
 * @returns {number} posição na lista (-1 com a lista vazia)
 */
export function dropIndex(rects, { x, y }) {
  const away = (start, end, value) => Math.max(start - value, 0, value - end);
  const rows = rects.map((rect) => away(rect.top, rect.bottom, y));
  const nearest = Math.min(...rows);
  let found = -1;
  let best = Infinity;
  rects.forEach((rect, i) => {
    if (rows[i] - nearest > 0.5) return; // outra linha
    const distance = Math.abs((rect.left + rect.right) / 2 - x);
    if (distance < best) {
      best = distance;
      found = i;
    }
  });
  return found;
}

/**
 * Quanto cada cartão anda para abrir espaço, com o de `from` indo para `to`. O arrastado fica com zero: ele segue o
 * dedo. Numa coluna só, os do meio andam a altura do arrastado mais o espaço entre os cartões (foto, Word e PDF têm
 * alturas diferentes); na grade, cada um vai para o lugar do vizinho.
 * @param {Box[]} rects
 * @returns {{x: number, y: number}[]}
 */
export function shiftOffsets(rects, from, to) {
  const column = rects.every((rect) => Math.abs(rect.left - rects[0].left) < 1);
  const gap = column && rects.length > 1 ? rects[1].top - rects[0].bottom : 0;
  const step = rects[from] ? rects[from].bottom - rects[from].top + gap : 0;
  return rects.map((rect, i) => {
    const j = newIndex(i, from, to);
    if (i === from || j === i) return { x: 0, y: 0 };
    if (column) return { x: 0, y: j < i ? -step : step };
    return { x: rects[j].left - rect.left, y: rects[j].top - rect.top };
  });
}

/** O retângulo que junta todos os cartões. @param {Box[]} rects @returns {Box} */
export function bounds(rects) {
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

/**
 * Deslocamento do cartão arrastado, preso dentro da área dos cartões. Fora dela, a página ficaria mais comprida (ou
 * mais larga) a cada passo, e a rolagem automática não pararia mais.
 * @param {Box} rect o cartão, no lugar dele
 * @param {Box} area
 * @param {number} dx
 * @param {number} dy
 */
export function clampShift(rect, area, dx, dy) {
  const clamp = (value, low, high) => Math.min(Math.max(value, Math.min(low, 0)), Math.max(high, 0));
  return {
    x: clamp(dx, area.left - rect.left, area.right - rect.right),
    y: clamp(dy, area.top - rect.top, area.bottom - rect.bottom),
  };
}

/**
 * Rolagem automática: perto da borda de cima ou de baixo da tela, a página rola sozinha, mais rápido quanto mais
 * perto da borda e quanto mais tempo o dedo fica ali. Numa tela baixa, a faixa encolhe para não ocupar o meio.
 * @param {number} y o dedo, em px a partir do alto da tela
 * @param {number} height altura da tela
 * @param {number} [held] milissegundos com o dedo na faixa
 * @returns {number} px por milissegundo (negativo: para cima)
 */
export function edgeSpeed(y, height, held = 0) {
  const edge = Math.min(EDGE, height / 5);
  const boost = 1 + (BOOST - 1) * Math.min(Math.max(held, 0) / BOOST_MS, 1);
  if (y < edge) return -MAX_SPEED * boost * Math.min(1, (edge - y) / edge);
  if (y > height - edge) return MAX_SPEED * boost * Math.min(1, (y - height + edge) / edge);
  return 0;
}

// ---------- O arrasto na lista ----------

/**
 * Liga o arrasto pela alça (`.drag-handle`) dos cartões, que são os filhos de `list`. Enquanto arrasta, o cartão
 * segue o dedo e os outros abrem espaço, só com `transform`: a lista não é recriada. A ordem só muda ao soltar, em
 * outro lugar, por `move`, que muda as páginas e recria a lista. Soltar no mesmo lugar, Esc ou o navegador cancelar
 * o toque devolvem o cartão sem chamar `move`.
 * @param {HTMLElement} list
 * @param {{enabled: () => boolean, move: (from: number, to: number) => void}} options enabled: falso com o app
 *   ocupado (aí o arrasto não começa, e o que estiver em andamento volta)
 */
export function setupReorder(list, { enabled, move }) {
  let drag = null;

  // Posição na página, não na tela: continua valendo depois da rolagem automática.
  const pageBox = (element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left + scrollX, top: box.top + scrollY, right: box.right + scrollX, bottom: box.bottom + scrollY };
  };
  const translate = (element, { x, y }) => {
    element.style.transform = x || y ? `translate(${x}px, ${y}px)` : '';
  };

  list.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('.drag-handle');
    if (!handle || drag || !event.isPrimary || event.button !== 0 || list.children.length < 2 || !enabled()) return;
    const cards = [...list.children];
    const card = cards.find((child) => child.contains(handle));
    if (!card) return;
    event.preventDefault(); // sem selecionar texto nem gerar os eventos de mouse
    try {
      handle.setPointerCapture(event.pointerId); // o mouse continua com a alça mesmo fora da janela
    } catch {
      // Sem captura, o arrasto segue igual: os eventos são ouvidos na janela, e o toque já fica preso à alça.
    }
    const rects = cards.map(pageBox);
    const from = cards.indexOf(card);
    drag = {
      id: event.pointerId, card, cards, rects, from, to: from, area: bounds(rects),
      startX: event.clientX + scrollX, startY: event.clientY + scrollY, x: event.clientX, y: event.clientY,
      width: innerWidth, time: performance.now(), edge: performance.now(), frame: 0,
    };
    list.classList.add('sorting');
    card.classList.remove('settling');
    card.classList.add('lifted');
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onCancel);
    addEventListener('keydown', onKey);
    addEventListener('resize', onResize);
    addEventListener('blur', onCancel);
    drag.frame = requestAnimationFrame(frame);
  });

  function onMove(event) {
    if (event.pointerId !== drag?.id) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
  }

  // A cada quadro: rola perto da borda, põe o cartão sob o dedo e abre espaço onde ele vai entrar.
  function frame(time) {
    if (!drag) return;
    if (!enabled() || !drag.card.isConnected) return stop(true); // ficou ocupado ou a lista foi recriada
    if (edgeSpeed(drag.y, innerHeight) === 0) drag.edge = time; // fora da faixa: a aceleração recomeça
    const speed = edgeSpeed(drag.y, innerHeight, time - drag.edge);
    if (speed) scrollBy(0, speed * Math.min(Math.max(time - drag.time, 0), 50));
    drag.time = time;
    place();
    drag.frame = requestAnimationFrame(frame);
  }

  function place() {
    const { card, rects, from } = drag;
    const rect = rects[from];
    const shift = clampShift(rect, drag.area, drag.x + scrollX - drag.startX, drag.y + scrollY - drag.startY);
    translate(card, shift);
    const to = dropIndex(rects, { x: (rect.left + rect.right) / 2 + shift.x, y: (rect.top + rect.bottom) / 2 + shift.y });
    if (to === drag.to) return;
    drag.to = to;
    shiftOffsets(rects, from, to).forEach((offset, i) => {
      if (i !== from) translate(drag.cards[i], offset);
    });
  }

  function onUp(event) {
    if (event.pointerId !== drag?.id) return;
    onMove(event);
    place();
    const { card, from, to } = drag;
    if (to === from || !enabled() || !card.isConnected) return stop(true);
    const before = card.getBoundingClientRect();
    stop(false);
    move(from, to);
    // A lista foi recriada: o cartão novo sai de onde o dedo largou e desliza até o lugar dele.
    const moved = list.children[to];
    if (!moved) return;
    const after = moved.getBoundingClientRect();
    moved.classList.add('lifted'); // sem transição: começa já deslocado
    translate(moved, { x: before.left - after.left, y: before.top - after.top });
    moved.getBoundingClientRect(); // aplica o ponto de partida antes de ligar a transição
    moved.classList.remove('lifted');
    settle(moved);
  }

  function onCancel(event) {
    if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.id)) return;
    stop(true);
  }

  function onKey(event) {
    if (event.key !== 'Escape' || !drag) return;
    event.preventDefault();
    stop(true);
  }

  // Girar o aparelho muda a grade (e os retângulos guardados). A barra do Safari, ao sumir, muda só a altura.
  function onResize() {
    if (drag && innerWidth !== drag.width) stop(true);
  }

  // Termina o arrasto. animate: o cartão volta deslizando ao lugar e os outros fecham o espaço.
  function stop(animate) {
    const { card, cards } = drag;
    cancelAnimationFrame(drag.frame);
    drag = null;
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onCancel);
    removeEventListener('keydown', onKey);
    removeEventListener('resize', onResize);
    removeEventListener('blur', onCancel);
    list.classList.remove('sorting');
    card.classList.remove('lifted');
    if (animate) settle(card);
    for (const other of cards) translate(other, { x: 0, y: 0 });
  }

  // Volta o cartão ao lugar com a transição do CSS, por cima dos outros até chegar.
  function settle(card) {
    if (!card.style.transform) return;
    card.classList.add('settling');
    card.addEventListener('transitionend', () => card.classList.remove('settling'), { once: true });
    translate(card, { x: 0, y: 0 });
  }
}
