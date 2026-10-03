import { buildPdf, layoutPage } from './pdf.js';
import { FILTERS, decodeFile, renderPage, canvasToBlob } from './imaging.js';
import { CONFIG } from './config.js';

const QUALITY = {
  light: { maxSide: 1600, jpeg: 0.7 },
  balanced: { maxSide: 2400, jpeg: 0.82 },
  high: { maxSide: 3508, jpeg: 0.92 },
};
const MARGINS = { none: 0, small: 18, normal: 36 };
const PREVIEW_SIDE = 800; // cópia reduzida guardada em memória para as miniaturas
const THUMB_SIDE = 480;

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
};

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

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

// ---------- Adicionar imagens ----------

async function addFiles(fileList) {
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

  els.pages.replaceChildren(...state.pages.map((page, i) => {
    const button = (action, label, text, disabled = false) => el('button', {
      type: 'button', className: 'icon-btn', textContent: text, title: label, disabled,
      'aria-label': `${label} (página ${i + 1})`, 'data-action': action,
    });

    return el('li', { className: 'page-card', 'data-id': page.id }, [
      el('div', { className: 'thumb' }, [el('img', { src: page.thumbUrl, alt: `Página ${i + 1}: ${page.file.name}` })]),
      el('div', { className: 'page-tools' }, [
        el('span', { className: 'page-num', textContent: i + 1 }),
        button('left', 'Mover para antes', '←', i === 0),
        button('right', 'Mover para depois', '→', i === total - 1),
        button('rotate', 'Girar', '⟳'),
        button('remove', 'Remover', '✕'),
      ]),
      el('select', { className: 'page-filter', 'aria-label': `Filtro da página ${i + 1}` }, filterOptions(page.filter)),
    ]);
  }));
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
      els.pages.children[index]?.querySelector('[data-action="rotate"]')?.focus();
      break;
    case 'remove':
      URL.revokeObjectURL(page.thumbUrl);
      state.pages.splice(index, 1);
      renderPages();
      announce(`Página ${index + 1} removida.`);
      break;
  }
});

els.pages.addEventListener('change', async (event) => {
  if (!event.target.matches('.page-filter')) return;
  const page = state.pages[findPage(event.target)];
  page.filter = event.target.value;
  discardPdf();
  await refreshThumb(page);
  renderPages();
});

els.filterAll.append(...filterOptions('document'));
els.filterAll.addEventListener('change', async () => {
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
  els.generate.disabled = busy;
  els.generate.textContent = busy ? 'Gerando…' : 'Gerar PDF';
  els.workspace.toggleAttribute('aria-busy', busy);
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

  try {
    const pages = [];
    for (const [i, page] of state.pages.entries()) {
      announce(`Processando página ${i + 1} de ${state.pages.length}…`);
      await nextFrame();
      const image = await decodeFile(page.file);
      let canvas;
      try {
        canvas = renderPage(image.source, image.width, image.height, { rotation: page.rotation, filter: page.filter, maxSide: quality.maxSide });
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
    els.resultInfo.textContent = `${name} · ${state.pages.length} ${state.pages.length === 1 ? 'página' : 'páginas'} · ${formatBytes(file.size)}`;
    els.share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    els.result.hidden = false;
    announce('PDF pronto. Ele só existe aqui no seu aparelho até você baixar.', 'success');
    els.download.focus();
  } catch (err) {
    console.error(err);
    announce(`Algo deu errado ao gerar o PDF: ${err.message}`, 'error');
  } finally {
    setBusy(false);
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

els.pickFiles.addEventListener('click', () => els.fileInput.click());
els.takePhoto.addEventListener('click', () => els.cameraInput.click());
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

// ---------- Doação ----------

const donate = $('#donate-link');
if (CONFIG.donationUrl) {
  donate.href = CONFIG.donationUrl;
  donate.hidden = false;
}
const pix = $('#pix-copy');
if (CONFIG.pixKey) {
  pix.hidden = false;
  pix.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(CONFIG.pixKey);
      pix.textContent = 'Chave copiada! ✓';
    } catch {
      pix.textContent = `Chave Pix: ${CONFIG.pixKey}`;
    }
  });
}
for (const link of document.querySelectorAll('[data-repo-link]')) link.href = CONFIG.repoUrl;

// ---------- Offline ----------
// O service worker só guarda os arquivos do próprio app (HTML/CSS/JS) para funcionar sem internet.
// Ele nunca vê suas imagens: elas não passam pela rede.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
