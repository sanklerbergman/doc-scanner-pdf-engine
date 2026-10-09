// Monta PDFs pequenos para os testes do leitor, imitando o que outros programas gravam:
// tabela xref clássica ou em stream (com preditor PNG), object streams e atualizações incrementais.
// Independente do gerador do app (web/js/pdf.js), com o zlib do Node.
import { deflateSync } from 'node:zlib';

const encoder = new TextEncoder();
const bytes = (value) => (typeof value === 'string' ? encoder.encode(value) : value);

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let pos = 0;
  for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
  return out;
}

// Corpo de um objeto: texto ("<< ... >>") ou stream {dict: '/Chave valor', data, deflate}.
function body(value) {
  if (typeof value === 'string') return bytes(value);
  const data = value.deflate ? new Uint8Array(deflateSync(bytes(value.data))) : bytes(value.data);
  const filter = value.deflate ? ' /Filter /FlateDecode' : '';
  return concat([bytes(`<< ${value.dict ?? ''}${filter} /Length ${data.length} >>\nstream\n`), data, bytes('\nendstream')]);
}

// Preditor PNG "Up" (tipo 2), como o Acrobat grava nas tabelas xref em stream.
function predictUp(rows, width) {
  const out = [];
  rows.forEach((row, r) => {
    out.push(2);
    for (let i = 0; i < width; i++) out.push((row[i] - (r ? rows[r - 1][i] : 0)) & 0xff);
  });
  return Uint8Array.from(out);
}

/**
 * @param {Record<number, string | {dict?: string, data: string | Uint8Array, deflate?: boolean}>} objects
 * @param {{xref?: 'table' | 'stream', packed?: number[], trailer?: string, prev?: number, start?: Uint8Array}} [options]
 *   packed: objetos que vão dentro de um object stream (exige xref 'stream').
 *   start/prev: para atualização incremental, os bytes do PDF anterior e o offset da xref dele.
 */
export function makeRawPdf(objects, { xref = 'table', packed = [], trailer = '/Root 1 0 R', prev, start } = {}) {
  const chunks = [start ?? bytes('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  let length = chunks[0].length;
  const push = (chunk) => { chunks.push(chunk); length += chunk.length; };
  const entries = new Map(); // num → [tipo, campo2, campo3]

  const loose = Object.entries(objects).filter(([num]) => !packed.includes(Number(num)));
  for (const [num, value] of loose) {
    entries.set(Number(num), [1, length, 0]);
    push(bytes(`${num} 0 obj\n`));
    push(body(value));
    push(bytes('\nendobj\n'));
  }

  const nums = Object.keys(objects).map(Number);
  let size = Math.max(0, ...nums) + 1;
  if (packed.length) {
    const streamNum = size++;
    let header = '';
    let content = '';
    packed.forEach((num, i) => {
      header += `${num} ${content.length} `;
      content += `${objects[num]}\n`;
      entries.set(num, [2, streamNum, i]);
    });
    entries.set(streamNum, [1, length, 0]);
    push(bytes(`${streamNum} 0 obj\n`));
    push(body({ dict: `/Type /ObjStm /N ${packed.length} /First ${header.length}`, data: header + content, deflate: true }));
    push(bytes('\nendobj\n'));
  }

  const xrefOffset = length;
  const prevPart = prev !== undefined ? ` /Prev ${prev}` : '';
  if (xref === 'table') {
    let table = 'xref\n';
    const sorted = [...entries.keys()].sort((a, b) => a - b);
    if (!start) table += '0 1\n0000000000 65535 f \n';
    for (const num of sorted) table += `${num} 1\n${String(entries.get(num)[1]).padStart(10, '0')} 00000 n \n`;
    push(bytes(`${table}trailer\n<< /Size ${size} ${trailer}${prevPart} >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  } else {
    const xrefNum = size++;
    entries.set(xrefNum, [1, xrefOffset, 0]);
    const rows = [];
    const index = [];
    for (const num of [...entries.keys()].sort((a, b) => a - b)) {
      const [type, a, b] = entries.get(num);
      rows.push([type, (a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >>> 8) & 255, b & 255]);
      index.push(num, 1);
    }
    const data = predictUp(rows, 7);
    push(bytes(`${xrefNum} 0 obj\n`));
    push(body({
      dict: `/Type /XRef /Size ${size} /W [1 4 2] /Index [${index.join(' ')}] ${trailer}${prevPart} /DecodeParms << /Predictor 12 /Columns 7 >>`,
      data, deflate: true,
    }));
    push(bytes(`\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`));
  }
  return { bytes: concat(chunks), xrefOffset };
}

// Página simples com texto em Helvetica.
export const textPageObjects = (text, { pages = 2, page = 3, content = 4, font = 5, extra = '' } = {}) => ({
  [page]: `<< /Type /Page /Parent ${pages} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R${extra} >>`,
  [content]: { data: `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`, deflate: true },
  [font]: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
});
