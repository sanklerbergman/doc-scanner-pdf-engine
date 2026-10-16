// Gerador de PDF mínimo, sem dependências. Três tipos de página:
// - foto: imagem JPEG (filtro DCTDecode), que entra no PDF byte a byte, sem recompressão, com a camada de texto
//   invisível do OCR quando a pessoa liga essa opção;
// - texto (documento do Word): texto de verdade, selecionável, com as fontes padrão do PDF
//   (Helvetica, Times e Courier, codificação WinAnsi), sem embutir fonte;
// - copiada de outro PDF (juntar e dividir): os objetos vêm prontos do pdf-reader.js, renumerados aqui.
// Nenhum metadado é gravado (sem /Info, sem datas, sem "Producer"). A única data possível é a hora da assinatura
// (/M), e só quando a pessoa assina (buildPdfToSign).
import { textWidth, winAnsiCode } from './fonts.js';

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

// Conteúdo de uma página de texto. Os itens vêm com a origem no canto superior esquerdo;
// no PDF ela fica no inferior, por isso y vira height - y.
function textContent(page, fontNames, imageNames) {
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
  return ops.join('\n');
}

const OCR_FONT = 'Helvetica';

// Texto que veio do OCR, só com caracteres da WinAnsi: o que as fontes padrão não têm vira "?".
const ocrText = (text) => [...text].map((char) => (winAnsiCode(char) === undefined ? '?' : char)).join('');

// String hexadecimal (<...>): o texto reconhecido na imagem nunca entra cru no conteúdo da página, então um ")"
// ou uma "\" lida na foto não tem como quebrar o PDF.
const hexString = (text) => `<${[...text].map((char) => winAnsiCode(char).toString(16).padStart(2, '0')).join('')}>`;

/**
 * Camada de texto invisível (3 Tr) do OCR, em cima da foto: cada palavra na posição em que aparece na imagem.
 * O tamanho da letra sai da altura da linha, e a largura é ajustada com Tz para a seleção cair em cima da palavra.
 * Entre as palavras da mesma linha vai um espaço, esticado até a próxima, para copiar e colar sair com espaços.
 * @param {import('./ocr.js').OcrWord[]} words medidas de 0 a 1 relativas à imagem
 * @param {{x: number, y: number, w: number, h: number}} box posição da imagem na página
 */
function ocrLayer(words, box, fontName) {
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const ops = ['BT', '3 Tr'];
  let tf = '';
  let tz = '100';
  words.forEach((word, i) => {
    const next = word.last ? null : words[i + 1];
    const text = ocrText(word.text) + (next ? ' ' : '');
    const size = Math.max(1, word.size * box.h);
    const x0 = clamp(word.x0);
    const end = clamp(next ? Math.max(word.x1, next.x0) : word.x1);
    const natural = textWidth(text, OCR_FONT, size);
    const scale = natural > 0 ? Math.min(1000, Math.max(1, (100 * (end - x0) * box.w) / natural)) : 100;
    const font = `${fontName} ${num(size)} Tf`;
    if (font !== tf) ops.push((tf = font));
    if (num(scale) !== tz) ops.push(`${(tz = num(scale))} Tz`);
    ops.push(`1 0 0 1 ${num(box.x + x0 * box.w)} ${num(box.y + (1 - clamp(word.baseline)) * box.h)} Tm ${hexString(text)} Tj`);
  });
  ops.push('ET');
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
 * - foto: {jpeg: Uint8Array, width, height, box: {x, y, w, h}, ocr?}, com a imagem posicionada em box
 *   (origem no canto inferior esquerdo) e ocr = palavras reconhecidas (ocr.js), que viram texto invisível;
 * - texto: {width, height, items, rotation?}, com items vindos de layout.js: {type: 'text', x, y, text, font,
 *   size, color?, wordSpacing?, rise?}, {type: 'line', x1, x2, y (ou y1 e y2), width, color?}, {type: 'rect', x, y,
 *   w, h, color} e {type: 'image', jpeg, x, y, w, h}, origem no canto superior esquerdo e y do texto na linha
 *   de base. A mesma imagem (o mesmo Uint8Array) usada em várias páginas é gravada uma vez só.
 *   rotation (0, 90, 180 ou 270) vira /Rotate.
 * - copiada: {copy: {source, page}, rotation?}, com source = {objects} e page = descritor de copyPages
 *   (pdf-reader.js). Páginas do mesmo source compartilham os objetos (fontes, imagens), gravados uma vez só.
 * Medidas em pontos (1/72 pol.).
 * @returns {Uint8Array}
 */
export function buildPdf(pages) {
  return assemble(pages).bytes;
}

/**
 * Monta o PDF com o espaço da assinatura digital (PAdES): campo de assinatura invisível na primeira página,
 * dicionário /Sig com o /ByteRange já preenchido e o /Contents em zeros, para o cms.js preencher (fillSignature).
 * Sem /Name, /Reason, /Location nem /ContactInfo: só a hora da assinatura (/M), que faz parte do padrão.
 * @param {object[]} pages as mesmas de buildPdf
 * @param {{reserve: number, time: Date}} signature reserve: bytes reservados para o CMS
 * @returns {{bytes: Uint8Array, byteRange: number[], contents: {at: number, length: number}}} contents: posição
 *   e tamanho (em dígitos hexadecimais) do espaço da assinatura, entre o < e o >
 */
export function buildPdfToSign(pages, signature) {
  if (!(signature?.reserve > 0) || !(signature.time instanceof Date)) throw new Error('Assinatura sem espaço ou sem hora');
  return assemble(pages, signature);
}

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

function assemble(pages, signature) {
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

  // Objetos das páginas copiadas: cada PDF de origem ganha uma faixa de números, depois das fontes.
  const sources = new Map();
  for (const page of pages) {
    if (!page.copy || sources.has(page.copy.source)) continue;
    sources.set(page.copy.source, nextId);
    nextId += page.copy.source.objects.length;
  }
  const parts = (list, base) => list.map((part) => (part?.ref !== undefined ? `${base + part.ref} 0 R` : part));

  // Assinatura: campo (widget) e dicionário /Sig, os dois últimos objetos.
  const widgetId = signature ? nextId++ : 0;
  const sigId = signature ? nextId++ : 0;

  // Página copiada pode usar recursos de versões mais novas do formato (transparência, JPEG 2000…). A assinatura
  // no padrão PAdES (/ETSI.CAdES.detached) também é do PDF 1.7 em diante.
  push(sources.size || signature ? '%PDF-1.7\n' : '%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marca de arquivo binário

  object(1, signature
    ? `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${widgetId} 0 R] /SigFlags 3 >> >>`
    : '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);

  pages.forEach((page, i) => {
    const id = pageIds[i];
    const mediaBox = `/MediaBox [0 0 ${num(page.width)} ${num(page.height)}]`;
    const annots = signature && i === 0 ? ` /Annots [${widgetId} 0 R]` : '';

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

    if (!page.jpeg) {
      const used = new Set(page.items.filter((item) => item.type === 'text').map((item) => item.font));
      const fonts = [...used].map((font) => ` ${fontNames.get(font)} ${fontIds.get(font)} 0 R`).join('');
      const pictures = [...new Set(page.items.filter((item) => item.type === 'image').map((item) => item.jpeg))]
        .map((jpeg) => ` ${imageNames.get(jpeg)} ${imageIds.get(jpeg)} 0 R`).join('');
      const rotate = page.rotation ? ` /Rotate ${page.rotation}` : '';
      const content = textContent(page, fontNames, imageNames); // só ASCII: o tamanho em caracteres é o tamanho em bytes
      object(id,
        `<< /Type /Page /Parent 2 0 R ${mediaBox}${rotate}` +
        ` /Resources <<${fonts ? ` /Font <<${fonts} >>` : ''}${pictures ? ` /XObject <<${pictures} >>` : ''} >> /Contents ${id + 1} 0 R${annots} >>`);
      object(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      return;
    }

    const { x, y, w, h } = page.box;
    const ocr = page.ocr?.length ? fontNames.get(OCR_FONT) : null;
    let content = `q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /Im0 Do Q`;
    if (ocr) content += `\n${ocrLayer(page.ocr, page.box, ocr)}`; // só ASCII, como o das páginas de texto
    const font = ocr ? ` /Font << ${ocr} ${fontIds.get(OCR_FONT)} 0 R >>` : '';

    object(id,
      `<< /Type /Page /Parent 2 0 R ${mediaBox}` +
      ` /Resources << /XObject << /Im0 ${id + 2} 0 R >>${font} >> /Contents ${id + 1} 0 R${annots} >>`);
    object(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    object(id + 2, ...imageObject(page.jpeg));
  });

  for (const [font, id] of fontIds) {
    object(id, `<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`);
  }
  for (const [jpeg, id] of imageIds) object(id, ...imageObject(jpeg));
  for (const [source, base] of sources) {
    source.objects.forEach((list, i) => object(base + i, ...parts(list, base)));
  }

  // Campo de assinatura invisível (/Rect zerado), que só imprime e não se mexe (/F 132 = Print + Locked).
  let byteRangeAt = 0;
  let contentsAt = 0;
  if (signature) {
    object(widgetId, `<< /Type /Annot /Subtype /Widget /FT /Sig /T (Assinatura) /F 132 /Rect [0 0 0 0] /P ${pageIds[0]} 0 R /V ${sigId} 0 R >>`);
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
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let pos = 0;
  for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
  if (!signature) return { bytes: out };

  // /ByteRange: do começo até o "<" do /Contents e do ">" até o fim. Os números ocupam o espaço reservado
  // (o que sobra fica em branco antes do "]"), então nenhum offset do arquivo muda.
  const after = contentsAt + signature.reserve * 2 + 2;
  const byteRange = [0, contentsAt, after, out.length - after];
  const text = `[${byteRange.join(' ')}`;
  out.set(encoder.encode(`${text.padEnd(BYTE_RANGE_SPACE.length - 1)}]`), byteRangeAt);
  return { bytes: out, byteRange, contents: { at: contentsAt + 1, length: signature.reserve * 2 } };
}

const BYTE_RANGE_SPACE = '[0 0000000000 0000000000 0000000000]';

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
