// Gerador de PDF mínimo, sem dependências. Três tipos de página:
// - foto: imagem JPEG (filtro DCTDecode), que entra no PDF byte a byte, sem recompressão, com a camada de texto
//   invisível do OCR quando a pessoa liga essa opção;
// - texto (documento do Word): texto de verdade, selecionável, com as fontes padrão do PDF
//   (Helvetica, Times e Courier, codificação WinAnsi), sem embutir fonte;
// - copiada de outro PDF (juntar e dividir): os objetos vêm prontos do pdf-reader.js, renumerados aqui.
// Nas fotos e nas páginas de texto, as edições da pessoa (edits.js) entram no conteúdo da página, por cima do que
// já está nela e por baixo das tarjas; na página copiada, elas vêm prontas do copyPages.
// Nenhum metadado é gravado (sem /Info, sem datas, sem "Producer"). A única data possível é a hora da assinatura
// (/M), e só quando a pessoa assina (buildPdfToSign). Com a opção PDF/A, entra só a identificação do padrão (XMP com
// pdfaid), o perfil de cor sRGB e o /ID, tirado do próprio conteúdo.
import { winAnsiCode } from './fonts.js';
import { srgbProfile } from './icc.js';
import { md5 } from './md5.js';
import { buildStamp, stampPageIndex, STAMP_FONTS } from './stamp.js';
import { ocrLayer, OCR_FONT } from './ocr-layer.js';
import { editsContent, resourceCollector, redactEdits, pdfValue } from './edits.js';
import { toRotatedRects } from './redact.js';
import './edit-types.js';

const encoder = new TextEncoder();

// Lê largura, altura e número de componentes do cabeçalho SOF de um JPEG.
export function readJpegInfo(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Arquivo não é um JPEG válido');
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
        components: bytes[i + 9],
      };
    }
    i += 2 + length;
  }
  throw new Error('JPEG sem cabeçalho SOF');
}

const COLOR_SPACES = { 1: '/DeviceGray', 3: '/DeviceRGB' };

// Objeto de imagem JPEG (o arquivo entra inteiro, sem recompressão), em partes para object().
function imageObject(jpeg) {
  const info = readJpegInfo(jpeg);
  const colorSpace = COLOR_SPACES[info.components];
  if (!colorSpace) throw new Error(`JPEG com ${info.components} componentes não é suportado`);
  return [
    `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height}` +
    ` /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    '\nendstream',
  ];
}

// Números em PDF não aceitam notação exponencial; duas casas bastam.
const num = (v) => String(Math.round(v * 100) / 100);

// As 12 fontes padrão de texto que todo leitor de PDF tem (as outras duas são de símbolos).
export const STANDARD_FONTS = [
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
];

// String literal do PDF só com ASCII: parênteses e barra invertida escapados, o que passa do ASCII em octal.
function pdfString(text) {
  let out = '(';
  for (const char of text) {
    const code = winAnsiCode(char);
    if (code === undefined) throw new Error(`Caractere sem suporte nas fontes do PDF: ${char}`);
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${char}`;
    else if (code > 0x7e) out += `\\${code.toString(8)}`;
    else out += char;
  }
  return `${out})`;
}

const rgb = (color) => (color ?? [0, 0, 0]).map(num).join(' ');

// Caixa preta da tarja (x0 y0 x1 y1 no espaço do PDF), arredondada para fora, como os pixels da tarja: o
// arredondamento de duas casas nunca deixa uma lasca do que está embaixo aparecer na borda.
function coverBox(x0, y0, x1, y1) {
  const [a, b] = [x0, y0].map((v) => Math.floor(Math.round(v * 1e6) / 1e4) / 100);
  const [c, d] = [x1, y1].map((v) => Math.ceil(Math.round(v * 1e6) / 1e4) / 100);
  return `${num(a)} ${num(b)} ${num(c - a)} ${num(d - b)} re`;
}

// Conteúdo de uma página de texto. Os itens vêm com a origem no canto superior esquerdo;
// no PDF ela fica no inferior, por isso y vira height - y.
function textContent(page, fontNames, imageNames, edits = '') {
  // Fundos e imagens primeiro (ficam por baixo do texto), cada um entre q e Q para não mexer na cor do texto.
  const ops = [];
  for (const item of page.items) {
    if (item.type === 'rect') {
      ops.push(`q ${rgb(item.color)} rg ${num(item.x)} ${num(page.height - item.y - item.h)} ${num(item.w)} ${num(item.h)} re f Q`);
    } else if (item.type === 'image') {
      ops.push(`q ${num(item.w)} 0 0 ${num(item.h)} ${num(item.x)} ${num(page.height - item.y - item.h)} cm ${imageNames.get(item.jpeg)} Do Q`);
    }
  }
  ops.push('BT');
  let font = '';
  let fill = '0 0 0';
  let wordSpacing = 0;
  let rise = 0;
  for (const item of page.items) {
    if (item.type !== 'text') continue;
    const tf = `${fontNames.get(item.font)} ${num(item.size)} Tf`;
    if (tf !== font) ops.push((font = tf));
    if (rgb(item.color) !== fill) ops.push(`${(fill = rgb(item.color))} rg`);
    if ((item.wordSpacing ?? 0) !== wordSpacing) ops.push(`${num((wordSpacing = item.wordSpacing ?? 0))} Tw`);
    if ((item.rise ?? 0) !== rise) ops.push(`${num((rise = item.rise ?? 0))} Ts`);
    ops.push(`1 0 0 1 ${num(item.x)} ${num(page.height - item.y)} Tm ${pdfString(item.text)} Tj`);
  }
  ops.push('ET');
  let stroke = '0 0 0';
  for (const item of page.items) {
    if (item.type !== 'line') continue;
    if (rgb(item.color) !== stroke) ops.push(`${(stroke = rgb(item.color))} RG`);
    const y1 = num(page.height - (item.y1 ?? item.y));
    const y2 = num(page.height - (item.y2 ?? item.y));
    ops.push(`${num(item.width)} w ${num(item.x1)} ${y1} m ${num(item.x2)} ${y2} l S`);
  }
  // Edições (edits.js): por cima do documento e por baixo das tarjas.
  if (edits) ops.push(edits);
  // Tarjas: caixas pretas por cima de tudo. O texto que estava embaixo já saiu da página (redact.js).
  for (const item of page.items) {
    if (item.type !== 'redaction') continue;
    ops.push(`q 0 0 0 rg ${coverBox(item.x, page.height - item.y - item.h, item.x + item.w, page.height - item.y)} f Q`);
  }
  return ops.join('\n');
}

// Data no formato do PDF, com o fuso do aparelho: D:20261016093000-03'00'.
export function pdfDate(date) {
  const pad = (v) => String(v).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const zone = offset === 0 ? 'Z' : `${offset > 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}'${pad(Math.abs(offset) % 60)}'`;
  return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}` +
    `${pad(date.getMinutes())}${pad(date.getSeconds())}${zone}`;
}

/**
 * Monta um PDF. Cada página é de um destes tipos:
 * - foto: {jpeg: Uint8Array, width, height, box: {x, y, w, h}, ocr?, edits?, redactions?}, com a imagem posicionada
 *   em box (origem no canto inferior esquerdo) e ocr = palavras reconhecidas (ocr.js), que viram texto invisível;
 *   edits: edições (edits.js), de 0 a 1 na folha inteira; redactions: as tarjas da imagem (de 0 a 1 nela), já
 *   pintadas nos pixels, que vão de novo como caixas por cima das edições;
 * - texto: {width, height, items, rotation?}, com items vindos de layout.js: {type: 'text', x, y, text, font,
 *   size, color?, wordSpacing?, rise?}, {type: 'line', x1, x2, y (ou y1 e y2), width, color?}, {type: 'rect', x, y,
 *   w, h, color}, {type: 'image', jpeg, x, y, w, h} e {type: 'redaction', x, y, w, h} (tarja, desenhada por cima
 *   de tudo), origem no canto superior esquerdo e y do texto na linha de base. A mesma imagem (o mesmo
 *   Uint8Array) usada em várias páginas é gravada uma vez só.
 *   rotation (0, 90, 180 ou 270) vira /Rotate. edits: edições (edits.js), de 0 a 1 na página como aparece (com o
 *   giro), desenhadas antes das tarjas.
 * - copiada: {copy: {source, page}, rotation?}, com source = {objects} e page = descritor de copyPages
 *   (pdf-reader.js). Páginas do mesmo source compartilham os objetos (fontes, imagens), gravados uma vez só. As
 *   edições dela vão pelo copyPages (opção edits).
 * Medidas em pontos (1/72 pol.).
 * @param {{pdfa?: boolean, fonts?: Map<string, object>}} [options] pdfa: PDF/A-2b (arquivamento e tribunais).
 *   Páginas copiadas de outro PDF não cumprem o padrão, e quem chama não liga a opção com elas; fonts: com o PDF/A,
 *   as fontes embutidas das páginas de texto (embedFonts, em pdfa-fonts.js), pela fonte padrão
 * @returns {Uint8Array}
 */
export function buildPdf(pages, options = {}) {
  return assemble(pages, null, options).bytes;
}

/**
 * Monta o PDF com o espaço da assinatura digital (PAdES): campo de assinatura, dicionário /Sig com o /ByteRange já
 * preenchido e o /Contents em zeros, para o cms.js preencher (fillSignature). O campo é invisível, na primeira
 * página, ou mostra o carimbo (stamp.js) na página e no lugar escolhidos.
 * Sem /Name, /Reason, /Location nem /ContactInfo: só a hora da assinatura (/M), que faz parte do padrão.
 * @param {object[]} pages as mesmas de buildPdf
 * @param {{reserve: number, time: Date, pdfa?: boolean, fonts?: Map<string, object>, stamp?: {name: string,
 *   position: string, page: 'first' | 'last' | number}}} signature reserve: bytes reservados para o CMS; pdfa e
 *   fonts: como em buildPdf; stamp: carimbo visível. Com o PDF/A, o texto do carimbo vai com as fontes embutidas
 *   (fonts, com as letras do carimbo: stampCharacters em stamp.js), nos mesmos objetos de fonte das páginas
 * @returns {{bytes: Uint8Array, byteRange: number[], contents: {at: number, length: number}}} contents: posição
 *   e tamanho (em dígitos hexadecimais) do espaço da assinatura, entre o < e o >
 */
export function buildPdfToSign(pages, signature) {
  if (!(signature?.reserve > 0) || !(signature.time instanceof Date)) throw new Error('Assinatura sem espaço ou sem hora');
  if (signature.pdfa && signature.stamp && !STAMP_FONTS.every((font) => signature.fonts?.has(font))) {
    throw new Error('O carimbo com o PDF/A precisa das fontes embutidas, que não foram preparadas');
  }
  return assemble(pages, signature, { pdfa: signature.pdfa, fonts: signature.fonts });
}

// Área visível e giro de uma página de buildPdf, para posicionar o carimbo.
function pageGeometry(page) {
  if (page.copy) {
    const { page: copied } = page.copy;
    return { box: copied.cropBox ?? copied.mediaBox, rotate: (copied.rotate + (page.rotation ?? 0)) % 360 };
  }
  return { box: [0, 0, page.width, page.height], rotate: page.jpeg ? 0 : page.rotation ?? 0 };
}

// Identificação do PDF/A-2b (XMP): só a parte e o nível do padrão. Sem autor, título, datas nem programa.
// O começo do pacote leva a marca de ordem dos bytes (U+FEFF), em UTF-8, como o XMP pede.
const XMP = '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
  + '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
  + ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
  + '  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n'
  + '   <pdfaid:part>2</pdfaid:part>\n'
  + '   <pdfaid:conformance>B</pdfaid:conformance>\n'
  + '  </rdf:Description>\n'
  + ' </rdf:RDF>\n'
  + '</x:xmpmeta>\n'
  + '<?xpacket end="w"?>';

// Bytes que a assinatura cobre: o arquivo todo, menos o /Contents (com o < e o >).
export function signedRanges(bytes, byteRange) {
  const [a, b, c, d] = byteRange;
  return [bytes.subarray(a, a + b), bytes.subarray(c, c + d)];
}

/**
 * Grava a assinatura (o CMS em DER) no espaço reservado por buildPdfToSign. O resto fica em zeros.
 * @param {{bytes: Uint8Array, contents: {at: number, length: number}}} prepared
 * @param {Uint8Array} der
 */
export function fillSignature({ bytes, contents }, der) {
  if (der.length * 2 > contents.length) throw new Error('A assinatura não coube no espaço reservado');
  const hex = encoder.encode([...der].map((b) => b.toString(16).padStart(2, '0')).join(''));
  bytes.set(hex, contents.at);
  return bytes;
}

// Tarjas da página na página como aparece (de 0 a 1), para as edições: na foto, as da imagem levadas para a folha;
// no Word, as caixas do layout (antes do giro) levadas para a página girada. Exportada para a imagem sob a tarja
// (cutImages, em edit-image.js), que apaga a parte coberta dos pixels antes de montar.
export function pageCovers(page) {
  if (page.jpeg) {
    const { x, y, w, h } = page.box;
    const top = page.height - y - h;
    return (page.redactions ?? []).map((rect) => ({
      x0: (x + rect.x0 * w) / page.width, x1: (x + rect.x1 * w) / page.width,
      y0: (top + rect.y0 * h) / page.height, y1: (top + rect.y1 * h) / page.height,
    }));
  }
  const boxes = page.items.filter((item) => item.type === 'redaction').map((item) => ({
    x0: item.x / page.width, x1: (item.x + item.w) / page.width, y0: item.y / page.height, y1: (item.y + item.h) / page.height,
  }));
  return toRotatedRects(boxes, page.rotation ?? 0);
}

/**
 * As edições de uma foto ou página de texto como vão para o arquivo: sem o que fica sob as tarjas (redactEdits, com as
 * tarjas e o tamanho da página como aparece). A mesma conta serve ao conteúdo (prepareEdits) e às letras das fontes
 * embutidas do PDF/A (pdfa-fonts.js): a letra tirada pela tarja não fica nem no programa da fonte.
 * @param {object} page uma página de buildPdf (foto ou texto)
 */
export function redactedEdits(page) {
  if (page.copy || !page.edits?.length) return [];
  const sideways = !page.jpeg && (page.rotation ?? 0) % 180;
  const visible = sideways ? { width: page.height, height: page.width } : { width: page.width, height: page.height };
  return redactEdits(page.edits, pageCovers(page), visible);
}

// Edições de uma foto ou página de texto: os operadores, os recursos que eles pedem e as tarjas que vão por cima.
// null sem nada a desenhar.
function prepareEdits(page) {
  const covers = pageCovers(page);
  const res = resourceCollector();
  const frame = { box: [0, 0, page.width, page.height], rotate: page.jpeg ? 0 : page.rotation ?? 0 };
  const ops = editsContent(redactedEdits(page), frame, res);
  return ops ? { ops, res, covers } : null;
}

// Recursos das edições de uma página, como entradas dos dicionários (" /Ed1 12 0 R"), e o /ExtGState inteiro.
function editResources(prepared, fontIds, refOf) {
  if (!prepared) return { fonts: '', xobjects: '', states: '' };
  const { res } = prepared;
  const fonts = [...res.fonts].map(([name, font]) => ` /${name} ${fontIds.get(font)} 0 R`).join('');
  const xobjects = [...res.xobjects].map(([name, { key }]) => ` /${name} ${refOf(key)}`).join('');
  const states = res.states.size
    ? ` /ExtGState <<${[...res.states].map(([name, params]) => ` /${name} ${pdfValue(params, refOf)}`).join('')} >>`
    : '';
  return { fonts, xobjects, states };
}

// Objeto pedido pelas edições (imagem, formulário, máscara), em partes para object().
function editObject({ dict, data }, refOf) {
  if (!data) return [pdfValue(dict, refOf)];
  return [`${pdfValue({ ...dict, Length: data.length }, refOf)}\nstream\n`, data, '\nendstream'];
}

function assemble(pages, signature, { pdfa = false, fonts = null } = {}) {
  if (!pages.length) throw new Error('Nenhuma página para gerar');

  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id, ...parts) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    parts.forEach(push);
    push('\nendobj\n');
  };

  // Objetos: 1 catálogo, 2 árvore de páginas, depois cada página em ordem (foto: página, conteúdo e imagem;
  // texto: página e conteúdo) e, no fim, cada fonte usada, uma vez só. PDF só de fotos sai igual ao de antes.
  const pageIds = [];
  let nextId = 3;
  for (const page of pages) {
    pageIds.push(nextId);
    nextId += page.jpeg ? 3 : page.copy ? 1 : 2;
  }
  const fontIds = new Map();
  const fontNames = new Map();
  for (const page of pages) {
    if (page.jpeg || page.copy) continue;
    for (const item of page.items) {
      if (item.type !== 'text' || fontIds.has(item.font)) continue;
      if (!STANDARD_FONTS.includes(item.font)) throw new Error(`Fonte desconhecida: ${item.font}`);
      fontIds.set(item.font, nextId++);
      fontNames.set(item.font, `/F${fontIds.size}`);
    }
  }
  // Camada do OCR nas fotos: Helvetica, a mesma das páginas de texto (uma vez só no arquivo).
  if (pages.some((page) => page.jpeg && page.ocr?.length) && !fontIds.has(OCR_FONT)) {
    fontIds.set(OCR_FONT, nextId++);
    fontNames.set(OCR_FONT, `/F${fontIds.size}`);
  }
  // Imagens das páginas de texto (documentos do Word), depois das fontes.
  const imageIds = new Map();
  const imageNames = new Map();
  for (const page of pages) {
    if (page.jpeg || page.copy) continue;
    for (const item of page.items) {
      if (item.type !== 'image' || imageIds.has(item.jpeg)) continue;
      imageIds.set(item.jpeg, nextId++);
      imageNames.set(item.jpeg, `/Im${imageIds.size}`);
    }
  }

  // Edições das fotos e das páginas de texto: o conteúdo de cada uma e o que ele pede. As fontes entram com as das
  // páginas (uma vez só no arquivo); imagens, formulários e máscaras, uma vez só pela chave, mesmo em várias páginas.
  const edited = pages.map((page) => (page.copy || !page.edits?.length ? null : prepareEdits(page)));
  const editIds = new Map();
  for (const prepared of edited) {
    if (!prepared) continue;
    for (const font of prepared.res.fonts.values()) {
      if (fontIds.has(font)) continue;
      if (!STANDARD_FONTS.includes(font)) throw new Error(`Fonte desconhecida: ${font}`);
      fontIds.set(font, nextId++);
      fontNames.set(font, `/F${fontIds.size}`);
    }
    for (const [key, body] of prepared.res.objects) if (!editIds.has(key)) editIds.set(key, { id: nextId++, body });
    for (const { key, dict, data } of prepared.res.xobjects.values()) if (!editIds.has(key)) editIds.set(key, { id: nextId++, body: { dict, data } });
  }
  const refOf = (key) => `${editIds.get(key).id} 0 R`;

  // Objetos das páginas copiadas: cada PDF de origem ganha uma faixa de números, depois das fontes.
  const sources = new Map();
  for (const page of pages) {
    if (!page.copy || sources.has(page.copy.source)) continue;
    sources.set(page.copy.source, nextId);
    nextId += page.copy.source.objects.length;
  }
  const parts = (list, base) => list.map((part) => (part?.ref !== undefined ? `${base + part.ref} 0 R` : part));

  // PDF/A: identificação (XMP) e perfil de cor. Depois, a assinatura: campo (widget) e dicionário /Sig.
  const metadataId = pdfa ? nextId++ : 0;
  const iccId = pdfa ? nextId++ : 0;
  const widgetId = signature ? nextId++ : 0;
  const sigId = signature ? nextId++ : 0;
  // Carimbo visível: a aparência do campo, na página escolhida. Sem carimbo, o campo fica na primeira página.
  const stampIndex = signature?.stamp ? stampPageIndex(signature.stamp.page, pages.length) : 0;
  // Com o PDF/A, o texto do carimbo vai com as fontes embutidas: os mesmos objetos das páginas, quando elas já usam a
  // fonte (Word ou camada do OCR), ou objetos novos, só para ele.
  const stampFonts = signature?.stamp && pdfa ? new Map() : null;
  for (const font of stampFonts ? STAMP_FONTS : []) {
    if (!fontIds.has(font)) fontIds.set(font, nextId++);
    stampFonts.set(font, `${fontIds.get(font)} 0 R`);
  }
  const stamp = signature?.stamp
    ? buildStamp({ ...signature.stamp, time: signature.time }, pageGeometry(pages[stampIndex]), stampFonts)
    : null;
  // Toda letra do carimbo tem que estar no subconjunto, preparado antes da hora da assinatura (stampCharacters).
  if (stampFonts && stamp.lines.some((line) => [...line.text].some((char) => !fonts.get(line.font).chars.includes(char)))) {
    throw new Error('O carimbo usa uma letra que não está na fonte embutida');
  }
  const appearanceId = stamp ? nextId++ : 0;
  // PDF/A com página de Word ou com carimbo: cada fonte vai embutida (pdfa-fonts.js), com o descritor, o programa da
  // fonte e o mapa para Unicode.
  const embedded = new Map();
  if (pdfa && fonts) {
    for (const font of fontIds.keys()) {
      if (fonts.has(font)) embedded.set(font, { font: fonts.get(font), descriptor: nextId++, file: nextId++, unicode: nextId++ });
    }
  }

  // Com o PDF/A, toda fonte das edições vai embutida: sem ela, nada sai.
  if (pdfa && edited.some((prepared) => [...(prepared?.res.fonts.values() ?? [])].some((font) => !embedded.has(font)))) {
    throw new Error('O PDF/A precisa das fontes das edições embutidas, que não foram preparadas');
  }

  // Página copiada pode usar recursos de versões mais novas do formato (transparência, JPEG 2000…). A assinatura
  // no padrão PAdES (/ETSI.CAdES.detached) também é do PDF 1.7 em diante.
  push(sources.size || signature ? '%PDF-1.7\n' : '%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marca de arquivo binário

  const pdfaCatalog = pdfa
    ? ` /Metadata ${metadataId} 0 R /OutputIntents [<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier`
      + ` (sRGB IEC61966-2.1) /Info (sRGB IEC61966-2.1) /DestOutputProfile ${iccId} 0 R >>]`
    : '';
  object(1, `<< /Type /Catalog /Pages 2 0 R${pdfaCatalog}${signature ? ` /AcroForm << /Fields [${widgetId} 0 R] /SigFlags 3 >>` : ''} >>`);
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);

  pages.forEach((page, i) => {
    const id = pageIds[i];
    const mediaBox = `/MediaBox [0 0 ${num(page.width)} ${num(page.height)}]`;
    const annots = signature && i === stampIndex ? ` /Annots [${widgetId} 0 R]` : '';

    if (page.copy) {
      const { source, page: copied } = page.copy;
      const base = sources.get(source);
      const box = (name, value) => (value ? ` /${name} [${value.map(num).join(' ')}]` : '');
      const rotate = (copied.rotate + (page.rotation ?? 0)) % 360;
      object(id,
        `<< /Type /Page /Parent 2 0 R${box('MediaBox', copied.mediaBox)}${box('CropBox', copied.cropBox)}`,
        rotate ? ` /Rotate ${rotate}` : '',
        copied.userUnit ? ` /UserUnit ${num(copied.userUnit)}` : '',
        ' /Resources ', ...parts(copied.resources, base),
        ...(copied.contents ? [' /Contents ', ...parts(copied.contents, base)] : []),
        ...(copied.group ? [' /Group ', ...parts(copied.group, base)] : []),
        `${annots} >>`);
      return;
    }

    const extra = editResources(edited[i], fontIds, refOf);
    if (!page.jpeg) {
      const used = new Set(page.items.filter((item) => item.type === 'text').map((item) => item.font));
      const fonts = [...used].map((font) => ` ${fontNames.get(font)} ${fontIds.get(font)} 0 R`).join('') + extra.fonts;
      const pictures = [...new Set(page.items.filter((item) => item.type === 'image').map((item) => item.jpeg))]
        .map((jpeg) => ` ${imageNames.get(jpeg)} ${imageIds.get(jpeg)} 0 R`).join('') + extra.xobjects;
      const rotate = page.rotation ? ` /Rotate ${page.rotation}` : '';
      const content = textContent(page, fontNames, imageNames, edited[i]?.ops); // só ASCII: o tamanho em caracteres é o tamanho em bytes
      object(id,
        `<< /Type /Page /Parent 2 0 R ${mediaBox}${rotate}` +
        ` /Resources <<${fonts ? ` /Font <<${fonts} >>` : ''}${pictures ? ` /XObject <<${pictures} >>` : ''}${extra.states} >> /Contents ${id + 1} 0 R${annots} >>`);
      object(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      return;
    }

    const { x, y, w, h } = page.box;
    const ocr = page.ocr?.length ? fontNames.get(OCR_FONT) : null;
    let content = `q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /Im0 Do Q`;
    if (edited[i]) {
      // Edições por cima da imagem e, por cima delas, as tarjas da imagem de novo (nos pixels elas já estão).
      const { ops, covers } = edited[i];
      const boxes = covers.map((r) => coverBox(r.x0 * page.width, (1 - r.y1) * page.height, r.x1 * page.width, (1 - r.y0) * page.height));
      content += `\n${ops}${boxes.length ? `\nq 0 0 0 rg ${boxes.join(' ')} f Q` : ''}`;
    }
    if (ocr) content += `\n${ocrLayer(page.ocr, { box: [x, y, x + w, y + h], width: w, height: h }, ocr)}`; // só ASCII
    const fontEntries = (ocr ? ` ${ocr} ${fontIds.get(OCR_FONT)} 0 R` : '') + extra.fonts;
    const font = fontEntries ? ` /Font <<${fontEntries} >>` : '';

    object(id,
      `<< /Type /Page /Parent 2 0 R ${mediaBox}` +
      ` /Resources << /XObject << /Im0 ${id + 2} 0 R${extra.xobjects} >>${font}${extra.states} >> /Contents ${id + 1} 0 R${annots} >>`);
    object(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    object(id + 2, ...imageObject(page.jpeg));
  });

  for (const [font, id] of fontIds) {
    const embed = embedded.get(font);
    if (!embed) {
      object(id, `<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`);
      continue;
    }
    const { font: data, descriptor, file, unicode } = embed;
    const d = data.descriptor;
    object(id, `<< /Type /Font /Subtype /TrueType /BaseFont /${data.baseFont} /FirstChar ${data.firstChar} /LastChar ${data.lastChar}`
      + ` /Widths [${data.widths.join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor ${descriptor} 0 R /ToUnicode ${unicode} 0 R >>`);
    object(descriptor, `<< /Type /FontDescriptor /FontName /${data.baseFont} /Flags ${d.flags} /FontBBox [${d.bbox.join(' ')}]`
      + ` /ItalicAngle ${num(d.italicAngle)} /Ascent ${d.ascent} /Descent ${d.descent} /CapHeight ${d.capHeight} /StemV ${d.stemV}`
      + ` /FontFile2 ${file} 0 R >>`);
    object(file, `<< /Length ${data.program.length} /Length1 ${data.length1} /Filter /FlateDecode >>\nstream\n`, data.program, '\nendstream');
    object(unicode, `<< /Length ${data.toUnicode.length} >>\nstream\n${data.toUnicode}\nendstream`);
  }
  for (const [jpeg, id] of imageIds) object(id, ...imageObject(jpeg));
  for (const { id, body } of editIds.values()) object(id, ...editObject(body, refOf));
  for (const [source, base] of sources) {
    source.objects.forEach((list, i) => object(base + i, ...parts(list, base)));
  }

  if (pdfa) {
    const xmp = encoder.encode(XMP);
    object(metadataId, `<< /Type /Metadata /Subtype /XML /Length ${xmp.length} >>\nstream\n`, xmp, '\nendstream');
    const icc = srgbProfile();
    object(iccId, `<< /N 3 /Length ${icc.length} >>\nstream\n`, icc, '\nendstream');
  }

  // Campo de assinatura, que imprime e não se mexe (/F 132 = Print + Locked): invisível (/Rect zerado) ou com o
  // carimbo como aparência (/AP).
  let byteRangeAt = 0;
  let contentsAt = 0;
  if (signature) {
    const rect = stamp ? stamp.rect.map(num).join(' ') : '0 0 0 0';
    const appearance = stamp ? ` /AP << /N ${appearanceId} 0 R >>` : '';
    object(widgetId, `<< /Type /Annot /Subtype /Widget /FT /Sig /T (Assinatura) /F 132 /Rect [${rect}] /P ${pageIds[stampIndex]} 0 R /V ${sigId} 0 R${appearance} >>`);
    if (stamp) object(appearanceId, stamp.appearance);
    offsets[sigId] = length;
    push(`${sigId} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /M (${pdfDate(signature.time)}) /ByteRange `);
    byteRangeAt = length;
    push(BYTE_RANGE_SPACE);
    push(' /Contents ');
    contentsAt = length;
    push(`<${'0'.repeat(signature.reserve * 2)}>`);
    push(' >>\nendobj\n');
  }

  const xrefOffset = length;
  const count = offsets.length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  const joined = () => {
    const out = new Uint8Array(length);
    let pos = 0;
    for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
    return out;
  };
  // PDF/A: /ID no trailer, o MD5 de tudo o que vem antes dele. O mesmo conteúdo dá o mesmo /ID, que não identifica
  // nem o aparelho nem a hora.
  const hash = pdfa ? [...md5(joined())].map((b) => b.toString(16).padStart(2, '0')).join('') : '';
  const id = pdfa ? ` /ID [<${hash}> <${hash}>]` : '';
  push(`trailer\n<< /Size ${count} /Root 1 0 R${id} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = joined();
  if (!signature) return { bytes: out };
  return { bytes: out, ...finishSignature(out, { byteRangeAt, contentsAt, reserve: signature.reserve }) };
}

// Espaço do /ByteRange: números de até 10 dígitos (arquivos de até 9,9 GB).
export const BYTE_RANGE_SPACE = '[0 0000000000 0000000000 0000000000]';

/**
 * Preenche o /ByteRange: do começo até o "<" do /Contents e do ">" até o fim. Os números ocupam o espaço
 * reservado (o que sobra fica em branco antes do "]"), então nenhum offset do arquivo muda.
 * Também usado pelo pdf-crypt.js, depois de cifrar um PDF que vai ser assinado.
 * @param {Uint8Array} out o PDF inteiro
 * @param {{byteRangeAt: number, contentsAt: number, reserve: number}} at posição do espaço do /ByteRange, do "<"
 *   do /Contents e bytes reservados para o CMS
 */
export function finishSignature(out, { byteRangeAt, contentsAt, reserve }) {
  const after = contentsAt + reserve * 2 + 2;
  const byteRange = [0, contentsAt, after, out.length - after];
  const text = `[${byteRange.join(' ')}`;
  out.set(encoder.encode(`${text.padEnd(BYTE_RANGE_SPACE.length - 1)}]`), byteRangeAt);
  return { byteRange, contents: { at: contentsAt + 1, length: reserve * 2 } };
}

// Posiciona a imagem na página. sizes em pontos; margin em pontos.
export const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

export function layoutPage(imgWidth, imgHeight, size, margin) {
  if (size === 'fit') {
    // Página do formato da imagem, com o lado menor do tamanho de um A4.
    const scale = PAGE_SIZES.a4[0] / Math.min(imgWidth, imgHeight);
    const w = imgWidth * scale;
    const h = imgHeight * scale;
    return { width: w + margin * 2, height: h + margin * 2, box: { x: margin, y: margin, w, h } };
  }
  let [width, height] = PAGE_SIZES[size];
  if (imgWidth > imgHeight) [width, height] = [height, width]; // imagem deitada → página deitada
  const scale = Math.min((width - margin * 2) / imgWidth, (height - margin * 2) / imgHeight);
  const w = imgWidth * scale;
  const h = imgHeight * scale;
  return { width, height, box: { x: (width - w) / 2, y: (height - h) / 2, w, h } };
}
