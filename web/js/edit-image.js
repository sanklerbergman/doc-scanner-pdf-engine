// Ferramenta Imagem do modo Editar (#14): um PNG ou JPEG escolhido no aparelho, posto na página com a proporção travada.
// Carregada pelo editor (TOOL_MODULES, em editor.js). O arquivo nunca entra no PDF como veio: a imagem é desenhada num
// canvas, com o lado maior limitado, e codificada de novo (sem EXIF, GPS nem texto do PNG). Com transparência de
// verdade, vai como Flate com máscara; sem, como JPEG (edit-media.js). Tudo fica pronto (comprimido) aqui, antes de
// montar o PDF, porque o assemble é síncrono. Também daqui: a parte de uma imagem sob uma tarja, apagada dos pixels
// antes de montar (cutImages).
import { registerTool } from './editor.js';
import { boxAround } from './edits.js';
import { storeImage, imageRecord, flateImage, hasTransparency, imageCuts, cutKey, cutFlate, pixelCuts, underCover } from './edit-media.js';
import { decodeFile, canvasToBlob } from './imaging.js';
import { pageCovers, readJpegInfo } from './pdf.js';
import { md5 } from './md5.js';

// Lado maior da imagem no PDF. Numa A4 inteira, 2000 pixels dão uns 240 por polegada (nítido na impressão); numa
// imagem do tamanho de meia página, mais de 300. No iPhone, o canvas de 2000 × 2000 ocupa 16 MB, e o pico ao preparar
// uma imagem com transparência fica perto de 70 MB (pixels, canais separados e comprimidos), por pouco tempo.
export const MAX_SIDE = 2000;
const PREVIEW_SIDE = 1200; // prévia guardada na memória (miniaturas e tela cheia): até 5,8 MB por imagem
const MAX_PIXELS = 50e6; // arquivo maior que isso nem é aberto: só decodificar ocuparia 200 MB
const MAX_BYTES = 50 * 1024 * 1024;
const JPEG_QUALITY = 0.92; // texto e traço de logotipo sem borrão visível
const TAP_MOVE = 'Toque sem arrastar: onde o dedo encostar, a imagem entra.';

class ImageError extends Error {}

// ---------- Preparar a imagem ----------

// Tipo e tamanho pelo começo do arquivo, sem confiar na extensão nem no tipo que o sistema informa.
async function readHeader(file) {
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, i) => head[i] === byte)) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return head.length >= 24 ? { type: 'png', width: view.getUint32(16), height: view.getUint32(20) } : null;
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    try {
      const { width, height } = readJpegInfo(head);
      return { type: 'jpeg', width, height };
    } catch {
      return { type: 'jpeg', width: 0, height: 0 }; // cabeçalho depois do começo: o tamanho é conferido ao decodificar
    }
  }
  return null;
}

const tooBig = () => new ImageError('A imagem é grande demais para abrir aqui (mais de 50 megapixels ou 50 MB). Reduza e tente de novo.');

// Identificação pelo conteúdo já recodificado: a mesma imagem escolhida duas vezes é uma só na memória e no PDF.
// Fora de HTTPS (sem crypto.subtle), o MD5 do próprio app serve: aqui ele só compara, não protege nada.
async function contentId(encoded) {
  const bytes = new Uint8Array(await new Blob([encoded.kind, encoded.data, encoded.mask ?? new Uint8Array()]).arrayBuffer());
  const hash = crypto.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : md5(bytes);
  return [...hash.subarray(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Lê, reduz e codifica a imagem escolhida, e guarda o resultado na memória da aba (storeImage).
 * @param {File} file
 * @returns {Promise<{id: string, width: number, height: number, reduced: boolean}>}
 */
export async function prepareImage(file) {
  const header = await readHeader(file);
  if (!header) throw new ImageError('Esse arquivo não é PNG nem JPEG. Escolha uma imagem PNG ou JPEG.');
  if (file.size > MAX_BYTES || header.width * header.height > MAX_PIXELS) throw tooBig();
  let image;
  try {
    image = await decodeFile(file);
  } catch {
    throw new ImageError('Não deu para abrir essa imagem: o arquivo pode estar corrompido. Tente outra, em PNG ou JPEG.');
  }
  const canvas = document.createElement('canvas');
  let reduced = false;
  try {
    if (image.width * image.height > MAX_PIXELS) throw tooBig();
    const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    reduced = scale < 1;
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: header.type === 'png' });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image.source, 0, 0, canvas.width, canvas.height);
  } finally {
    image.release(); // a imagem original sai da memória antes de codificar
  }
  try {
    const { width, height } = canvas;
    // Só o PNG pode ter transparência; o JPEG vai direto para o JPEG novo.
    const pixels = header.type === 'png' ? canvas.getContext('2d').getImageData(0, 0, width, height).data : null;
    let encoded;
    if (pixels && hasTransparency(pixels)) encoded = await flateImage(pixels, width, height);
    else {
      const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
      encoded = { kind: 'jpeg', width, height, data: new Uint8Array(await blob.arrayBuffer()) };
    }
    const id = await contentId(encoded);
    if (!imageRecord(id)) storeImage(id, { ...encoded, picture: previewOf(canvas) });
    return { id, width, height, reduced };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// Cópia reduzida para a prévia, com a transparência.
function previewOf(canvas) {
  const scale = Math.min(1, PREVIEW_SIDE / Math.max(canvas.width, canvas.height));
  const preview = document.createElement('canvas');
  preview.width = Math.max(1, Math.round(canvas.width * scale));
  preview.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = preview.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, preview.width, preview.height);
  return preview;
}

// ---------- Imagem sob as tarjas ----------

// Versão da imagem com as partes cortadas pintadas de preto: o JPEG pelo canvas; o Flate direto nos canais.
async function cutImage(record, cuts) {
  if (record.kind === 'flate') return cutFlate(record, cuts);
  const bitmap = await createImageBitmap(new Blob([record.data], { type: 'image/jpeg' }));
  const canvas = document.createElement('canvas');
  canvas.width = record.width;
  canvas.height = record.height;
  try {
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, record.width, record.height);
    bitmap.close();
    ctx.fillStyle = '#000';
    for (const [x0, y0, x1, y1] of pixelCuts(cuts, record.width, record.height)) ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    return { kind: 'jpeg', width: record.width, height: record.height, data: new Uint8Array(await blob.arrayBuffer()), picture: record.picture };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

/**
 * Antes de montar o PDF: em cada página com tarja, a imagem que a tarja pega só em parte ganha a versão sem essa parte
 * (o tipo "image", em edit-media.js, troca por ela ao montar; sem ela, nada sai).
 * @param {object[]} pages as páginas de buildPdf (pdf.js), com as edições e as tarjas
 */
export async function cutImages(pages) {
  for (const page of pages) {
    if (page.copy || !page.edits?.some((edit) => edit.type === 'image')) continue;
    const covers = pageCovers(page);
    if (!covers.length) continue;
    for (const edit of page.edits) {
      if (edit.type !== 'image' || underCover(edit, covers)) continue;
      const cuts = imageCuts(edit, covers);
      if (!cuts.length) continue;
      const id = cutKey(edit.image, cuts);
      const record = imageRecord(edit.image);
      if (!imageRecord(id) && record) storeImage(id, await cutImage(record, cuts));
    }
  }
}

// ---------- Ferramenta ----------

// O seletor de arquivo fica dentro da tela cheia (o diálogo modal deixa inerte o que está fora dele).
let input = null;
function fileInput() {
  if (input) return input;
  input = document.createElement('input');
  Object.assign(input, { type: 'file', accept: 'image/png,image/jpeg', hidden: true });
  (document.querySelector('#viewer') ?? document.body).append(input);
  return input;
}

// Tamanho inicial: o da imagem na tela do computador (96 pixels por polegada), sem passar de 60% da largura nem de
// 45% da altura da página.
function startSize({ width, height }, page) {
  const w = width * 0.75;
  const h = height * 0.75;
  const fit = Math.min(1, (page.width * 0.6) / w, (page.height * 0.45) / h);
  return [w * fit, h * fit];
}

// Abre o seletor; a imagem escolhida entra centrada em point (de 0 a 1 na página).
function pick(api, point) {
  const chooser = fileInput();
  chooser.onchange = async () => {
    const file = chooser.files?.[0];
    chooser.value = '';
    if (!file) return;
    const editing = () => !document.querySelector('#edit')?.hidden;
    api.say('Preparando a imagem…');
    try {
      const image = await prepareImage(file);
      if (!editing()) return; // a pessoa saiu do modo Editar enquanto a imagem era preparada
      const box = boxAround(point[0], point[1], startSize(image, api.page), api.page);
      const reduced = image.reduced ? ` Ela foi reduzida para ${MAX_SIDE} pixels no lado maior, o bastante para imprimir nítida.` : '';
      api.add({ type: 'image', ...box, image: image.id },
        `Imagem posta na página: arraste para mover; os cantos mudam o tamanho sem deformar.${reduced} Toque em "Aplicar" quando terminar.`);
    } catch (err) {
      if (!(err instanceof ImageError)) console.error(err);
      if (editing()) api.say(err instanceof ImageError ? err.message : 'Não deu para abrir essa imagem. Tente outra, em PNG ou JPEG.');
    }
  };
  chooser.value = '';
  chooser.click();
}

registerTool({
  id: 'image', label: 'Imagem', icon: 'image', type: 'image', after: 'ink', // depois do Desenho, como no plano

  hint: 'Toque na página onde vai a imagem (PNG ou JPEG), ou use "Novo" para pô-la no meio. Os cantos mudam o tamanho sem deformar.',
  // Toque: numa edição, seleciona; fora, com algo selecionado, só tira a seleção; senão, escolhe a imagem. Arrastar
  // não faz nada (a imagem entra no tamanho dela, e depois os cantos mudam o tamanho).
  pointer(api, point, event) {
    const owner = event.target.closest?.('.edit-box');
    let moved = false;
    return {
      move() { moved = true; },
      up() {
        if (moved) api.say(TAP_MOVE);
        else if (owner) api.select(Number(owner.dataset.index));
        else if (api.selected >= 0) api.select(-1);
        else pick(api, point);
      },
    };
  },
  keyboard: (api) => pick(api, [0.5, 0.5]),
});
