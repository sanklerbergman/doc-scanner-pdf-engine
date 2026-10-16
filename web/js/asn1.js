// ASN.1, o formato dos certificados, do arquivo .pfx (PKCS#12) e da assinatura (CMS): leitor e escritor mínimos.
// O leitor aceita BER, porque o Windows e algumas certificadoras gravam o .pfx com comprimento indefinido e com
// strings em pedaços. O escritor só grava DER (a forma única que a assinatura exige).
// O arquivo vem de fora: limites de profundidade e de quantidade de elementos, e nada de ler além do fim.

export class Asn1Error extends Error {}

export const UNIVERSAL = 0;
export const CONTEXT = 2;

export const TAG = {
  BOOLEAN: 1, INTEGER: 2, BIT_STRING: 3, OCTET_STRING: 4, NULL: 5, OID: 6, UTF8_STRING: 12, SEQUENCE: 16, SET: 17,
  PRINTABLE_STRING: 19, T61_STRING: 20, IA5_STRING: 22, UTC_TIME: 23, GENERALIZED_TIME: 24, UNIVERSAL_STRING: 28,
  BMP_STRING: 30,
};

const MAX_DEPTH = 64;
const MAX_NODES = 200000;

/**
 * Elemento lido. content: os bytes do conteúdo (sem cabeçalho); der: o elemento inteiro, como está no arquivo.
 * @typedef {{cls: number, constructed: boolean, tag: number, content: Uint8Array, der: Uint8Array,
 *   children: Asn1Node[] | null}} Asn1Node
 */

/**
 * Lê um elemento que ocupa os bytes inteiros (sobra no fim é erro).
 * @param {Uint8Array} bytes
 * @returns {Asn1Node}
 */
export function parse(bytes) {
  const state = { nodes: 0 };
  const [node, end] = read(bytes, 0, bytes.length, 0, state);
  if (end !== bytes.length) throw new Asn1Error('Dados a mais depois do fim');
  return node;
}

function read(bytes, pos, limit, depth, state) {
  if (depth > MAX_DEPTH) throw new Asn1Error('Estrutura funda demais');
  if (++state.nodes > MAX_NODES) throw new Asn1Error('Estrutura grande demais');
  const start = pos;
  if (pos + 2 > limit) throw new Asn1Error('Fim inesperado');
  const first = bytes[pos++];
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    // Número de tag alto (raro aqui): base 128, até 4 bytes.
    tag = 0;
    for (let i = 0; ; i++) {
      if (pos >= limit || i > 3) throw new Asn1Error('Tag inválida');
      const b = bytes[pos++];
      tag = tag * 128 + (b & 0x7f);
      if (!(b & 0x80)) break;
    }
  }
  if (pos >= limit) throw new Asn1Error('Fim inesperado');
  let length = bytes[pos++];
  let indefinite = false;
  if (length === 0x80) {
    if (!constructed) throw new Asn1Error('Comprimento indefinido em elemento simples');
    indefinite = true;
  } else if (length > 0x80) {
    const count = length & 0x7f;
    if (count > 4 || pos + count > limit) throw new Asn1Error('Comprimento inválido');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[pos++];
  }
  const contentStart = pos;
  let children = null;
  let contentEnd;
  let end;
  if (indefinite) {
    children = [];
    for (;;) {
      if (pos + 2 > limit) throw new Asn1Error('Fim inesperado');
      if (bytes[pos] === 0 && bytes[pos + 1] === 0) {
        contentEnd = pos;
        end = pos + 2;
        break;
      }
      const [child, next] = read(bytes, pos, limit, depth + 1, state);
      children.push(child);
      pos = next;
    }
  } else {
    contentEnd = contentStart + length;
    end = contentEnd;
    if (contentEnd > limit) throw new Asn1Error('Elemento passa do fim');
    if (constructed) {
      children = [];
      while (pos < contentEnd) {
        const [child, next] = read(bytes, pos, contentEnd, depth + 1, state);
        children.push(child);
        pos = next;
      }
    }
  }
  return [{
    cls, constructed, tag, children,
    content: bytes.subarray(contentStart, contentEnd),
    der: bytes.subarray(start, end),
  }, end];
}

// Confere a classe e a tag de um elemento (universal, por padrão) e devolve o próprio elemento.
export function expect(node, tag, cls = UNIVERSAL, what = 'elemento') {
  if (!node || node.cls !== cls || node.tag !== tag) throw new Asn1Error(`Esperava ${what}`);
  return node;
}

// Filhos de uma SEQUENCE (ou SET), conferindo a tag.
export function sequence(node, tag = TAG.SEQUENCE, cls = UNIVERSAL) {
  expect(node, tag, cls, 'sequência');
  if (!node.children) throw new Asn1Error('Esperava sequência');
  return node.children;
}

// Bytes de uma OCTET STRING (ou de uma tag de contexto que a substitui), juntando os pedaços do BER.
export function octets(node, depth = 0) {
  if (!node.constructed) return node.content;
  if (depth > 8) throw new Asn1Error('String em pedaços demais');
  const parts = node.children.map((child) => octets(child, depth + 1));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
}

export function oid(node) {
  const bytes = expect(node, TAG.OID, UNIVERSAL, 'identificador (OID)').content;
  if (!bytes.length || bytes[bytes.length - 1] & 0x80) throw new Asn1Error('OID inválido');
  const parts = [];
  let value = 0;
  for (const b of bytes) {
    value = value * 128 + (b & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER / 128) throw new Asn1Error('OID inválido');
    if (!(b & 0x80)) {
      if (!parts.length) parts.push(value < 80 ? Math.floor(value / 40) : 2, value < 80 ? value % 40 : value - 80);
      else parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

// Inteiro pequeno (contagem de iterações, versão, tamanho de chave).
export function integer(node) {
  const bytes = expect(node, TAG.INTEGER, UNIVERSAL, 'inteiro').content;
  if (!bytes.length || bytes.length > 6 || bytes[0] & 0x80) throw new Asn1Error('Inteiro fora do esperado');
  return bytes.reduce((sum, b) => sum * 256 + b, 0);
}

// Inteiro grande (número de série, módulo RSA): os bytes sem o zero de sinal da frente.
export function unsigned(node) {
  const bytes = expect(node, TAG.INTEGER, UNIVERSAL, 'inteiro').content;
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return bytes.subarray(i);
}

export function bitString(node) {
  const bytes = expect(node, TAG.BIT_STRING, UNIVERSAL, 'BIT STRING').content;
  if (!bytes.length || bytes[0] > 7) throw new Asn1Error('BIT STRING inválida');
  return { unused: bytes[0], bytes: bytes.subarray(1) };
}

// UTCTime (AAMMDDhhmmssZ) e GeneralizedTime (AAAAMMDDhhmmssZ), como nos certificados.
export function time(node) {
  const text = String.fromCharCode(...node.content);
  let match;
  if (node.tag === TAG.UTC_TIME) {
    match = text.match(/^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/);
    if (match) match[1] = String((Number(match[1]) < 50 ? 2000 : 1900) + Number(match[1]));
  } else if (node.tag === TAG.GENERALIZED_TIME) {
    match = text.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(?:\.\d+)?Z$/);
  }
  if (node.cls !== UNIVERSAL || !match) throw new Asn1Error('Data inválida');
  const [, y, mo, d, h, mi, s = '0'] = match;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

// Texto dos nomes do certificado (CN, O…), nos tipos de string que aparecem por aí.
export function text(node) {
  const bytes = node.content;
  switch (node.tag) {
    case TAG.UTF8_STRING:
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    case TAG.BMP_STRING: {
      let out = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return out;
    }
    case TAG.UNIVERSAL_STRING: {
      let out = '';
      for (let i = 0; i + 3 < bytes.length; i += 4) {
        const code = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
        out += code <= 0x10ffff ? String.fromCodePoint(code) : '?';
      }
      return out;
    }
    default: // PrintableString, IA5String, T61String: ASCII e Latin-1
      return String.fromCharCode(...bytes);
  }
}

// ---------- Escritor (DER) ----------

function lengthBytes(length) {
  if (length < 0x80) return [length];
  const out = [];
  for (let v = length; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return [0x80 | out.length, ...out];
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
};

/**
 * Um elemento em DER.
 * @param {number} identifier o primeiro byte (classe, construído e tag), ex.: 0x30 para SEQUENCE
 * @param {Uint8Array | Uint8Array[]} content
 */
export function der(identifier, content) {
  const body = Array.isArray(content) ? concat(content) : content;
  return concat([Uint8Array.from([identifier, ...lengthBytes(body.length)]), body]);
}

export const seq = (...items) => der(0x30, items);

// SET OF em DER: os elementos em ordem crescente dos bytes (X.690, 11.6).
export function set(...items) {
  const sorted = [...items].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  });
  return der(0x31, sorted);
}

export const octetString = (bytes) => der(0x04, bytes);
export const nullValue = () => Uint8Array.from([0x05, 0x00]);

// Tag de contexto [n], construída (EXPLICIT ou IMPLICIT de uma sequência/conjunto).
export const context = (n, ...items) => der(0xa0 | n, items);

export function encodeOid(text) {
  const parts = text.split('.').map(Number);
  const values = [parts[0] * 40 + parts[1], ...parts.slice(2)];
  const out = [];
  for (const value of values) {
    const chunk = [value & 0x7f];
    for (let v = Math.floor(value / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return der(0x06, Uint8Array.from(out));
}

// INTEGER a partir de um número pequeno ou dos bytes sem sinal (com o zero da frente quando precisa).
export function encodeInteger(value) {
  let bytes;
  if (typeof value === 'number') {
    const out = [];
    for (let v = value; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
    bytes = out.length ? out : [0];
  } else {
    let i = 0;
    while (i < value.length - 1 && value[i] === 0) i++;
    bytes = [...value.subarray(i)];
  }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return der(0x02, Uint8Array.from(bytes));
}
