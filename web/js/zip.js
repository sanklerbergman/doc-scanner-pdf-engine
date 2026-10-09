// Leitor de ZIP mínimo, sem dependências: o necessário para abrir um .docx (que é um ZIP de arquivos XML).
// Lê o diretório central no fim do arquivo e descompacta com o DecompressionStream do próprio navegador.
// Contra "ZIP bomb" (arquivo pequeno que descompacta para gigabytes), há limite de entradas e de tamanho
// descompactado por arquivo e no total; o limite vale para o que sai de fato, não para o que o ZIP declara.

import { inflate, InflateError } from './inflate.js';

export const ZIP_LIMITS = {
  maxEntries: 10000,
  maxFileSize: 32 * 1024 * 1024,
  maxTotalSize: 128 * 1024 * 1024,
};

export class ZipError extends Error {}

const CORRUPTED = 'O arquivo está corrompido ou incompleto.';
const TOO_BIG = 'O arquivo é grande demais depois de descompactado.';

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

let crcTable;

export function crc32(bytes) {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Abre um ZIP que já está na memória.
 * @param {Uint8Array} bytes
 * @param {Partial<typeof ZIP_LIMITS>} [limits]
 * @returns {{names: string[], has: (name: string) => boolean,
 *            read: (name: string) => Promise<Uint8Array>, readText: (name: string) => Promise<string>}}
 */
export function openZip(bytes, limits = {}) {
  const { maxEntries, maxFileSize, maxTotalSize } = { ...ZIP_LIMITS, ...limits };

  // Fim do diretório central (PK 5 6): nos últimos 22 bytes, ou antes deles se o ZIP tiver comentário.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(bytes, i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new ZipError('O arquivo não é um ZIP válido.');

  const count = u16(bytes, end + 10);
  const dirOffset = u32(bytes, end + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipError('ZIP64 não é suportado.');
  if (count > maxEntries) throw new ZipError('O arquivo tem itens demais.');

  const decoder = new TextDecoder();
  const entries = new Map();
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > end || u32(bytes, p) !== 0x02014b50) throw new ZipError(CORRUPTED);
    const nameLength = u16(bytes, p + 28);
    const entry = {
      flags: u16(bytes, p + 8),
      method: u16(bytes, p + 10),
      crc: u32(bytes, p + 16),
      compressedSize: u32(bytes, p + 20),
      size: u32(bytes, p + 24),
      localOffset: u32(bytes, p + 42),
    };
    entries.set(decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)), entry);
    p += 46 + nameLength + u16(bytes, p + 30) + u16(bytes, p + 32);
  }

  let total = 0;

  async function read(name) {
    const entry = entries.get(name);
    if (!entry) throw new ZipError(`Falta ${name} dentro do arquivo.`);
    if (entry.flags & 1) throw new ZipError('O arquivo está protegido por senha.');
    if (entry.size > maxFileSize || total + entry.size > maxTotalSize) throw new ZipError(TOO_BIG);

    const local = entry.localOffset;
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw new ZipError(CORRUPTED);
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    if (start + entry.compressedSize > bytes.length) throw new ZipError(CORRUPTED);
    const raw = bytes.subarray(start, start + entry.compressedSize);

    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) data = await inflateEntry(raw, Math.min(maxFileSize, maxTotalSize - total));
    else throw new ZipError('O arquivo usa uma compressão que não é suportada.');

    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new ZipError(CORRUPTED);
    total += data.length;
    return data;
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    readText: async (name) => decodeText(await read(name)),
  };
}

async function inflateEntry(raw, limit) {
  try {
    return await inflate(raw, 'deflate-raw', limit);
  } catch (err) {
    if (err instanceof InflateError) throw new ZipError(err.message);
    throw err;
  }
}

// XML do Office: UTF-8 quase sempre; UTF-16 se começar com a marca de ordem dos bytes.
function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder().decode(bytes);
}
