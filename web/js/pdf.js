// Gerador de PDF mínimo, sem dependências.
// Só embute imagens JPEG (filtro DCTDecode): o JPEG entra no PDF byte a byte,
// sem recompressão. Nenhum metadado é gravado (sem /Info, sem datas, sem "Producer").

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

/**
 * Monta um PDF com uma imagem por página.
 * @param {{jpeg: Uint8Array, width: number, height: number,
 *          box: {x: number, y: number, w: number, h: number}}[]} pages
 *   width/height da página e box da imagem em pontos (1/72 pol.), origem no canto inferior esquerdo.
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

  // Objetos: 1 catálogo, 2 árvore de páginas, depois 3 por página (página, conteúdo, imagem).
  const pageId = (i) => 3 + i * 3;

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marca de arquivo binário

  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`);

  pages.forEach((page, i) => {
    const info = readJpegInfo(page.jpeg);
    const colorSpace = COLOR_SPACES[info.components];
    if (!colorSpace) throw new Error(`JPEG com ${info.components} componentes não é suportado`);

    const id = pageId(i);
    const { x, y, w, h } = page.box;
    const content = `q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /Im0 Do Q`;

    object(id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}]` +
      ` /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    object(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    object(id + 2,
      `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height}` +
      ` /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      page.jpeg,
      '\nendstream');
  });

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
