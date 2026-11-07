// Tela cheia de uma página: mostra como ela vai sair no PDF, deixa ajustar o recorte arrastando os quatro
// cantos sobre a foto original, marcar tarjas (retângulos que apagam o que está embaixo, redact.js), editar a página
// (desenho, formas e marcas que ficam fixos no PDF, editor.js), preencher os campos do formulário de uma página de PDF
// (form-panel.js) e copiar o texto da página para a área de transferência.
import { FULL_QUAD, fromRotated, toRotated, isConvex, isFullFrame } from './geometry.js';
import { normalizeRect } from './redact.js';
import { replacementLayout, winAnsiText, droppedMessage } from './edit-text.js';
import { followKeyboard } from './keyboard-panel.js';
import { setupPageZoom } from './page-zoom.js';
import { nudgeControls, nudgeOf } from './edit-nudge.js';
import { wordCount } from './page-text.js';
import { t, plural } from './i18n.js';

const SVG = 'http://www.w3.org/2000/svg';

// O texto de uma tarja num SVG do tamanho da caixa dela (replacementLayout, em edit-text.js): na tela, como no PDF.
// page: o tamanho da página em qualquer unidade (a proporção é o que conta). null sem texto.
export function replacementSvg(rect, page) {
  const layout = replacementLayout(rect, page);
  if (!layout) return null;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', layout.viewBox);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  for (const line of layout.lines) {
    const text = document.createElementNS(SVG, 'text');
    text.setAttribute('x', String(line.x));
    text.setAttribute('y', String(line.y));
    text.setAttribute('font-size', String(layout.size));
    text.setAttribute('font-family', layout.font);
    text.setAttribute('fill', layout.color);
    text.setAttribute('textLength', String(line.width));
    text.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    text.textContent = line.text;
    svg.append(text);
  }
  return svg;
}

const $ = (selector) => document.querySelector(selector);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const CORNERS = [t('Canto superior esquerdo'), t('Canto superior direito'), t('Canto inferior direito'), t('Canto inferior esquerdo')];
const START_INSET = 0.04; // sem recorte ainda: os cantos começam um pouco para dentro, fáceis de pegar
const LOUPE_SIZE = 120; // diâmetro da lupa do recorte, em px da tela
const LOUPE_ZOOM = 3; // ampliação sobre a foto como ela aparece na tela
const LOUPE_GAP = 48; // do dedo até a borda da lupa: o dedo não cobre
const TAP = 6; // px da tela: menos que isso, no canto do recorte, é um toque (escolhe o canto), não um arrasto

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
 * @param {(page) => boolean} [deps.canFill] a página é de um PDF com campos que dá para preencher
 * @param {(page) => Promise<{blob: Blob, width: number, height: number, form: object, index: number, rotation: number}>}
 *   [deps.fillBase] a página para o modo Preencher, como vai sair; o formulário, a página no PDF e o giro do app
 * @param {(page, changes: Map<number, unknown>, problems: object) => Promise<string>} [deps.saveForm] grava os valores
 *   do formulário (form-panel.js) e devolve o aviso
 * @param {(page) => Promise<object[] | null>} [deps.fillText] o texto da página, para os rótulos dos campos
 * @param {(page) => Promise<string | null>} [deps.formHint] a dica da página de PDF sem campos que parece um formulário
 * @param {(page) => void} deps.onClose chamado ao fechar, para devolver o foco ao cartão da página
 */
export function setupViewer({
  renderProcessed, canCrop, viewHint = () => null, renderOriginal, detect, applyCrop, step, renderPlain, redactHint,
  saveRedactions, copyText, canCopy, editBase, saveEdits, onClose,
  canFill = () => false, fillBase, saveForm, fillText = async () => null, formHint = async () => null,
}) {
  const dialog = $('#viewer');
  const title = $('#viewer-title');
  const stage = $('#viewer-stage');
  const image = $('#viewer-image');
  const crop = $('#crop');
  const cropImage = $('#crop-image');
  const polygon = $('#crop-polygon');
  // Traço duplo na linha do recorte: um contorno escuro por baixo da linha clara, para ela aparecer (contraste de 3:1)
  // tanto no papel branco quanto no fundo escuro.
  const halo = polygon.cloneNode();
  halo.removeAttribute('id');
  halo.classList.add('crop-halo');
  polygon.before(halo);
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
  const redactColors = [$('#redact-black'), $('#redact-white')];
  const redactWrite = $('#redact-write');
  const textPanel = $('#redact-text-panel');
  const textInput = $('#redact-text');
  const textNote = $('#redact-text-note');
  const copyButton = $('#viewer-copy');
  const editButton = $('#viewer-edit');
  const fillButton = $('#viewer-fill');
  const discard = $('#discard-dialog');
  // Zoom da página (page-zoom.js): os botões ficam na barra do título. No Tarjar e no Editar, a página amplia em
  // passos; na visualização, entre a página inteira e a ampliada (como no toque na imagem).
  const zoom = setupPageZoom({ stage, controls: $('#page-zoom'), say: (message) => { hint.textContent = message; } });

  let page = null;
  let label = '';
  let points = FULL_QUAD; // cantos sobre a foto girada, de 0 a 1
  let marks = []; // tarjas em edição, de 0 a 1 na página como aparece
  let current = -1; // a tarja selecionada (a última criada ou tocada): a cor e o texto mudam nela
  let markColor = 'black'; // a cor das próximas tarjas
  let stopKeyboard = null; // para de acompanhar o teclado (painel do texto da tarja)
  let token = 0; // invalida renderizações que terminam depois de a pessoa já ter mudado de tela
  let copying = null; // AbortController da cópia do texto em andamento (o OCR pode levar segundos)
  let loupeOwner = null; // ponteiro que arrasta o canto mostrado na lupa
  let pressed = null; // {index, id, x, y, moved}: o canto do recorte sob o ponteiro, antes de saber se é toque ou arrasto
  let armed = -1; // o canto escolhido com um toque: o próximo toque na foto o leva até lá
  let editor = null; // modo Editar (editor.js), carregado na primeira vez
  let filler = null; // modo Preencher (form-panel.js), carregado na primeira vez
  const urls = { view: '', crop: '', redact: '' };
  // Recorte, tarjas ou edição: sem trocar de página.
  const editing = () => !crop.hidden || !redact.hidden || !!editor?.active() || !!filler?.active();

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

  // startInCrop: abre direto no ajuste do recorte (botão "Recortar" do cartão).
  function open(target, name, startInCrop = false) {
    page = target;
    label = name;
    dialog.showModal();
    if (startInCrop) showCrop();
    else showView();
  }

  // note: aviso que fica na dica depois de carregar (o resultado de "Aplicar" no Preencher). Como ouvinte de clique,
  // recebe o evento: aí não há aviso.
  async function showView(note = '') {
    const mine = nextToken();
    title.textContent = label;
    crop.hidden = true;
    cropActions.hidden = true;
    redact.hidden = true;
    redactActions.hidden = true;
    closeTextPanel(false);
    zoom.detach(redact);
    editor?.close();
    filler?.close();
    viewActions.hidden = false;
    cropButton.hidden = !canCrop(page);
    fillButton.hidden = !canFill(page);
    copyButton.hidden = !canCopy(page) || !clipboardWorks();
    updateNav(true);
    image.hidden = false;
    stage.classList.remove('zoomed');
    zoom.view(viewZoom);
    image.src = page.thumbUrl; // aparece na hora; a versão nítida entra em seguida
    image.alt = t('{label}, como vai sair no PDF', { label });
    const message = typeof note === 'string' ? note : '';
    hint.textContent = message || t('Carregando em alta qualidade…');
    try {
      const blob = await renderProcessed(page);
      if (mine !== token) return;
      setUrl('view', image, blob);
      // Com a cópia do texto em andamento, o aviso dela continua na tela.
      if (!copying) hint.textContent = message || (viewHint(page) ?? t('É assim que a página vai sair no PDF. Toque ou clique na imagem para ampliar.'));
      // Página de PDF sem campos que parece um formulário: a dica de sempre dá lugar à do Editar → Texto.
      if (!message && !viewHint(page)) {
        formHint(page).then((tip) => {
          if (tip && mine === token && !copying) hint.textContent = tip;
        }, () => {});
      }
    } catch (err) {
      console.error(err);
      if (mine === token && !copying) hint.textContent = t('Mostrando a miniatura (não deu para carregar em alta qualidade).');
    }
  }

  async function showCrop() {
    const mine = nextToken();
    title.textContent = t('Recorte: {label}', { label });
    updateNav(false); // no meio do recorte, trocar de página perderia os cantos arrastados
    image.hidden = true;
    viewActions.hidden = true;
    stage.classList.remove('zoomed');
    zoom.view(null);
    hint.textContent = t('Preparando a foto…');
    const blob = await renderOriginal(page);
    if (mine !== token) return;
    points = page.quad
      ? toRotated(page.quad, page.rotation)
      : FULL_QUAD.map(([x, y]) => [x ? 1 - START_INSET : START_INSET, y ? 1 - START_INSET : START_INSET]);
    setUrl('crop', cropImage, blob);
    await cropImage.decode().catch(() => {});
    if (mine !== token) return;
    hideLoupe(); // a tela pode ter fechado no meio de um arrasto
    pressed = null;
    arm(-1);
    crop.hidden = false;
    cropActions.hidden = false;
    const redacted = page.redactions?.length;
    const edited = page.edits?.length;
    hint.textContent = redacted && edited ? t('Arraste os quatro cantos até as bordas do papel. Mudar o recorte apaga as tarjas e as edições desta página.')
      : redacted ? t('Arraste os quatro cantos até as bordas do papel. Mudar o recorte apaga as tarjas desta página.')
      : edited ? t('Arraste os quatro cantos até as bordas do papel. Mudar o recorte apaga as edições desta página.')
      : t('Arraste os quatro cantos até as bordas do papel.');
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
    const list = points.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');
    polygon.setAttribute('points', list);
    halo.setAttribute('points', list);
    handles.forEach((handle, i) => {
      handle.style.left = `${points[i][0] * 100}%`;
      handle.style.top = `${points[i][1] * 100}%`;
    });
    const valid = isConvex(points);
    crop.classList.toggle('invalid', !valid);
    applyButton.disabled = !valid;
    if (!valid) hint.textContent = t('Os cantos se cruzaram. Arraste-os de volta para formar um quadrilátero.');
  }

  function movePoint(index, x, y) {
    points = points.map((point, i) => (i === index ? [clamp01(x), clamp01(y)] : point));
    hint.textContent = t('Arraste os quatro cantos até as bordas do papel.');
    drawPoints();
  }

  // Sem arrastar (WCAG 2.5.7): tocar num canto o escolhe, e tocar na foto leva o canto escolhido até ali. Tocar de
  // novo no mesmo canto desiste. O arrasto e a lupa continuam como antes: o canto só anda depois de o dedo andar.
  function arm(index) {
    armed = index;
    handles.forEach((handle, i) => handle.classList.toggle('armed', i === index));
    crop.classList.toggle('armed', index >= 0);
  }

  handles.forEach((handle, index) => {
    handle.setAttribute('aria-label', t('{corner}: arraste, use as setas ou escolha ele e depois o lugar dele na foto', { corner: CORNERS[index] }));
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.focus();
      pressed = { index, id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      showLoupe(index, event, crop.getBoundingClientRect());
    });
    handle.addEventListener('pointermove', (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const box = crop.getBoundingClientRect();
      if (pressed?.id === event.pointerId && !pressed.moved) {
        if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < TAP) return;
        pressed.moved = true;
        arm(-1); // arrastou: o canto escolhido antes (este ou outro) fica para trás
      }
      movePoint(index, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
      showLoupe(index, event, box);
    });
    // Soltar sem ter andado é um toque: escolhe o canto (ou desiste, se já era ele).
    handle.addEventListener('pointerup', (event) => {
      if (pressed?.id !== event.pointerId) return;
      const tapped = !pressed.moved;
      pressed = null;
      if (!tapped) return;
      if (armed === index) {
        arm(-1);
        hint.textContent = t('Arraste os quatro cantos até as bordas do papel.');
      } else {
        arm(index);
        hint.textContent = t('{corner} escolhido: agora toque ou clique no lugar da foto para onde ele vai.', { corner: CORNERS[index] });
      }
    });
    // pointerup, pointercancel e perda de captura soltam o canto sozinhos (a captura acaba junto); a lupa some.
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      handle.addEventListener(type, (event) => {
        if (event.pointerId === loupeOwner) hideLoupe();
        if (type !== 'pointerup' && pressed?.id === event.pointerId) pressed = null;
      });
    }
    // Pelas setas a lupa não aparece: nada cobre o canto.
    handle.addEventListener('keydown', (event) => {
      const move = nudgeOf(event.key, event.shiftKey ? 0.05 : 0.01);
      if (!move) return;
      event.preventDefault();
      movePoint(index, points[index][0] + move[0], points[index][1] + move[1]);
    });
  });

  // O toque na foto, com um canto escolhido, leva o canto até ali; o foco fica nele.
  crop.addEventListener('click', (event) => {
    if (armed < 0 || event.target.closest('.crop-handle')) return;
    const box = crop.getBoundingClientRect();
    const index = armed;
    arm(-1);
    movePoint(index, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
    handles[index].focus();
    if (isConvex(points)) hint.textContent = t('{corner} no lugar novo.', { corner: CORNERS[index] });
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
    // Com o mesmo traço duplo da tela: o contorno escuro por baixo.
    ctx.lineJoin = 'round';
    for (const [color, line] of [['rgba(0, 0, 0, 0.8)', 5], [getComputedStyle(polygon).stroke, 2]]) {
      ctx.lineWidth = line * dpr;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(...at(points[(index + 3) % 4]));
      ctx.lineTo(side / 2, side / 2);
      ctx.lineTo(...at(points[(index + 1) % 4]));
      ctx.stroke();
    }
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
  // Arrastar sobre a página marca um retângulo; arrastar uma tarja move ela, e a alça do canto muda o tamanho. Pelo teclado: "Nova tarja" cria uma no meio da página, as setas
  // movem, Shift e setas mudam o tamanho, e Delete remove. Sem arrastar nem teclado: "Nova tarja" e as setas das
  // opções da tarja selecionada (edit-nudge.js), que fazem o mesmo. Nada muda na página até "Aplicar tarjas".

  // Mover e mudar o tamanho da tarja selecionada com toques: o mesmo passo das setas do teclado.
  const redactNudge = nudgeControls({
    act: (kind, dx, dy) => {
      if (current < 0) return;
      nudgeMark(current, kind, dx, dy);
      drawMarks();
      hint.textContent = kind === 'move' ? t('Tarja {n} movida.', { n: current + 1 }) : t('Tarja {n}: tamanho mudado.', { n: current + 1 });
    },
    say: (message) => { hint.textContent = message; },
  });
  $('.redact-options').append(redactNudge.element);

  async function showRedact() {
    const mine = nextToken();
    title.textContent = t('Tarjas: {label}', { label });
    updateNav(false);
    image.hidden = true;
    viewActions.hidden = true;
    stage.classList.remove('zoomed');
    zoom.view(null);
    hint.textContent = t('Preparando a página…');
    let blob;
    try {
      blob = await renderPlain(page);
    } catch (err) {
      console.error(err);
      if (mine === token) hint.textContent = t('Não deu para preparar a página para tarjar.');
      return;
    }
    if (mine !== token) return;
    marks = (page.redactions ?? []).map((rect) => ({ ...rect }));
    current = marks.length - 1;
    setUrl('redact', redactImage, blob);
    await redactImage.decode().catch(() => {});
    if (mine !== token) return;
    redact.hidden = false;
    redactActions.hidden = false;
    hint.textContent = redactHint(page);
    zoom.attach({
      surface: redact, base: redactBase, resized: () => {}, cancel: cancelDrawing,
      focus: () => (marks[current] ? [(marks[current].x0 + marks[current].x1) / 2, (marks[current].y0 + marks[current].y1) / 2] : null),
    });
    fitRedact();
    drawMarks();
    redactAdd.focus();
  }

  // Com zoom 1, a área das tarjas tem exatamente o tamanho da página na tela, como a do recorte; o zoom
  // (page-zoom.js) multiplica.
  function redactBase() {
    const margin = 8;
    const scale = Math.min((stage.clientWidth - margin * 2) / redactImage.naturalWidth, (stage.clientHeight - margin * 2) / redactImage.naturalHeight);
    return { width: redactImage.naturalWidth * scale, height: redactImage.naturalHeight * scale };
  }
  function fitRedact() {
    if (!redact.hidden && redactImage.naturalWidth) zoom.layout();
  }

  const place = (element, { x0, y0, x1, y1 }) => {
    element.style.left = `${x0 * 100}%`;
    element.style.top = `${y0 * 100}%`;
    element.style.width = `${(x1 - x0) * 100}%`;
    element.style.height = `${(y1 - y0) * 100}%`;
  };

  // A página das tarjas na unidade da imagem: o texto por cima delas guarda a proporção da página.
  const redactPage = () => ({ width: redactImage.naturalWidth || 1, height: redactImage.naturalHeight || 1 });

  // O nome da tarja para o leitor de tela: a cor e o texto escrito nela.
  function markLabel(mark, n) {
    const color = mark.color === 'white' ? t('branca') : t('preta');
    const text = mark.text?.trim();
    return text
      ? t('Tarja {n}, {color}, com o texto "{text}": as setas movem, Shift e setas mudam o tamanho, Delete remove', { n, color, text })
      : t('Tarja {n}, {color}: as setas movem, Shift e setas mudam o tamanho, Delete remove', { n, color });
  }

  // Recria as caixas. focus: posição da tarja que recebe o foco (a recém-criada ou a que mexeu pelo teclado).
  function drawMarks(focus = -1) {
    if (focus >= 0) current = focus;
    if (current >= marks.length) current = marks.length - 1;
    redactBoxes.replaceChildren(...marks.map((mark, i) => {
      const box = document.createElement('div');
      box.className = `redact-box${mark.color === 'white' ? ' white' : ''}${mark.text?.trim() ? ' has-text' : ''}${i === current ? ' selected' : ''}`;
      box.tabIndex = 0;
      box.dataset.index = i;
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', markLabel(mark, i + 1));
      place(box, mark);
      const svg = replacementSvg(mark, redactPage());
      if (svg) box.append(svg);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'redact-remove';
      remove.dataset.index = i;
      remove.textContent = '×';
      remove.setAttribute('aria-label', t('Remover a tarja {n}', { n: i + 1 }));
      box.append(remove);
      // Alça de tamanho (canto de baixo à direita): só aparece na tarja selecionada; arrastar muda o tamanho.
      const grip = document.createElement('span');
      grip.className = 'redact-grip';
      grip.setAttribute('aria-hidden', 'true');
      box.append(grip);
      return box;
    }));
    redactUndo.disabled = !marks.length;
    showOptions();
    if (focus >= 0) redactBoxes.children[focus]?.focus();
  }

  // Os botões da cor mostram a da tarja selecionada (ou a das próximas, sem seleção); "Escrever por cima" pede uma.
  function showOptions() {
    const color = marks[current]?.color === 'white' || (current < 0 && markColor === 'white') ? 'white' : 'black';
    for (const button of redactColors) button.setAttribute('aria-pressed', String(button.dataset.color === color));
    // Sem tarja selecionada, escrever, mover e o tamanho não têm em que agir: somem, em vez de ficar apagados (#34).
    redactWrite.disabled = current < 0;
    redactNudge.setDisabled(current < 0);
    redactWrite.hidden = current < 0;
    redactNudge.element.hidden = current < 0;
  }

  function selectMark(index) {
    current = index;
    for (const box of redactBoxes.children) box.classList.toggle('selected', Number(box.dataset.index) === index);
    showOptions();
  }

  function removeMark(index) {
    marks.splice(index, 1);
    if (current >= index) current -= 1;
    if (current < 0 && marks.length) current = 0;
    drawMarks(Math.min(index, marks.length - 1));
    if (!marks.length) redactAdd.focus();
    hint.textContent = marks.length ? t('Tarja removida. Ficam {n}.', { n: marks.length }) : t('Tarja removida. Nenhuma tarja nesta página.');
  }

  let drawing = null; // {id, x, y}: ponto onde o dedo (ou o mouse) começou a arrastar
  const pointIn = (event) => {
    const box = redact.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  };
  // Arrastar uma tarja que já existe move ela (com o texto escrito por cima); a alça do canto muda o tamanho. Um toque
  // sem arrastar seleciona. Fora das tarjas, arrastar marca uma nova.
  const DRAG_MIN = 6; // px: abaixo disso é toque, não arrasto
  let dragging = null; // {id, index, kind: 'move'|'grow', x, y, cx, cy, start, moved}
  redact.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.redact-remove') || drawing || dragging) return;
    event.preventDefault();
    redact.setPointerCapture(event.pointerId);
    const { x, y } = pointIn(event);
    const box = event.target.closest('.redact-box:not(.redact-preview)');
    if (box) {
      const index = Number(box.dataset.index);
      const kind = event.target.closest('.redact-grip') && index === current ? 'grow' : 'move';
      dragging = { id: event.pointerId, index, kind, x, y, cx: event.clientX, cy: event.clientY, start: { ...marks[index] }, moved: false };
      return;
    }
    drawing = { id: event.pointerId, x, y };
    place(redactPreview, { x0: x, y0: y, x1: x, y1: y });
    redactPreview.classList.toggle('white', markColor === 'white');
    redactPreview.hidden = false;
  });
  redact.addEventListener('pointermove', (event) => {
    if (dragging?.id === event.pointerId) {
      if (!dragging.moved && Math.hypot(event.clientX - dragging.cx, event.clientY - dragging.cy) < DRAG_MIN) return;
      if (!dragging.moved) {
        dragging.moved = true;
        selectMark(dragging.index);
      }
      const { x, y } = pointIn(event);
      const { start } = dragging;
      marks[dragging.index] = start;
      nudgeMark(dragging.index, dragging.kind, x - dragging.x, y - dragging.y);
      place(redactBoxes.children[dragging.index], marks[dragging.index]);
      return;
    }
    if (drawing?.id !== event.pointerId) return;
    const { x, y } = pointIn(event);
    place(redactPreview, { x0: Math.min(x, drawing.x), y0: Math.min(y, drawing.y), x1: Math.max(x, drawing.x), y1: Math.max(y, drawing.y) });
  });
  redact.addEventListener('pointerup', (event) => {
    if (dragging?.id === event.pointerId) {
      const { index, kind, moved } = dragging;
      dragging = null;
      if (!moved) {
        // Toque sem arrastar: seleciona (para mudar a cor, escrever nela ou ajustar).
        selectMark(index);
        hint.textContent = t('Tarja {n} selecionada: arraste para mover, ou pela alça do canto para mudar o tamanho.', { n: index + 1 });
        return;
      }
      drawMarks(index);
      hint.textContent = kind === 'move' ? t('Tarja {n} movida.', { n: index + 1 }) : t('Tarja {n}: tamanho mudado.', { n: index + 1 });
      return;
    }
    if (drawing?.id !== event.pointerId) return;
    const { x, y } = pointIn(event);
    const rect = normalizeRect({ x0: drawing.x, y0: drawing.y, x1: x, y1: y, ...newColor() });
    drawing = null;
    redactPreview.hidden = true;
    if (!rect) return; // toque fora das tarjas, sem arrastar: nada
    marks.push(rect);
    current = marks.length - 1;
    drawMarks();
    hint.textContent = plural(marks.length, '{n} tarja marcada. Ao terminar, use "Aplicar tarjas".', '{n} tarjas marcadas. Ao terminar, use "Aplicar tarjas".');
  });
  // O toque foi cancelado (pelo navegador, ou pelo segundo dedo da pinça do zoom): a tarja em andamento some.
  function cancelDrawing() {
    drawing = null;
    redactPreview.hidden = true;
    if (dragging) {
      // O arrasto da tarja também é desfeito: ela volta para onde estava.
      marks[dragging.index] = dragging.start;
      dragging = null;
      drawMarks();
    }
  }
  redact.addEventListener('pointercancel', cancelDrawing);

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
    const move = nudgeOf(event.key);
    if (!move) return;
    event.preventDefault();
    nudgeMark(index, event.shiftKey ? 'grow' : 'move', move[0], move[1]);
    drawMarks(index);
  });

  // Um passo das setas (do teclado ou das opções): move a tarja sem sair da página e sem mudar o tamanho, ou (grow)
  // leva o canto de baixo à direita, sem deixar a tarja pequena demais.
  function nudgeMark(index, kind, dx, dy) {
    const mark = marks[index];
    let next;
    if (kind === 'grow') {
      next = normalizeRect({ ...mark, x1: mark.x1 + dx, y1: mark.y1 + dy });
    } else {
      const mx = Math.min(1 - mark.x1, Math.max(-mark.x0, dx));
      const my = Math.min(1 - mark.y1, Math.max(-mark.y0, dy));
      next = { ...mark, x0: mark.x0 + mx, y0: mark.y0 + my, x1: mark.x1 + mx, y1: mark.y1 + my };
    }
    if (next) marks[index] = next;
  }

  redactBoxes.addEventListener('focusin', (event) => {
    const box = event.target.closest('.redact-box');
    if (box) selectMark(Number(box.dataset.index));
  });

  // A tarja nova leva a cor escolhida (sem nada: preta).
  const newColor = () => (markColor === 'white' ? { color: 'white' } : {});

  redactAdd.addEventListener('click', () => {
    marks.push({ x0: 0.3, y0: 0.45, x1: 0.7, y1: 0.55, ...newColor() });
    drawMarks(marks.length - 1);
    hint.textContent = t('Tarja criada no meio da página: use as setas (da tela ou do teclado) para mover; Tamanho, ou Shift e setas, muda o tamanho.');
  });
  redactUndo.addEventListener('click', () => {
    if (!marks.length) return;
    marks.pop();
    current = marks.length - 1;
    drawMarks();
    hint.textContent = marks.length ? t('Última tarja desfeita.') : t('Última tarja desfeita. Nenhuma tarja nesta página.');
  });
  // Cor: muda a tarja selecionada e fica para as próximas.
  for (const button of redactColors) {
    button.addEventListener('click', () => {
      markColor = button.dataset.color;
      const mark = marks[current];
      if (mark) {
        if (markColor === 'white') mark.color = 'white';
        else delete mark.color;
        drawMarks();
      } else {
        showOptions();
      }
      hint.textContent = markColor === 'white'
        ? t('Tarja branca: o que fica embaixo é apagado do mesmo jeito, mas quem recebe o PDF não vê que algo foi tirado.')
        : t('Tarja preta.');
    });
  }

  // Escrever por cima: o painel abre com o texto da tarja selecionada.
  function openTextPanel() {
    const mark = marks[current];
    if (!mark) return;
    textInput.value = mark.text ?? '';
    textNote.textContent = t('O que está embaixo da tarja é apagado do PDF, e este texto vai no lugar, do maior tamanho que cabe nela. Para a letra ficar menor, deixe a tarja mais baixa.');
    textPanel.hidden = false;
    stopKeyboard?.();
    stopKeyboard = followKeyboard(textPanel);
    textInput.focus();
  }

  // focus: devolve o foco à tarja (fechar pelo Cancelar ou pelo "Pôr na tarja").
  function closeTextPanel(focus = true) {
    if (textPanel.hidden) return;
    textPanel.hidden = true;
    stopKeyboard?.();
    stopKeyboard = null;
    if (focus) (redactBoxes.children[current] ?? redactAdd).focus();
  }

  function setMarkText(value) {
    const mark = marks[current];
    if (!mark) return;
    const { text, dropped } = winAnsiText(value);
    const clean = text.replace(/\s+$/, '');
    if (clean.trim()) mark.text = clean;
    else delete mark.text;
    closeTextPanel(false);
    drawMarks(current);
    const note = droppedMessage(dropped);
    hint.textContent = (mark.text ? t('Texto posto na tarja {n}.', { n: current + 1 }) : t('Texto tirado da tarja {n}.', { n: current + 1 }))
      + (note ? ` ${note}` : '');
  }

  redactWrite.addEventListener('click', openTextPanel);
  $('#redact-text-put').addEventListener('click', () => setMarkText(textInput.value));
  $('#redact-text-clear').addEventListener('click', () => setMarkText(''));
  $('#redact-text-cancel').addEventListener('click', () => closeTextPanel());
  textInput.addEventListener('input', () => {
    textNote.textContent = droppedMessage(winAnsiText(textInput.value).dropped)
      || t('O que está embaixo da tarja é apagado do PDF, e este texto vai no lugar, do maior tamanho que cabe nela. Para a letra ficar menor, deixe a tarja mais baixa.');
  });

  const redactDirty = () => !redact.hidden && JSON.stringify(marks) !== JSON.stringify(page?.redactions ?? []);
  $('#redact-cancel').addEventListener('click', () => leaveIfSure(showView));
  redactApply.addEventListener('click', async () => {
    redactApply.disabled = true;
    hint.textContent = t('Aplicando as tarjas…');
    try {
      await saveRedactions(page, marks.map((mark) => ({ ...mark })));
    } finally {
      redactApply.disabled = false;
    }
    showView();
  });
  $('#viewer-redact').addEventListener('click', showRedact);
  new ResizeObserver(() => requestAnimationFrame(fitRedact)).observe(stage);

  // ---------- Editar ----------
  // O modo Editar (editor.js) carrega na primeira vez. A página aparece como vai sair no PDF, sem as edições, que o
  // editor desenha por cima; as tarjas ficam por cima de tudo.

  let loading = null;
  // Ao sair do modo Editar (Aplicar ou Cancelar), o foco volta para o botão "Editar".
  const leaveEdit = () => {
    showView();
    editButton.focus();
  };
  const loadEditor = () => (loading ??= import('./editor.js').then(async ({ setupEditor, loadTools }) => {
    await loadTools(); // as ferramentas das outras fases, antes de a barra ser montada
    return (editor = setupEditor({ stage, hint, save: saveEdits, confirm: confirmDiscard, leave: leaveEdit, zoom }));
  }).catch((err) => {
    loading = null; // sem rede e sem cache: tenta de novo na próxima vez
    throw err;
  }));

  async function showEdit() {
    const mine = nextToken();
    title.textContent = t('Editar: {label}', { label });
    updateNav(false);
    image.hidden = true;
    viewActions.hidden = true;
    stage.classList.remove('zoomed');
    zoom.view(null);
    hint.textContent = t('Preparando a página…');
    let base;
    try {
      [, base] = await Promise.all([loadEditor(), editBase(page)]);
    } catch (err) {
      console.error(err);
      if (mine !== token) return;
      image.hidden = false;
      viewActions.hidden = false;
      zoom.view(viewZoom);
      updateNav(true);
      hint.textContent = t('Não deu para preparar a página para editar. Confira a conexão e tente de novo.');
      return;
    }
    if (mine !== token) return;
    await editor.open(page, base, () => mine === token);
  }
  editButton.addEventListener('click', showEdit);

  // ---------- Preencher ----------
  // O modo Preencher (form-panel.js) carrega na primeira vez. A página aparece como vai sair (com os valores já
  // aplicados, as edições e as tarjas), com uma caixa sobre cada campo; os campos ficam num painel que abre de baixo.

  let fillLoading = null;
  // Ao sair do modo Preencher (Aplicar ou Cancelar), o foco volta para o botão "Preencher"; o aviso fica na dica.
  const leaveFill = (note) => {
    showView(note);
    fillButton.focus();
  };
  const loadFill = () => (fillLoading ??= import('./form-panel.js').then(({ setupFill }) => (filler = setupFill({
    stage, hint, save: saveForm, confirm: confirmDiscard, leave: leaveFill, textItems: fillText,
  }))).catch((err) => {
    fillLoading = null; // sem rede e sem cache: tenta de novo na próxima vez
    throw err;
  }));

  async function showFill() {
    if (!canFill(page)) return;
    const mine = nextToken();
    title.textContent = t('Preencher: {label}', { label });
    updateNav(false);
    image.hidden = true;
    viewActions.hidden = true;
    stage.classList.remove('zoomed');
    zoom.view(null);
    hint.textContent = t('Preparando a página…');
    let base;
    try {
      [, base] = await Promise.all([loadFill(), fillBase(page)]);
    } catch (err) {
      console.error(err);
      if (mine !== token) return;
      image.hidden = false;
      viewActions.hidden = false;
      zoom.view(viewZoom);
      updateNav(true);
      hint.textContent = t('Não deu para preparar a página para preencher. Confira a conexão e tente de novo.');
      return;
    }
    if (mine !== token) return;
    await filler.open(page, base, () => mine === token);
  }
  fillButton.addEventListener('click', showFill);

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

  const unsaved = () => (editor?.dirty() ? t('As edições desta página ainda não foram aplicadas. Se sair agora, elas se perdem.')
    : redactDirty() ? t('As tarjas desta página ainda não foram aplicadas. Se sair agora, elas se perdem.')
    : filler?.dirty() ? t('Os valores desta página ainda não foram aplicados. Se sair agora, eles se perdem.') : '');

  async function leaveIfSure(action) {
    const message = unsaved();
    if (message && !(await confirmDiscard(message))) return;
    action();
  }

  // Esc: no modo Editar, fecha antes o painel ou o traço em andamento; com mudança não aplicada, pergunta. O keydown
  // cancelado não chega a fechar a tela; o cancel é a reserva, para o navegador que fechar mesmo assim.
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !dialog.open) return;
    if (!textPanel.hidden) { // o painel do texto da tarja fecha antes
      event.preventDefault();
      closeTextPanel();
      return;
    }
    if ((editor?.active() && editor.escape()) || (filler?.active() && filler.escape())) {
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
    say(t('Copiando o texto…'));
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
      hint.textContent = known ? result.error.message : t('Não deu para ler o texto desta página.');
      return;
    }
    if (blocked) {
      hint.textContent = t('O navegador não liberou a área de transferência. Use "Copiar texto" de novo.');
      return;
    }
    const count = wordCount(result.value);
    const words = plural(count, '{n} palavra', '{n} palavras');
    hint.textContent = target.redactions?.length
      ? t('Texto copiado ({words}), sem o que está sob as tarjas. Ele não sai do aparelho.', { words })
      : t('Texto copiado ({words}). Ele não sai do aparelho.', { words });
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
  image.addEventListener('load', () => {
    placeSteps();
    zoom.refresh(); // a versão nítida tem outro tamanho: o número do zoom acompanha
  });
  new ResizeObserver(() => requestAnimationFrame(placeSteps)).observe(stage);

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
    setViewZoom(!stage.classList.contains('zoomed'));
  });

  // Zoom da visualização: a página inteira ou ampliada (a imagem com 2,2× a largura do palco, no CSS). O toque na
  // imagem e os botões de zoom da barra do título (page-zoom.js, também pelo teclado) fazem o mesmo.
  function setViewZoom(on) {
    stage.classList.toggle('zoomed', on);
    placeSteps();
    zoom.refresh();
  }
  const viewZoom = { level: viewLevel, set: setViewZoom };
  // O zoom da imagem na tela, em relação à página inteira (o número que o botão do meio mostra).
  function viewLevel() {
    if (!stage.classList.contains('zoomed') || !image.naturalWidth) return 1;
    const style = getComputedStyle(stage);
    const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const fit = image.naturalWidth * Math.min(1, width / image.naturalWidth, height / image.naturalHeight);
    return Math.max(1, (width * 2.2) / fit);
  }

  $('#crop-detect').addEventListener('click', () => {
    const quad = detect(page);
    if (quad) {
      points = toRotated(quad, page.rotation);
      drawPoints();
      hint.textContent = t('Cantos encontrados. Confira e ajuste se precisar.');
    } else {
      hint.textContent = t('Não achei as bordas do papel nesta foto. Arraste os cantos manualmente.');
    }
  });
  $('#crop-full').addEventListener('click', () => {
    points = FULL_QUAD;
    drawPoints();
    hint.textContent = t('Foto inteira, sem recorte.');
  });
  $('#crop-cancel').addEventListener('click', showView);
  applyButton.addEventListener('click', async () => {
    if (!isConvex(points)) return;
    applyButton.disabled = true;
    hint.textContent = t('Aplicando o recorte…');
    try {
      await applyCrop(page, isFullFrame(points) ? null : fromRotated(points, page.rotation));
    } finally {
      applyButton.disabled = false;
    }
    showView();
  });

  // Os ajustes ao tamanho do palco rodam no quadro seguinte, fora do aviso do ResizeObserver (como no editor.js):
  // mudar o layout dentro dele dava "ResizeObserver loop" no WebKit.
  new ResizeObserver(() => requestAnimationFrame(fitCrop)).observe(stage);
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
    closeTextPanel(false);
    zoom.detach(redact);
    zoom.view(null);
    marks = [];
    editor?.close();
    filler?.close();
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
