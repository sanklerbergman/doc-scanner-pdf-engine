// PDF com senha (mecanismo padrão do PDF, revisões 2 a 6): abrir PDFs protegidos e proteger o PDF gerado.
// Carregado só quando aparece um PDF com senha ou quando a pessoa liga "Proteger o PDF com senha".
//
// O navegador faz o AES (Web Crypto) e os hashes SHA. Aqui ficam só o que o Web Crypto não tem: o MD5 e o RC4,
// usados pelos PDFs antigos (revisões 2 a 4). Os dois são fracos e só servem para LER esses arquivos; o PDF
// protegido pelo app usa AES-256 (revisão 6).
//
// A senha e a chave só existem na memória durante a operação: depois de abrir, o PDF fica decifrado e a chave
// é descartada. Nada vai para o console. As restrições do autor (imprimir, alterar, juntar) não são aplicadas
// (decisão do dono em 2026-10-16): o app só avisa que o PDF novo sai sem elas.
import { Parser, PdfDict, PdfStream, PdfString, PdfName, PdfRef, PdfError, Keyword, isName, formatNumber, formatName, formatString } from './pdf-reader.js';
import { finishSignature, BYTE_RANGE_SPACE } from './pdf.js';

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

// Falta a senha, ou a senha não confere. wrong: uma senha foi digitada e não serviu.
export class PdfPasswordError extends PdfError {
  name = 'PdfPasswordError';
  constructor(wrong) {
    super(wrong ? 'A senha não confere.' : 'O PDF está protegido por senha.');
    this.wrong = wrong;
  }
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
};
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

// ---------- MD5 (RFC 1321) ----------

const MD5_SHIFT = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Int32Array.from([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

export function md5(bytes) {
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(total);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const view = new DataView(data.buffer);
  view.setUint32(total - 8, bits >>> 0, true);
  view.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476];
  const m = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getInt32(off + i * 4, true);
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const s = MD5_SHIFT[(i >> 4) * 4 + (i & 3)];
      f = (f + a + MD5_K[i] + m[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((f << s) | (f >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => outView.setInt32(i * 4, v, true));
  return out;
}

// ---------- RC4 ----------

export function rc4(key, data) {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

// ---------- AES (Web Crypto) ----------

const aesKey = (raw) => subtle.importKey('raw', raw, 'AES-CBC', false, ['encrypt', 'decrypt']);

// AES-CBC sem preenchimento (dados com tamanho múltiplo de 16). O Web Crypto sempre acrescenta um bloco de
// preenchimento ao cifrar; no CBC, os blocos de antes não mudam, então basta tirar o último.
async function aesEncryptRaw(key, iv, data) {
  const out = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, key, data));
  return out.subarray(0, data.length);
}

// Decifra sem conferir o preenchimento: acrescenta um bloco de preenchimento válido (cifrado a partir do último
// bloco), que o navegador confere e tira, e devolve o resto como está.
async function aesDecryptRaw(key, iv, data) {
  if (!data.length) return new Uint8Array(0);
  // O bloco "16 × 0x10" cifrado encadeado no último bloco: decifrado depois dele, volta a ser 16 × 0x10.
  const pad = await aesEncryptRaw(key, data.subarray(data.length - 16), new Uint8Array(16).fill(16));
  return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, key, concat(data, pad)));
}

// String ou stream cifrado com AES: vetor inicial nos 16 primeiros bytes. Preenchimento errado (acontece em PDFs
// gerados por programas descuidados) não impede a leitura.
async function aesDecrypt(key, data) {
  if (data.length < 32) return new Uint8Array(0);
  const iv = data.subarray(0, 16);
  const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, key, body));
  } catch {
    const raw = await aesDecryptRaw(key, iv, body);
    const pad = raw[raw.length - 1];
    return pad >= 1 && pad <= 16 && raw.subarray(raw.length - pad).every((b) => b === pad) ? raw.subarray(0, raw.length - pad) : raw;
  }
}

// Cifra com AES-CBC, vetor inicial aleatório na frente, preenchimento PKCS#7 (como o PDF pede).
async function aesEncrypt(key, data) {
  const iv = random(16);
  return concat(iv, new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, key, data)));
}

const sha = async (name, data) => new Uint8Array(await subtle.digest(name, data));

// ---------- Senha ----------

// Senha das revisões 2 a 4: Latin-1 (PDFDocEncoding), no máximo 32 bytes, completada com o preenchimento padrão.
const PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
const pad32 = (bytes) => concat(bytes.subarray(0, 32), PADDING.subarray(0, Math.max(0, 32 - bytes.length)));

// As formas da senha que vale tentar nas revisões 2 a 4: Latin-1 e, se tiver caractere fora dele, UTF-8.
function legacyPasswords(password) {
  const latin = Uint8Array.from([...password].filter((c) => c.charCodeAt(0) < 256), (c) => c.charCodeAt(0));
  const utf8 = encoder.encode(password);
  return equal(latin, utf8) ? [latin] : [latin, utf8];
}

// Senha das revisões 5 e 6: SASLprep (RFC 4013, simplificado: espaços especiais viram espaço, o que é "mapeado
// para nada" sai, e normalização NFKC) e UTF-8, no máximo 127 bytes.
export function preparePassword(password) {
  const prepared = password
    .replace(/[   -​  　]/g, ' ')
    .replace(/[­͏᠆᠋-᠍​-‍⁠︀-️﻿]/g, '')
    .normalize('NFKC');
  let bytes = encoder.encode(prepared);
  if (bytes.length > 127) {
    bytes = bytes.subarray(0, 127);
    while (bytes.length && (bytes[bytes.length - 1] & 0xc0) === 0x80) bytes = bytes.subarray(0, bytes.length - 1); // não corta um caractere
    if (bytes.length && bytes[bytes.length - 1] >= 0xc0) bytes = bytes.subarray(0, bytes.length - 1);
  }
  return bytes;
}

// Hash da senha nas revisões 5 (SHA-256) e 6 (algoritmo 2.B da ISO 32000-2).
async function hash2B(password, salt, udata, revision) {
  let k = await sha('SHA-256', concat(password, salt, udata));
  if (revision < 6) return k;
  let e = new Uint8Array(0);
  for (let i = 0; i < 64 || e[e.length - 1] > i - 32; i++) {
    const unit = concat(password, k, udata);
    const k1 = new Uint8Array(unit.length * 64);
    for (let r = 0; r < 64; r++) k1.set(unit, r * unit.length);
    e = await aesEncryptRaw(await aesKey(k.subarray(0, 16)), k.subarray(16, 32), k1);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j];
    k = await sha(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], e);
  }
  return k.subarray(0, 32);
}

// ---------- Abrir ----------

const bytesOf = (value) => (value instanceof PdfString ? value.bytes : new Uint8Array(0));

/**
 * Confere a senha e devolve o que decifra o PDF.
 * @param {PdfDict} encrypt o dicionário /Encrypt, já resolvido
 * @param {Uint8Array} id o primeiro elemento do /ID do trailer (vazio se não houver)
 * @param {string | null} password null: tenta só a senha vazia
 * @returns {Promise<{decrypt: (value: any, num: number, gen: number) => Promise<any>, hadPassword: boolean,
 *   restricted: boolean}>}
 */
export async function openSecurity(encrypt, id, password, resolve = (v) => v) {
  const get = (key) => resolve(encrypt.get(key));
  const filter = get('Filter');
  if (!isName(filter, 'Standard')) {
    throw new PdfError('Este PDF foi protegido com certificado digital ou com um programa específico, e o app só abre PDF protegido por senha.');
  }
  const v = get('V') ?? 0;
  const r = get('R') ?? 0;
  if (![1, 2, 4, 5].includes(v) || r < 2 || r > 6) throw new PdfError('Este PDF usa um tipo de proteção que o app não conhece.');
  const p = get('P') ?? -1;
  const o = bytesOf(get('O'));
  const u = bytesOf(get('U'));
  const encryptMetadata = get('EncryptMetadata') !== false;
  let length = v === 1 ? 5 : Math.round((get('Length') ?? (v === 4 ? 128 : 40)) / 8);
  if (v === 5) length = 32;
  else length = Math.min(16, Math.max(5, length || 5));

  // Métodos de cada tipo de dado: RC4, AES de 128 bits (chave por objeto) ou AES de 256 (chave única).
  const methods = { Identity: 'none' };
  let streamMethod = 'rc4';
  let stringMethod = 'rc4';
  if (v >= 4) {
    const filters = resolve(encrypt.get('CF'));
    const methodOf = (name) => {
      if (!name || name === 'Identity') return 'none';
      const cf = filters instanceof PdfDict ? resolve(filters.get(name)) : null;
      const cfm = cf instanceof PdfDict ? resolve(cf.get('CFM')) : null;
      if (isName(cfm, 'AESV2')) return 'aes128';
      if (isName(cfm, 'AESV3')) return 'aes256';
      if (isName(cfm, 'V2')) return 'rc4';
      return 'none';
    };
    const stmF = get('StmF');
    const strF = get('StrF');
    streamMethod = methodOf(stmF instanceof PdfName ? stmF.value : null);
    stringMethod = methodOf(strF instanceof PdfName ? strF.value : null);
    if (filters instanceof PdfDict) for (const name of filters.keys()) methods[name] = methodOf(name);
    // Só os anexos são cifrados (/EFF): o documento abre sem senha, e anexo não vai para o PDF novo.
    if (encrypt.has('EFF') && streamMethod === 'none' && stringMethod === 'none') {
      return { decrypt: async (value) => value, hadPassword: false, restricted: false };
    }
  }

  const attempts = password === null || password === '' ? [''] : ['', password];
  let fileKey = null;
  let used = null;
  for (const attempt of attempts) {
    fileKey = r >= 5
      ? await keyR6(attempt, encrypt, get, r)
      : await keyR4(attempt, { r, o, u, p, id, length, encryptMetadata });
    if (fileKey) {
      used = attempt;
      break;
    }
  }
  if (!fileKey) throw new PdfPasswordError(password !== null && password !== '');

  // Chave de cada objeto: nas revisões 2 a 4, MD5 da chave do arquivo com o número do objeto.
  const objectKey = (num, gen, aes) => {
    if (v === 5) return fileKey;
    const extra = Uint8Array.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
    return md5(concat(fileKey, extra, aes ? encoder.encode('sAlT') : new Uint8Array(0))).subarray(0, Math.min(fileKey.length + 5, 16));
  };
  // Chave AES importada no Web Crypto: a do arquivo (AES-256) e a do último objeto (AES-128, uma por objeto).
  let fileAes = null;
  let objectAes = { id: '', key: null };
  const decryptBytes = async (data, method, num, gen) => {
    if (method === 'none') return data;
    if (method === 'rc4') return rc4(objectKey(num, gen, false), data);
    if (method === 'aes256') return aesDecrypt((fileAes ??= await aesKey(fileKey)), data);
    if (objectAes.id !== `${num} ${gen}`) objectAes = { id: `${num} ${gen}`, key: await aesKey(objectKey(num, gen, true)) };
    return aesDecrypt(objectAes.key, data);
  };

  // Decifra as strings e os streams de um objeto (um valor já lido pelo pdf-reader).
  async function decrypt(value, num, gen, depth = 0) {
    if (depth > 100) return value;
    if (value instanceof PdfString) return new PdfString(await decryptBytes(value.bytes, stringMethod, num, gen));
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) out.push(await decrypt(item, num, gen, depth + 1));
      return out;
    }
    if (value instanceof PdfDict) {
      const out = new PdfDict();
      // O /Contents de uma assinatura digital nunca é cifrado.
      const signature = value.has('ByteRange');
      for (const [key, item] of value) out.set(key, signature && key === 'Contents' ? item : await decrypt(item, num, gen, depth + 1));
      return out;
    }
    if (value instanceof PdfStream) {
      const dict = await decrypt(value.dict, num, gen, depth + 1);
      const type = resolve(dict.get('Type'));
      if (isName(type, 'XRef')) return new PdfStream(dict, value.data); // a tabela xref em stream não é cifrada
      if (isName(type, 'Metadata') && !encryptMetadata) return new PdfStream(dict, value.data);
      let method = streamMethod;
      // Filtro /Crypt no próprio stream: escolhe o método e sai da lista (o PDF novo não é cifrado).
      let filters = resolve(dict.get('Filter'));
      let params = resolve(dict.get('DecodeParms'));
      if (isName(filters)) { filters = [filters]; params = [params]; }
      if (Array.isArray(filters) && isName(resolve(filters[0]), 'Crypt')) {
        const param = resolve(Array.isArray(params) ? params[0] : null);
        const name = param instanceof PdfDict ? resolve(param.get('Name')) : null;
        method = methods[name instanceof PdfName ? name.value : 'Identity'] ?? 'none';
        const rest = filters.slice(1);
        const restParams = Array.isArray(params) ? params.slice(1) : [];
        if (rest.length) dict.set('Filter', rest); else dict.delete('Filter');
        if (restParams.some((item) => item != null)) dict.set('DecodeParms', restParams); else dict.delete('DecodeParms');
      }
      return new PdfStream(dict, await decryptBytes(value.data, method, num, gen));
    }
    return value;
  }

  const permissions = 4 | 8 | 16 | 32 | 256 | 512 | 1024 | 2048; // imprimir, alterar, copiar, anotar, formulários…
  return {
    decrypt,
    hadPassword: used !== '',
    restricted: used === '' && ((p | 0) & permissions) !== permissions,
  };
}

// Revisões 2 a 4: chave do arquivo a partir da senha de usuário (algoritmo 2), conferida pelo /U (algoritmos 4 e 5).
// Se não conferir, tenta a senha como de proprietário (algoritmo 7), que revela a de usuário.
async function keyR4(password, params) {
  for (const bytes of legacyPasswords(password)) {
    const key = userKeyR4(pad32(bytes), params);
    if (key) return key;
    const fromOwner = userKeyR4(ownerToUserR4(bytes, params), params);
    if (fromOwner) return fromOwner;
  }
  return null;
}

function userKeyR4(padded, { r, o, u, p, id, length, encryptMetadata }) {
  const pBytes = Uint8Array.from([p & 255, (p >> 8) & 255, (p >> 16) & 255, (p >>> 24) & 255]);
  const parts = [padded, o.subarray(0, 32), pBytes, id];
  if (r >= 4 && !encryptMetadata) parts.push(Uint8Array.from([255, 255, 255, 255]));
  let hash = md5(concat(...parts));
  const n = r === 2 ? 5 : length;
  if (r >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, n));
  const key = hash.subarray(0, n);
  if (r === 2) return equal(rc4(key, PADDING), u.subarray(0, 32)) ? key : null;
  let check = rc4(key, md5(concat(PADDING, id)));
  for (let i = 1; i <= 19; i++) check = rc4(key.map((b) => b ^ i), check);
  return u.length >= 16 && equal(check, u.subarray(0, 16)) ? key : null;
}

function ownerToUserR4(bytes, { r, o, length }) {
  let hash = md5(pad32(bytes));
  if (r >= 3) for (let i = 0; i < 50; i++) hash = md5(hash);
  const key = hash.subarray(0, r === 2 ? 5 : length);
  let user = o.subarray(0, 32);
  if (r === 2) return rc4(key, user);
  for (let i = 19; i >= 0; i--) user = rc4(key.map((b) => b ^ i), user);
  return user;
}

// Revisões 5 e 6: a senha confere pelo hash no /U (ou no /O), e a chave do arquivo vem decifrada do /UE (ou /OE).
async function keyR6(password, encrypt, get, revision) {
  const u = bytesOf(get('U'));
  const o = bytesOf(get('O'));
  if (u.length < 48 || o.length < 48) return null;
  const bytes = preparePassword(password);
  const tries = [
    { hash: u.subarray(0, 32), salts: [u.subarray(32, 40), u.subarray(40, 48)], extra: new Uint8Array(0), wrapped: bytesOf(get('UE')) },
    { hash: o.subarray(0, 32), salts: [o.subarray(32, 40), o.subarray(40, 48)], extra: u.subarray(0, 48), wrapped: bytesOf(get('OE')) },
  ];
  for (const { hash, salts, extra, wrapped } of tries) {
    if (!equal(await hash2B(bytes, salts[0], extra, revision), hash)) continue;
    if (wrapped.length < 32) return null;
    const intermediate = await hash2B(bytes, salts[1], extra, revision);
    return aesDecryptRaw(await aesKey(intermediate), new Uint8Array(16), wrapped.subarray(0, 32));
  }
  return null;
}

// ---------- Proteger o PDF gerado (AES-256, revisão 6) ----------

/**
 * Protege com senha um PDF gerado pelo app (pdf.js): todas as strings e streams cifrados com AES-256, só com
 * senha de abertura. A senha de proprietário é a mesma, então não há senha escondida nem restrição nenhuma.
 * @param {Uint8Array} bytes PDF do buildPdf ou do buildPdfToSign (estrutura simples: xref clássica, sem object
 *   streams)
 * @param {string} password
 * @param {{signature?: boolean}} [options] signature: o PDF tem o espaço da assinatura (buildPdfToSign); o
 *   /Contents dela fica sem cifrar (como a norma manda) e o /ByteRange é refeito para o arquivo novo
 * @returns {Promise<{bytes: Uint8Array, byteRange?: number[], contents?: {at: number, length: number}}>}
 */
export async function protectPdf(bytes, password, { signature = false } = {}) {
  if (!password) throw new Error('Sem senha para proteger o PDF');
  const { objects, size } = readOwnPdf(bytes);

  // Chave do arquivo e os valores que permitem abrir com a senha (algoritmos 8, 9 e 10 da ISO 32000-2).
  const fileKey = random(32);
  const pass = preparePassword(password);
  const zero = new Uint8Array(16);
  const wrapKey = async (salt, udata) => aesEncryptRaw(await aesKey(await hash2B(pass, salt, udata, 6)), zero, fileKey);
  const [userSalt, userKeySalt, ownerSalt, ownerKeySalt] = [random(8), random(8), random(8), random(8)];
  const u = concat(await hash2B(pass, userSalt, new Uint8Array(0), 6), userSalt, userKeySalt);
  const ue = await wrapKey(userKeySalt, new Uint8Array(0));
  const o = concat(await hash2B(pass, ownerSalt, u, 6), ownerSalt, ownerKeySalt);
  const oe = await wrapKey(ownerKeySalt, u);
  const P = -4; // tudo permitido
  const perms = concat(Uint8Array.from([0xfc, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), encoder.encode('Tadb'), random(4));
  const key = await aesKey(fileKey);
  const permsEncrypted = await aesEncryptRaw(key, zero, perms);
  fileKey.fill(0);

  // Cifra cada objeto (menos o /Contents da assinatura, que fica como espaço reservado).
  const encryptValue = async (value) => {
    if (value instanceof PdfString) return new PdfString(await aesEncrypt(key, value.bytes));
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) out.push(await encryptValue(item));
      return out;
    }
    if (value instanceof PdfDict) {
      const out = new PdfDict();
      const sig = value.has('ByteRange');
      for (const [k, item] of value) out.set(k, sig && (k === 'Contents' || k === 'ByteRange') ? item : await encryptValue(item));
      return out;
    }
    if (value instanceof PdfStream) return new PdfStream(await encryptValue(value.dict), await aesEncrypt(key, value.data));
    return value;
  };

  const chunks = [];
  let length = 0;
  const push = (data) => {
    const part = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(part);
    length += part.length;
  };
  const offsets = [];
  let byteRangeAt = 0;
  let contentsAt = 0;
  let reserve = 0;
  // Valor → texto do PDF. O /ByteRange e o /Contents da assinatura saem no formato do espaço reservado.
  const write = (value, signatureDict = false, key = '') => {
    if (signatureDict && key === 'ByteRange') {
      byteRangeAt = length;
      push(BYTE_RANGE_SPACE);
    } else if (signatureDict && key === 'Contents') {
      reserve = value.bytes.length;
      contentsAt = length;
      push(`<${'0'.repeat(reserve * 2)}>`);
    } else if (value instanceof PdfRef) push(`${value.num} ${value.gen} R`);
    else if (value instanceof PdfName) push(formatName(value.value));
    else if (value instanceof PdfString) push(formatString(value.bytes));
    else if (typeof value === 'number') push(formatNumber(value));
    else if (typeof value === 'boolean') push(String(value));
    else if (value === null || value === undefined || value instanceof Keyword) push('null');
    else if (Array.isArray(value)) {
      push('[');
      value.forEach((item, i) => { if (i) push(' '); write(item); });
      push(']');
    } else if (value instanceof PdfDict) {
      const sig = value.has('ByteRange');
      push('<<');
      for (const [k, item] of value) {
        push(` ${formatName(k)} `);
        write(item, sig, k);
      }
      push(' >>');
    } else if (value instanceof PdfStream) {
      const dict = new PdfDict(value.dict);
      dict.set('Length', value.data.length);
      write(dict);
      push('\nstream\n');
      push(value.data);
      push('\nendstream');
    }
  };

  push('%PDF-1.7\n');
  push(Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const encryptId = size;
  for (let id = 1; id < size; id++) {
    let value = objects.get(id);
    if (value === undefined) throw new Error(`Objeto ${id} ausente no PDF gerado`);
    // AES-256 (revisão 6) é da extensão nível 8 do PDF 1.7, que o catálogo declara para o Acrobat.
    if (id === 1 && value instanceof PdfDict) {
      value = new PdfDict(value);
      value.set('Extensions', new PdfDict([['ADBE', new PdfDict([['BaseVersion', new PdfName('1.7')], ['ExtensionLevel', 8]])]]));
    }
    const encrypted = await encryptValue(value);
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    write(encrypted);
    push('\nendobj\n');
  }
  offsets[encryptId] = length;
  push(`${encryptId} 0 obj\n<< /Filter /Standard /V 5 /R 6 /Length 256` +
    ' /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF' +
    ` /O ${formatString(o)} /U ${formatString(u)} /OE ${formatString(oe)} /UE ${formatString(ue)} /P ${P} /Perms ${formatString(permsEncrypted)} >>\nendobj\n`);

  const count = encryptId + 1;
  const xrefOffset = length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  const fileId = formatString(random(16));
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Encrypt ${encryptId} 0 R /ID [${fileId} ${fileId}] >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = concat(...chunks);
  if (!signature) return { bytes: out };
  if (!reserve) throw new Error('O PDF não tem o espaço da assinatura');
  return { bytes: out, ...finishSignature(out, { byteRangeAt, contentsAt, reserve }) };
}

// Lê um PDF gerado pelo próprio app: xref clássica, objetos numerados de 1 em diante, streams com /Length direto.
function readOwnPdf(bytes) {
  const text = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  const tail = text(Math.max(0, bytes.length - 64), bytes.length);
  const start = Number(tail.match(/startxref\s+(\d+)/)?.[1]);
  const parser = new Parser(bytes, start);
  parser.skip();
  if (parser.token() !== 'xref') throw new Error('PDF gerado sem xref clássica');
  parser.skip();
  parser.token(); // 0
  parser.skip();
  const size = Number(parser.token());
  const offsets = [];
  for (let id = 0; id < size; id++) {
    parser.skip();
    const offset = Number(parser.token());
    parser.skip();
    parser.token();
    parser.skip();
    parser.token();
    offsets.push(offset);
  }
  const objects = new Map();
  for (let id = 1; id < size; id++) {
    const reader = new Parser(bytes, offsets[id]);
    if (reader.value() !== id) throw new Error(`Objeto ${id} fora do lugar no PDF gerado`);
    reader.value(); // geração
    reader.value(); // obj
    let value = reader.value();
    if (value instanceof PdfDict) {
      reader.skip();
      if (text(reader.pos, reader.pos + 6) === 'stream') {
        let pos = reader.pos + 6;
        if (bytes[pos] === 13) pos++;
        if (bytes[pos] === 10) pos++;
        value = new PdfStream(value, bytes.subarray(pos, pos + value.get('Length')));
      }
    }
    objects.set(id, value);
  }
  return { objects, size };
}
