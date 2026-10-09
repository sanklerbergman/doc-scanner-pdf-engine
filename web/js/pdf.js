// Gerador de PDF mínimo, sem dependências. Dois tipos de página:
// - foto: imagem JPEG (filtro DCTDecode), que entra no PDF byte a byte, sem recompressão;
// - texto (documento do Word): texto de verdade, selecionável, com as fontes padrão do PDF
//   (Helvetica, Times e Courier, codificação WinAnsi), sem embutir fonte.
// Nenhum metadado é gravado (sem /Info, sem datas, sem "Producer").

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

// Números em PDF não aceitam notação exponencial; duas casas bastam.
const num = (v) => String(Math.round(v * 100) / 100);

// As 12 fontes padrão de texto que todo leitor de PDF tem (as outras duas são de símbolos).
export const STANDARD_FONTS = [
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
];

// WinAnsi: ASCII e Latin-1 (todos os acentos do português), mais estes 27 caracteres entre 0x80 e 0x9F.
const WIN_ANSI_EXTRA = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91],
  [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
  [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

// Código WinAnsi de um caractere, ou undefined se as fontes padrão não o têm.
export function winAnsiCode(char) {
  const code = char.codePointAt(0);
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return WIN_ANSI_EXTRA.get(code);
}

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
function textContent(page, fontNames) {
  const ops = ['BT'];
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
    const y = num(page.height - item.y);
    ops.push(`${num(item.width)} w ${num(item.x1)} ${y} m ${num(item.x2)} ${y} l S`);
  }
  return ops.join('\n');
}

/**
 * Monta um PDF. Cada página é de um destes tipos:
 * - foto: {jpeg: Uint8Array, width, height, box: {x, y, w, h}}, com a imagem posicionada em box
 *   (origem no canto inferior esquerdo);
 * - texto: {width, height, items, rotation?}, com items vindos de layout.js: {type: 'text', x, y, text, font,
 *   size, color?, wordSpacing?, rise?} e {type: 'line', x1, x2, y, width, color?}, origem no canto superior
 *   esquerdo e y na linha de base do texto. rotation (0, 90, 180 ou 270) vira /Rotate.
 * Medidas em pontos (1/72 pol.).
 * @returns {Uint8Array}
 */
export function buildPdf(pages) {
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
    nextId += page.jpeg ? 3 : 2;
  }
  const fontIds = new Map();
  const fontNames = new Map();
  for (const page of pages) {
    if (page.jpeg) continue;
    for (const item of page.items) {
      if (item.type !== 'text' || fontIds.has(item.font)) continue;
      if (!STANDARD_FONTS.includes(item.font)) throw new Error(`Fonte desconhecida: ${item.font}`);
      fontIds.set(item.font, nextId++);
      fontNames.set(item.font, `/F${fontIds.size}`);
    }
  }

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marca de arquivo binário

  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);

  pages.forEach((page, i) => {
    const id = pageIds[i];
    const mediaBox = `/MediaBox [0 0 ${num(page.width)} ${num(page.height)}]`;

    if (!page.jpeg) {
      const used = new Set(page.items.filter((item) => item.type === 'text').map((item) => item.font));
      const fonts = [...used].map((font) => ` ${fontNames.get(font)} ${fontIds.get(font)} 0 R`).join('');
      const rotate = page.rotation ? ` /Rotate ${page.rotation}` : '';
      const content = textContent(page, fontNames); // só ASCII: o tamanho em caracteres é o tamanho em bytes
      object(id,
        `<< /Type /Page /Parent 2 0 R ${mediaBox}${rotate}` +
        ` /Resources <<${fonts ? ` /Font <<${fonts} >>` : ''} >> /Contents ${id + 1} 0 R >>`);
      object(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      return;
    }

    const info = readJpegInfo(page.jpeg);
    const colorSpace = COLOR_SPACES[info.components];
    if (!colorSpace) throw new Error(`JPEG com ${info.components} componentes não é suportado`);

    const { x, y, w, h } = page.box;
    const content = `q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /Im0 Do Q`;

    object(id,
      `<< /Type /Page /Parent 2 0 R ${mediaBox}` +
      ` /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    object(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    object(id + 2,
      `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height}` +
      ` /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      page.jpeg,
      '\nendstream');
  });

  for (const [font, id] of fontIds) {
    object(id, `<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`);
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
  return out;
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
