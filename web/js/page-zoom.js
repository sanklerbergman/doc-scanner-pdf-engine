// Zoom da página nos modos Tarjar e Editar da tela cheia (viewer.js e editor.js): um só para os dois, ligado ao modo
// que está na tela (attach) e desligado ao sair (detach).
//
// - Celular: pinçar com dois dedos amplia, e arrastar com os dois move a página ampliada. Um dedo continua sendo da
//   ferramenta (desenhar, marcar a tarja, mover a caixa): o segundo dedo que encosta cancela o que o primeiro fazia.
// - Computador: Ctrl e a roda do mouse (ou a pinça do trackpad, que o navegador entrega do mesmo jeito; no Safari,
//   pelos eventos de gesto) ampliam no ponto do cursor; a roda sozinha e as barras rolam a página ampliada.
// - Os dois: os botões −, % e + na barra do título, e as teclas +, − e 0. Com uma caixa selecionada, os botões
//   ampliam com ela no meio da tela.
//
// O modo diz o tamanho da página com zoom 1 (base, a página inteira na tela) e recebe o aviso de cada mudança de tamanho
// (resized): final false no meio da pinça (só o que é barato), true quando ela termina.
import { t } from './i18n.js';

const MIN = 1;
const MAX = 4; // a página do Editar e das tarjas tem 2000 px no lado maior: mais que isso só borra
const STEP = 1.5; // cada toque nos botões
const SETTLE = 160; // ms sem roda do mouse: o zoom terminou

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {object} deps
 * @param {HTMLElement} deps.stage a área que rola
 * @param {HTMLElement} deps.controls o grupo dos botões (com #page-zoom-in, #page-zoom-out e #page-zoom-fit)
 * @param {(message: string) => void} deps.say o aviso da tela cheia (role=status)
 */
export function setupPageZoom({ stage, controls, say }) {
  const zoomIn = controls.querySelector('#page-zoom-in');
  const zoomOut = controls.querySelector('#page-zoom-out');
  const fitButton = controls.querySelector('#page-zoom-fit');

  /**
   * @type {null | {surface: HTMLElement, base: () => {width: number, height: number}, resized: (final: boolean) => void,
   *   cancel: () => void, focus?: () => number[] | null}}
   */
  let target = null;
  let zoom = 1;
  const touches = new Map(); // dedos na página: id → [x, y] na tela
  let pinch = null; // a pinça em andamento; fica até o último dedo sair, para o dedo que sobra não desenhar
  let settleTimer = 0;
  let gesture = null; // a pinça do trackpad no Safari

  function setSize() {
    const { width, height } = target.base();
    target.surface.style.width = `${Math.max(40, width * zoom)}px`;
    target.surface.style.height = `${Math.max(40, height * zoom)}px`;
    fitButton.textContent = `${Math.round(zoom * 100)}%`;
    zoomIn.disabled = zoom >= MAX;
    zoomOut.disabled = fitButton.disabled = zoom <= MIN;
  }

  // O ponto at da tela (clientX, clientY) mostra o ponto point da página (de 0 a 1) depois do zoom novo.
  function zoomTo(next, point, at, final) {
    zoom = clamp(next, MIN, MAX);
    setSize();
    const box = target.surface.getBoundingClientRect();
    stage.scrollLeft += box.left + point[0] * box.width - at[0];
    stage.scrollTop += box.top + point[1] * box.height - at[1];
    target.resized(final);
  }

  // O ponto da página (de 0 a 1) sob o ponto da tela.
  function pageAt([x, y]) {
    const box = target.surface.getBoundingClientRect();
    return [clamp((x - box.left) / box.width, 0, 1), clamp((y - box.top) / box.height, 0, 1)];
  }

  // O meio da parte visível da área que rola.
  function middle() {
    const box = stage.getBoundingClientRect();
    return [box.left + stage.clientWidth / 2, box.top + stage.clientHeight / 2];
  }

  // O zoom terminou (botão, tecla, fim da pinça ou da roda): o aviso diz em quanto ficou e como mover a página.
  function announce() {
    say(zoom > MIN
      ? t('Página em {n}%. Para mover, arraste com dois dedos, use a roda do mouse ou as barras de rolagem.', { n: Math.round(zoom * 100) })
      : t('Página inteira na tela.'));
  }

  // Botões e teclas: amplia com a caixa selecionada no meio da tela; sem seleção, no meio do que já está na tela.
  function step(next) {
    if (!target) return;
    const at = middle();
    zoomTo(next, target.focus?.() ?? pageAt(at), at, true);
    announce();
  }

  zoomIn.addEventListener('click', () => step(zoom * STEP));
  zoomOut.addEventListener('click', () => step(zoom / STEP < 1.1 ? MIN : zoom / STEP));
  fitButton.addEventListener('click', () => step(MIN));

  // ---------- Pinça com dois dedos ----------
  // Na fase de captura, antes da ferramenta do modo: o segundo dedo é do zoom, não dela.

  const distance = ([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const center = ([a, b]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

  stage.addEventListener('pointerdown', (event) => {
    if (!target || event.pointerType !== 'touch' || !target.surface.contains(event.target)) return;
    touches.set(event.pointerId, [event.clientX, event.clientY]);
    if (pinch) {
      event.stopImmediatePropagation(); // terceiro dedo, ou um dedo de volta antes de soltar todos
      event.preventDefault();
      return;
    }
    if (touches.size < 2) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    target.cancel(); // o que o primeiro dedo estava fazendo volta ao lugar
    for (const id of touches.keys()) {
      try { target.surface.setPointerCapture(id); } catch { /* o dedo já saiu */ }
    }
    const points = [...touches.values()].slice(0, 2);
    pinch = { distance: Math.max(1, distance(points)), zoom, point: pageAt(center(points)) };
  }, { capture: true });

  stage.addEventListener('pointermove', (event) => {
    if (!touches.has(event.pointerId)) return;
    touches.set(event.pointerId, [event.clientX, event.clientY]);
    if (!pinch) return;
    event.stopImmediatePropagation();
    if (touches.size < 2 || pinch.done) return;
    const points = [...touches.values()].slice(0, 2);
    // O ponto da página que estava entre os dedos fica entre eles: pinçar amplia ali, e arrastar move a página.
    zoomTo(pinch.zoom * (distance(points) / pinch.distance), pinch.point, center(points), false);
  }, { capture: true });

  function lift(event) {
    if (!touches.delete(event.pointerId)) return;
    if (!pinch) return;
    event.stopImmediatePropagation();
    if (!pinch.done && touches.size < 2) {
      pinch.done = true;
      target?.resized(true);
      announce();
    }
    if (!touches.size) pinch = null;
  }
  stage.addEventListener('pointerup', lift, { capture: true });
  stage.addEventListener('pointercancel', lift, { capture: true });

  // ---------- Roda do mouse e trackpad ----------

  function settleLater() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (!target) return;
      target.resized(true);
      announce();
    }, SETTLE);
  }

  stage.addEventListener('wheel', (event) => {
    if (!target || !(event.ctrlKey || event.metaKey)) return; // sem Ctrl, a roda rola a página ampliada
    event.preventDefault(); // não amplia a tela inteira do navegador
    const delta = clamp(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY, -25, 25);
    const at = [event.clientX, event.clientY];
    zoomTo(zoom * Math.exp(-delta * 0.01), pageAt(at), at, false);
    settleLater();
  }, { passive: false });

  // Safari no Mac: a pinça do trackpad chega como gesto. No iPhone o gesto também vem, junto com os dedos (já tratados).
  stage.addEventListener('gesturestart', (event) => {
    if (!target) return;
    event.preventDefault();
    gesture = touches.size ? null : { zoom };
  });
  stage.addEventListener('gesturechange', (event) => {
    if (!target) return;
    event.preventDefault();
    if (!gesture || touches.size) return;
    const at = [event.clientX, event.clientY];
    zoomTo(gesture.zoom * event.scale, pageAt(at), at, false);
    settleLater();
  });
  stage.addEventListener('gestureend', (event) => {
    if (target) event.preventDefault();
    gesture = null;
  });

  // ---------- Teclas ----------

  stage.closest('dialog').addEventListener('keydown', (event) => {
    if (!target || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.matches('input, textarea, select, [contenteditable]')) return;
    const action = { '+': zoom * STEP, '=': zoom * STEP, '-': zoom / STEP, '0': MIN }[event.key];
    if (action === undefined) return;
    event.preventDefault();
    step(action < 1.1 ? MIN : action);
  });

  return {
    /** Liga o zoom no modo que acabou de abrir. Começa com a página inteira na tela. */
    attach(next) {
      target = next;
      zoom = 1;
      touches.clear();
      pinch = gesture = null;
      stage.classList.add('zoomable');
      controls.hidden = false;
      setSize();
      stage.scrollTo(0, 0);
    },
    /** Desliga o zoom do modo (só se for o que está ligado). */
    detach(surface) {
      if (!target || (surface && target.surface !== surface)) return;
      clearTimeout(settleTimer);
      target = null;
      touches.clear();
      pinch = gesture = null;
      stage.classList.remove('zoomable');
      controls.hidden = true;
      stage.scrollTo(0, 0);
    },
    /** A tela mudou de tamanho: a página acompanha, no mesmo zoom. */
    layout() {
      if (!target) return;
      setSize();
      target.resized(true);
    },
  };
}
