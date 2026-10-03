// Tela cheia de uma página: mostra como ela vai sair no PDF e deixa ajustar o recorte
// arrastando os quatro cantos sobre a foto original.
import { FULL_QUAD, fromRotated, toRotated, isConvex, isFullFrame } from './geometry.js';

const $ = (selector) => document.querySelector(selector);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const CORNERS = ['superior esquerdo', 'superior direito', 'inferior direito', 'inferior esquerdo'];
const START_INSET = 0.04; // sem recorte ainda: os cantos começam um pouco para dentro, fáceis de pegar

/**
 * @param {object} deps
 * @param {(page) => Promise<Blob>} deps.renderProcessed página pronta (recorte + giro + filtro), em boa resolução
 * @param {(page) => Promise<Blob>} deps.renderOriginal foto girada, sem recorte nem filtro
 * @param {(page) => number[][] | null} deps.detect cantos do papel nas coordenadas da foto, ou null
 * @param {(page, quad: number[][] | null) => Promise<void>} deps.applyCrop grava o recorte e atualiza a miniatura
 */
export function setupViewer({ renderProcessed, renderOriginal, detect, applyCrop }) {
  const dialog = $('#viewer');
  const title = $('#viewer-title');
  const stage = $('#viewer-stage');
  const image = $('#viewer-image');
  const crop = $('#crop');
  const cropImage = $('#crop-image');
  const polygon = $('#crop-polygon');
  const handles = [...crop.querySelectorAll('.crop-handle')];
  const hint = $('#viewer-hint');
  const viewActions = $('#viewer-view-actions');
  const cropActions = $('#viewer-crop-actions');
  const applyButton = $('#crop-apply');

  let page = null;
  let label = '';
  let points = FULL_QUAD; // cantos sobre a foto girada, de 0 a 1
  let token = 0; // invalida renderizações que terminam depois de a pessoa já ter mudado de tela
  const urls = { view: '', crop: '' };

  function setUrl(kind, img, blob) {
    if (urls[kind]) URL.revokeObjectURL(urls[kind]);
    urls[kind] = blob ? URL.createObjectURL(blob) : '';
    if (blob) img.src = urls[kind];
  }

  function open(target, name) {
    page = target;
    label = name;
    dialog.showModal();
    showView();
  }

  async function showView() {
    const mine = ++token;
    title.textContent = label;
    crop.hidden = true;
    cropActions.hidden = true;
    viewActions.hidden = false;
    image.hidden = false;
    stage.classList.remove('zoomed');
    image.src = page.thumbUrl; // aparece na hora; a versão nítida entra em seguida
    image.alt = `${label}, como vai sair no PDF`;
    hint.textContent = 'Carregando em alta qualidade…';
    try {
      const blob = await renderProcessed(page);
      if (mine !== token) return;
      setUrl('view', image, blob);
      hint.textContent = 'É assim que a página vai sair no PDF. Toque na imagem para ampliar.';
    } catch (err) {
      console.error(err);
      if (mine === token) hint.textContent = 'Mostrando a miniatura (não deu para carregar em alta qualidade).';
    }
  }

  async function showCrop() {
    const mine = ++token;
    title.textContent = `Recorte: ${label}`;
    image.hidden = true;
    viewActions.hidden = true;
    stage.classList.remove('zoomed');
    hint.textContent = 'Preparando a foto…';
    const blob = await renderOriginal(page);
    if (mine !== token) return;
    points = page.quad
      ? toRotated(page.quad, page.rotation)
      : FULL_QUAD.map(([x, y]) => [x ? 1 - START_INSET : START_INSET, y ? 1 - START_INSET : START_INSET]);
    setUrl('crop', cropImage, blob);
    await cropImage.decode().catch(() => {});
    if (mine !== token) return;
    crop.hidden = false;
    cropActions.hidden = false;
    hint.textContent = 'Arraste os quatro cantos até as bordas do papel.';
    fitCrop();
    drawPoints();
    handles[0].focus();
  }

  // A área de recorte tem exatamente o tamanho da foto na tela: assim "50%" é o meio da foto.
  function fitCrop() {
    if (crop.hidden || !cropImage.naturalWidth) return;
    const margin = 28; // espaço para os cantos não ficarem colados na borda da tela
    const maxW = stage.clientWidth - margin * 2;
    const maxH = stage.clientHeight - margin * 2;
    const scale = Math.min(maxW / cropImage.naturalWidth, maxH / cropImage.naturalHeight);
    crop.style.width = `${Math.max(40, cropImage.naturalWidth * scale)}px`;
    crop.style.height = `${Math.max(40, cropImage.naturalHeight * scale)}px`;
  }

  function drawPoints() {
    polygon.setAttribute('points', points.map(([x, y]) => `${x * 100},${y * 100}`).join(' '));
    handles.forEach((handle, i) => {
      handle.style.left = `${points[i][0] * 100}%`;
      handle.style.top = `${points[i][1] * 100}%`;
    });
    const valid = isConvex(points);
    crop.classList.toggle('invalid', !valid);
    applyButton.disabled = !valid;
    if (!valid) hint.textContent = 'Os cantos se cruzaram. Arraste-os de volta para formar um quadrilátero.';
  }

  function movePoint(index, x, y) {
    points = points.map((point, i) => (i === index ? [clamp01(x), clamp01(y)] : point));
    hint.textContent = 'Arraste os quatro cantos até as bordas do papel.';
    drawPoints();
  }

  handles.forEach((handle, index) => {
    handle.setAttribute('aria-label', `Canto ${CORNERS[index]}: arraste ou use as setas`);
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.focus();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const box = crop.getBoundingClientRect();
      movePoint(index, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
    });
    // pointerup, pointercancel e perda de captura soltam o canto sozinhos (a captura acaba junto).
    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.05 : 0.01;
      const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (!move) return;
      event.preventDefault();
      movePoint(index, points[index][0] + move[0], points[index][1] + move[1]);
    });
  });

  $('#viewer-crop').addEventListener('click', showCrop);
  $('#viewer-close').addEventListener('click', () => dialog.close());
  image.addEventListener('click', () => stage.classList.toggle('zoomed'));

  $('#crop-detect').addEventListener('click', () => {
    const quad = detect(page);
    if (quad) {
      points = toRotated(quad, page.rotation);
      drawPoints();
      hint.textContent = 'Cantos encontrados. Confira e ajuste se precisar.';
    } else {
      hint.textContent = 'Não achei as bordas do papel nesta foto. Arraste os cantos manualmente.';
    }
  });
  $('#crop-full').addEventListener('click', () => {
    points = FULL_QUAD;
    drawPoints();
    hint.textContent = 'Foto inteira, sem recorte.';
  });
  $('#crop-cancel').addEventListener('click', showView);
  applyButton.addEventListener('click', async () => {
    if (!isConvex(points)) return;
    applyButton.disabled = true;
    hint.textContent = 'Aplicando o recorte…';
    try {
      await applyCrop(page, isFullFrame(points) ? null : fromRotated(points, page.rotation));
    } finally {
      applyButton.disabled = false;
    }
    showView();
  });

  new ResizeObserver(fitCrop).observe(stage);
  dialog.addEventListener('close', () => {
    token++;
    setUrl('view', image, null);
    setUrl('crop', cropImage, null);
    image.removeAttribute('src');
    cropImage.removeAttribute('src');
    page = null;
  });

  return { open };
}
