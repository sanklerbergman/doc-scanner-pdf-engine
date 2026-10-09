// Descompactação com o DecompressionStream do próprio navegador, sem dependências.
// Usada pelo leitor de ZIP (.docx) e pelo leitor de PDF. Para assim que a saída passa do limite:
// um arquivo pequeno que descompacta para gigabytes ("bomba de compressão") não chega a encher a memória.

export class InflateError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason; // 'corrupted', 'too-big' ou 'unsupported'
  }
}

/**
 * @param {Uint8Array} raw
 * @param {'deflate' | 'deflate-raw'} format deflate = com cabeçalho zlib (PDF); deflate-raw = sem (ZIP)
 * @param {number} limit tamanho máximo da saída, em bytes
 * @param {{lenient?: boolean}} [options] lenient: se o fluxo quebrar no fim (checksum faltando, comum em PDF),
 *   devolve o que já saiu em vez de recusar
 */
export async function inflate(raw, format, limit, { lenient = false } = {}) {
  if (typeof DecompressionStream !== 'function') {
    throw new InflateError('Este navegador não consegue abrir o arquivo. Atualize o navegador e tente de novo.', 'unsupported');
  }
  const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    let result;
    try {
      result = await reader.read();
    } catch {
      if (lenient && length) break;
      throw new InflateError('O arquivo está corrompido ou incompleto.', 'corrupted');
    }
    if (result.done) break;
    length += result.value.length;
    if (length > limit) {
      reader.cancel().catch(() => {});
      throw new InflateError('O arquivo é grande demais depois de descompactado.', 'too-big');
    }
    chunks.push(result.value);
  }
  const out = new Uint8Array(length);
  let pos = 0;
  for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
  return out;
}
