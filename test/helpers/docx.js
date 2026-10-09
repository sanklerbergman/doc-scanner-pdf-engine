// Monta ZIPs e .docx pequenos para os testes, com o zlib do Node (independente do leitor do app).
import { deflateRawSync, crc32 } from 'node:zlib';

const encoder = new TextEncoder();

/**
 * @param {Record<string, string | Uint8Array | {data: string | Uint8Array, store?: boolean,
 *         declaredSize?: number, encrypted?: boolean}>} files
 * @param {{store?: boolean}} [options] store: grava sem compressão
 */
export function makeZip(files, { store = false } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const spec = typeof value === 'string' || value instanceof Uint8Array ? { data: value } : value;
    const data = typeof spec.data === 'string' ? encoder.encode(spec.data) : spec.data;
    const stored = spec.store ?? store;
    const body = stored ? data : new Uint8Array(deflateRawSync(data));
    const nameBytes = encoder.encode(name);
    const flags = 0x0800 | (spec.encrypted ? 1 : 0);
    const size = spec.declaredSize ?? data.length;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt16LE(0x21, 12); // 1º de janeiro de 1980
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, ...central, end]));
}

export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = `xmlns:w="${W}" xmlns:r="${R}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
  ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"' +
  ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml"';

const relationships = (list) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  list.map(([id, type, target, external]) =>
    `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`).join('') +
  '</Relationships>';

/**
 * Arquivos de um .docx mínimo. Os trechos são o miolo de cada XML (sem o elemento raiz).
 * @param {{body?: string, styles?: string, numbering?: string, settings?: string, theme?: {major: string, minor: string},
 *          headers?: Record<string, string>, extra?: Record<string, string>, documentXml?: string}} parts
 */
export function docxFiles({ body = '', styles, numbering, settings, theme, headers = {}, extra = {}, documentXml } = {}) {
  const docRels = [];
  const files = {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': relationships([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': documentXml ?? `${XML}<w:document ${NS}><w:body>${body}</w:body></w:document>`,
  };
  if (styles !== undefined) {
    files['word/styles.xml'] = `${XML}<w:styles ${NS}>${styles}</w:styles>`;
    docRels.push(['rId10', 'styles', 'styles.xml']);
  }
  if (numbering !== undefined) {
    files['word/numbering.xml'] = `${XML}<w:numbering ${NS}>${numbering}</w:numbering>`;
    docRels.push(['rId11', 'numbering', 'numbering.xml']);
  }
  if (settings !== undefined) {
    files['word/settings.xml'] = `${XML}<w:settings ${NS}>${settings}</w:settings>`;
    docRels.push(['rId12', 'settings', 'settings.xml']);
  }
  if (theme) {
    files['word/theme/theme1.xml'] = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">` +
      `<a:themeElements><a:fontScheme name="Office"><a:majorFont><a:latin typeface="${theme.major}"/></a:majorFont>` +
      `<a:minorFont><a:latin typeface="${theme.minor}"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
    docRels.push(['rId13', 'theme', 'theme/theme1.xml']);
  }
  for (const [id, content] of Object.entries(headers)) {
    files[`word/${id}.xml`] = `${XML}<w:hdr ${NS}>${content}</w:hdr>`;
    docRels.push([id, 'header', `${id}.xml`]);
  }
  docRels.push(['rId99', 'image', 'https://exemplo.invalid/foto.png', true]); // link externo: deve ser ignorado
  files['word/_rels/document.xml.rels'] = relationships(docRels);
  return { ...files, ...extra };
}

export const makeDocx = (parts) => makeZip(docxFiles(parts));

// Parágrafo simples: texto com formatação opcional.
export const p = (text, { pPr = '', rPr = '' } = {}) =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
