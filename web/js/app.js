import { buildPdf, layoutPage } from './pdf.js';
import { FILTERS, decodeFile, detectQuad, renderPage, renderPageAsync, canvasToBlob } from './imaging.js';
import { setupViewer } from './viewer.js';
import { quadSize } from './geometry.js';
import { setupCamera } from './camera.js';
import { pixPayload } from './pix.js';
import { CONFIG } from './config.js';
import { parseRanges } from './ranges.js';

// O GitHub Pages não permite enviar o cabeçalho que proíbe embutir o site dentro de outro (frame-ancestors).
// Então o próprio app se recusa a rodar dentro de um iframe: evita que outro site o exiba como se fosse dele
// ou sobreponha botões falsos aos nossos (clickjacking).
if (window.top !== window.self) {
  const link = document.createElement('a');
  link.href = location.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Abrir o Scanner Doc em uma aba própria';
  document.body.replaceChildren(link);
  throw new Error('O Scanner Doc não funciona embutido em outro site.');
}

const QUALITY = {
  light: { maxSide: 1600, jpeg: 0.7 },
  balanced: { maxSide: 2400, jpeg: 0.82 },
  high: { maxSide: 3508, jpeg: 0.92 },
};
const MARGINS = { none: 0, small: 18, normal: 36 };
const PREVIEW_SIDE = 1280; // cópia reduzida guardada em memória (miniaturas, detecção do papel, tela de recorte)
const THUMB_SIDE = 960; // no celular a miniatura ocupa a largura da tela, em tela de alta densidade
const VIEW_SIDE = 2000; // página em tela cheia
const UNDO_MS = 10000; // tempo para desfazer a remoção de uma página

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const isDocx = (file) => /\.docx$/i.test(file.name) || file.type === DOCX_TYPE;
const isOldWord = (file) => /\.doc$/i.test(file.name) || file.type === 'application/msword';
const isImage = (file) => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name);
const isPdf = (file) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
// Tipos de página: 'photo' (foto, com recorte e filtro), 'document' (Word, texto já distribuído em páginas)
// e 'pdf' (página de um PDF que já existe, copiada como está).
const isPhoto = (page) => page.kind === 'photo';
const isDocument = (page) => page.kind === 'document';

// Módulos carregados só quando aparece o primeiro arquivo do tipo. Sem rede e sem cache, a falha não fica
// guardada: tenta de novo na próxima vez.
function lazy(path) {
  let promise;
  return () => (promise ??= import(path).catch((err) => {
    promise = undefined;
    throw err;
  }));
}
const loadDocuments = lazy('./document.js'); // .docx: ZIP, XML, layout
const loadPdfTools = lazy('./pdf-open.js'); // .pdf: leitor de PDF

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
  qualityTip: $('#quality-tip'),
  qualityTipApply: $('#quality-tip-apply'),
  documentNote: $('#document-note'),
  outputMode: $('#output-mode'),
  ranges: $('#ranges'),
  rangesField: $('#ranges-field'),
  resultTitle: $('#result-title'),
  resultFiles: $('#result-files'),
  downloadAll: $('#download-all'),
  outputPreview: $('#output-preview'),
  outputSummary: $('#output-summary'),
  outputFiles: $('#output-files'),
};

// Tudo que muda o PDF fica travado enquanto ele é gerado (os cartões são tratados em renderPages).
const lockedWhileBusy = [
  'filterAll', 'pageSize', 'margin', 'quality', 'fileName', 'clear', 'pickFiles', 'takePhoto', 'undo', 'qualityTipApply',
  'outputMode', 'ranges',
].map((key) => els[key]);

const state = { pages: [], busy: false, output: null }; // output: PDFs gerados, [{file, url}]
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

// ---------- Adicionar imagens e documentos ----------

async function addFiles(fileList) {
  if (state.busy) return; // arrastar ou colar durante a geração: ignora (os botões já estão travados)
  const files = [...fileList].filter((f) => isImage(f) || isDocx(f) || isOldWord(f) || isPdf(f));
  if (!files.length) {
    announce('Por aqui só entram imagens (JPG, PNG, WebP…), PDFs e documentos do Word (.docx).', 'error');
    return;
  }
  discardPdf();
  const failed = [];
  const documentMessages = [];
  const documentErrors = [];
  let images = 0;
  let cropped = 0;
  for (const file of files) {
    announce(`Lendo ${file.name}…`);
    if (!isImage(file)) {
      const result = isPdf(file) ? await addPdfFile(file) : await addDocument(file);
      if (result.error) documentErrors.push(result.error);
      else documentMessages.push(result.message);
      continue;
    }
    try {
      const { preview, width, height } = await makePreview(file);
      // width/height: tamanho da foto original. quad: recorte do papel (4 cantos, de 0 a 1, na foto sem girar)
      // ou null para usar a foto inteira.
      const page = { id: nextId++, kind: 'photo', file, preview, width, height, quad: detectQuad(preview, preview.width, preview.height), rotation: 0, filter: els.filterAll.value, thumbUrl: '' };
      if (page.quad) cropped++;
      await refreshThumb(page);
      state.pages.push(page);
      renderPages();
      images++;
    } catch (err) {
      console.error(err);
      failed.push(file.name);
    }
  }

  const messages = [];
  if (failed.length) messages.push(`Não consegui abrir: ${failed.join(', ')}. Tente exportar como JPG ou PNG.`);
  else if (images) messages.push(imagesMessage(images, cropped));
  messages.push(...documentErrors, ...documentMessages);
  announce(messages.join(' '), failed.length || documentErrors.length ? 'error' : 'info');
}

function imagesMessage(count, cropped) {
  const added = count === 1 ? '1 imagem adicionada' : `${count} imagens adicionadas`;
  const missed = count - cropped;
  if (!missed) return `${added}, com o papel recortado automaticamente. Se os cantos não ficaram certos, use "Ajustar recorte".`;
  if (!cropped) return `${added}. Não achei as bordas do papel: use "Recortar" para marcar os cantos.`;
  return `${added}. Em ${missed === 1 ? 'uma delas' : `${missed} delas`} não achei as bordas do papel: use "Recortar" para marcar os cantos.`;
}

// Um .docx vira várias páginas na lista, que dá para reordenar e misturar com fotos.
// O texto já sai distribuído nas páginas, com o tamanho e as margens do próprio documento.
async function addDocument(file) {
  if (isOldWord(file) && !isDocx(file)) {
    return { error: `${file.name} é do Word antigo (.doc): abra no Word, use "Salvar como" e escolha .docx.` };
  }
  let module;
  try {
    module = await loadDocuments();
    const { pages, notes } = await module.openDocument(file);
    for (const [i, layout] of pages.entries()) {
      const page = { id: nextId++, kind: 'document', name: file.name, number: i + 1, total: pages.length, layout, rotation: 0, thumbUrl: '' };
      await refreshThumb(page);
      state.pages.push(page);
    }
    renderPages();
    const count = pages.length === 1 ? '1 página adicionada' : `${pages.length} páginas adicionadas`;
    return { message: [`${file.name}: ${count}.`, ...notes].join(' ') };
  } catch (err) {
    console.error(err);
    const reason = module && err instanceof module.DocxError ? err.message : 'Não deu para ler o documento.';
    return { error: `Não consegui abrir ${file.name}. ${reason}` };
  }
}

async function makePreview(file) {
  const image = await decodeFile(file);
  try {
    const preview = renderPage(image.source, image.width, image.height, { maxSide: PREVIEW_SIDE });
    return { preview, width: image.width, height: image.height };
  } finally {
    image.release();
  }
}

// Cada página de um PDF entra na lista, para reordenar, remover (dividir) e misturar com outros PDFs (juntar),
// fotos e documentos. No PDF novo ela sai igual ao original.
async function addPdfFile(file) {
  let module;
  try {
    module = await loadPdfTools();
    const { doc, pages, notes } = await module.openPdfFile(file);
    for (const info of pages) {
      const page = {
        id: nextId++, kind: 'pdf', name: file.name, number: info.index + 1, total: pages.length,
        doc, index: info.index, size: { width: info.width, height: info.height }, rotation: 0, thumbUrl: '',
      };
      await refreshThumb(page);
      state.pages.push(page);
    }
    renderPages();
    const count = pages.length === 1 ? '1 página adicionada' : `${pages.length} páginas adicionadas`;
    return { message: [`${file.name}: ${count}.`, ...notes].join(' ') };
  } catch (err) {
    console.error(err);
    const reason = module && err instanceof module.PdfError ? err.message : 'Não deu para ler o PDF.';
    return { error: `Não consegui abrir ${file.name}. ${reason}` };
  }
}

async function refreshThumb(page) {
  const blob = page.kind === 'pdf'
    ? await drawPdfPage(page, THUMB_SIDE)
    : isDocument(page)
    ? await drawDocument(page, THUMB_SIDE)
    : await canvasToBlob(renderPage(page.preview, page.preview.width, page.preview.height, {
      rotation: page.rotation, filter: page.filter, quad: page.quad, maxSide: THUMB_SIDE,
    }), 'image/jpeg', 0.8);
  if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
  page.thumbUrl = URL.createObjectURL(blob);
}

// Página de PDF desenhada pelo PDF.js; se não der, um cartão com o formato da folha e o número.
async function drawPdfPage(page, maxSide) {
  const tools = await loadPdfTools();
  const { canvas, real } = await tools.drawPdfPage(page.doc, { index: page.index, ...page.size }, {
    maxSide, rotation: page.rotation, number: page.number,
  });
  page.drawn = real;
  try {
    return await canvasToBlob(canvas, 'image/png');
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// Página de documento desenhada como vai sair no PDF. PNG: texto nítido, sem os borrões do JPEG.
async function drawDocument(page, maxSide) {
  const { drawDocumentPage } = await loadDocuments();
  const canvas = drawDocumentPage(page.layout, { maxSide, rotation: page.rotation });
  try {
    return await canvasToBlob(canvas, 'image/png');
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// ---------- Lista de páginas ----------

const filterOptions = (selected) =>
  Object.entries(FILTERS).map(([value, label]) => el('option', { value, textContent: label, selected: value === selected }));

// ---------- Recomendação de qualidade ----------
// A qualidade limita o lado MAIOR da página. Numa página comprida (conta, cupom, extrato) sobra pouca
// largura e o texto miúdo perde definição. Quando a foto tem resolução para mais, sugere a qualidade Alta.

const NARROW_SIDE = 1000; // lado menor, em pixels, abaixo do qual texto pequeno começa a sofrer

function wouldGainFromHigh(page) {
  if (!isPhoto(page)) return false; // texto de verdade ou página de PDF: a qualidade não muda nada
  const size = page.quad
    ? quadSize(page.quad.map(([x, y]) => [x * page.width, y * page.height]), page.width, page.height)
    : { width: page.width, height: page.height };
  const long = Math.max(size.width, size.height);
  const short = Math.min(size.width, size.height);
  const scale = Math.min(1, QUALITY[els.quality.value].maxSide / long);
  const scaleHigh = Math.min(1, QUALITY.high.maxSide / long);
  return short * scale < NARROW_SIDE && scaleHigh > scale * 1.2;
}

function updateQualityTip() {
  els.qualityTip.hidden = els.quality.value === 'high' || !state.pages.some(wouldGainFromHigh);
}

els.qualityTipApply.addEventListener('click', () => {
  els.quality.value = 'high';
  discardPdf();
  updateQualityTip();
  announce('Qualidade Alta selecionada.');
  els.quality.focus();
});

function renderPages() {
  updateQualityTip();
  const total = state.pages.length;
  els.workspace.hidden = total === 0;
  els.count.textContent = total ? `(${total})` : '';

  // Filtro, tamanho, margem e qualidade só valem para fotos: documento do Word e PDF seguem o próprio arquivo.
  const hasPhotos = state.pages.some(isPhoto);
  for (const control of [els.filterAll, els.pageSize, els.margin, els.quality]) control.closest('.field').hidden = !hasPhotos;
  els.documentNote.hidden = state.pages.every(isPhoto);
  els.rangesField.hidden = els.outputMode.value !== 'ranges';
  renderOutputPreview();

  // Cartão: miniatura; número + remover (longe dos outros botões); mover ← → e girar; filtro.
  // Página de documento ou de PDF: no lugar do recorte e do filtro, de qual arquivo ela veio.
  els.pages.replaceChildren(...state.pages.map((page, i) => {
    const button = (action, label, disabled = false) => el('button', {
      type: 'button', className: `icon-btn icon-btn-${action}`, title: label, disabled: disabled || state.busy,
      'aria-label': `${label} (página ${i + 1})`, 'data-action': action,
    }, [icon(action)]);
    const doc = !isPhoto(page);

    return el('li', { className: 'page-card', 'data-id': page.id }, [
      el('button', {
        type: 'button', className: 'thumb', 'data-action': 'view', disabled: state.busy,
        'aria-label': doc ? `Ver a página ${i + 1} em tela cheia` : `Ver a página ${i + 1} em tela cheia e ajustar o recorte`,
      }, [el('img', { src: page.thumbUrl, alt: '' }), el('span', { className: 'thumb-zoom' }, [icon('expand')])]),
      doc
        ? el('p', { className: 'page-source', title: page.name }, [
          icon('file'), el('span', { className: 'page-source-name', textContent: page.name }),
          el('span', { textContent: ` · ${page.number}/${page.total}`, 'aria-label': `, página ${page.number} de ${page.total}` }),
        ])
        // Botão com texto: o recorte é o ajuste que mais muda o resultado e não pode ficar escondido atrás da miniatura.
        : el('button', {
          type: 'button', className: 'btn btn-crop', 'data-action': 'crop', disabled: state.busy,
          'aria-label': `Ajustar o recorte da página ${i + 1}`,
        }, [icon('crop'), ` ${page.quad ? 'Ajustar recorte' : 'Recortar'}`]),
      el('div', { className: 'page-tools' }, [
        el('span', { className: 'page-num', textContent: i + 1 }),
        button('remove', 'Remover'),
        button('left', 'Mover para antes', i === 0),
        button('right', 'Mover para depois', i === total - 1),
        button('rotate', 'Girar'),
      ]),
      ...(doc ? [] : [el('select', {
        className: 'page-filter', 'aria-label': `Filtro da página ${i + 1}`, disabled: state.busy,
      }, filterOptions(page.filter))]),
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
  if (button.dataset.action === 'view' || button.dataset.action === 'crop') {
    viewer.open(page, `Página ${index + 1} de ${state.pages.length}`, button.dataset.action === 'crop');
    return;
  }
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

// ---------- Tela cheia e recorte ----------

async function renderProcessed(page) {
  if (page.kind === 'pdf') return drawPdfPage(page, VIEW_SIDE);
  if (isDocument(page)) return drawDocument(page, VIEW_SIDE);
  const image = await decodeFile(page.file);
  let canvas;
  try {
    canvas = await renderPageAsync(image.source, image.width, image.height, {
      rotation: page.rotation, filter: page.filter, quad: page.quad, maxSide: VIEW_SIDE,
    });
  } finally {
    image.release();
  }
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
  canvas.width = canvas.height = 0;
  return blob;
}

const viewer = setupViewer({
  renderProcessed,
  step(page, delta) {
    const index = state.pages.indexOf(page) + delta;
    const next = state.pages[index];
    return next ? { page: next, label: `Página ${index + 1} de ${state.pages.length}` } : null;
  },
  canCrop: isPhoto,
  viewHint: (page) => (page.kind === 'pdf' && !page.drawn
    ? 'Não deu para desenhar esta página aqui, mas no PDF novo ela sai igualzinha ao original.'
    : null),
  renderOriginal: (page) => canvasToBlob(
    renderPage(page.preview, page.preview.width, page.preview.height, { rotation: page.rotation }), 'image/jpeg', 0.9),
  detect: (page) => detectQuad(page.preview, page.preview.width, page.preview.height),
  async applyCrop(page, quad) {
    page.quad = quad;
    discardPdf();
    await refreshThumb(page);
    renderPages();
  },
  // A lista pode ter sido recriada enquanto a tela cheia estava aberta: devolve o foco ao cartão da página.
  onClose(page) {
    const index = state.pages.indexOf(page);
    if (index >= 0) focusCard(index, '.thumb');
  },
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
    if (!isPhoto(page)) continue;
    page.filter = els.filterAll.value;
    await refreshThumb(page);
  }
  renderPages();
});

for (const select of [els.pageSize, els.margin, els.quality]) select.addEventListener('change', discardPdf);
els.quality.addEventListener('change', updateQualityTip);
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
  if (state.pages.some((page) => page.kind === 'pdf')) loadPdfTools().then((tools) => tools.releasePdfPreviews()).catch(() => {});
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

function baseFileName() {
  return els.fileName.value.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-') || 'documento';
}

// Um PDF com tudo, um por página ou um por intervalo: posições da lista em cada arquivo.
function outputGroups(total) {
  if (els.outputMode.value === 'each') return Array.from({ length: total }, (_, i) => [i]);
  if (els.outputMode.value === 'ranges') return parseRanges(els.ranges.value, total);
  return [Array.from({ length: total }, (_, i) => i)];
}

// Nome de cada arquivo quando são vários: documento-03.pdf, documento-1-3.pdf…
function groupFileName(base, group, total) {
  if (els.outputMode.value === 'each') return `${base}-${String(group[0] + 1).padStart(String(total).length, '0')}.pdf`;
  const first = group[0] + 1;
  const last = group[group.length - 1] + 1;
  return `${base}-${first === last ? first : `${first}-${last}`}.pdf`;
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
  if (!state.output) return;
  for (const { url } of state.output) URL.revokeObjectURL(url);
  state.output = null;
  els.result.hidden = true;
  els.resultFiles.replaceChildren();
}

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

async function generate() {
  if (!state.pages.length || state.busy) return;
  let groups;
  try {
    groups = outputGroups(state.pages.length);
  } catch (err) {
    announce(err.message, 'error');
    els.ranges.focus();
    return;
  }
  setBusy(true);
  discardPdf();
  const quality = QUALITY[els.quality.value];
  const margin = MARGINS[els.margin.value];
  const size = els.pageSize.value;

  const list = [...state.pages]; // retrato da lista: o PDF sai igual ao que estava na tela
  let ok = false;
  try {
    // Fotos e documentos são processados uma vez só, mesmo que a página entre em mais de um arquivo.
    const pages = [];
    for (const [i, page] of list.entries()) {
      announce(`Processando página ${i + 1} de ${list.length}…`);
      await nextFrame();
      if (page.kind === 'pdf') {
        pages.push(null); // copiada mais abaixo, junto com as outras páginas do mesmo PDF
        continue;
      }
      if (isDocument(page)) {
        pages.push({ ...page.layout, rotation: page.rotation }); // texto: o PDF desenha direto, sem imagem
        continue;
      }
      const image = await decodeFile(page.file);
      let canvas;
      try {
        // O filtro roda num Web Worker: a página continua respondendo durante a geração.
        canvas = await renderPageAsync(image.source, image.width, image.height, { rotation: page.rotation, filter: page.filter, quad: page.quad, maxSide: quality.maxSide });
      } finally {
        image.release();
      }
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality.jpeg);
      pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), ...layoutPage(canvas.width, canvas.height, size, margin) });
      canvas.width = canvas.height = 0; // devolve a memória do canvas na hora
    }

    const tools = list.some((page) => page.kind === 'pdf') ? await loadPdfTools() : null;
    const base = baseFileName();
    const files = [];
    for (const [g, group] of groups.entries()) {
      announce(groups.length === 1 ? 'Montando o PDF…' : `Montando o PDF ${g + 1} de ${groups.length}…`);
      await nextFrame();
      // Páginas de PDF: cada PDF de origem é copiado uma vez por arquivo, só com as páginas que entram nele.
      const wanted = new Map();
      for (const i of group) {
        const page = list[i];
        if (page.kind !== 'pdf') continue;
        if (!wanted.has(page.doc)) wanted.set(page.doc, []);
        wanted.get(page.doc).push(page.index);
      }
      const copies = new Map([...wanted].map(([doc, indices]) => [doc, tools.copyPages(doc, indices)]));
      const groupPages = group.map((i) => {
        const page = list[i];
        if (page.kind !== 'pdf') return pages[i];
        const source = copies.get(page.doc);
        return { copy: { source, page: source.pages.get(page.index) }, rotation: page.rotation };
      });
      const name = groups.length === 1 ? `${base}.pdf` : groupFileName(base, group, list.length);
      files.push(new File([buildPdf(groupPages)], name, { type: 'application/pdf' }));
    }
    state.output = files.map((file) => ({ file, url: URL.createObjectURL(file) }));
    showResult(groups);
    announce(files.length === 1
      ? 'PDF pronto. Ele só existe aqui no seu aparelho até você baixar.'
      : `${files.length} PDFs prontos. Eles só existem aqui no seu aparelho até você baixar.`, 'success');
    ok = true;
  } catch (err) {
    console.error(err);
    announce(`Algo deu errado ao gerar o PDF: ${err.message}`, 'error');
  } finally {
    setBusy(false);
    // Foco só depois de liberar os controles (controle desabilitado não recebe foco).
    if (!ok) els.generate.focus();
    else (state.output.length === 1 ? els.download : els.downloadAll).focus();
  }
}

function showResult(groups) {
  const files = state.output;
  const total = files.reduce((sum, { file }) => sum + file.size, 0);
  const pages = (n) => `${n} ${n === 1 ? 'página' : 'páginas'}`;
  const single = files.length === 1;
  els.resultTitle.textContent = single ? 'PDF pronto' : `${files.length} PDFs prontos`;
  els.resultInfo.textContent = single
    ? `${files[0].file.name} · ${pages(groups[0].length)} · ${formatBytes(total)}`
    : `${formatBytes(total)} no total`;
  els.download.hidden = !single;
  els.download.href = files[0].url;
  els.download.download = files[0].file.name;
  els.downloadAll.hidden = single;
  els.resultFiles.hidden = single;
  els.resultFiles.replaceChildren(...(single ? [] : files.map(({ file, url }, i) => el('li', {}, [
    el('a', { href: url, download: file.name, textContent: file.name }),
    el('span', { className: 'muted', textContent: ` · ${pages(groups[i].length)} · ${formatBytes(file.size)}` }),
  ]))));
  const all = files.map(({ file }) => file);
  els.share.hidden = !(navigator.canShare && navigator.canShare({ files: all }));
  els.share.lastChild.textContent = single ? ' Compartilhar' : ' Compartilhar todos';
  els.result.hidden = false;
}

// ---------- Prévia do resultado ----------
// Mostra, antes de gerar, quais arquivos vão sair e que páginas entram em cada um. Acompanha a opção
// "Gerar", os intervalos, o nome do arquivo e qualquer mudança na lista.

const PREVIEW_THUMBS = 10; // miniaturas por arquivo; o resto vira "+N"

function renderOutputPreview() {
  const total = state.pages.length;
  els.outputPreview.hidden = total === 0;
  if (!total) return;
  els.outputSummary.classList.remove('error');
  let groups;
  try {
    groups = outputGroups(total);
  } catch (err) {
    els.outputSummary.textContent = els.ranges.value.trim() ? err.message : 'Escreva os intervalos para ver os arquivos que vão sair.';
    els.outputSummary.classList.toggle('error', !!els.ranges.value.trim());
    els.outputFiles.replaceChildren();
    return;
  }
  const base = baseFileName();
  const used = new Set(groups.flat());
  const left = state.pages.map((_, i) => i + 1).filter((n) => !used.has(n - 1));
  const files = groups.length === 1 ? '1 arquivo' : `${groups.length} arquivos`;
  els.outputSummary.textContent = left.length
    ? `Vão sair ${files}. ${left.length === 1 ? 'Fica de fora a página' : 'Ficam de fora as páginas'} ${left.join(', ')}.`
    : `Vão sair ${files}.`;

  els.outputFiles.replaceChildren(...groups.map((group) => {
    const name = groups.length === 1 ? `${base}.pdf` : groupFileName(base, group, total);
    const thumbs = group.slice(0, PREVIEW_THUMBS).map((i) => el('button', {
      type: 'button', className: 'output-thumb', 'data-index': i, disabled: state.busy,
      'aria-label': `Ver a página ${i + 1}`, title: `Página ${i + 1}`,
    }, [el('img', { src: state.pages[i].thumbUrl, alt: '' }), el('span', { textContent: i + 1 })]));
    if (group.length > PREVIEW_THUMBS) thumbs.push(el('span', { className: 'output-more', textContent: `+${group.length - PREVIEW_THUMBS}` }));
    return el('li', {}, [
      el('p', { className: 'output-name' }, [icon('file'), el('strong', { textContent: name }),
        el('span', { className: 'muted', textContent: ` · ${group.length} ${group.length === 1 ? 'página' : 'páginas'}` })]),
      el('div', { className: 'output-thumbs' }, thumbs),
    ]);
  }));
}

// Tocar numa miniatura da prévia abre a página em tela cheia.
els.outputFiles.addEventListener('click', (event) => {
  const thumb = event.target.closest('.output-thumb');
  if (!thumb || state.busy) return;
  const index = Number(thumb.dataset.index);
  viewer.open(state.pages[index], `Página ${index + 1} de ${state.pages.length}`);
});

// Vários arquivos: um download de cada vez (o navegador pode pedir permissão para baixar vários).
els.downloadAll.addEventListener('click', async () => {
  if (!state.output) return;
  for (const link of els.resultFiles.querySelectorAll('a[download]')) {
    link.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
});

els.outputMode.addEventListener('change', () => {
  discardPdf();
  els.rangesField.hidden = els.outputMode.value !== 'ranges';
  renderOutputPreview();
  if (!els.rangesField.hidden) els.ranges.focus();
});
els.ranges.addEventListener('input', () => {
  discardPdf();
  renderOutputPreview();
});
els.fileName.addEventListener('input', renderOutputPreview);

els.generate.addEventListener('click', generate);

els.share.addEventListener('click', async () => {
  if (!state.output) return;
  try {
    const files = state.output.map(({ file }) => file);
    await navigator.share({ files, title: files.length === 1 ? files[0].name : 'PDFs' });
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
for (const link of document.querySelectorAll('[data-release-link]')) link.href = `${CONFIG.repoUrl}/releases/tag/v${link.textContent}`;

// ---------- Offline ----------
// O service worker só guarda os arquivos do próprio app (HTML/CSS/JS) para funcionar sem internet.
// Ele nunca vê suas imagens: elas não passam pela rede.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
