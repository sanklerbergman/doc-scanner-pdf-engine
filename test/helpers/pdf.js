// Monta PDFs pequenos para os testes do leitor, imitando o que outros programas gravam:
// tabela xref clássica ou em stream (com preditor PNG), object streams e atualizações incrementais.
// Independente do gerador do app (web/js/pdf.js), com o zlib do Node.
import { readFileSync } from 'node:fs';
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

/**
 * Amostras para o fuzzing (scripts/fuzz-pdf.mjs e test/pdf-fuzz.test.js): cada uma passa por uma parte diferente
 * do leitor, da cópia de páginas e da compressão.
 * @returns {Record<string, Uint8Array>}
 */
export function samplePdfs() {
  const jpeg = new Uint8Array(readFileSync(new URL('../fixtures/rgb-40x30.jpg', import.meta.url)));
  const pixels = Uint8Array.from({ length: 8 * 6 * 3 }, (_, i) => (i * 37) % 256);
  const base = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    ...textPageObjects('Texto'),
  };
  const first = makeRawPdf(base);
  return {
    'xref-classica': first.bytes,
    'xref-stream': makeRawPdf(base, { xref: 'stream', packed: [1, 2, 3, 5] }).bytes,
    incremental: makeRawPdf({ 4: { data: 'BT /F1 24 Tf 72 720 Td (Novo) Tj ET', deflate: true } }, { start: first.bytes, prev: first.xrefOffset }).bytes,
    arvore: makeRawPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [6 0 R 3 0 R] /Count 3 /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> >>',
      3: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Rotate 90 /CropBox [10 10 310 410] >>',
      4: { data: 'BT /F1 12 Tf (x) Tj ET', deflate: true },
      5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      6: '<< /Type /Pages /Parent 2 0 R /Kids [7 0 R 8 0 R] /Count 2 /Rotate 180 >>',
      7: '<< /Type /Page /Parent 6 0 R /Contents [4 0 R 4 0 R] >>',
      8: '<< /Type /Page /Parent 6 0 R /Contents 4 0 R /MediaBox [0 0 200 100] /Rotate -90 >>',
    }, { xref: 'stream', packed: [2, 3, 6] }).bytes,
    anotacoes: makeRawPdf({
      1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [9 0 R 11 0 R] /SigFlags 3 >> /OpenAction 20 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      ...textPageObjects('Formulario', { extra: ' /Annots [10 0 R 11 0 R 12 0 R]' }),
      9: '<< /FT /Sig /T (Assinatura1) /V 13 0 R >>',
      10: '<< /Type /Annot /Subtype /Link /Rect [0 0 100 20] /A << /S /URI /URI (https://exemplo.invalid) >> >>',
      11: '<< /Type /Annot /Subtype /Widget /FT /Btn /T (marca) /F 4 /Rect [100 600 120 620] /AS /Sim /AP << /N << /Sim 14 0 R /Off 14 0 R >> >> >>',
      12: '<< /Type /Annot /Subtype /Widget /FT /Tx /F 4 /Rect [100 500 300 520] /AP << /N 14 0 R >> >>',
      13: '<< /Type /Sig /Filter /Adobe.PPKLite /Contents <00> >>',
      14: { dict: '/BBox [0 0 20 20] /Matrix [0 1 -1 0 20 0] /Resources << /Font << /F1 5 0 R >> >>', data: 'BT /F1 12 Tf 2 5 Td (X) Tj ET', deflate: true },
      20: '<< /S /JavaScript /JS (app.alert\(1\)) >>',
    }).bytes,
    camadas: makeRawPdf({
      1: '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R 8 0 R] /D << /OFF [6 0 R] >> >> >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /Properties << /oc1 6 0 R /oc2 9 0 R >> /XObject << /Fm1 7 0 R >> >> /Contents 4 0 R >>',
      4: {
        data: 'q BT /F1 24 Tf 72 700 Td (VISIVEL) Tj ET /OC /oc1 BDC BT /F1 24 Tf 72 600 Td (OCULTO) Tj ET 0 0 m 10 10 l S BI /W 1 /H 1 /CS /G /BPC 8 ID A EI EMC Q /OC /oc2 BDC /Fm1 Do EMC',
        deflate: true,
      },
      5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      6: '<< /Type /OCG /Name (Notas internas) >>',
      7: { dict: '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /OC 6 0 R /Resources << /Font << /F1 5 0 R >> >>', data: 'BT /F1 12 Tf (form) Tj ET', deflate: true },
      8: '<< /Type /OCG /Name (Ligada) >>',
      9: '<< /Type /OCMD /OCGs [6 0 R 8 0 R] /P /AnyOn /VE [/And 8 0 R [/Not 6 0 R]] >>',
    }).bytes,
    imagens: makeRawPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /XObject << /A 5 0 R /B 6 0 R /C 7 0 R >> >> >>',
      4: { data: 'q 100 0 0 100 0 0 cm /A Do Q q 100 0 0 100 100 0 cm /B Do Q q 100 0 0 100 200 0 cm /C Do Q' },
      5: { dict: '/Type /XObject /Subtype /Image /Width 8 /Height 6 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 8 0 R', data: pixels, deflate: true },
      6: { dict: '/Type /XObject /Subtype /Image /Width 40 /Height 30 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: jpeg },
      7: { dict: '/Type /XObject /Subtype /Image /Width 8 /Height 6 /ColorSpace [/ICCBased 9 0 R] /BitsPerComponent 8', data: pixels, deflate: true },
      8: { dict: '/Type /XObject /Subtype /Image /Width 8 /Height 6 /ColorSpace /DeviceGray /BitsPerComponent 8', data: pixels.subarray(0, 48), deflate: true },
      9: { dict: '/N 3', data: 'perfil' },
    }).bytes,
  };
}
