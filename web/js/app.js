import { buildPdf, layoutPage, redactedEdits } from './pdf.js';
import { FILTERS, decodeFile, detectQuad, renderPage, renderPageAsync, canvasToBlob } from './imaging.js';
import { setupViewer } from './viewer.js';
import { quadSize, unskewRect } from './geometry.js';
import { setupCamera } from './camera.js';
import { pixPayload } from './pix.js';
import { CONFIG } from './config.js';
import { parseRanges } from './ranges.js';
import { paintRedactions, rotateRedactions, toUnrotated, toRotatedRects, redactLayout, filterWords, textUnderRedactions } from './redact.js';
import { findInPieces, padRect, TYPE_LABELS } from './find-data.js';
import { plainText, linesText, documentText, looksLikeForm } from './page-text.js';
import { textWidth } from './fonts.js';
import { STAMP_POSITIONS, stampLayout, placeStamp, stampPageIndex, stampCharacters } from './stamp.js';
import { ocrWorkers, progressNote } from './ocr-plan.js';
import { moveItem, setupReorder } from './reorder.js';
import { paintEdits, rotateEdits, fileExtras, editCharacters, redactEdits } from './edits.js';
import './edit-types.js';
import { setupAllPages, spotGrid } from './all-pages.js';
import './all-pages-text.js'; // numeração, cabeçalho e rodapé (fase 2)
import './watermark.js'; // marca d'água em todas as páginas (fase 3)
import { forgetMedia, keepImages } from './edit-media.js';
import './rubric.js'; // rubrica em todas as páginas (fase 4)

// O site oficial já proíbe ser embutido em outro pelo cabeçalho frame-ancestors (web/_headers). Esta checagem
// fica como segunda camada, e protege cópias hospedadas onde não dá para enviar cabeçalhos: o app se recusa a
// rodar dentro de um iframe, para outro site não exibi-lo como se fosse dele nem sobrepor botões falsos (clickjacking).
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
// OCR: a imagem do PDF serve quando o lado maior está entre 2000 e 3500 px; abaixo disso (qualidade Leve), a foto é
// desenhada de novo com 2400 px, só para o OCR. Medido em 10 fotos de documento (2026-10-17): o tempo de leitura
// cresce bem menos que os pixels (1600 → 2400 px: +19%; 2400 → 3500: +30%), e o texto certo, pouco (99,2%, 99,3% e
// 99,7%); reduzir abaixo de 2400 ganha pouco tempo e perde letra miúda. Na qualidade Alta (3508 px), a cópia
// reduzida a 3500 lê melhor que a imagem do PDF direto (98,7% contra 98,0%): o teto fica em 3500.
const OCR_MIN_SIDE = 2000;
const OCR_SIDE = 2400;
const OCR_MAX_SIDE = 3500;

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
const loadOcr = lazy('./ocr.js'); // OCR: o motor (vendor/tesseract) só carrega quando o reconhecimento começa
const loadSigning = lazy('./sign.js'); // assinatura: PKCS#12, certificado e CMS
const loadAppend = lazy('./pdf-append.js'); // assinar um PDF que já existe sem reescrever o arquivo
const loadCrypt = lazy('./pdf-crypt.js'); // proteger o PDF gerado com senha
const loadPdfaFonts = lazy('./pdfa-fonts.js'); // PDF/A com Word ou carimbo: as fontes embutidas (vendor/liberation)

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
  pdfCompress: $('#pdf-compress'),
  compressTip: $('#compress-tip'),
  compressTipText: $('#compress-tip-text'),
  compressTipToggle: $('#compress-tip-toggle'),
  ocr: $('#ocr'),
  ocrField: $('#ocr-field'),
  sign: $('#sign'),
  cancel: $('#cancel'),
  signDialog: $('#sign-dialog'),
  signStepOpen: $('#sign-step-open'),
  signStepConfirm: $('#sign-step-confirm'),
  signPick: $('#sign-pick'),
  signFile: $('#sign-file'),
  signFileName: $('#sign-file-name'),
  signPassword: $('#sign-password'),
  signHolder: $('#sign-holder'),
  signIssuer: $('#sign-issuer'),
  signValid: $('#sign-valid'),
  signChain: $('#sign-chain'),
  signMode: $('#sign-mode'),
  stampField: $('#stamp-field'),
  stamp: $('#stamp'),
  stampBlocked: $('#stamp-blocked'),
  stampOptions: $('#stamp-options'),
  stampPage: $('#stamp-page'),
  stampGrid: $('#stamp-grid'),
  stampPreview: $('#stamp-preview'),
  signStatus: $('#sign-status'),
  signCancel: $('#sign-cancel'),
  signNext: $('#sign-next'),
  protect: $('#protect'),
  protectInputs: $('#protect-inputs'),
  protectPassword: $('#protect-password'),
  protectConfirm: $('#protect-confirm'),
  pdfPasswordDialog: $('#pdf-password'),
  pdfPasswordName: $('#pdf-password-name'),
  pdfPasswordInput: $('#pdf-password-input'),
  pdfPasswordStatus: $('#pdf-password-status'),
  pdfPasswordOpen: $('#pdf-password-open'),
  pdfPasswordSkip: $('#pdf-password-skip'),
  findData: $('#find-data'),
  findDialog: $('#find-dialog'),
  findSummary: $('#find-summary'),
  findList: $('#find-list'),
  findApply: $('#find-apply'),
  findCancel: $('#find-cancel'),
  pdfa: $('#pdfa'),
  pdfaBlocked: $('#pdfa-blocked'),
  protectBlocked: $('#protect-blocked'),
  allPages: $('#all-pages'),
  allPagesOptions: $('#all-pages-options'),
  allPagesPreview: $('#all-pages-preview'),
};

// Tudo que muda o PDF fica travado enquanto ele é gerado (os cartões são tratados em renderPages).
const lockedWhileBusy = [
  'filterAll', 'pageSize', 'margin', 'quality', 'fileName', 'clear', 'pickFiles', 'takePhoto', 'undo', 'qualityTipApply',
  'outputMode', 'ranges', 'pdfCompress', 'compressTipToggle', 'ocr', 'sign', 'protect', 'protectPassword', 'protectConfirm',
  'findData', 'pdfa',
].map((key) => els[key]);

// compressChosen: a pessoa já mexeu na opção de comprimir (aí o app não liga nem desliga sozinho).
// cancel: durante o OCR, interrompe a geração (botão Cancelar).
const state = { pages: [], busy: false, output: null, compressChosen: false, cancel: null }; // output: PDFs gerados, [{file, url}]
let nextId = 1;

// "Em todas as páginas" (all-pages.js): numeração, cabeçalho, rodapé, marca d'água e rubrica entram nas próximas
// fases. Mudar uma opção descarta o PDF gerado e redesenha a prévia.
const allPages = setupAllPages({
  section: els.allPages,
  container: els.allPagesOptions,
  changed() {
    discardPdf();
    drawAllPagesPreview();
  },
});

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
    // PDF com senha: pede a senha e tenta de novo, quantas vezes a pessoa quiser (ou pula o arquivo).
    let opened;
    let password = null;
    while (!opened) {
      try {
        opened = await module.openPdfFile(file, password);
      } catch (err) {
        if (err?.name !== 'PdfPasswordError') throw err;
        announce(`${file.name} está protegido por senha.`);
        password = await askPdfPassword(file.name, err.wrong);
        if (password === null) return { error: `${file.name} ficou de fora: ele precisa de senha para abrir.` };
      }
    }
    password = null;
    const { doc, pages, notes, heavy } = opened;
    doc.heavy = heavy;
    doc.size = file.size;
    // Valores do formulário (doc.form, pdf-form.js): gravados pelo painel de preenchimento, valem para o PDF inteiro.
    doc.form?.onChange((changed) => formChanged(doc, changed));
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
    // PDF pesado por causa de imagens: já liga a compressão, a não ser que a pessoa tenha escolhido antes. PDF
    // assinado fica como está: comprimir faria a assinatura dele deixar de valer (ela só se mantém se o PDF for
    // assinado sem mudar nada).
    let compress = '';
    if (heavy && !state.compressChosen && !doc.isSigned()) {
      els.pdfCompress.value = 'light';
      compress = `É um PDF pesado (${formatBytes(file.size)}): deixei a compressão das imagens ligada, para o arquivo ficar bem menor.`;
      updateCompressTip();
    }
    return { message: [`${file.name}: ${count}.`, compress, ...notes].filter(Boolean).join(' ') };
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
    : await photoThumb(page);
  if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
  page.thumbUrl = URL.createObjectURL(blob);
}

// Miniatura da foto: a imagem recortada, filtrada e girada; com edição, a folha inteira (photoOnSheet). Guarda o
// tamanho da imagem (page.shape): a proporção dela decide a folha (photoSheet).
async function photoThumb(page) {
  const picture = renderPage(page.preview, page.preview.width, page.preview.height, {
    rotation: page.rotation, filter: page.filter, quad: page.quad, maxSide: THUMB_SIDE, redactions: page.redactions,
  });
  page.shape = { width: picture.width, height: picture.height };
  const canvas = page.edits?.length ? photoOnSheet(picture, page, THUMB_SIDE) : picture;
  try {
    return await canvasToBlob(canvas, 'image/jpeg', 0.8);
  } finally {
    canvas.width = canvas.height = 0;
    picture.width = picture.height = 0;
  }
}

// ---------- Folha e edições ----------
// As edições (edits.js) ficam de 0 a 1 na página como ela aparece; na foto, na folha inteira, com a margem.

// Folha da foto como vai sair no PDF (layoutPage, com o tamanho e a margem escolhidos): o tamanho em pontos e onde a
// imagem entra, com a origem em cima. shape: a foto recortada e girada (só a proporção conta).
function photoSheet(shape) {
  const { width, height, box } = layoutPage(shape.width, shape.height, els.pageSize.value, MARGINS[els.margin.value]);
  return { width, height, image: { x: box.x, y: height - box.y - box.h, w: box.w, h: box.h } };
}

// Tarjas da foto (de 0 a 1 na imagem) levadas para a folha.
const sheetRects = (rects, { width, height, image }) => (rects ?? []).map(({ x0, y0, x1, y1 }) => ({
  x0: (image.x + x0 * image.w) / width, x1: (image.x + x1 * image.w) / width,
  y0: (image.y + y0 * image.h) / height, y1: (image.y + y1 * image.h) / height,
}));

// A página como aparece, em pontos (a espessura dos traços das edições). Foto: a folha.
function visibleSize(page) {
  if (isPhoto(page)) {
    const { width, height } = photoSheet(page.shape ?? { width: page.width, height: page.height });
    return { width, height };
  }
  const size = page.kind === 'pdf' ? page.size : page.layout;
  return page.rotation % 180 ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
}

// Foto com edição: a folha inteira (com a margem e o formato escolhidos), a imagem no lugar, as edições e, por cima de
// tudo, as tarjas. É assim que ela sai no PDF. Sem edição, a miniatura e a tela cheia continuam só com a imagem.
// picture: a imagem já tarjada (nos pixels).
function photoOnSheet(picture, page, maxSide, { edits = true, redact = true } = {}) {
  const sheet = photoSheet({ width: picture.width, height: picture.height });
  const scale = maxSide / Math.max(sheet.width, sheet.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sheet.width * scale));
  canvas.height = Math.max(1, Math.round(sheet.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(picture, sheet.image.x * scale, sheet.image.y * scale, sheet.image.w * scale, sheet.image.h * scale);
  const covers = sheetRects(page.redactions, sheet);
  if (edits) paintEdits(ctx, redact ? shownEdits(page.edits, covers, sheet) : page.edits, sheet);
  if (redact) paintRedactions(ctx, covers, canvas.width, canvas.height);
  return canvas;
}

// Edições e, por cima, tarjas, num canvas que é a página como aparece (Word e página de PDF).
function paintOver(canvas, page, { redact = true, edits = true } = {}) {
  const ctx = canvas.getContext('2d');
  const size = visibleSize(page);
  if (edits) paintEdits(ctx, redact ? shownEdits(page.edits, page.redactions, size) : page.edits, size);
  if (redact) paintRedactions(ctx, page.redactions, canvas.width, canvas.height);
}

// As edições como o PDF as leva, para a tela mostrar o mesmo: sem as letras que as tarjas tiram (texto e marca
// d'água) e sem o que elas pegam inteiro. Desenho, forma, rubrica e imagem pegos em parte saem cortados no PDF; na tela,
// a tarja pintada por cima mostra o mesmo (a imagem é cortada só ao gerar, quando o arquivo é montado).
function shownEdits(edits, covers, size) {
  if (!edits?.length || !covers?.length) return edits;
  return edits.flatMap((edit) => (edit.type === 'image' ? [edit] : redactEdits([edit], covers, size)));
}

// Pede a senha de um PDF protegido. Devolve a senha, ou null se a pessoa pular o arquivo. O campo é limpo na hora.
function askPdfPassword(name, wrong) {
  return new Promise((resolve) => {
    const dialog = els.pdfPasswordDialog;
    const status = (message, kind = 'info') => {
      els.pdfPasswordStatus.textContent = message;
      els.pdfPasswordStatus.dataset.kind = kind;
    };
    const finish = (value) => {
      els.pdfPasswordOpen.removeEventListener('click', submit);
      els.pdfPasswordSkip.removeEventListener('click', skip);
      els.pdfPasswordInput.removeEventListener('keydown', onKey);
      dialog.removeEventListener('cancel', onCancel);
      els.pdfPasswordInput.value = '';
      dialog.close();
      resolve(value);
    };
    const submit = () => {
      const value = els.pdfPasswordInput.value;
      if (!value) {
        status('Digite a senha do PDF.', 'error');
        els.pdfPasswordInput.focus();
        return;
      }
      finish(value);
    };
    const skip = () => finish(null);
    const onKey = (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submit();
    };
    const onCancel = (event) => { // Esc: o mesmo que pular
      event.preventDefault();
      finish(null);
    };
    els.pdfPasswordName.textContent = name;
    els.pdfPasswordInput.value = '';
    status(wrong ? 'A senha não confere. Confira maiúsculas e minúsculas e tente de novo.' : '', wrong ? 'error' : 'info');
    els.pdfPasswordOpen.addEventListener('click', submit);
    els.pdfPasswordSkip.addEventListener('click', skip);
    els.pdfPasswordInput.addEventListener('keydown', onKey);
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
    els.pdfPasswordInput.focus();
  });
}

// Valores do formulário de um PDF mudaram (form.setValue ou form.clear, em pdf-form.js): as páginas dele com campos
// que mudaram são desenhadas de novo, como vão sair (com os valores fixos), e o PDF gerado antes deixa de valer.
// O mesmo campo vale em todas as páginas e em todos os arquivos com ele.
async function formChanged(doc, changed) {
  discardPdf();
  const affected = state.pages.filter((page) => page.kind === 'pdf' && page.doc === doc && changed.has(page.index));
  for (const page of affected) await refreshThumb(page);
  if (affected.length) renderPages();
}

// Valores do painel de preenchimento (form-panel.js) gravados no formulário do PDF: o mesmo campo vale em todas as
// páginas e arquivos com ele, e as páginas são desenhadas de novo pelo onChange (formChanged). Devolve o aviso, que
// também vai para a tela cheia: quantos campos, o que não coube, o que não serviu para o formato e os obrigatórios que
// ficaram vazios (avisados, sem bloquear).
async function saveFormValues(page, changes, { empty = [], invalid = [] } = {}) {
  const { form } = page.doc;
  let clipped = 0;
  for (const [id, value] of changes) if (form.setValue(id, value).clipped) clipped++;
  const index = state.pages.indexOf(page) + 1;
  const names = (list) => {
    const shown = list.slice(0, 3);
    return list.length > 3 ? `${shown.join(', ')} e mais ${list.length - 3}` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} e ${shown.at(-1)}` : shown[0];
  };
  const parts = [changes.size
    ? `Página ${index}: ${changes.size === 1 ? '1 campo preenchido, fixo' : `${changes.size} campos preenchidos, fixos`} na página do PDF.`
    : `Página ${index}: nenhum valor mudou.`];
  if (clipped) parts.push(clipped === 1 ? 'Um valor não coube no campo e sai cortado.' : `${clipped} valores não couberam no campo e saem cortados.`);
  if (invalid.length) parts.push(`Fora do formato do formulário, como digitado: ${names(invalid)}.`);
  if (empty.length) parts.push(`${empty.length === 1 ? 'Ficou vazio o campo obrigatório' : 'Ficaram vazios os campos obrigatórios'} ${names(empty)}.`);
  const message = parts.join(' ');
  announce(message, empty.length || invalid.length || clipped ? 'error' : 'info');
  return message;
}

// Página de PDF desenhada pelo PDF.js; se não der, um cartão com o formato da folha e o número.
// redact: com as tarjas da página por cima (false na tela de tarjar, que desenha as caixas à parte); edits: com as
// edições (false no modo Editar, que as desenha à parte).
async function drawPdfPage(page, maxSide, { redact = true, edits = true } = {}) {
  const tools = await loadPdfTools();
  const { canvas, real } = await tools.drawPdfPage(page.doc, { index: page.index, ...page.size }, {
    maxSide, rotation: page.rotation, number: page.number,
  });
  page.drawn = real;
  try {
    paintOver(canvas, page, { redact, edits });
    return await canvasToBlob(canvas, 'image/png');
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// Página de documento desenhada como vai sair no PDF. PNG: texto nítido, sem os borrões do JPEG.
async function drawDocument(page, maxSide, { redact = true, edits = true } = {}) {
  const { drawDocumentPage } = await loadDocuments();
  const canvas = drawDocumentPage(page.layout, { maxSide, rotation: page.rotation });
  paintOver(canvas, page, { redact, edits });
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
  // OCR nas fotos e nas páginas de PDF escaneado (as de PDF que já têm texto são puladas); o Word já tem texto.
  els.ocrField.hidden = !hasPhotos && !state.pages.some((page) => page.kind === 'pdf');
  updatePdfaOption();
  els.documentNote.hidden = state.pages.every(isPhoto);
  els.pdfCompress.closest('.field').hidden = !state.pages.some((page) => page.kind === 'pdf');
  updateCompressTip();
  els.rangesField.hidden = els.outputMode.value !== 'ranges';
  renderOutputPreview();

  // Cartão: miniatura; alça de arrastar, número e remover (longe dos outros botões); mover ← → e girar; filtro.
  // Página de documento ou de PDF: no lugar do recorte e do filtro, de qual arquivo ela veio.
  // A alça fica fora do Tab e do leitor de tela: os botões ← e → fazem o mesmo pelo teclado.
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
        el('span', { className: 'page-label' }, [
          el('span', { className: 'drag-handle', title: 'Arraste para mudar a página de lugar', 'aria-hidden': 'true' }, [icon('grip')]),
          el('span', { className: 'page-num', textContent: i + 1 }),
        ]),
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
      if (page.redactions?.length) page.redactions = rotateRedactions(page.redactions, 90);
      if (page.edits?.length) page.edits = rotateEdits(page.edits, 90); // a folha da foto gira junto com a imagem
      page.ocr = null; // o OCR lê a página de pé: com outro giro, lê de novo
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
  page.ocr = null;
  discardPdf();
  await refreshThumb(page);
  renderPages();
  // Quem trocou o filtro pelo teclado continua no mesmo seletor.
  const index = state.pages.indexOf(page);
  if (index >= 0 && focusLost()) focusCard(index, '.page-filter');
});

// Arrastar pela alça (reorder.js): a ordem só muda ao soltar, e soltar no mesmo lugar não muda nada.
setupReorder(els.pages, {
  enabled: () => !state.busy,
  move(from, to) {
    state.pages = moveItem(state.pages, from, to);
    discardPdf();
    renderPages();
    announce(`Página ${from + 1} movida para a posição ${to + 1}.`);
  },
});

// ---------- Tela cheia e recorte ----------

// Página em tela cheia, como vai sair no PDF. redact e edits: com as tarjas e com as edições.
async function renderProcessed(page, { redact = true, edits = true } = {}) {
  if (page.kind === 'pdf') return drawPdfPage(page, VIEW_SIDE, { redact, edits });
  if (isDocument(page)) return drawDocument(page, VIEW_SIDE, { redact, edits });
  const picture = await renderPhoto(page, redact);
  const canvas = edits && page.edits?.length ? photoOnSheet(picture, page, VIEW_SIDE, { redact }) : picture;
  try {
    return await canvasToBlob(canvas, 'image/jpeg', 0.9);
  } finally {
    canvas.width = canvas.height = 0;
    picture.width = picture.height = 0;
  }
}

// A foto em tela cheia: recortada, filtrada, girada e, com redact, tarjada.
async function renderPhoto(page, redact = true) {
  const image = await decodeFile(page.file);
  try {
    return await renderPageAsync(image.source, image.width, image.height, {
      rotation: page.rotation, filter: page.filter, quad: page.quad, maxSide: VIEW_SIDE,
      redactions: redact ? page.redactions : null,
    });
  } finally {
    image.release();
  }
}

// Foto para a tela das tarjas: só a imagem (as tarjas da foto são marcadas nela), sem as tarjas e com a parte das
// edições que cai sobre a imagem.
async function photoForRedaction(page) {
  const picture = await renderPhoto(page, false);
  try {
    if (page.edits?.length) {
      const sheet = photoSheet({ width: picture.width, height: picture.height });
      const scale = picture.width / sheet.image.w;
      paintEdits(picture.getContext('2d'), page.edits, sheet, {
        x: -sheet.image.x * scale, y: -sheet.image.y * scale, width: sheet.width * scale, height: sheet.height * scale,
      });
    }
    return await canvasToBlob(picture, 'image/jpeg', 0.9);
  } finally {
    picture.width = picture.height = 0;
  }
}

// Página para o modo Editar: como vai sair no PDF, mas sem as edições (o editor as desenha por cima), com o tamanho em
// pontos e as tarjas na página como aparece (o editor as mostra por cima das edições). Foto: a folha inteira.
async function editBase(page) {
  if (!isPhoto(page)) return { blob: await renderProcessed(page, { edits: false }), ...visibleSize(page), redactions: page.redactions ?? [] };
  const picture = await renderPhoto(page);
  const sheet = photoSheet({ width: picture.width, height: picture.height });
  const canvas = photoOnSheet(picture, page, VIEW_SIDE, { edits: false });
  try {
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
    return { blob, width: sheet.width, height: sheet.height, redactions: sheetRects(page.redactions, sheet) };
  } finally {
    canvas.width = canvas.height = 0;
    picture.width = picture.height = 0;
  }
}

const viewer = setupViewer({
  renderProcessed,
  step(page, delta) {
    const index = state.pages.indexOf(page) + delta;
    const next = state.pages[index];
    return next ? { page: next, label: `Página ${index + 1} de ${state.pages.length}` } : null;
  },
  canCrop: isPhoto,
  // "Formulário" sem campos (muitos dos públicos): a dica da tela cheia aponta para o Texto da v4.0.0. Só na página de
  // PDF sem campos que parece um formulário (linhas para preencher, quadrinhos), para não aparecer em todo PDF.
  formHint(page) {
    if (page.kind !== 'pdf' || page.doc.form?.fields.length) return Promise.resolve(null);
    page.formHint ??= loadPdfTools()
      .then((tools) => tools.pdfPageTextItems(page.doc, page.index))
      .then(({ items }) => (looksLikeForm(items) ? 'Este PDF não tem campos para preencher: para escrever nos espaços, use "Editar" e depois "Texto".' : null))
      .catch(() => null);
    return page.formHint;
  },
  viewHint: (page) => (page.kind === 'pdf' && !page.drawn
    ? 'Não deu para desenhar esta página aqui, mas no PDF novo ela sai igualzinha ao original.'
    : null),
  renderOriginal: (page) => canvasToBlob(
    renderPage(page.preview, page.preview.width, page.preview.height, { rotation: page.rotation }), 'image/jpeg', 0.9),
  detect: (page) => detectQuad(page.preview, page.preview.width, page.preview.height),
  async applyCrop(page, quad) {
    const changed = JSON.stringify(quad) !== JSON.stringify(page.quad);
    page.quad = quad;
    page.ocr = null;
    // As tarjas e as edições ficam sobre a foto já recortada: com outro recorte, cobririam outro lugar. Saem, com aviso.
    const lost = changed ? [page.redactions?.length && 'As tarjas', page.edits?.length && 'As edições'].filter(Boolean) : [];
    if (lost.length) {
      page.redactions = [];
      page.edits = [];
      const what = lost.length === 2 ? 'As tarjas e as edições' : lost[0];
      announce(`${what} da página ${state.pages.indexOf(page) + 1} foram apagadas porque o recorte mudou: marque de novo.`, 'error');
    }
    discardPdf();
    await refreshThumb(page);
    renderPages();
  },
  renderPlain: (page) => (isPhoto(page) ? photoForRedaction(page) : renderProcessed(page, { redact: false })),
  redactHint: (page) => (page.kind === 'pdf'
    ? 'Arraste sobre o que esconder. O que fica sob a tarja é apagado, não só coberto. Esta página é de um PDF: com tarja, ela sai como imagem, e o texto dela deixa de ser selecionável.'
    : 'Arraste sobre o que esconder. O que fica sob a tarja é apagado do PDF, não só coberto.'),
  async saveRedactions(page, list) {
    page.redactions = list;
    page.ocr = null;
    discardPdf();
    await refreshThumb(page);
    renderPages();
    const index = state.pages.indexOf(page) + 1;
    announce(list.length
      ? `Página ${index}: ${list.length === 1 ? '1 tarja' : `${list.length} tarjas`}. O que está embaixo vai ser apagado do PDF.`
      : `Página ${index}: sem tarjas.`);
  },
  copyText: pageText,
  canCopy: () => !state.busy, // gerando o PDF ou procurando dados, o OCR e as páginas estão em uso
  editBase,
  async saveEdits(page, list) {
    page.edits = list;
    // Imagem que nenhuma página usa mais (removida, ou escolhida e cancelada) sai da memória (edit-media.js).
    keepImages([...state.pages, removed?.page].flatMap((each) => each?.edits ?? []));
    discardPdf();
    await refreshThumb(page);
    renderPages();
    const index = state.pages.indexOf(page) + 1;
    announce(list.length
      ? `Página ${index}: ${list.length === 1 ? '1 edição' : `${list.length} edições`}, fixas na página do PDF.`
      : `Página ${index}: sem edições.`);
  },
  // Preencher (form-panel.js): página de PDF com campos que dá para preencher (o XFA puro não dá).
  canFill: (page) => page.kind === 'pdf' && !!page.doc.form?.fillable && page.doc.form.pageFields(page.index).length > 0,
  // A página como vai sair (com os valores já aplicados, as edições e as tarjas), o formulário e onde ela está.
  async fillBase(page) {
    return { blob: await renderProcessed(page), ...visibleSize(page), form: page.doc.form, index: page.index, rotation: page.rotation };
  },
  // O texto da página (PDF.js), para os rótulos pelo texto em volta dos campos. Sem o PDF.js, ficam os do formulário.
  async fillText(page) {
    const tools = await loadPdfTools();
    return (await tools.pdfPageTextItems(page.doc, page.index).catch(() => null))?.items ?? null;
  },
  async saveForm(page, changes, problems) {
    return saveFormValues(page, changes, problems);
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
    if (page.filter !== els.filterAll.value) page.ocr = null;
    page.filter = els.filterAll.value;
    await refreshThumb(page);
  }
  renderPages();
});

for (const select of [els.pageSize, els.margin, els.quality, els.ocr]) select.addEventListener('change', discardPdf);
// A folha da foto com edição muda com o tamanho e a margem: as edições vão junto, na mesma posição relativa, e a
// miniatura é desenhada de novo.
for (const select of [els.pageSize, els.margin]) {
  select.addEventListener('change', async () => {
    const edited = state.pages.filter((page) => isPhoto(page) && page.edits?.length);
    for (const page of edited) await refreshThumb(page);
    if (edited.length) renderPages();
  });
}
// Ligou o OCR: o código e o modelo (uns 2 MB) já começam a baixar, para o reconhecimento começar mais cedo ao gerar.
els.ocr.addEventListener('change', () => {
  if (els.ocr.checked) loadOcr().then(({ preloadOcr }) => preloadOcr(), () => {});
});

// PDF/A: com fotos e páginas de Word (que levam as fontes embutidas), sem página de outro PDF (que vem como está, com
// fontes e cores que o app não converte) e sem senha (o PDF/A não permite criptografia). O motivo de estar
// indisponível aparece logo abaixo da opção.
function pdfaUnavailable() {
  if (state.pages.some((page) => page.kind === 'pdf')) return 'O PDF/A não vale para páginas de outro PDF: com elas na lista, a opção fica indisponível.';
  if (els.protect.checked) return 'O PDF/A não permite senha: desligue "Proteger o PDF com senha" para usar.';
  return '';
}

function updatePdfaOption() {
  const reason = pdfaUnavailable();
  if (reason && els.pdfa.checked) els.pdfa.checked = false;
  if (!state.busy) els.pdfa.disabled = !!reason;
  els.pdfaBlocked.hidden = !reason;
  els.pdfaBlocked.textContent = reason;
  if (!state.busy) els.protect.disabled = els.pdfa.checked;
  els.protectBlocked.hidden = !els.pdfa.checked;
}

els.pdfa.addEventListener('change', () => {
  discardPdf();
  updatePdfaOption();
});

// Proteger com senha: os campos só aparecem com a opção ligada; desligar apaga o que foi digitado.
els.protect.addEventListener('change', () => {
  discardPdf();
  updatePdfaOption();
  els.protectInputs.hidden = !els.protect.checked;
  if (els.protect.checked) els.protectPassword.focus();
  else els.protectPassword.value = els.protectConfirm.value = '';
});
for (const input of [els.protectPassword, els.protectConfirm]) input.addEventListener('input', discardPdf);

// Senha para proteger o PDF, já conferida. null: sem proteção; undefined: falta ou não confere (já avisado).
function protectionPassword() {
  if (!els.protect.checked) return null;
  const password = els.protectPassword.value;
  if (!password) {
    announce('Digite a senha para proteger o PDF.', 'error');
    els.protectPassword.focus();
    return undefined;
  }
  if (password !== els.protectConfirm.value) {
    announce('As duas senhas não são iguais. Digite de novo.', 'error');
    els.protectConfirm.value = '';
    els.protectConfirm.focus();
    return undefined;
  }
  return password;
}
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
  forgetMedia(); // as imagens das edições e a rubrica (edit-media.js)
  state.compressChosen = false;
  els.pdfCompress.value = 'none';
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

// label: o que aparece no botão de gerar enquanto o app trabalha.
function setBusy(busy, label = 'Gerando…') {
  state.busy = busy;
  if (busy) disarmClear();
  els.generate.disabled = busy;
  els.generate.textContent = busy ? label : 'Gerar PDF';
  if (busy) els.workspace.setAttribute('aria-busy', 'true');
  else els.workspace.removeAttribute('aria-busy');
  for (const control of lockedWhileBusy) control.disabled = busy;
  // "Em todas as páginas" (numeração, cabeçalho, rodapé, marca d'água, rubrica e "Desenhar de novo") inteiro: o
  // fieldset desligado desliga todo controle de dentro, e cada um volta ao estado dele ao religar.
  els.allPages.disabled = busy;
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

// O que muda o resultado do OCR: recorte, filtro, rotação e tarjas (a qualidade não: as posições do texto são
// guardadas relativas à imagem). O OCR lê a página como ela aparece no app, com o giro escolhido: é assim que a
// pessoa deixa o texto de pé, também numa página de PDF que o scanner gravou deitada.
const ocrKey = (page) => (page.kind === 'pdf'
  ? JSON.stringify(['pdf', page.rotation, page.redactions ?? [], page.doc.form?.pageVersion(page.index) ?? 0])
  : JSON.stringify([page.quad, page.filter, page.rotation, page.redactions ?? []]));

class Cancelled extends Error {}

/**
 * Gera os PDFs. Ordem de cada página: montar, reconhecer o texto (OCR), comprimir e, por último, assinar.
 * @param {{signer?: object, stamp?: object | null, append?: object | null}} [options] signer: certificado aberto em
 *   sign.js, descartado no fim, dê certo ou não; stamp: carimbo visível ({page, position}); append: o PDF da lista,
 *   quando ele é assinado sem reescrever (unchangedPdf)
 */
async function generate({ signer, stamp = null, append = null } = {}) {
  if (!state.pages.length || state.busy) {
    signer?.discard();
    return;
  }
  let groups;
  try {
    groups = outputGroups(state.pages.length);
  } catch (err) {
    signer?.discard();
    announce(err.message, 'error');
    els.ranges.focus();
    return;
  }
  const password = protectionPassword(); // proteger com senha: conferida antes de começar
  if (password === undefined) {
    signer?.discard();
    return;
  }
  const pdfa = els.pdfa.checked && !pdfaUnavailable();
  setBusy(true);
  discardPdf();
  const quality = QUALITY[els.quality.value];
  const margin = MARGINS[els.margin.value];
  const size = els.pageSize.value;

  const list = [...state.pages]; // retrato da lista: o PDF sai igual ao que estava na tela
  // OCR: nas fotos e nas páginas de PDF (as que já têm texto são puladas), e só nas que ainda não foram lidas com o
  // recorte, o filtro, a rotação e as tarjas de agora (ocrKey).
  const readable = (page) => isPhoto(page) || page.kind === 'pdf';
  const useOcr = els.ocr.checked && list.some(readable);
  const toRead = useOcr ? list.filter((page) => readable(page) && page.ocr?.key !== ocrKey(page)) : [];
  const workers = toRead.length ? ocrWorkers(navigator, toRead.length) : 1; // dois só onde sobra memória
  let ocr = null; // motor do OCR, encerrado no fim
  let starting = null; // o motor ligando
  let cancelled = false;
  let finished = false;
  if (toRead.length) {
    els.cancel.hidden = false;
    state.cancel = () => {
      cancelled = true;
      els.cancel.disabled = true;
      ocr?.cancel();
    };
  }
  const stopIfCancelled = () => {
    if (cancelled) throw new Cancelled();
  };
  // O motor do OCR liga uma vez, quando a primeira página precisa dele (página de PDF que já tem texto não precisa).
  // Com foto para ler, ele já liga no começo, enquanto a primeira foto é montada.
  const engine = () => {
    if (!starting) {
      starting = (async () => {
        const { startOcr } = await loadOcr().catch(() => {
          throw ocrError('Não deu para carregar o reconhecimento de texto. Confira a conexão e tente de novo.');
        });
        stopIfCancelled();
        const reader = await startOcr({ workers });
        // Cancelado, ou a geração parou com erro, enquanto o motor ligava: ele sai da memória na hora.
        if (cancelled || finished) {
          reader.terminate();
          throw new Cancelled();
        }
        return (ocr = reader);
      })();
      starting.catch(() => {}); // o erro aparece para quem espera o motor
    }
    return starting;
  };
  // Leituras do OCR em andamento, no máximo uma por worker. Enquanto o worker lê uma página, o app gera o JPEG dela.
  // Com um worker só (no iPhone, por exemplo), o app também decodifica a próxima foto, mas só recorta e filtra depois
  // que a leitura termina: a memória não passa da de antes, quando a foto da página ficava aberta durante a leitura.
  // Com dois, onde sobra memória, a página seguinte já fica pronta, esperando a vez.
  const single = workers === 1;
  const reading = new Set();
  let done = 0;
  let begin = 0; // quando a primeira leitura começou: base da estimativa do tempo que falta
  const free = async () => {
    while (reading.size >= (ocr?.workers ?? workers)) await Promise.race(reading);
  };
  const turn = async (page) => {
    if (!ocr) announce('Preparando o reconhecimento de texto (na primeira vez, o app baixa uns 5 MB)…');
    const reader = await engine();
    await free();
    stopIfCancelled();
    begin ||= performance.now();
    announce(`Reconhecendo o texto: página ${toRead.indexOf(page) + 1} de ${toRead.length}…${progressNote(performance.now() - begin, done, toRead.length)}`);
    return reader;
  };
  // Guarda a leitura em andamento. A falha fica no Set e aparece na próxima espera pela vez ou no fim.
  const track = (words, save) => {
    const job = words.then((list) => {
      save(list);
      done++;
      reading.delete(job);
    });
    job.catch(() => {});
    reading.add(job);
  };

  let ok = false;
  try {
    // PDF assinado sem reescrever: o original vai inteiro, e a assinatura entra no fim (pdf-append.js).
    if (signer && append) {
      announce('Assinando o PDF…');
      await nextFrame();
      const bytes = await signer.signExisting(append, new Date(), { stamp });
      const file = new File([bytes], `${baseFileName()}.pdf`, { type: 'application/pdf' });
      state.output = [{ file, before: null, url: URL.createObjectURL(file) }];
      showResult(groups, signer, false, false);
      const kept = append.isSigned() ? ' As assinaturas que ele já tinha continuam valendo.' : '';
      announce(`PDF assinado. Ele só existe aqui no seu aparelho até você baixar.${kept}`, 'success');
      ok = true;
      return;
    }

    // Fotos e documentos são processados uma vez só, mesmo que a página entre em mais de um arquivo.
    const pages = [];
    if (toRead.some(isPhoto)) engine();
    for (const [i, page] of list.entries()) {
      // Com uma leitura em andamento, a mensagem continua sendo a dela.
      if (!reading.size) announce(`Processando página ${i + 1} de ${list.length}…`);
      await nextFrame();
      stopIfCancelled();
      if (page.kind === 'pdf') {
        if (toRead.includes(page)) {
          if (single) await free();
          const key = ocrKey(page);
          const scan = await readPdfPage(turn, page);
          if (scan.hasText) page.ocr = { key, words: [], hasText: true };
          else track(scan.words, (words) => { page.ocr = { key, words, hasText: false }; });
          stopIfCancelled();
        }
        // Com tarja, a página vira imagem (com os pixels sob a tarja pintados); sem, é copiada mais abaixo, junto
        // com as outras páginas do mesmo PDF (com a camada do OCR, se ela foi lida).
        if (single && page.redactions?.length) await free();
        pages.push(page.redactions?.length ? await rasterizePdfPage(page, quality) : null);
        continue;
      }
      if (isDocument(page)) {
        // Texto: o PDF desenha direto, sem imagem. Com tarja, o texto embaixo sai da página (redact.js).
        pages.push(page.redactions?.length ? await redactDocumentPage(page) : { ...page.layout, rotation: page.rotation });
        continue;
      }
      // Com um worker só, a foto é decodificada enquanto ele ainda lê a anterior (que já saiu da memória), mas o
      // recorte e o filtro esperam a leitura terminar.
      const image = await decodeFile(page.file);
      let canvas;
      let source = null; // imagem para o OCR
      try {
        if (single) await free();
        // O filtro roda num Web Worker: a página continua respondendo durante a geração.
        canvas = await renderPageAsync(image.source, image.width, image.height, {
          rotation: page.rotation, filter: page.filter, quad: page.quad, maxSide: quality.maxSide, redactions: page.redactions,
        });
        if (toRead.includes(page)) source = await ocrImage(image, canvas, page);
      } finally {
        image.release(); // a foto original não espera a vez do OCR na memória
      }
      const layout = layoutPage(canvas.width, canvas.height, size, margin);
      if (source) {
        try {
          const reader = await turn(page);
          const key = ocrKey(page);
          const { width, height } = canvas;
          // O OCR lê a foto já tarjada; o que ele achar sobre uma tarja (a borda da caixa, ruído) também sai.
          // Resolução da imagem na página do PDF, em pontos por polegada: ajuda o Tesseract a medir as letras.
          track(reader.recognize(source, { dpi: source.width / (layout.box.w / 72) }), (words) => {
            page.ocr = { key, words: filterWords(words, page.redactions), size: { width, height } };
          });
        } finally {
          if (source !== canvas) source.width = source.height = 0; // os pixels já foram copiados
        }
      }
      stopIfCancelled();
      // O JPEG sai enquanto o worker lê a página: o recognize já copiou os pixels.
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality.jpeg);
      pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), ...layout });
      canvas.width = canvas.height = 0; // devolve a memória do canvas na hora
    }
    // As últimas leituras; depois, as palavras entram nas páginas que viraram imagem (fotos e páginas de PDF tarjadas).
    await Promise.all(reading);
    if (useOcr) {
      list.forEach((page, i) => {
        if (pages[i]?.jpeg && page.ocr?.words.length) pages[i].ocr = page.ocr.words;
      });
    }
    // O motor do OCR ocupa centenas de MB: sai da memória assim que as páginas terminam.
    ocr?.terminate();
    ocr = null;
    els.cancel.hidden = true;
    state.cancel = null;

    // Edições de cada página em cada arquivo: as da própria página e as de "em todas as páginas" (all-pages.js), que
    // contam a posição dentro do arquivo. Páginas montadas acima (foto, Word, PDF tarjado) recebem as edições na hora
    // de montar cada arquivo; as de PDF copiadas, pelo copyPages.
    const sizeOf = (i) => (pages[i]?.jpeg ? { width: pages[i].width, height: pages[i].height } : visibleSize(list[i]));
    const extras = fileExtras(groups, (context) => allPages.produce({ ...context, page: list[context.index], size: sizeOf(context.index) }));
    const editsIn = (g, p) => [...(list[groups[g][p]].edits ?? []), ...extras[g][p]];
    const withEdits = (built, page, edits) => (!edits.length ? built
      : { ...built, edits, ...(built.jpeg && page.redactions?.length ? { redactions: page.redactions } : {}) });

    // PDF/A com página de Word, com texto nas edições ou com carimbo: as fontes vão embutidas, só com as letras usadas
    // (as mesmas para todos os arquivos). O carimbo leva as letras do nome e todas as que a data e a hora da assinatura
    // podem usar.
    let fonts = null;
    const fontPages = groups.flatMap((group, g) => group.map((i, p) => pages[i] && withEdits(pages[i], list[i], editsIn(g, p))))
      .filter(Boolean);
    // Imagem das edições que uma tarja pega só em parte: essa parte sai dos pixels antes de montar (edit-image.js, já
    // carregado pelo editor quando há imagem).
    if (fontPages.some((page) => page.edits?.some((edit) => edit.type === 'image'))) {
      const { cutImages } = await import('./edit-image.js');
      await cutImages(fontPages);
    }
    // As letras das edições contam como vão para o arquivo, sem as tiradas pelas tarjas (redactedEdits, em pdf.js).
    if (pdfa && (list.some(isDocument) || (signer && stamp) || fontPages.some((page) => editCharacters(redactedEdits(page)).size))) {
      announce('Preparando as fontes do PDF/A…');
      const { embedFonts } = await loadPdfaFonts().catch(() => {
        throw fontError();
      });
      const extra = signer && stamp ? stampCharacters(signer.name) : undefined;
      fonts = await embedFonts(fontPages, extra).catch((err) => {
        if (!(err instanceof TypeError) && err?.name !== 'TrueTypeError') throw err;
        throw fontError();
      });
    }

    const tools = list.some((page) => page.kind === 'pdf') ? await loadPdfTools() : null;
    const crypt = password && !signer ? await loadCrypt() : null; // com assinatura, quem protege é o sign.js

    // Valores do formulário de cada PDF de origem (os preenchidos no app e os que outro programa não desenhou, #16): a
    // aparência nova de cada widget, a mesma em todos os arquivos.
    const fills = new Map(list.filter((page) => page.kind === 'pdf' && page.doc.form).map((page) => [page.doc, null]));
    for (const doc of fills.keys()) {
      try {
        fills.set(doc, doc.form.fill());
      } catch (err) {
        // PDF estranho: sem valor preenchido no app, ele sai como na v4.0.0, com os campos como estão; com valor, não sai.
        if (doc.form.hasValues()) throw err;
        console.warn('Campos do formulário sem desenho:', err);
        fills.set(doc, undefined);
      }
    }

    // Comprimir: as imagens de cada PDF de origem são recodificadas uma vez só, para todos os arquivos.
    const level = tools ? els.pdfCompress.value : 'none';
    const replacements = new Map();
    if (level !== 'none') {
      const used = new Map();
      for (const i of new Set(groups.flat())) {
        const page = list[i];
        if (page.kind !== 'pdf' || pages[i]) continue;
        if (!used.has(page.doc)) used.set(page.doc, new Set());
        used.get(page.doc).add(page.index);
      }
      for (const [doc, indices] of used) {
        replacements.set(doc, await tools.compressPdf(doc, [...indices], QUALITY[level], (done, total) => {
          announce(`Comprimindo as imagens do PDF (${done} de ${total})…`);
        }));
      }
    }

    const base = baseFileName();
    const files = [];
    let notSmaller = 0;
    for (const [g, group] of groups.entries()) {
      announce(groups.length === 1 ? 'Montando o PDF…' : `Montando o PDF ${g + 1} de ${groups.length}…`);
      await nextFrame();
      // Páginas de PDF: cada PDF de origem é copiado uma vez por arquivo, só com as páginas que entram nele.
      const wanted = new Map();
      for (const i of group) {
        const page = list[i];
        if (page.kind !== 'pdf' || pages[i]) continue;
        if (!wanted.has(page.doc)) wanted.set(page.doc, []);
        wanted.get(page.doc).push(page.index);
      }
      // Edições das páginas de PDF copiadas neste arquivo, por PDF de origem: pela posição da página, com o giro do app.
      const editedCopies = new Map();
      group.forEach((i, p) => {
        const page = list[i];
        const edits = editsIn(g, p);
        if (page.kind !== 'pdf' || pages[i] || !edits.length) return;
        if (!editedCopies.has(page.doc)) editedCopies.set(page.doc, new Map());
        editedCopies.get(page.doc).set(page.index, { edits, rotation: page.rotation });
      });
      const pagesOf = (compressed) => {
        const copies = new Map([...wanted].map(([doc, indices]) => [doc, tools.copyPages(doc, indices, {
          replace: compressed ? replacements.get(doc) : undefined,
          ocr: useOcr ? scannedWords(list, doc) : undefined,
          edits: editedCopies.get(doc),
          fill: fills.get(doc),
        })]));
        return group.map((i, p) => {
          const page = list[i];
          if (pages[i]) return withEdits(pages[i], page, editsIn(g, p));
          const source = copies.get(page.doc);
          return { copy: { source, page: source.pages.get(page.index) }, rotation: page.rotation };
        });
      };
      // Comprimido só fica se diminuir; senão, vai a versão sem recomprimir.
      let chosen = pagesOf(false);
      let bytes = buildPdf(chosen, { pdfa, fonts });
      let before = null;
      if (wanted.size && replacements.size) {
        const smallPages = pagesOf(true);
        const small = buildPdf(smallPages, { pdfa, fonts });
        if (small.length < bytes.length) {
          before = bytes.length;
          bytes = small;
          chosen = smallPages;
        } else {
          notSmaller++;
        }
      }
      // Tarjas: o PDF.js relê o PDF montado, e nenhum texto pode estar sob uma tarja. Se estiver, nada sai.
      await checkRedactions(bytes, group.map((i) => list[i]), chosen, g + 1, groups.length);
      // Assinar é sempre o último passo: qualquer mudança depois invalidaria a assinatura. Com senha, o PDF é
      // cifrado antes de ser assinado (a assinatura cobre o arquivo cifrado).
      if (signer) {
        announce(groups.length === 1 ? 'Assinando o PDF…' : `Assinando o PDF ${g + 1} de ${groups.length}…`);
        bytes = await signer.sign(chosen, new Date(), { password, pdfa, stamp, fonts });
      } else if (password) {
        announce(groups.length === 1 ? 'Protegendo o PDF com a senha…' : `Protegendo o PDF ${g + 1} de ${groups.length} com a senha…`);
        bytes = (await crypt.protectPdf(bytes, password)).bytes;
      }
      const name = groups.length === 1 ? `${base}.pdf` : groupFileName(base, group, list.length);
      files.push({ file: new File([bytes], name, { type: 'application/pdf' }), before });
    }
    state.output = files.map(({ file, before }) => ({ file, before, url: URL.createObjectURL(file) }));
    showResult(groups, signer, !!password, pdfa);
    if (password) els.protectPassword.value = els.protectConfirm.value = ''; // a senha não fica nos campos
    const what = signer ? (files.length === 1 ? 'PDF assinado.' : `${files.length} PDFs assinados.`) : (files.length === 1 ? 'PDF pronto.' : `${files.length} PDFs prontos.`);
    const ready = `${what} ${files.length === 1 ? 'Ele só existe' : 'Eles só existem'} aqui no seu aparelho até você baixar.`;
    const kept = !notSmaller ? '' : notSmaller === files.length && files.length === 1
      ? ' Comprimir não diminuiu este PDF (o tamanho está no texto e nas fontes, ou as imagens já eram leves): ficou sem recomprimir.'
      : ` ${notSmaller === 1 ? 'Um arquivo não diminuiu' : `${notSmaller} arquivos não diminuíram`} com a compressão e ${notSmaller === 1 ? 'ficou' : 'ficaram'} sem recomprimir.`;
    // Páginas lidas pelo OCR: as fotos e as de PDF que não tinham texto (as escaneadas).
    const scanned = list.filter((page) => isPhoto(page) || (page.kind === 'pdf' && !page.ocr?.hasText));
    const readKind = scanned.every(isPhoto) ? 'fotos' : 'páginas';
    const blank = useOcr ? scanned.filter((page) => !page.ocr?.words.length).length : 0;
    const withText = useOcr ? list.filter((page) => page.kind === 'pdf' && page.ocr?.hasText).length : 0;
    // Confiança baixa (ocr.js): o Tesseract deu nota baixa a boa parte do texto da página. Numeradas como na lista.
    // O módulo do OCR já está carregado (foi ele que leu as palavras); se falhar, a mensagem só sai sem o aviso.
    const { lowConfidence } = useOcr && scanned.some((page) => page.ocr?.words.length) ? await loadOcr().catch(() => ({})) : {};
    const doubtful = !lowConfidence ? [] : list
      .map((page, i) => (scanned.includes(page) && page.ocr?.words.length && lowConfidence(page.ocr.words) ? i + 1 : 0))
      .filter(Boolean);
    const where = doubtful.length === 1 ? `Na página ${doubtful[0]}` : `Nas páginas ${doubtful.slice(0, -1).join(', ')} e ${doubtful.at(-1)}`;
    const cause = doubtful.every((n) => isPhoto(list[n - 1])) ? 'foto tremida, escura, deitada ou com letra pequena' : 'imagem borrada, apagada, deitada ou com letra pequena';
    const unsure = !doubtful.length ? '' : ` ${where}, parte do texto pode ter saído errada (${cause}): confira antes de confiar na busca.`;
    const read = (!useOcr || !scanned.length ? '' : blank === 0
      ? ` O texto ${readKind === 'fotos' ? 'das fotos' : 'das páginas escaneadas'} foi reconhecido: dá para buscar e copiar no PDF.`
      : ` Não achei texto impresso em ${blank === 1 ? `uma das ${readKind}` : `${blank} das ${readKind}`}.`)
      + unsure
      + (!withText ? '' : withText === 1 ? ' Uma página de PDF já tinha texto e ficou como estava.' : ` ${withText} páginas de PDF já tinham texto e ficaram como estavam.`);
    const locked = !password ? '' : files.length === 1
      ? ' Ele só abre com a senha que você escolheu.'
      : ' Eles só abrem com a senha que você escolheu.';
    const redacted = list.filter((page) => page.redactions?.length);
    const rasterized = list.map((page, i) => (page.kind === 'pdf' && page.redactions?.length ? i + 1 : 0)).filter(Boolean);
    // Com o OCR, a página tarjada que virou imagem ganha o texto reconhecido (sem o que estava sob as tarjas).
    const asImage = useOcr ? 'o texto vem do OCR, sem o que estava sob as tarjas' : null;
    const covered = !redacted.length ? '' : ` Tarjas conferidas: não sobrou texto embaixo delas.${!rasterized.length ? '' : rasterized.length === 1
      ? ` A página ${rasterized[0]}, de PDF, saiu como imagem: ${asImage ?? 'o texto dela não fica selecionável'}.`
      : ` As páginas ${rasterized.join(', ')}, de PDF, saíram como imagem: ${asImage ?? 'o texto delas não fica selecionável'}.`}`;
    announce(ready + locked + covered + kept + read, 'success');
    ok = true;
  } catch (err) {
    if (cancelled || err instanceof Cancelled) {
      announce('Cancelado. Nenhum PDF foi gerado.');
    } else {
      // Erros do OCR e da assinatura já vêm com a explicação; os outros, com a mensagem técnica.
      const known = ['SignError', 'OcrError', 'RedactionError', 'FontError'].includes(err?.name);
      if (!known) console.error(err);
      announce(known ? err.message : `Algo deu errado ao gerar o PDF: ${err.message}`, 'error');
    }
  } finally {
    finished = true; // motor que ainda estiver ligando é encerrado assim que ligar
    ocr?.terminate();
    signer?.discard(); // a chave sai da memória, dê certo ou não
    state.cancel = null;
    els.cancel.hidden = true;
    els.cancel.disabled = false;
    setBusy(false);
    // Foco só depois de liberar os controles (controle desabilitado não recebe foco).
    if (!ok) (signer ? els.sign : els.generate).focus();
    else (state.output.length === 1 ? els.download : els.downloadAll).focus();
  }
}

// Imagem de uma foto para o OCR. A imagem do PDF serve quando já tem resolução boa para o OCR; senão, a foto é
// desenhada de novo, maior, só para isso (ou reduzida, acima do limite). A cópia, quando há, quem chama libera.
async function ocrImage(image, canvas, page) {
  const long = Math.max(canvas.width, canvas.height);
  if (long < OCR_MIN_SIDE && Math.max(image.width, image.height) > long) {
    return renderPageAsync(image.source, image.width, image.height, {
      rotation: page.rotation, filter: page.filter, quad: page.quad, maxSide: OCR_SIDE, redactions: page.redactions,
    });
  }
  if (long <= OCR_MAX_SIDE) return canvas;
  const scale = OCR_MAX_SIDE / long;
  const temporary = document.createElement('canvas');
  temporary.width = Math.max(1, Math.round(canvas.width * scale));
  temporary.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = temporary.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, temporary.width, temporary.height);
  return temporary;
}

els.cancel.addEventListener('click', () => state.cancel?.());

const redactionError = (message) => Object.assign(new Error(message), { name: 'RedactionError' });
const ocrError = (message) => Object.assign(new Error(message), { name: 'OcrError' });
const fontError = () => Object.assign(new Error('Não deu para carregar as fontes do PDF/A. Confira a conexão e tente de novo.'), { name: 'FontError' });

// Página de PDF: a que já tem texto (o PDF.js acha texto nela) fica como está; a escaneada, só com imagem, é
// desenhada pelo PDF.js na resolução do OCR e lida como aparece no app (com o /Rotate dela e o giro escolhido).
// Página tarjada vira imagem: é lida sempre, com as tarjas pintadas, e o que o OCR achar sob uma tarja sai.
// @returns {Promise<{words: object[], hasText: boolean}>} words: medidas na página como aparece no app
async function recognizePdfPage(engine, page) {
  const scan = await readPdfPage(engine, page);
  return scan.hasText ? { words: [], hasText: true } : { words: await scan.words, hasText: false };
}

// O mesmo, sem esperar a leitura: volta assim que o OCR copiou os pixels, com a leitura em andamento.
// @param {(page: object) => Promise<object>} engine devolve o motor do OCR quando é a vez da página
// @returns {Promise<{hasText: true} | {hasText: false, words: Promise<object[]>}>}
async function readPdfPage(engine, page) {
  const tools = await loadPdfTools();
  const number = state.pages.indexOf(page) + 1;
  const redacted = !!page.redactions?.length;
  if (!redacted) {
    const { items } = await tools.pdfPageTextItems(page.doc, page.index).catch(() => {
      throw ocrError(`Não deu para ler a página ${number} (do PDF ${page.name}) para reconhecer o texto. Confira a conexão e tente de novo.`);
    });
    if (items.length) return { hasText: true };
  }
  const { canvas, real } = await tools.drawPdfPage(page.doc, { index: page.index, ...page.size }, {
    maxSide: OCR_SIDE, rotation: page.rotation, number: page.number,
  });
  try {
    if (!real) throw ocrError(`Não deu para desenhar a página ${number} (do PDF ${page.name}) para reconhecer o texto. Confira a conexão e tente de novo.`);
    if (redacted) paintRedactions(canvas.getContext('2d'), page.redactions, canvas.width, canvas.height);
    // Resolução do desenho, em pontos por polegada: a largura da página como aparece, em pontos.
    const width = page.rotation % 180 !== 0 ? page.size.height : page.size.width;
    const reader = await engine(page);
    const words = reader.recognize(canvas, { dpi: canvas.width / (width / 72) })
      .then((list) => (redacted ? filterWords(list, page.redactions) : list));
    words.catch(() => {}); // a falha aparece para quem espera a leitura
    return { hasText: false, words };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// Palavras do OCR das páginas escaneadas de um PDF da lista (sem tarja: as tarjadas viram imagem), por página, com
// o giro do app em que foram lidas.
function scannedWords(list, doc) {
  return new Map(list.filter((page) => page.kind === 'pdf' && page.doc === doc && !page.redactions?.length && page.ocr?.words.length)
    .map((page) => [page.index, { words: page.ocr.words, rotation: page.rotation }]));
}

// Página de PDF com tarja: desenhada pelo PDF.js na qualidade escolhida, com os pixels sob as tarjas pintados,
// e entra no PDF como foto. Sem o desenho de verdade (só o cartão), não dá para tarjar: nada sai.
async function rasterizePdfPage(page, quality) {
  const tools = await loadPdfTools();
  const { canvas, real } = await tools.drawPdfPage(page.doc, { index: page.index, ...page.size }, {
    maxSide: quality.maxSide, rotation: page.rotation, number: page.number,
  });
  try {
    if (!real) throw redactionError(`Não deu para desenhar a página ${state.pages.indexOf(page) + 1} (do PDF ${page.name}) para tarjar: o PDF não foi gerado.`);
    paintRedactions(canvas.getContext('2d'), page.redactions, canvas.width, canvas.height);
    const jpeg = new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', quality.jpeg)).arrayBuffer());
    const sideways = page.rotation % 180 !== 0;
    const width = sideways ? page.size.height : page.size.width;
    const height = sideways ? page.size.width : page.size.height;
    return { jpeg, width, height, box: { x: 0, y: 0, w: width, h: height } };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// Página do Word com tarja: o texto embaixo sai (redact.js), e as imagens embaixo têm os pixels pintados.
async function redactDocumentPage(page) {
  const { items, images } = redactLayout(page.layout, toUnrotated(page.redactions, page.rotation));
  for (const { item, areas } of images) {
    const bitmap = await createImageBitmap(new Blob([item.jpeg], { type: 'image/jpeg' }), { imageOrientation: 'none' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    paintRedactions(ctx, areas, canvas.width, canvas.height);
    item.jpeg = new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
    canvas.width = canvas.height = 0;
  }
  return { ...page.layout, items, rotation: page.rotation };
}

/**
 * Conferência das tarjas no PDF montado: o PDF.js lê o texto das páginas tarjadas, e nada pode estar sob uma
 * tarja. Sem o PDF.js (sem rede e sem cache), não dá para conferir, e o PDF também não sai.
 * @param {object[]} sources as páginas da lista, na ordem do arquivo
 * @param {object[]} built as páginas que foram para o buildPdf (para a posição da imagem nas fotos)
 */
async function checkRedactions(bytes, sources, built, file, files) {
  const checks = sources.map((page, n) => [n, page]).filter(([, page]) => page.redactions?.length);
  if (!checks.length) return;
  announce(files === 1 ? 'Conferindo as tarjas…' : `Conferindo as tarjas do PDF ${file} de ${files}…`);
  let texts;
  try {
    texts = await (await loadPdfTools()).pdfTextBoxes(bytes, checks.map(([n]) => n));
  } catch {
    throw redactionError('Não deu para conferir as tarjas (o leitor de PDF não carregou). Confira a conexão e tente de novo: o PDF não foi gerado.');
  }
  for (const [n, page] of checks) {
    // Foto e página de PDF tarjada: as tarjas ficam na imagem, que fica dentro da página (com margem).
    const { box, width, height } = built[n];
    const rects = !box ? page.redactions : page.redactions.map((rect) => ({
      x0: (box.x + rect.x0 * box.w) / width, x1: (box.x + rect.x1 * box.w) / width,
      y0: (height - box.y - box.h + rect.y0 * box.h) / height, y1: (height - box.y - box.h + rect.y1 * box.h) / height,
    }));
    if (textUnderRedactions(texts.get(n) ?? [], rects).length) {
      throw redactionError(`A conferência achou texto sob uma tarja na página ${state.pages.indexOf(page) + 1}: o PDF não foi gerado. Avise a gente, por favor.`);
    }
  }
}

// "1,2 MB" ou, quando comprimiu, "1,2 MB (antes 4,8 MB, −75%)".
function sizeText(size, before) {
  if (!before) return formatBytes(size);
  return `${formatBytes(size)} (antes ${formatBytes(before)}, −${Math.round((1 - size / before) * 100)}%)`;
}

function showResult(groups, signer, locked, pdfa) {
  const files = state.output;
  const total = files.reduce((sum, { file }) => sum + file.size, 0);
  const totalBefore = files.some(({ before }) => before) ? files.reduce((sum, { file, before }) => sum + (before ?? file.size), 0) : null;
  const pages = (n) => `${n} ${n === 1 ? 'página' : 'páginas'}`;
  const single = files.length === 1;
  els.resultTitle.textContent = signer
    ? (single ? 'PDF assinado' : `${files.length} PDFs assinados`)
    : (single ? 'PDF pronto' : `${files.length} PDFs prontos`);
  const signed = signer ? ` · ${single ? 'assinado' : 'assinados'} por ${signer.name}` : '';
  const withPassword = locked ? ' · com senha' : '';
  const archive = pdfa ? ' · PDF/A-2b' : '';
  els.resultInfo.textContent = single
    ? `${files[0].file.name} · ${pages(groups[0].length)} · ${sizeText(total, files[0].before)}${signed}${withPassword}${archive}`
    : `${sizeText(total, totalBefore)} no total${signed}${withPassword}${archive}`;
  els.download.hidden = !single;
  els.download.href = files[0].url;
  els.download.download = files[0].file.name;
  els.downloadAll.hidden = single;
  els.resultFiles.hidden = single;
  els.resultFiles.replaceChildren(...(single ? [] : files.map(({ file, url, before }, i) => el('li', {}, [
    el('a', { href: url, download: file.name, textContent: file.name }),
    el('span', { className: 'muted', textContent: ` · ${pages(groups[i].length)} · ${sizeText(file.size, before)}` }),
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
  drawAllPagesPreview(); // a primeira página do primeiro arquivo pode ter mudado
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
els.pdfCompress.addEventListener('change', () => {
  state.compressChosen = true;
  discardPdf();
  updateCompressTip();
});

// ---------- Aviso de PDF pesado ----------
// Aparece sozinho quando a lista tem um PDF pesado por causa de imagens. Diz o que está acontecendo
// (comprimindo ou não) e troca com um toque, sem precisar achar a opção.

function updateCompressTip() {
  const heavy = [...new Set(state.pages.filter((page) => page.kind === 'pdf' && page.doc.heavy).map((page) => page.doc))];
  els.compressTip.hidden = !heavy.length;
  if (!heavy.length) return;
  const size = formatBytes(heavy.reduce((sum, doc) => sum + doc.size, 0));
  const on = els.pdfCompress.value !== 'none';
  const what = heavy.length === 1 ? `Este PDF é pesado (${size})` : `Estes PDFs são pesados (${size} ao todo)`;
  els.compressTipText.replaceChildren(el('strong', { textContent: `${what}.` }), on
    ? ' As imagens vão ser comprimidas: o arquivo novo fica bem menor, bom para WhatsApp e e-mail.'
    : ' Comprimir as imagens deixa o arquivo bem menor, bom para WhatsApp e e-mail.');
  els.compressTipToggle.textContent = on ? 'Manter o original' : 'Comprimir';
  els.compressTip.classList.toggle('tip-on', on);
}

els.compressTipToggle.addEventListener('click', () => {
  els.pdfCompress.value = els.pdfCompress.value === 'none' ? 'light' : 'none';
  state.compressChosen = true;
  discardPdf();
  updateCompressTip();
  announce(els.pdfCompress.value === 'none' ? 'Compressão desligada: as imagens vão como estão.' : 'Compressão ligada.');
  els.compressTipToggle.focus();
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

// ---------- Procurar dados para tarjar ----------
// Lê o texto de cada página (Word: o layout; PDF: o PDF.js; foto: o OCR, que roda na hora se precisar), acha
// CPF, CNPJ, e-mail, telefone, CEP e cartão (find-data.js) e mostra numa janela. Só vira tarja o que a pessoa
// deixar marcado. Os dados achados só existem na memória e na janela, e nada vai para o console.

let findings = null; // enquanto a janela está aberta: [{page, index, type, value, rects}]

// Posição de cada caractere de um trecho (de x0 a x1), pela largura das letras numa fonte parecida: no PDF e na
// foto, só se sabe onde o trecho começa e termina.
const measureContext = document.createElement('canvas').getContext('2d');
function charPositions(text, x0, x1, family = 'sans-serif') {
  measureContext.font = `100px ${family}`;
  const widths = [...text].flatMap((char) => {
    const width = measureContext.measureText(char).width;
    return char.length === 2 ? [width, 0] : [width]; // caractere fora do BMP ocupa duas posições na string
  });
  const total = widths.reduce((sum, width) => sum + width, 0) || 1;
  const xs = [x0];
  let acc = 0;
  for (const width of widths) {
    acc += width;
    xs.push(x0 + ((x1 - x0) * acc) / total);
  }
  return xs;
}

// Palavras do OCR (foto e PDF escaneado) → dados achados, com a área da tarja. Na página torta, a busca usa as
// medidas da imagem endireitada (straight, ocr.js), onde as linhas são retas, e a área volta para a imagem torta
// como a caixa reta que a envolve: a tarja fica maior que o dado, mas cobre tudo.
function findInWords(words, size) {
  const angle = words.find((word) => word.angle)?.angle ?? 0;
  let line = 0; // a linha que o OCR leu (a última palavra dela tem last)
  const pieces = words.map((word) => {
    const at = word.angle ? word.straight : word;
    const piece = { str: word.text, xs: charPositions(word.text, at.x0, at.x1), y0: at.y0, y1: at.y1, line };
    if (word.last) line++;
    return piece;
  });
  return findInPieces(pieces, size).map((found) => ({ ...found, rect: unskewRect(padRect(found.rect, size, 0.3), angle, size) }));
}

// Word: a posição exata de cada letra sai das larguras das fontes padrão (as mesmas do PDF).
function findInDocument(page) {
  const { width, height, items } = page.layout;
  const pieces = items.filter((item) => item.type === 'text').map((item) => {
    const xs = [item.x / width];
    let x = item.x;
    for (let k = 0; k < item.text.length; k++) {
      const char = item.text[k];
      x += textWidth(char, item.font, item.size) + (char === ' ' ? item.wordSpacing ?? 0 : 0);
      xs.push(x / width);
    }
    const baseline = item.y - (item.rise ?? 0);
    return { str: item.text, xs, y0: (baseline - item.size * 0.85) / height, y1: (baseline + item.size * 0.25) / height };
  });
  return findInPieces(pieces, { width, height }).map((found) => ({ ...found, rect: toRotatedRects([found.rect], page.rotation)[0] }));
}

async function findInPdfPage(page, startEngine) {
  const tools = await loadPdfTools();
  const { items, width, height } = await tools.pdfPageTextItems(page.doc, page.index);
  if (!items.length) return findInScannedPage(page, startEngine, { width, height });
  const pieces = items.map((item) => ({ str: item.str, xs: charPositions(item.str, item.x0, item.x1, item.family), y0: item.y0, y1: item.y1 }));
  // A posição de cada letra é estimada: a tarja ganha uma margem maior.
  return findInPieces(pieces, { width, height })
    .map((found) => ({ ...found, rect: toRotatedRects([padRect(found.rect, { width, height }, 0.3)], page.rotation)[0] }));
}

// Página de PDF escaneada (sem texto): lida pelo OCR como aparece no app, como as fotos, e o resultado fica
// guardado para gerar o PDF. As caixas já saem na página como aparece, que é onde as tarjas são marcadas.
async function findInScannedPage(page, startEngine, { width, height }) {
  await ensureOcr(page, startEngine);
  const size = page.rotation % 180 !== 0 ? { width: height, height: width } : { width, height };
  return findInWords(page.ocr.words, size);
}

// Texto do OCR da foto ou da página de PDF com o recorte, o filtro, o giro e as tarjas de agora (ocrKey). Sem ele,
// o reconhecimento roda agora e fica guardado em page.ocr: gerar o PDF depois não lê de novo. Usado pela busca de
// dados e pelo "Copiar texto" da tela cheia.
async function ensureOcr(page, startEngine) {
  const key = ocrKey(page);
  if (page.ocr?.key !== key) {
    page.ocr = { key, ...(page.kind === 'pdf' ? await recognizePdfPage(startEngine, page) : await recognizePhoto(page, startEngine)) };
  }
  return page.ocr;
}

// Foto: desenhada na resolução do OCR, já tarjada, e lida; o que o OCR achar sobre uma tarja também sai.
async function recognizePhoto(page, startEngine) {
  const ocr = await startEngine();
  const image = await decodeFile(page.file);
  let canvas;
  try {
    canvas = await renderPageAsync(image.source, image.width, image.height, {
      rotation: page.rotation, filter: page.filter, quad: page.quad, maxSide: OCR_SIDE, redactions: page.redactions,
    });
  } finally {
    image.release();
  }
  try {
    // Sem a página do PDF ainda, a resolução é estimada como a de uma folha A4.
    const words = await ocr.recognize(canvas, { dpi: Math.max(canvas.width, canvas.height) / 11.69 });
    return { words: filterWords(words, page.redactions), size: { width: canvas.width, height: canvas.height } };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// Foto: o texto do OCR (já tarjado). Sem ele, o reconhecimento roda agora e fica guardado para gerar o PDF.
async function findInPhoto(page, startEngine) {
  await ensureOcr(page, startEngine);
  const size = page.ocr.size ?? { width: 1, height: 1.414 };
  return findInWords(page.ocr.words, size);
}

const inside = (outer, inner) => inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;

async function findData() {
  if (!state.pages.length || state.busy) return;
  setBusy(true, 'Procurando…');
  const list = [...state.pages];
  const toRead = list.filter((page) => isPhoto(page) && page.ocr?.key !== ocrKey(page));
  let ocr = null;
  let cancelled = false;
  // Páginas de PDF sem texto (escaneadas) também passam pelo OCR: com elas na lista, dá para cancelar.
  if (toRead.length || list.some((page) => page.kind === 'pdf' && page.ocr?.key !== ocrKey(page))) {
    els.cancel.hidden = false;
    state.cancel = () => {
      cancelled = true;
      els.cancel.disabled = true;
      ocr?.cancel();
    };
  }
  const startEngine = async () => {
    if (ocr) return ocr;
    announce('Preparando o reconhecimento de texto (na primeira vez, o app baixa uns 5 MB)…');
    const { startOcr } = await loadOcr().catch(() => {
      throw Object.assign(new Error('Não deu para carregar o reconhecimento de texto. Confira a conexão e tente de novo.'), { name: 'OcrError' });
    });
    if (cancelled) throw new Cancelled();
    ocr = await startOcr();
    return ocr;
  };
  const groups = new Map();
  const unreadable = [];
  let spent = 0; // tempo das fotos já lidas: base da estimativa do tempo que falta
  let done = 0;
  let ok = false;
  try {
    for (const [i, page] of list.entries()) {
      if (cancelled) throw new Cancelled();
      const reading = toRead.includes(page);
      announce(reading
        ? `Reconhecendo o texto da foto ${toRead.indexOf(page) + 1} de ${toRead.length} para procurar dados…${progressNote(spent, done, toRead.length)}`
        : `Procurando dados na página ${i + 1} de ${list.length}…`);
      await nextFrame();
      const start = performance.now();
      let found;
      try {
        found = isDocument(page) ? findInDocument(page) : page.kind === 'pdf' ? await findInPdfPage(page, startEngine) : await findInPhoto(page, startEngine);
        if (reading) {
          spent += performance.now() - start;
          done++;
        }
      } catch (err) {
        if (cancelled || err instanceof Cancelled || err?.name === 'OcrCancelled' || err?.name === 'OcrError') throw err;
        unreadable.push(i + 1); // ex.: página de PDF que o PDF.js não consegue ler
        continue;
      }
      for (const { type, value, rect } of found) {
        if ((page.redactions ?? []).some((existing) => inside(existing, rect))) continue; // já tarjado
        const key = `${i}|${type}|${value}`;
        if (!groups.has(key)) groups.set(key, { page, index: i, type, value, rects: [] });
        groups.get(key).rects.push(rect);
      }
    }
    ok = true;
  } catch (err) {
    if (cancelled || err instanceof Cancelled || err?.name === 'OcrCancelled') announce('Busca cancelada.');
    else announce(err?.name === 'OcrError' ? err.message : 'Não deu para procurar os dados. Tente de novo.', 'error');
  } finally {
    ocr?.terminate();
    state.cancel = null;
    els.cancel.hidden = true;
    els.cancel.disabled = false;
    setBusy(false);
  }
  if (!ok) {
    els.findData.focus();
    return;
  }
  const missed = !unreadable.length ? '' : ` Não deu para ler o texto ${unreadable.length === 1 ? `da página ${unreadable[0]}` : `das páginas ${unreadable.join(', ')}`}.`;
  if (!groups.size) {
    announce(`Não achei CPF, CNPJ, e-mail, telefone, CEP nem cartão no texto das páginas.${missed}`);
    els.findData.focus();
    return;
  }
  showFindings([...groups.values()], missed);
}

function showFindings(list, missed) {
  findings = list;
  const pages = new Set(list.map(({ index }) => index)).size;
  els.findSummary.textContent = `${list.length === 1 ? '1 dado' : `${list.length} dados`} em ${pages === 1 ? '1 página' : `${pages} páginas`}. Desmarque o que não precisa ser tarjado.${missed}`;
  const byPage = new Map();
  list.forEach((found, i) => {
    if (!byPage.has(found.index)) byPage.set(found.index, []);
    byPage.get(found.index).push(el('label', { className: 'check' }, [
      el('input', { type: 'checkbox', checked: true, 'data-key': i }),
      el('span', { textContent: `${TYPE_LABELS[found.type]}: ${found.value}${found.rects.length > 1 ? ` (${found.rects.length} vezes)` : ''}` }),
    ]));
  });
  els.findList.replaceChildren(...[...byPage].map(([index, rows]) => el('fieldset', { className: 'find-page' }, [
    el('legend', { textContent: `Página ${index + 1}` }), ...rows,
  ])));
  updateFindApply();
  announce(`${list.length === 1 ? '1 dado encontrado' : `${list.length} dados encontrados`}: confira na janela o que vai ser tarjado.`);
  els.findDialog.showModal();
  els.findApply.focus();
}

function updateFindApply() {
  const count = els.findList.querySelectorAll('input:checked').length;
  els.findApply.disabled = !count;
  els.findApply.textContent = count === 0 ? 'Tarjar os marcados' : count === 1 ? 'Tarjar 1 dado' : `Tarjar ${count} dados`;
}

els.findData.addEventListener('click', findData);
els.findList.addEventListener('change', updateFindApply);
els.findCancel.addEventListener('click', () => {
  els.findDialog.close();
  announce('Nenhuma tarja adicionada.');
});
// A lista (com os dados) sai da página ao fechar a janela.
els.findDialog.addEventListener('close', () => {
  findings = null;
  els.findList.replaceChildren();
  els.findSummary.textContent = '';
});
els.findApply.addEventListener('click', async () => {
  const chosen = (findings ?? []).filter((_, i) => els.findList.querySelector(`input[data-key="${i}"]`)?.checked);
  els.findDialog.close();
  if (!chosen.length) return;
  const touched = new Set();
  for (const { page, rects } of chosen) {
    const valid = isPhoto(page) && page.ocr?.key === ocrKey(page);
    page.redactions = [...(page.redactions ?? []), ...rects];
    // Foto: o texto do OCR continua valendo, sem o que ficou sob as tarjas novas, e não precisa reconhecer de novo.
    // Página de PDF tarjada vira imagem (já girada): o texto é lido de novo nela.
    if (valid) page.ocr = { ...page.ocr, key: ocrKey(page), words: filterWords(page.ocr.words, page.redactions) };
    touched.add(page);
  }
  discardPdf();
  for (const page of touched) await refreshThumb(page);
  renderPages();
  const total = chosen.reduce((sum, { rects }) => sum + rects.length, 0);
  announce(`${total === 1 ? '1 tarja adicionada' : `${total} tarjas adicionadas`} em ${touched.size === 1 ? '1 página' : `${touched.size} páginas`}. Confira em tela cheia: dá para ajustar ou remover cada uma.`);
  els.findData.focus();
});

// ---------- Copiar o texto da página (tela cheia) ----------
// O texto sai como a página vai para o PDF: Word, pelo layout (sem o que está sob as tarjas); PDF com texto, pelo
// PDF.js; foto, página escaneada e página de PDF tarjada (que vira imagem), pelo OCR, que roda agora se precisar e
// fica guardado para gerar o PDF. A área de transferência fica com a tela cheia (viewer.js). O texto só passa pela
// memória: nada no console.

const copyError = (message) => Object.assign(new Error(message), { name: 'CopyError' });
let copyDone = Promise.resolve(); // fim da cópia anterior, com o motor dela já fora da memória
const COPY_WAIT_MS = 20000; // quanto, no máximo, uma cópia espera o motor da anterior (cancelada) desligar

/**
 * @param {object} page
 * @param {{signal: AbortSignal, progress: (message: string) => void}} options signal: fechar a tela ou trocar de
 *   página cancela o OCR; progress: aviso de andamento na tela cheia
 * @returns {Promise<string>} o texto, nunca vazio (sem texto, dá erro CopyError com a explicação)
 */
async function pageText(page, { signal, progress }) {
  if (isDocument(page)) {
    const text = documentText(page.layout, page.redactions?.length ? toUnrotated(page.redactions, page.rotation) : []);
    if (!text) throw copyError('Esta página não tem texto.');
    return text;
  }
  const previous = copyDone;
  let finish;
  copyDone = new Promise((resolve) => { finish = resolve; });
  let ocr = null;
  const cancel = () => ocr?.cancel();
  signal.addEventListener('abort', cancel);
  const aborted = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  const startEngine = async () => {
    if (ocr) return ocr;
    progress('Reconhecendo o texto desta página (na primeira vez, o app baixa uns 5 MB). Fechar a tela cancela.');
    // Um motor por vez na memória: espera o da cópia anterior (cancelada) desligar, mas não para sempre.
    await Promise.race([previous, aborted, new Promise((resolve) => setTimeout(resolve, COPY_WAIT_MS))]);
    if (signal.aborted) throw new Cancelled();
    const { startOcr } = await loadOcr().catch(() => {
      throw ocrError('Não deu para carregar o reconhecimento de texto. Confira a conexão e tente de novo.');
    });
    if (signal.aborted) throw new Cancelled();
    ocr = await startOcr();
    if (signal.aborted) throw new Cancelled();
    return ocr;
  };
  try {
    const { words, hasText } = await ensureOcr(page, startEngine).catch((err) => {
      // PDF que o PDF.js não leu: o título da tela cheia já diz qual é a página, e o aviso curto cabe na dica.
      if (err?.name === 'OcrError' && /\(do PDF /.test(err.message)) {
        throw copyError('Não deu para ler esta página para reconhecer o texto. Confira a conexão e tente de novo.');
      }
      throw err;
    });
    // Página de PDF com texto (e sem tarja: a tarjada é sempre lida pelo OCR): o texto do próprio PDF.
    if (hasText && !page.redactions?.length) {
      const tools = await loadPdfTools();
      const { items, width, height } = await tools.pdfPageTextItems(page.doc, page.index).catch(() => {
        throw copyError('Não deu para ler o texto desta página. Confira a conexão e tente de novo.');
      });
      const text = linesText(items, { width, height });
      if (!text) throw copyError('Esta página não tem texto.');
      return text;
    }
    const text = plainText(words);
    if (!text) throw copyError('Não achei texto impresso nesta página.');
    return text;
  } finally {
    signal.removeEventListener('abort', cancel);
    ocr?.terminate(); // o motor ocupa centenas de MB: sai da memória no fim, dê certo ou não
    finish();
  }
}

// ---------- Assinar com certificado digital (A1) ----------
// Dois passos na mesma janela: escolher o .pfx e digitar a senha; depois, conferir titular e validade e confirmar.
// A senha sai do campo assim que é usada, o arquivo é zerado depois de lido, e a chave (já no Web Crypto,
// sem como ser lida de volta) é descartada ao fechar a janela ou ao terminar a assinatura.

// append: o PDF da lista, quando ele é assinado sem reescrever; locked: o motivo, quando o PDF foi certificado sem
// permitir alterações (aí não dá para assinar).
const signing = { file: null, signer: null, append: null, locked: '' };

function signStatus(message, kind = 'info') {
  els.signStatus.textContent = message;
  els.signStatus.dataset.kind = kind;
}

function resetSigning() {
  signing.signer?.discard();
  signing.signer = null;
  signing.file = null;
  signing.append = null;
  signing.locked = '';
  els.signFile.value = '';
  els.signPassword.value = '';
  els.signFileName.textContent = 'Nenhum arquivo escolhido';
  els.signStepOpen.hidden = false;
  els.signStepConfirm.hidden = true;
  els.signNext.textContent = 'Abrir o certificado';
  els.signNext.disabled = false;
  els.signNext.hidden = false;
  els.stamp.checked = false;
  els.stampOptions.hidden = true;
  signStatus('');
}

// Assinar sem reescrever: a lista é um PDF só, inteiro e na ordem, e nada do que foi escolhido muda o arquivo (giro,
// tarja, edição, valor no formulário, compressão, OCR, senha, dividir, "em todas as páginas"): unchangedSource, em
// pdf-append.js. Aí a assinatura entra no fim do arquivo, e as que ele já tinha continuam valendo. O PDF/A não vale
// para páginas de PDF.
async function unchangedPdf() {
  if (state.pages[0]?.kind !== 'pdf') return null;
  const { unchangedSource } = await loadAppend();
  let groups = null;
  try {
    groups = outputGroups(state.pages.length);
  } catch {
    // intervalos inválidos: o PDF não sai como veio
  }
  const changes = els.pdfCompress.value !== 'none' || els.protect.checked || els.ocr.checked || allPages.active();
  return unchangedSource(state.pages, { changes, groups });
}

// Passo 2 da janela: como a assinatura entra (PDF novo ou o PDF como veio) e se o carimbo pode ser usado.
async function prepareSignOptions() {
  const doc = await unchangedPdf();
  let blocker = null;
  let certified = false;
  if (doc) {
    const { appendBlocker, changePermission } = await loadAppend();
    blocker = appendBlocker(doc);
    certified = !blocker && changePermission(doc) !== null;
  }
  signing.append = doc && !blocker ? doc : null;
  signing.locked = blocker?.kind === 'locked' ? blocker.message : '';
  // PDF certificado sem permitir alterações: só o motivo (em sign-status, como erro) e o botão de cancelar.
  els.stampField.hidden = !!signing.locked;
  els.signNext.hidden = !!signing.locked;
  const signedSources = new Set(state.pages.filter((page) => page.kind === 'pdf' && page.doc.isSigned()).map((page) => page.doc));
  let mode = '';
  if (signing.locked) mode = '';
  else if (blocker) mode = blocker.message;
  else if (signing.append) {
    mode = doc.isSigned()
      ? 'Este PDF já tem assinatura. A sua entra no fim do arquivo, e as que ele tem continuam valendo. O PDF segue exatamente como veio, com o que ele tiver dentro (metadados, links, campos).'
      : 'O PDF segue exatamente como veio, com o que ele tiver dentro (metadados, links, campos): a sua assinatura entra no fim do arquivo, sem mudar nada nele.';
  } else if (signedSources.size) {
    // Edição ou valor do formulário fixo na página (ou em todas as páginas) muda o conteúdo: o aviso diz isso primeiro.
    // Certificado pelo autor: a certificação também deixa de valer.
    const { changePermission } = await loadAppend();
    const what = [...signedSources].some((source) => changePermission(source) !== null)
      ? 'a certificação e as assinaturas que ele já tinha deixam'
      : 'as assinaturas que ele já tinha deixam';
    const edited = state.pages.some((page) => page.edits?.length) || allPages.active();
    const filled = [...signedSources].some((source) => source.form?.hasValues());
    mode = edited || filled
      ? `${edited && filled ? 'As edições e os valores do formulário ficam fixos' : edited ? 'As edições ficam fixas' : 'Os valores do formulário ficam fixos'} nas páginas: o PDF vai ser montado de novo, e ${what} de valer. Para manter, assine o PDF sozinho, sem ${edited && filled ? 'editar, preencher' : edited ? 'editar' : 'preencher'} nem mudar nada nele.`
      : `O PDF vai ser montado de novo, e ${what} de valer. Para manter, assine o PDF sozinho, sem mudar nada nele (sem juntar, girar, tarjar, editar, preencher, comprimir nem ligar o OCR).`;
  }
  els.signMode.hidden = !mode;
  els.signMode.firstElementChild.textContent = mode;

  // Com o PDF/A, o carimbo vai com as fontes embutidas (pdfa-fonts.js), como as páginas de Word.
  const reason = signing.locked ? ''
    : certified ? 'Indisponível neste PDF: ele foi certificado pelo autor, e um carimbo novo pode invalidar a certificação em alguns validadores. A assinatura entra sem carimbo.'
    : '';
  els.stamp.checked = false;
  els.stamp.disabled = !!signing.locked || !!reason;
  els.stampBlocked.hidden = !reason;
  els.stampBlocked.textContent = reason;
  els.stampOptions.hidden = true;
  fillStampPages();
}

// Páginas do arquivo que recebe o carimbo (o primeiro, quando são vários) e se são vários arquivos.
function stampTarget() {
  if (signing.append) return { pages: state.pages, many: false };
  const groups = outputGroups(state.pages.length);
  return { pages: groups[0].map((i) => state.pages[i]), many: groups.length > 1 };
}

function fillStampPages() {
  const { pages, many } = stampTarget();
  const count = pages.length;
  const options = count === 1
    ? [['last', 'Página 1']]
    : [['last', many ? 'Última página de cada arquivo' : 'Última página'], ['first', many ? 'Primeira página de cada arquivo' : 'Primeira página']];
  if (!many) for (let n = 2; n < count && n <= 500; n++) options.push([String(n), `Página ${n}`]);
  els.stampPage.replaceChildren(...options.map(([value, text]) => el('option', { value, textContent: text })));
}

// O que vai para sign.js: a página ('first', 'last' ou o número) e o lugar.
function stampChoice() {
  const page = els.stampPage.value;
  const position = els.stampGrid.querySelector('input:checked')?.value ?? 'bottom-right';
  return { page: /^\d+$/.test(page) ? Number(page) : page, position };
}

// Os seis lugares: três em cima e três embaixo, numa folha em miniatura. Embaixo, à direita, é o padrão.
spotGrid(els.stampGrid, 'stamp-position');

const loadImage = (url) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = reject;
  image.src = url;
});

// Tamanho da página como ela vai sair (em pontos) e onde a miniatura entra nela. A foto ganha a margem e o formato de
// folha escolhidos (layoutPage), e a miniatura dela é só a imagem (com edição, já é a folha inteira); página de PDF e
// de Word já é a folha inteira.
function pageGeometry(page) {
  const { width, height } = visibleSize(page);
  const image = isPhoto(page) && !page.edits?.length ? photoSheet(page.shape).image : { x: 0, y: 0, w: width, h: height };
  return { width, height, image };
}

// Miniatura e geometria de uma página, para as prévias (carimbo, "em todas as páginas"). Sem a miniatura, uma folha
// A4 em branco.
async function previewSource(page) {
  try {
    return { image: await loadImage(page.thumbUrl), geometry: pageGeometry(page) };
  } catch {
    return { image: null, geometry: { width: 595.28, height: 841.89, image: null } };
  }
}

// Desenha a página da prévia no canvas, com até 130 px de largura (cabe ao lado da folha dos lugares no celular, mesmo
// com barra de rolagem). Devolve o contexto em pontos da página, com a origem em cima, para o que vai por cima.
function paintPreview(canvas, { image, geometry }) {
  const cssWidth = Math.min(130, (130 * geometry.width) / Math.max(geometry.width, geometry.height * 0.75));
  const scale = cssWidth / geometry.width;
  const ratio = window.devicePixelRatio || 1;
  canvas.style.width = `${Math.round(cssWidth)}px`;
  canvas.style.height = `${Math.round(geometry.height * scale)}px`;
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(geometry.height * scale * ratio);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale * ratio, 0, 0, scale * ratio, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, geometry.width, geometry.height);
  if (image && geometry.image) ctx.drawImage(image, geometry.image.x, geometry.image.y, geometry.image.w, geometry.image.h);
  return ctx;
}

// Prévia de "em todas as páginas": a primeira página do primeiro arquivo, com o que as opções ligadas acrescentam.
let allPagesToken = 0;
async function drawAllPagesPreview() {
  const token = ++allPagesToken;
  if (els.allPages.hidden || !state.pages.length) return;
  let groups;
  try {
    groups = outputGroups(state.pages.length);
  } catch {
    return; // intervalos inválidos: o aviso já está na prévia do resultado
  }
  const index = groups[0][0];
  const page = state.pages[index];
  const source = await previewSource(page);
  if (token !== allPagesToken) return;
  const ctx = paintPreview(els.allPagesPreview, source);
  const size = { width: source.geometry.width, height: source.geometry.height };
  const extras = allPages.produce({ position: 1, total: groups[0].length, file: 1, files: groups.length, index, page, size });
  paintEdits(ctx, extras, size);
  els.allPagesPreview.setAttribute('aria-label', `Prévia da página ${index + 1}${extras.length ? ', com o que entra em todas as páginas' : ''}`);
}

// Prévia: a página escolhida com o carimbo no lugar e no tamanho em que ele vai sair (stamp.js).
let previewToken = 0;
async function drawStampPreview() {
  const token = ++previewToken;
  if (els.stampOptions.hidden || !signing.signer) return;
  const { pages } = stampTarget();
  const choice = stampChoice();
  const page = pages[stampPageIndex(choice.page, pages.length)];
  const source = await previewSource(page);
  if (token !== previewToken) return;
  const { geometry } = source;
  const layout = stampLayout(signing.signer.name, new Date(), geometry.width);
  const { visible } = placeStamp({ box: [0, 0, geometry.width, geometry.height], rotate: 0 }, choice.position, layout);

  const canvas = els.stampPreview;
  const ctx = paintPreview(canvas, source);
  ctx.strokeStyle = '#294a8c';
  ctx.lineWidth = 0.75;
  ctx.strokeRect(visible.x + 0.5, visible.y + 0.5, visible.w - 1, visible.h - 1);
  ctx.fillStyle = '#000';
  let top = visible.y + 6;
  for (const line of layout.lines) {
    ctx.font = `${line.font.endsWith('Bold') ? 'bold ' : ''}${line.size}px Helvetica, Arial, sans-serif`;
    ctx.fillText(line.text, visible.x + 6, top + line.size * 0.95);
    top += line.size * 1.25;
  }
  canvas.setAttribute('aria-label', `Prévia: carimbo ${STAMP_POSITIONS[choice.position].toLowerCase()}, na ${els.stampPage.selectedOptions[0]?.textContent.toLowerCase() ?? 'página'}`);
}

els.stamp.addEventListener('change', () => {
  els.stampOptions.hidden = !els.stamp.checked;
  drawStampPreview();
});
els.stampPage.addEventListener('change', drawStampPreview);
els.stampGrid.addEventListener('change', drawStampPreview);

els.sign.addEventListener('click', () => {
  if (!state.pages.length || state.busy) return;
  try {
    outputGroups(state.pages.length); // intervalos inválidos: avisa antes de pedir o certificado
  } catch (err) {
    announce(err.message, 'error');
    els.ranges.focus();
    return;
  }
  if (protectionPassword() === undefined) return; // senha de proteção faltando ou diferente: idem
  resetSigning();
  els.signDialog.showModal();
  els.signPick.focus();
});

els.signPick.addEventListener('click', () => els.signFile.click());
els.signFile.addEventListener('change', () => {
  signing.file = els.signFile.files[0] ?? null;
  els.signFileName.textContent = signing.file ? signing.file.name : 'Nenhum arquivo escolhido';
  signStatus('');
  if (signing.file) els.signPassword.focus();
});
els.signPassword.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    els.signNext.click();
  }
});
els.signCancel.addEventListener('click', () => els.signDialog.close());
// Fechar de qualquer jeito (Cancelar, Esc) solta o certificado e limpa a senha.
els.signDialog.addEventListener('close', () => {
  if (signing.signer || signing.file || els.signPassword.value) resetSigning();
});

els.signNext.addEventListener('click', async () => {
  if (signing.signer) {
    // Passo 2: confirmou. A chave vai para a geração, que a descarta no fim.
    if (signing.locked) return;
    const { signer, append } = signing;
    const stamp = els.stamp.checked && !els.stamp.disabled ? stampChoice() : null;
    signing.signer = null;
    els.signDialog.close();
    generate({ signer, stamp, append });
    return;
  }
  if (!signing.file) {
    signStatus('Escolha o arquivo do certificado (.pfx ou .p12).', 'error');
    els.signPick.focus();
    return;
  }
  const password = els.signPassword.value;
  els.signPassword.value = ''; // a senha não fica no campo depois de usada
  els.signNext.disabled = true;
  signStatus('Abrindo o certificado…');
  let module;
  let bytes;
  try {
    module = await loadSigning();
    if (signing.file.size > 1024 * 1024) throw new module.SignError('Este arquivo é grande demais para ser um certificado A1.');
    bytes = new Uint8Array(await signing.file.arrayBuffer());
    const signer = await module.openCertificate(bytes, password);
    if (!els.signDialog.open) {
      signer.discard(); // a janela foi fechada enquanto o certificado abria
      return;
    }
    signing.signer = signer;
    els.signHolder.textContent = signer.name;
    els.signIssuer.textContent = signer.issuer;
    els.signValid.textContent = signer.notAfter.toLocaleDateString('pt-BR');
    els.signChain.hidden = signer.chainComplete;
    await prepareSignOptions();
    els.signStepOpen.hidden = true;
    els.signStepConfirm.hidden = false;
    const many = outputGroups(state.pages.length).length > 1;
    els.signNext.textContent = signing.append ? 'Assinar o PDF' : many ? 'Assinar e gerar os PDFs' : 'Assinar e gerar o PDF';
    signStatus(signing.locked, signing.locked ? 'error' : 'info');
    (signing.locked ? els.signCancel : els.signNext).focus();
  } catch (err) {
    // Sem console: a mensagem não leva nada do certificado, e o erro técnico também não precisa ir para lá.
    signStatus(module && err instanceof module.SignError ? err.message : 'Não deu para abrir o certificado.', 'error');
    els.signPassword.focus();
  } finally {
    bytes?.fill(0);
    els.signNext.disabled = !!signing.locked; // PDF certificado sem permitir alterações: não dá para assinar
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
