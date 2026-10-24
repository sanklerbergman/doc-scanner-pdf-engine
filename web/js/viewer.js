// Tela cheia de uma página: mostra como ela vai sair no PDF, deixa ajustar o recorte arrastando os quatro
// cantos sobre a foto original, marcar tarjas (retângulos que apagam o que está embaixo, redact.js), editar a página
// (desenho, formas e marcas que ficam fixos no PDF, editor.js) e copiar o texto da página para a área de transferência.
import { FULL_QUAD, fromRotated, toRotated, isConvex, isFullFrame } from './geometry.js';
import { normalizeRect } from './redact.js';
import { wordCount } from './page-text.js';

const $ = (selector) => document.querySelector(selector);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const CORNERS = ['superior esquerdo', 'superior direito', 'inferior direito', 'inferior esquerdo'];
const START_INSET = 0.04; // sem recorte ainda: os cantos começam um pouco para dentro, fáceis de pegar
const LOUPE_SIZE = 120; // diâmetro da lupa do recorte, em px da tela
const LOUPE_ZOOM = 3; // ampliação sobre a foto como ela aparece na tela
const LOUPE_GAP = 48; // do dedo até a borda da lupa: o dedo não cobre

/**
 * @param {object} deps
 * @param {(page) => Promise<Blob>} deps.renderProcessed página pronta (recorte + giro + filtro), em boa resolução
 * @param {(page) => boolean} deps.canCrop false para página sem foto (documento do Word, PDF)
 * @param {(page) => string | null} [deps.viewHint] texto de ajuda da tela cheia, se a página pedir um diferente
 * @param {(page) => Promise<Blob>} deps.renderOriginal foto girada, sem recorte nem filtro
 * @param {(page) => number[][] | null} deps.detect cantos do papel nas coordenadas da foto, ou null
 * @param {(page, quad: number[][] | null) => Promise<void>} deps.applyCrop grava o recorte e atualiza a miniatura
 * @param {(page, delta: number) => {page, label: string} | null} deps.step página vizinha (delta -1 ou +1), ou null
 * @param {(page) => Promise<Blob>} deps.renderPlain página como vai sair no PDF, mas sem as tarjas (para editá-las)
 * @param {(page) => string} deps.redactHint texto de ajuda das tarjas para a página
 * @param {(page, list: object[]) => Promise<void>} deps.saveRedactions grava as tarjas e atualiza a miniatura
 * @param {(page, options: {signal: AbortSignal, progress: (message: string) => void}) => Promise<string>} deps.copyText
 *   texto da página, sem o que está sob as tarjas (o OCR roda na hora se precisar; signal cancela)
 * @param {(page) => boolean} deps.canCopy false enquanto o app gera o PDF
 * @param {(page) => Promise<{blob: Blob, width: number, height: number, redactions: object[]}>} deps.editBase a
 *   página para o modo Editar: como vai sair no PDF, sem as edições; o tamanho dela em pontos e as tarjas nela
 * @param {(page, list: object[]) => Promise<void>} deps.saveEdits grava as edições e atualiza a miniatura
 * @param {(page) => void} deps.onClose chamado ao fechar, para devolver o foco ao cartão da página
 */
export function setupViewer({
  renderProcessed, canCrop, viewHint = () => null, renderOriginal, detect, applyCrop, step, renderPlain, redactHint,
  saveRedactions, copyText, canCopy, editBase, saveEdits, onClose,
}) {
  const dialog = $('#viewer');
  const title = $('#viewer-title');
  const stage = $('#viewer-stage');
  const image = $('#viewer-image');
  const crop = $('#crop');
  const cropImage = $('#crop-image');
  const polygon = $('#crop-polygon');
  const handles = [...crop.querySelectorAll('.crop-handle')];
  const loupe = $('#crop-loupe');
  const hint = $('#viewer-hint');
  const viewActions = $('#viewer-view-actions');
  const cropActions = $('#viewer-crop-actions');
  const applyButton = $('#crop-apply');
  const prevButton = $('#viewer-prev');
  const nextButton = $('#viewer-next');
  const cropButton = $('#viewer-crop');
  const redact = $('#redact');
  const redactImage = $('#redact-image');
  const redactBoxes = $('#redact-boxes');
  const redactPreview = $('#redact-preview');
  const redactActions = $('#viewer-redact-actions');
  const redactAdd = $('#redact-add');
  const redactUndo = $('#redact-undo');
  const redactApply = $('#redact-apply');
  const copyButton = $('#viewer-copy');
  const editButton = $('#viewer-edit');
  const discard = $('#discard-dialog');

  let page = null;
  let label = '';
  let points = FULL_QUAD; // cantos sobre a foto girada, de 0 a 1
  let marks = []; // tarjas em edição, de 0 a 1 na página como aparece
  let token = 0; // invalida renderizações que terminam depois de a pessoa já ter mudado de tela
  let copying = null; // AbortController da cópia do texto em andamento (o OCR pode levar segundos)
  let loupeOwner = null; // ponteiro que arrasta o canto mostrado na lupa
  let editor = null; // modo Editar (editor.js), carregado na primeira vez
  const urls = { view: '', crop: '', redact: '' };
  // Recorte, tarjas ou edição: sem trocar de página.
  const editing = () => !crop.hidden || !redact.hidden || !!editor?.active();

  function setUrl(kind, img, blob) {
    if (urls[kind]) URL.revokeObjectURL(urls[kind]);
    urls[kind] = blob ? URL.createObjectURL(blob) : '';
    if (blob) img.src = urls[kind];
  }

  // Nova tela (outra página, recorte, tarjas ou fechar): o que ainda estava carregando não vale mais, e a cópia do
  // texto em andamento é cancelada (o OCR para na hora).
  function nextToken() {
    copying?.abort();
    copying = null;
    return ++token;
  }

  // startInCrop: abre direto no ajuste do recorte (botão "Ajustar recorte" do cartão).
  function open(target, name, startInCrop = false) {
    page = target;
    label = name;
    dialog.showModal();
    if (startInCrop) showCrop();
    else showView();
  }

  async function showView() {
    const mine = nextToken();
    title.textContent = label;
    crop.hidden = true;
    cropActions.hidden = true;
    redact.hidden = true;
    redactActions.hidden = true;
    editor?.close();
    viewActions.hidden = false;
    cropButton.hidden = !canCrop(page);
    copyButton.hidden = !canCopy(page) || !clipboardWorks();
    updateNav(true);
    image.hidden = false;
    stage.classList.remove('zoomed');
    image.src = page.thumbUrl; // aparece na hora; a versão nítida entra em seguida
    image.alt = `${label}, como vai sair no PDF`;
    hint.textContent = 'Carregando em alta qualidade…';
    try {
      const blob = await renderProcessed(page);
      if (mine !== token) return;
      setUrl('view', image, blob);
      // Com a cópia do texto em andamento, o aviso dela continua na tela.
      if (!copying) hint.textContent = viewHint(page) ?? 'É assim que a página vai sair no PDF. Toque na imagem para ampliar.';
    } catch (err) {
      console.error(err);
      if (mine === token && !copying) hint.textContent = 'Mostrando a miniatura (não deu para carregar em alta qualidade).';
    }
  }

  async function showCrop() {
    const mine = nextToken();
    title.textContent = `Recorte: ${label}`;
    updateNav(false); // no meio do recorte, trocar de página perderia os cantos arrastados
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
    hideLoupe(); // a tela pode ter fechado no meio de um arrasto
    crop.hidden = false;
    cropActions.hidden = false;
    const lost = [page.redactions?.length && 'as tarjas', page.edits?.length && 'as edições'].filter(Boolean).join(' e ');
    hint.textContent = lost
      ? `Arraste os quatro cantos até as bordas do papel. Mudar o recorte apaga ${lost} desta página.`
      : 'Arraste os quatro cantos até as bordas do papel.';
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
      showLoupe(index, event, crop.getBoundingClientRect());
    });
    handle.addEventListener('pointermove', (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const box = crop.getBoundingClientRect();
      movePoint(index, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
      showLoupe(index, event, box);
    });
    // pointerup, pointercancel e perda de captura soltam o canto sozinhos (a captura acaba junto); a lupa some.
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      handle.addEventListener(type, (event) => {
        if (event.pointerId === loupeOwner) hideLoupe();
      });
    }
    // Pelas setas a lupa não aparece: nada cobre o canto.
    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.05 : 0.01;
      const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (!move) return;
      event.preventDefault();
      movePoint(index, points[index][0] + move[0], points[index][1] + move[1]);
    });
  });

  // ---------- Lupa do recorte ----------
  // O dedo cobre o canto que está arrastando: um círculo longe dele mostra a foto ampliada em volta do canto, com
  // a mira no ponto exato e as duas linhas do recorte que saem dele. Desenha a foto que já está na memória, na
  // resolução dela e na densidade da tela; nada fica guardado.
  loupe.style.width = loupe.style.height = `${LOUPE_SIZE}px`;

  // box: retângulo da área de recorte na tela (do tamanho da foto).
  function showLoupe(index, event, box) {
    loupeOwner = event.pointerId;
    const [x, y] = points[index];
    const corner = { x: box.left + x * box.width, y: box.top + y * box.height };
    // Nem o dedo nem o canto ficam embaixo da lupa (os dois se separam quando o dedo passa da borda da foto).
    const spot = {
      left: Math.min(corner.x, event.clientX), right: Math.max(corner.x, event.clientX),
      top: Math.min(corner.y, event.clientY), bottom: Math.max(corner.y, event.clientY),
    };
    const center = loupeCenter(spot, { width: document.documentElement.clientWidth, height: window.innerHeight });
    loupe.style.left = `${center.x - LOUPE_SIZE / 2}px`;
    loupe.style.top = `${center.y - LOUPE_SIZE / 2}px`;
    drawLoupe(index, box);
    loupe.hidden = false;
  }

  function hideLoupe() {
    loupe.hidden = true;
    loupeOwner = null;
  }

  function drawLoupe(index, box) {
    const side = Math.round(LOUPE_SIZE * (window.devicePixelRatio || 1));
    const dpr = side / LOUPE_SIZE; // px do canvas por px da tela
    if (loupe.width !== side) loupe.width = loupe.height = side;
    const ctx = loupe.getContext('2d');
    ctx.clearRect(0, 0, side, side);
    const width = cropImage.naturalWidth;
    const height = cropImage.naturalHeight;
    // Px do canvas por unidade da área de recorte (0 a 1) e por px da foto original.
    const unitX = box.width * LOUPE_ZOOM * dpr;
    const unitY = box.height * LOUPE_ZOOM * dpr;
    const kx = unitX / width;
    const ky = unitY / height;
    const [cx, cy] = points[index];
    // Trecho da foto em volta do canto, cortado nas bordas dela (fora da foto aparece o fundo do canvas, no CSS).
    const x0 = cx * width - side / 2 / kx;
    const y0 = cy * height - side / 2 / ky;
    const sx = Math.max(0, x0);
    const sy = Math.max(0, y0);
    const ex = Math.min(width, x0 + side / kx);
    const ey = Math.min(height, y0 + side / ky);
    ctx.imageSmoothingQuality = 'high';
    if (ex > sx && ey > sy) ctx.drawImage(cropImage, sx, sy, ex - sx, ey - sy, (sx - x0) * kx, (sy - y0) * ky, (ex - sx) * kx, (ey - sy) * ky);
    // As duas linhas do recorte que saem do canto, na cor do polígono (vermelha quando os cantos se cruzam).
    const at = ([px, py]) => [side / 2 + (px - cx) * unitX, side / 2 + (py - cy) * unitY];
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = getComputedStyle(polygon).stroke;
    ctx.beginPath();
    ctx.moveTo(...at(points[(index + 3) % 4]));
    ctx.lineTo(side / 2, side / 2);
    ctx.lineTo(...at(points[(index + 1) % 4]));
    ctx.stroke();
    // Mira: um anel em volta do ponto exato, branco com contorno escuro para aparecer em qualquer foto.
    const ring = 7 * dpr;
    for (const [color, line] of [['rgba(0, 0, 0, 0.6)', 3.5], ['#fff', 1.5]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = line * dpr;
      ctx.beginPath();
      ctx.arc(side / 2, side / 2, ring, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ---------- Tarjas ----------
  // Arrastar sobre a página marca um retângulo. Pelo teclado: "Nova tarja" cria uma no meio da página, as setas
  // movem, Shift e setas mudam o tamanho, e Delete remove. Nada muda na página até "Aplicar tarjas".

  async function showRedact() {
    const mine = nextToken();
    title.textContent = `Tarjas: ${label}`;
    updateNav(false);
    image.hidden = true;
    viewActions.hidden = true;
    stage.classList.remove('zoomed');
    hint.textContent = 'Preparando a página…';
    let blob;
    try {
      blob = await renderPlain(page);
    } catch (err) {
      console.error(err);
      if (mine === token) hint.textContent = 'Não deu para preparar a página para tarjar.';
      return;
    }
    if (mine !== token) return;
    marks = (page.redactions ?? []).map((rect) => ({ ...rect }));
    setUrl('redact', redactImage, blob);
    await redactImage.decode().catch(() => {});
    if (mine !== token) return;
    redact.hidden = false;
    redactActions.hidden = false;
    hint.textContent = redactHint(page);
    fitRedact();
    drawMarks();
    redactAdd.focus();
  }

  // A área das tarjas tem exatamente o tamanho da página na tela, como a do recorte.
  function fitRedact() {
    if (redact.hidden || !redactImage.naturalWidth) return;
    const margin = 8;
    const scale = Math.min((stage.clientWidth - margin * 2) / redactImage.naturalWidth, (stage.clientHeight - margin * 2) / redactImage.naturalHeight);
    redact.style.width = `${Math.max(40, redactImage.naturalWidth * scale)}px`;
    redact.style.height = `${Math.max(40, redactImage.naturalHeight * scale)}px`;
  }

  const place = (element, { x0, y0, x1, y1 }) => {
    element.style.left = `${x0 * 100}%`;
    element.style.top = `${y0 * 100}%`;
    element.style.width = `${(x1 - x0) * 100}%`;
    element.style.height = `${(y1 - y0) * 100}%`;
  };

  // Recria as caixas. focus: posição da tarja que recebe o foco (a recém-criada ou a que mexeu pelo teclado).
  function drawMarks(focus = -1) {
    redactBoxes.replaceChildren(...marks.map((mark, i) => {
      const box = document.createElement('div');
      box.className = 'redact-box';
      box.tabIndex = 0;
      box.dataset.index = i;
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', `Tarja ${i + 1}: as setas movem, Shift e setas mudam o tamanho, Delete remove`);
      place(box, mark);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'redact-remove';
      remove.dataset.index = i;
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remover a tarja ${i + 1}`);
      box.append(remove);
      return box;
    }));
    redactUndo.disabled = !marks.length;
    if (focus >= 0) redactBoxes.children[focus]?.focus();
  }

  function removeMark(index) {
    marks.splice(index, 1);
    drawMarks(Math.min(index, marks.length - 1));
    if (!marks.length) redactAdd.focus();
    hint.textContent = marks.length ? `Tarja removida. Ficam ${marks.length}.` : 'Tarja removida. Nenhuma tarja nesta página.';
  }

  let drawing = null; // {id, x, y}: ponto onde o dedo (ou o mouse) começou a arrastar
  const pointIn = (event) => {
    const box = redact.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  };
  redact.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.redact-remove') || drawing) return;
    event.preventDefault();
    redact.setPointerCapture(event.pointerId);
    const { x, y } = pointIn(event);
    drawing = { id: event.pointerId, x, y };
    place(redactPreview, { x0: x, y0: y, x1: x, y1: y });
    redactPreview.hidden = false;
  });
  redact.addEventListener('pointermove', (event) => {
    if (drawing?.id !== event.pointerId) return;
    const { x, y } = pointIn(event);
    place(redactPreview, { x0: Math.min(x, drawing.x), y0: Math.min(y, drawing.y), x1: Math.max(x, drawing.x), y1: Math.max(y, drawing.y) });
  });
  redact.addEventListener('pointerup', (event) => {
    if (drawing?.id !== event.pointerId) return;
    const { x, y } = pointIn(event);
    const rect = normalizeRect({ x0: drawing.x, y0: drawing.y, x1: x, y1: y });
    drawing = null;
    redactPreview.hidden = true;
    if (!rect) return; // toque sem arrastar
    marks.push(rect);
    drawMarks();
    hint.textContent = `${marks.length === 1 ? '1 tarja marcada' : `${marks.length} tarjas marcadas`}. Toque em "Aplicar tarjas" quando terminar.`;
  });
  redact.addEventListener('pointercancel', () => {
    drawing = null;
    redactPreview.hidden = true;
  });

  redactBoxes.addEventListener('click', (event) => {
    const remove = event.target.closest('.redact-remove');
    if (remove) removeMark(Number(remove.dataset.index));
  });
  redactBoxes.addEventListener('keydown', (event) => {
    const box = event.target.closest('.redact-box');
    if (!box || event.target !== box) return;
    const index = Number(box.dataset.index);
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeMark(index);
      return;
    }
    const step = 0.01;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!move) return;
    event.preventDefault();
    const mark = marks[index];
    let next;
    if (event.shiftKey) {
      next = normalizeRect({ ...mark, x1: mark.x1 + move[0], y1: mark.y1 + move[1] });
    } else {
      // Move sem sair da página e sem mudar o tamanho.
      const dx = Math.min(1 - mark.x1, Math.max(-mark.x0, move[0]));
      const dy = Math.min(1 - mark.y1, Math.max(-mark.y0, move[1]));
      next = { x0: mark.x0 + dx, y0: mark.y0 + dy, x1: mark.x1 + dx, y1: mark.y1 + dy };
    }
    if (next) marks[index] = next;
    drawMarks(index);
  });

  redactAdd.addEventListener('click', () => {
    marks.push({ x0: 0.3, y0: 0.45, x1: 0.7, y1: 0.55 });
    drawMarks(marks.length - 1);
    hint.textContent = 'Tarja criada no meio da página: use as setas para mover e Shift e setas para mudar o tamanho.';
  });
  redactUndo.addEventListener('click', () => {
    if (!marks.length) return;
    marks.pop();
    drawMarks();
    hint.textContent = marks.length ? 'Última tarja desfeita.' : 'Última tarja desfeita. Nenhuma tarja nesta página.';
  });
  const redactDirty = () => !redact.hidden && JSON.stringify(marks) !== JSON.stringify(page?.redactions ?? []);
  $('#redact-cancel').addEventListener('click', () => leaveIfSure(showView));
  redactApply.addEventListener('click', async () => {
    redactApply.disabled = true;
    hint.textContent = 'Aplicando as tarjas…';
    try {
      await saveRedactions(page, marks.map((mark) => ({ ...mark })));
    } finally {
      redactApply.disabled = false;
    }
    showView();
  });
  $('#viewer-redact').addEventListener('click', showRedact);
  new ResizeObserver(fitRedact).observe(stage);

  // ---------- Editar ----------
  // O modo Editar (editor.js) carrega na primeira vez. A página aparece como vai sair no PDF, sem as edições, que o
  // editor desenha por cima; as tarjas ficam por cima de tudo.

  let loading = null;
  // Ao sair do modo Editar (Aplicar ou Cancelar), o foco volta para o botão "Editar".
  const leaveEdit = () => {
    showView();
    editButton.focus();
  };
  const loadEditor = () => (loading ??= import('./editor.js').then(({ setupEditor }) => (editor = setupEditor({
    stage, hint, save: saveEdits, confirm: confirmDiscard, leave: leaveEdit,
  }))).catch((err) => {
    loading = null; // sem rede e sem cache: tenta de novo na próxima vez
    throw err;
  }));

  async function showEdit() {
    const mine = nextToken();
    title.textContent = `Editar: ${label}`;
    updateNav(false);
    image.hidden = true;
    viewActions.hidden = true;
    stage.classList.remove('zoomed');
    hint.textContent = 'Preparando a página…';
    let base;
    try {
      [, base] = await Promise.all([loadEditor(), editBase(page)]);
    } catch (err) {
      console.error(err);
      if (mine !== token) return;
      image.hidden = false;
      viewActions.hidden = false;
      updateNav(true);
      hint.textContent = 'Não deu para preparar a página para editar. Confira a conexão e tente de novo.';
      return;
    }
    if (mine !== token) return;
    await editor.open(page, base, () => mine === token);
  }
  editButton.addEventListener('click', showEdit);

  // ---------- Sair sem aplicar ----------
  // Tarjas ou edições que não foram aplicadas: fechar, cancelar ou Esc perguntam antes, numa janela do próprio app.

  let settle = null; // resposta da confirmação aberta
  $('#discard-keep').addEventListener('click', () => settle?.(false));
  $('#discard-confirm').addEventListener('click', () => settle?.(true));
  discard.addEventListener('cancel', (event) => { // Esc: continua editando
    event.preventDefault();
    settle?.(false);
  });

  /** @returns {Promise<boolean>} true: descartar */
  function confirmDiscard(message) {
    if (settle) return Promise.resolve(false);
    return new Promise((resolve) => {
      settle = (ok) => {
        settle = null;
        discard.close();
        resolve(ok);
      };
      $('#discard-text').textContent = message;
      discard.showModal();
      $('#discard-keep').focus();
    });
  }

  const unsaved = () => (editor?.dirty() ? 'As edições desta página ainda não foram aplicadas. Se sair agora, elas se perdem.'
    : redactDirty() ? 'As tarjas desta página ainda não foram aplicadas. Se sair agora, elas se perdem.' : '');

  async function leaveIfSure(action) {
    const message = unsaved();
    if (message && !(await confirmDiscard(message))) return;
    action();
  }

  // Esc: no modo Editar, fecha antes o painel ou o traço em andamento; com mudança não aplicada, pergunta. O keydown
  // cancelado não chega a fechar a tela; o cancel é a reserva, para o navegador que fechar mesmo assim.
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !dialog.open) return;
    if (editor?.active() && editor.escape()) {
      event.preventDefault();
      return;
    }
    if (unsaved()) {
      event.preventDefault();
      leaveIfSure(() => dialog.close());
    }
  }, true);
  dialog.addEventListener('cancel', (event) => {
    if (!unsaved()) return;
    event.preventDefault();
    leaveIfSure(() => dialog.close());
  });

  // ---------- Copiar o texto ----------
  // O texto vai só para a área de transferência do aparelho: nunca para o console nem para o HTML da página.

  const clipboardWorks = () => !!(navigator.clipboard?.write || navigator.clipboard?.writeText);

  // O Safari só deixa escrever na área de transferência durante o toque, e o OCR leva segundos: o ClipboardItem
  // recebe a promessa do texto, e o navegador espera por ela sem perder o toque (o Chromium também). Sem
  // ClipboardItem, o texto vai pelo writeText depois de pronto.
  function writeClipboard(text) {
    if (typeof ClipboardItem === 'function' && navigator.clipboard?.write) {
      const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
      blob.catch(() => {}); // quem explica o erro do texto é o aviso da cópia
      try {
        return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      } catch {
        // ClipboardItem que não aceita promessa: vai pelo writeText
      }
    }
    return text.then((value) => navigator.clipboard.writeText(value));
  }

  copyButton.addEventListener('click', async () => {
    if (!page || copying || !canCopy(page)) return;
    const mine = token;
    const target = page;
    const job = new AbortController();
    copying = job;
    const say = (message) => {
      if (mine === token) hint.textContent = message;
    };
    say('Copiando o texto…');
    // Tudo dentro do toque: o pedido do texto começa e a escrita na área de transferência já fica esperando por ele.
    const text = copyText(target, { signal: job.signal, progress: say });
    let blocked = false;
    try {
      await writeClipboard(text);
    } catch {
      blocked = true; // se o texto falhou, a escrita falha junto; o motivo vem abaixo
    }
    const result = await text.then((value) => ({ value }), (error) => ({ error }));
    if (mine !== token) return; // fechou a tela ou trocou de página: a cópia foi cancelada
    copying = null;
    if (result.error) {
      const known = ['CopyError', 'OcrError'].includes(result.error?.name);
      if (!known) console.error(result.error);
      hint.textContent = known ? result.error.message : 'Não deu para ler o texto desta página.';
      return;
    }
    if (blocked) {
      hint.textContent = 'O navegador não liberou a área de transferência. Toque em "Copiar texto" de novo.';
      return;
    }
    const count = wordCount(result.value);
    const words = count === 1 ? '1 palavra' : `${count} palavras`;
    hint.textContent = target.redactions?.length
      ? `Texto copiado (${words}), sem o que está sob as tarjas. Ele não sai do aparelho.`
      : `Texto copiado (${words}). Ele não sai do aparelho.`;
  });

  // ---------- Anterior / próxima ----------

  // As setas encostam nas bordas da página exibida, sem sair da tela (no celular, ficam nas bordas da tela).
  function placeSteps() {
    const frame = stage.parentElement.getBoundingClientRect();
    const box = image.hidden || stage.classList.contains('zoomed') || !image.complete ? frame : image.getBoundingClientRect();
    const gap = 16;
    const size = prevButton.offsetWidth || 48;
    prevButton.style.left = `${Math.max(12, box.left - frame.left - size - gap)}px`;
    nextButton.style.right = `${Math.max(12, frame.right - box.right - size - gap)}px`;
  }
  image.addEventListener('load', placeSteps);
  new ResizeObserver(placeSteps).observe(stage);

  // Na primeira e na última página, a seta que não leva a lugar nenhum some; no recorte, as duas.
  function updateNav(enabled) {
    prevButton.hidden = !enabled || !step(page, -1);
    nextButton.hidden = !enabled || !step(page, 1);
    placeSteps();
  }

  function go(delta) {
    if (!page || editing()) return;
    const next = step(page, delta);
    if (!next) return;
    page = next.page;
    label = next.label;
    showView();
    // Chegou na ponta e a seta clicada sumiu: o foco passa para a outra seta (ou para "Fechar").
    if (document.activeElement?.hidden) (!prevButton.hidden ? prevButton : !nextButton.hidden ? nextButton : $('#viewer-close')).focus();
  }

  prevButton.addEventListener('click', () => go(-1));
  nextButton.addEventListener('click', () => go(1));
  dialog.addEventListener('keydown', (event) => {
    if (editing() || event.target.matches('select, input')) return;
    if (event.key === 'ArrowLeft') go(-1);
    else if (event.key === 'ArrowRight') go(1);
    else return;
    event.preventDefault();
  });

  // Deslizar para o lado na imagem (sem zoom) também troca de página.
  // Sem zoom, o deslizar horizontal é nosso (ver touch-action no CSS); com zoom, rola a imagem.
  image.draggable = false; // no mouse, arrastar a imagem não pode virar "arrastar arquivo"
  let swipe = null;
  let swiped = false;
  image.addEventListener('pointerdown', (event) => { swipe = { x: event.clientX, y: event.clientY }; });
  image.addEventListener('pointerup', (event) => {
    if (!swipe || stage.classList.contains('zoomed')) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true; // o "click" que vem logo depois não deve ampliar a imagem
      go(dx < 0 ? 1 : -1);
    }
  });

  $('#viewer-crop').addEventListener('click', showCrop);
  $('#viewer-close').addEventListener('click', () => leaveIfSure(() => dialog.close()));
  image.addEventListener('click', () => {
    if (swiped) { swiped = false; return; }
    stage.classList.toggle('zoomed');
    placeSteps();
  });

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
    nextToken();
    setUrl('view', image, null);
    setUrl('crop', cropImage, null);
    setUrl('redact', redactImage, null);
    image.removeAttribute('src');
    cropImage.removeAttribute('src');
    redactImage.removeAttribute('src');
    redact.hidden = true;
    redactActions.hidden = true;
    marks = [];
    editor?.close();
    const closed = page;
    page = null;
    setTimeout(() => onClose(closed), 0); // depois de o navegador devolver o foco por conta própria
  });

  return { open };
}

/**
 * Centro da lupa do recorte, em px da tela. Fica acima do que ela não pode cobrir (o dedo e o canto arrastado), a
 * uma distância que o dedo não cobre. Sem espaço em cima, vai para o lado com mais espaço; se também não couber,
 * para baixo. Nunca sai da tela, nem com o ponteiro fora dela.
 * @param {{left: number, top: number, right: number, bottom: number}} spot o que fica descoberto
 * @param {{width: number, height: number}} screen
 * @returns {{x: number, y: number}}
 */
export function loupeCenter(spot, screen, { size = LOUPE_SIZE, gap = LOUPE_GAP, margin = 8 } = {}) {
  const radius = size / 2;
  const away = gap + radius; // da borda do que fica descoberto até o centro da lupa
  const min = margin + radius;
  const clampX = (x) => Math.max(min, Math.min(screen.width - min, x));
  const clampY = (y) => Math.max(min, Math.min(screen.height - min, y));
  const middleX = (spot.left + spot.right) / 2;
  const above = spot.top - away;
  if (above >= min) return { x: clampX(middleX), y: clampY(above) };
  const side = screen.width - spot.right >= spot.left ? spot.right + away : spot.left - away;
  const middleY = clampY((spot.top + spot.bottom) / 2);
  if (side >= min && side <= screen.width - min) return { x: side, y: middleY };
  const below = spot.bottom + away;
  if (below <= screen.height - min) return { x: clampX(middleX), y: clampY(below) };
  return { x: clampX(side), y: middleY }; // tela pequena demais: o que couber
}
