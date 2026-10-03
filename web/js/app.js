import { buildPdf, layoutPage } from './pdf.js';
import { FILTERS, decodeFile, renderPage, renderPageAsync, canvasToBlob } from './imaging.js';
import { setupCamera } from './camera.js';
import { pixPayload } from './pix.js';
import { CONFIG } from './config.js';

const QUALITY = {
  light: { maxSide: 1600, jpeg: 0.7 },
  balanced: { maxSide: 2400, jpeg: 0.82 },
  high: { maxSide: 3508, jpeg: 0.92 },
};
const MARGINS = { none: 0, small: 18, normal: 36 };
const PREVIEW_SIDE = 800; // cópia reduzida guardada em memória para as miniaturas
const THUMB_SIDE = 480;
const UNDO_MS = 10000; // tempo para desfazer a remoção de uma página

const $ = (selector) => document.querySelector(selector);
const els = {
  dropzone: $('#dropzone'),
  fileInput: $('#file-input'),
  cameraInput: $('#camera-input'),
  pickFiles: $('#pick-files'),
  takePhoto: $('#take-photo'),
  workspace: $('#workspace'),
  pages: $('#pages'),
  count: $('#page-count'),
  clear: $('#clear'),
  filterAll: $('#filter-all'),
  pageSize: $('#page-size'),
  margin: $('#margin'),
  quality: $('#quality'),
  fileName: $('#file-name'),
  generate: $('#generate'),
  result: $('#result'),
  resultInfo: $('#result-info'),
  download: $('#download'),
  share: $('#share'),
  status: $('#status'),
  undo: $('#undo'),
  pasteKey: $('#paste-key'),
};

// Tudo que muda o PDF fica travado enquanto ele é gerado (os cartões são tratados em renderPages).
const lockedWhileBusy = [
  'filterAll', 'pageSize', 'margin', 'quality', 'fileName', 'clear', 'pickFiles', 'takePhoto', 'undo',
].map((key) => els[key]);

const state = { pages: [], busy: false, pdf: null };
let nextId = 1;

function announce(message, kind = 'info') {
  els.status.textContent = message;
  els.status.dataset.kind = kind;
}

// Cria um elemento. Chaves "aria-*" e "data-*" viram atributos; o resto, propriedades.
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (/^(aria|data)-/.test(key)) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

// Ícone do sprite do index.html (#i-nome): decorativo, o texto ou o aria-label do botão já diz o que ele faz.
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

// ---------- Adicionar imagens ----------

async function addFiles(fileList) {
  if (state.busy) return; // arrastar ou colar durante a geração: ignora (os botões já estão travados)
  const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  if (!files.length) {
    announce('Por aqui só entram imagens (JPG, PNG, WebP…).', 'error');
    return;
  }
  discardPdf();
  const failed = [];
  for (const file of files) {
    announce(`Lendo ${file.name}…`);
    try {
      const page = { id: nextId++, file, preview: await makePreview(file), rotation: 0, filter: els.filterAll.value, thumbUrl: '' };
      await refreshThumb(page);
      state.pages.push(page);
      renderPages();
    } catch (err) {
      console.error(err);
      failed.push(file.name);
    }
  }
  if (failed.length) {
    announce(`Não consegui abrir: ${failed.join(', ')}. Tente exportar como JPG ou PNG.`, 'error');
  } else {
    announce(`${files.length === 1 ? '1 imagem adicionada' : `${files.length} imagens adicionadas`}.`);
  }
}

async function makePreview(file) {
  const image = await decodeFile(file);
  try {
    return renderPage(image.source, image.width, image.height, { maxSide: PREVIEW_SIDE });
  } finally {
    image.release();
  }
}

async function refreshThumb(page) {
  const canvas = renderPage(page.preview, page.preview.width, page.preview.height, {
    rotation: page.rotation, filter: page.filter, maxSide: THUMB_SIDE,
  });
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.8);
  if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
  page.thumbUrl = URL.createObjectURL(blob);
}

// ---------- Lista de páginas ----------

const filterOptions = (selected) =>
  Object.entries(FILTERS).map(([value, label]) => el('option', { value, textContent: label, selected: value === selected }));

function renderPages() {
  const total = state.pages.length;
  els.workspace.hidden = total === 0;
  els.count.textContent = total ? `(${total})` : '';

  // Cartão: miniatura; número + remover (longe dos outros botões); mover ← → e girar; filtro.
  els.pages.replaceChildren(...state.pages.map((page, i) => {
    const button = (action, label, disabled = false) => el('button', {
      type: 'button', className: `icon-btn icon-btn-${action}`, title: label, disabled: disabled || state.busy,
      'aria-label': `${label} (página ${i + 1})`, 'data-action': action,
    }, [icon(action)]);

    return el('li', { className: 'page-card', 'data-id': page.id }, [
      el('div', { className: 'thumb' }, [el('img', { src: page.thumbUrl, alt: `Página ${i + 1}: ${page.file.name}` })]),
      el('div', { className: 'page-tools' }, [
        el('span', { className: 'page-num', textContent: i + 1 }),
        button('remove', 'Remover'),
        button('left', 'Mover para antes', i === 0),
        button('right', 'Mover para depois', i === total - 1),
        button('rotate', 'Girar'),
      ]),
      el('select', {
        className: 'page-filter', 'aria-label': `Filtro da página ${i + 1}`, disabled: state.busy,
      }, filterOptions(page.filter)),
    ]);
  }));
}

// A lista é recriada a cada mudança: devolve o foco a um controle do cartão na posição `index`.
function focusCard(index, selector) {
  const card = els.pages.children[Math.min(index, els.pages.children.length - 1)];
  const target = card?.querySelector(`${selector}:not(:disabled)`) ?? card?.querySelector('button:not(:disabled)');
  if (target) target.focus();
  else focusAddButton();
}

// Lista vazia: o foco vai para o botão principal de adicionar que estiver visível.
function focusAddButton() {
  (els.takePhoto.offsetParent ? els.takePhoto : els.pickFiles).focus();
}

function findPage(target) {
  const card = target.closest('.page-card');
  return card && state.pages.findIndex((p) => p.id === Number(card.dataset.id));
}

els.pages.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || state.busy) return;
  const index = findPage(button);
  const page = state.pages[index];
  discardPdf();

  switch (button.dataset.action) {
    case 'left':
    case 'right': {
      const to = index + (button.dataset.action === 'left' ? -1 : 1);
      [state.pages[index], state.pages[to]] = [state.pages[to], state.pages[index]];
      renderPages();
      els.pages.children[to]?.querySelector(`[data-action="${button.dataset.action}"]:not(:disabled)`)?.focus();
      break;
    }
    case 'rotate':
      page.rotation = (page.rotation + 90) % 360;
      await refreshThumb(page);
      renderPages();
      if (focusLost()) els.pages.children[state.pages.indexOf(page)]?.querySelector('[data-action="rotate"]')?.focus();
      break;
    case 'remove':
      removePage(index);
      break;
  }
});

els.pages.addEventListener('change', async (event) => {
  if (!event.target.matches('.page-filter') || state.busy) return;
  const page = state.pages[findPage(event.target)];
  page.filter = event.target.value;
  discardPdf();
  await refreshThumb(page);
  renderPages();
  // Quem trocou o filtro pelo teclado continua no mesmo seletor.
  const index = state.pages.indexOf(page);
  if (index >= 0 && focusLost()) focusCard(index, '.page-filter');
});

// A miniatura demora um pouco: se nesse meio-tempo a pessoa já foi para outro controle, não puxa o foco de volta.
function focusLost() {
  return !document.activeElement || document.activeElement === document.body;
}

// ---------- Remover com "Desfazer" ----------
// A miniatura da página removida só é descartada quando o prazo para desfazer acaba.

let removed = null; // { page, index, timer }

function removePage(index) {
  finishUndo();
  const [page] = state.pages.splice(index, 1);
  renderPages();
  if (state.pages.length) focusCard(index, '[data-action="remove"]');
  else focusAddButton();

  removed = { page, index, timer: 0, message: `Página ${index + 1} removida. Dá para desfazer por alguns segundos.` };
  announce(removed.message);
  els.undo.setAttribute('aria-label', `Desfazer: trazer de volta a página ${index + 1}`);
  els.undo.hidden = false;
  scheduleUndoExpiry();
}

// Não some enquanto o botão está com foco ou sob o ponteiro: espera a pessoa terminar.
function scheduleUndoExpiry() {
  clearTimeout(removed.timer);
  removed.timer = setTimeout(() => {
    if (els.undo.matches(':focus, :hover')) scheduleUndoExpiry();
    else finishUndo();
  }, UNDO_MS);
}

function finishUndo() {
  if (!removed) return;
  clearTimeout(removed.timer);
  URL.revokeObjectURL(removed.page.thumbUrl);
  // O aviso não promete mais o que já não dá para fazer.
  if (els.status.textContent === removed.message) announce(`Página ${removed.index + 1} removida.`);
  removed = null;
  els.undo.hidden = true;
}

els.undo.addEventListener('click', () => {
  if (!removed || state.busy) return;
  clearTimeout(removed.timer);
  const { page, index } = removed;
  removed = null;
  els.undo.hidden = true;
  const at = Math.min(index, state.pages.length);
  state.pages.splice(at, 0, page);
  discardPdf();
  renderPages();
  focusCard(at, '[data-action="remove"]');
  announce(`Página ${at + 1} de volta.`);
});

els.filterAll.append(...filterOptions('document'));
els.filterAll.addEventListener('change', async () => {
  if (state.busy) return;
  discardPdf();
  for (const page of state.pages) {
    page.filter = els.filterAll.value;
    await refreshThumb(page);
  }
  renderPages();
});

for (const select of [els.pageSize, els.margin, els.quality]) select.addEventListener('change', discardPdf);
els.fileName.addEventListener('input', discardPdf);

// "Limpar tudo" pede um segundo toque em vez de abrir um diálogo.
let clearTimer;
els.clear.addEventListener('click', () => {
  if (!els.clear.dataset.armed) {
    els.clear.dataset.armed = '1';
    els.clear.textContent = 'Toque de novo para confirmar';
    clearTimer = setTimeout(disarmClear, 3000);
    return;
  }
  disarmClear();
  finishUndo();
  for (const page of state.pages) URL.revokeObjectURL(page.thumbUrl);
  state.pages = [];
  discardPdf();
  renderPages();
  announce('Tudo limpo. Nada ficou guardado.');
});

function disarmClear() {
  clearTimeout(clearTimer);
  delete els.clear.dataset.armed;
  els.clear.textContent = 'Limpar tudo';
}

// ---------- Gerar PDF ----------

function pdfFileName() {
  const base = els.fileName.value.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-') || 'documento';
  return `${base}.pdf`;
}

function setBusy(busy) {
  state.busy = busy;
  if (busy) disarmClear();
  els.generate.disabled = busy;
  els.generate.textContent = busy ? 'Gerando…' : 'Gerar PDF';
  if (busy) els.workspace.setAttribute('aria-busy', 'true');
  else els.workspace.removeAttribute('aria-busy');
  for (const control of lockedWhileBusy) control.disabled = busy;
  if (busy) for (const control of els.pages.querySelectorAll('button, select')) control.disabled = true;
  else renderPages(); // recria os cartões liberados (mover nas pontas da lista continua desabilitado)
}

function discardPdf() {
  if (!state.pdf) return;
  URL.revokeObjectURL(state.pdf.url);
  state.pdf = null;
  els.result.hidden = true;
}

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

async function generate() {
  if (!state.pages.length || state.busy) return;
  setBusy(true);
  discardPdf();
  const quality = QUALITY[els.quality.value];
  const margin = MARGINS[els.margin.value];
  const size = els.pageSize.value;

  const list = [...state.pages]; // retrato da lista: o PDF sai igual ao que estava na tela
  let ok = false;
  try {
    const pages = [];
    for (const [i, page] of list.entries()) {
      announce(`Processando página ${i + 1} de ${list.length}…`);
      await nextFrame();
      const image = await decodeFile(page.file);
      let canvas;
      try {
        // O filtro roda num Web Worker: a página continua respondendo durante a geração.
        canvas = await renderPageAsync(image.source, image.width, image.height, { rotation: page.rotation, filter: page.filter, maxSide: quality.maxSide });
      } finally {
        image.release();
      }
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality.jpeg);
      pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), ...layoutPage(canvas.width, canvas.height, size, margin) });
      canvas.width = canvas.height = 0; // devolve a memória do canvas na hora
    }

    announce('Montando o PDF…');
    await nextFrame();
    const name = pdfFileName();
    const file = new File([buildPdf(pages)], name, { type: 'application/pdf' });
    state.pdf = { file, url: URL.createObjectURL(file) };

    els.download.href = state.pdf.url;
    els.download.download = name;
    els.resultInfo.textContent = `${name} · ${list.length} ${list.length === 1 ? 'página' : 'páginas'} · ${formatBytes(file.size)}`;
    els.share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    els.result.hidden = false;
    announce('PDF pronto. Ele só existe aqui no seu aparelho até você baixar.', 'success');
    ok = true;
  } catch (err) {
    console.error(err);
    announce(`Algo deu errado ao gerar o PDF: ${err.message}`, 'error');
  } finally {
    setBusy(false);
    // Foco só depois de liberar os controles (controle desabilitado não recebe foco).
    (ok ? els.download : els.generate).focus();
  }
}

els.generate.addEventListener('click', generate);

els.share.addEventListener('click', async () => {
  if (!state.pdf) return;
  try {
    await navigator.share({ files: [state.pdf.file], title: state.pdf.file.name });
  } catch (err) {
    if (err.name !== 'AbortError') announce('Não deu para compartilhar. Use o botão Baixar.', 'error');
  }
});

// ---------- Entrada: botões, arrastar e colar ----------

// No Mac, colar é ⌘V.
if (/mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '')) els.pasteKey.textContent = '⌘V';

els.pickFiles.addEventListener('click', () => els.fileInput.click());
// "Tirar foto" abre a câmera da página (com botão de luz); sem suporte, cai na câmera do sistema.
const camera = setupCamera({
  onPhoto: (file) => addFiles([file]),
  useNative: () => els.cameraInput.click(),
});
els.takePhoto.addEventListener('click', () => (camera ? camera.open() : els.cameraInput.click()));
for (const input of [els.fileInput, els.cameraInput]) {
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  els.dropzone.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; els.dropzone.classList.remove('dragging'); }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropzone.classList.remove('dragging');
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});

window.addEventListener('paste', (e) => {
  if (e.target.matches?.('input, textarea')) return;
  const files = e.clipboardData?.files;
  if (files?.length) addFiles(files);
});

// ---------- Feedback ----------

const feedbackEmail = $('#feedback-email');
if (CONFIG.feedbackEmail) {
  feedbackEmail.href = `mailto:${CONFIG.feedbackEmail}?subject=${encodeURIComponent('Feedback - Scanner Doc')}`;
  feedbackEmail.hidden = false;
}
$('#feedback-issue').href = `${CONFIG.repoUrl}/issues/new`;

// ---------- Doação ----------

const donate = $('#donate-link');
if (CONFIG.donationUrl) {
  donate.href = CONFIG.donationUrl;
  donate.hidden = false;
}
if (CONFIG.pixKey) setupPix();

async function setupPix() {
  const code = pixPayload(CONFIG.pixKey, { name: CONFIG.pixName, city: CONFIG.pixCity });
  const copy = $('#pix-copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.textContent = 'Código copiado! ✓';
      setTimeout(() => { copy.textContent = 'Copiar código Pix'; }, 3000);
    } catch {
      copy.replaceWith(el('code', { className: 'pix-code', textContent: code }));
    }
  });
  $('#pix').hidden = false;

  try {
    const { default: qrcode } = await import('../vendor/qrcode/qrcode.js');
    const qr = qrcode(0, 'M');
    qr.addData(code);
    qr.make();
    drawQr($('#pix-qr'), qr);
  } catch (err) {
    console.error(err);
    $('#pix-qr').hidden = true; // sem QR, o botão de copiar continua funcionando
  }
}

// Sempre preto no branco, com margem: é o que os leitores dos bancos esperam.
function drawQr(canvas, qr) {
  const count = qr.getModuleCount();
  const scale = 6;
  const quiet = 4;
  canvas.width = canvas.height = (count + quiet * 2) * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
    }
  }
}

for (const link of document.querySelectorAll('[data-repo-link]')) link.href = CONFIG.repoUrl;

// ---------- Offline ----------
// O service worker só guarda os arquivos do próprio app (HTML/CSS/JS) para funcionar sem internet.
// Ele nunca vê suas imagens: elas não passam pela rede.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
