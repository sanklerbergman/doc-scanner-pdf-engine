// Leitor do arquivo do certificado A1 (.pfx ou .p12, formato PKCS#12, RFC 7292). Tudo no aparelho.
// Confere a senha pelo MAC do arquivo e decifra a chave e os certificados:
// - arquivos novos (OpenSSL 3, Windows com AES): PBES2, com PBKDF2 e AES, feitos pelo Web Crypto do navegador;
// - arquivos antigos (Windows, certificadoras): 3DES e RC2 de 40 bits, em legacy-ciphers.js.
// A chave decifrada sai em bytes (PKCS#8) só para o sign.js importar no Web Crypto; quem chama zera os bytes.
// O arquivo vem de fora: limites de tamanho e de iterações, e qualquer estrutura inesperada é recusada.
import { parse, sequence, octets, oid, integer, expect, Asn1Error, TAG, CONTEXT, UNIVERSAL } from './asn1.js';
import { decryptTripleDesCbc, decryptRc2Cbc, CipherError } from './legacy-ciphers.js';

export class Pkcs12Error extends Error {
  /** @param {'password' | 'corrupt' | 'unsupported'} reason */
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

const MAX_FILE = 1024 * 1024; // um .pfx tem poucos KB
const MAX_KDF_ITERATIONS = 100000; // KDF do PKCS#12, feito aqui: acima disso o navegador ficaria travado
const MAX_PBKDF2_ITERATIONS = 10000000; // PBKDF2 do próprio navegador

const OID = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  safeContentsBag: '1.2.840.113549.1.12.10.1.6',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  pbeSha1TripleDes: '1.2.840.113549.1.12.1.3',
  pbeSha1TwoKeyTripleDes: '1.2.840.113549.1.12.1.4',
  pbeSha1Rc2128: '1.2.840.113549.1.12.1.5',
  pbeSha1Rc240: '1.2.840.113549.1.12.1.6',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  pbmac1: '1.2.840.113549.1.5.14',
  desEde3Cbc: '1.2.840.113549.3.7',
};

const HASHES = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};
const HMACS = {
  '1.2.840.113549.2.7': 'SHA-1',
  '1.2.840.113549.2.9': 'SHA-256',
  '1.2.840.113549.2.10': 'SHA-384',
  '1.2.840.113549.2.11': 'SHA-512',
};
const AES = { '2.16.840.1.101.3.4.1.2': 16, '2.16.840.1.101.3.4.1.22': 24, '2.16.840.1.101.3.4.1.42': 32 };

const corrupt = () => new Pkcs12Error('corrupt', 'O arquivo do certificado está corrompido ou não é um certificado A1 (.pfx ou .p12).');
const unsupported = (what) => new Pkcs12Error('unsupported', `Este certificado usa um formato que o app ainda não abre (${what}).`);

/**
 * Abre o .pfx com a senha.
 * @param {Uint8Array} file
 * @param {string} password
 * @returns {Promise<{keys: Uint8Array[], certificates: Uint8Array[]}>} chaves em PKCS#8 e certificados em DER
 */
export async function readPkcs12(file, password) {
  if (!file?.length || file.length > MAX_FILE) throw corrupt();
  try {
    return await read(file, password);
  } catch (err) {
    if (err instanceof Pkcs12Error) throw err;
    if (err instanceof Asn1Error || err instanceof CipherError) throw corrupt();
    throw err;
  }
}

async function read(file, password) {
  const [version, authSafe, macData] = sequence(parse(file));
  if (integer(version) !== 3) throw corrupt();
  const [contentType, wrapped] = sequence(authSafe);
  if (oid(contentType) !== OID.data) throw unsupported('integridade por chave pública');
  const content = octets(expect(sequence(wrapped, 0, CONTEXT)[0], TAG.OCTET_STRING));

  // O MAC confere a senha antes de decifrar qualquer coisa.
  const passwords = bmpPasswords(password);
  if (macData) await checkMac(macData, content, passwords);

  const keys = [];
  const certificates = [];
  for (const info of sequence(parse(content))) {
    const [type, value] = sequence(info);
    const kind = oid(type);
    let safeContents;
    if (kind === OID.data) {
      safeContents = octets(expect(sequence(value, 0, CONTEXT)[0], TAG.OCTET_STRING));
    } else if (kind === OID.encryptedData) {
      const [, encryptedInfo] = sequence(sequence(value, 0, CONTEXT)[0]);
      const [, algorithm, encrypted] = sequence(encryptedInfo);
      if (!encrypted || encrypted.cls !== CONTEXT || encrypted.tag !== 0) throw corrupt();
      safeContents = await decrypt(algorithm, octets(encrypted), password, passwords);
    } else {
      throw unsupported('conteúdo com envelope');
    }
    await readBags(parse(safeContents), password, passwords, keys, certificates, 0);
  }
  if (!keys.length) throw new Pkcs12Error('corrupt', 'O arquivo não tem a chave do certificado. Exporte de novo marcando "exportar a chave privada".');
  return { keys, certificates };
}

async function readBags(node, password, passwords, keys, certificates, depth) {
  if (depth > 2) throw corrupt();
  for (const bag of sequence(node)) {
    const [type, wrapped] = sequence(bag);
    const value = sequence(wrapped, 0, CONTEXT)[0];
    switch (oid(type)) {
      case OID.keyBag:
        keys.push(value.der.slice());
        break;
      case OID.shroudedKeyBag: {
        const [algorithm, encrypted] = sequence(value);
        keys.push(await decrypt(algorithm, octets(expect(encrypted, TAG.OCTET_STRING)), password, passwords));
        break;
      }
      case OID.certBag: {
        const [certType, certValue] = sequence(value);
        if (oid(certType) !== OID.x509Certificate) break; // outros tipos de certificado: ignorados
        certificates.push(octets(expect(sequence(certValue, 0, CONTEXT)[0], TAG.OCTET_STRING)).slice());
        break;
      }
      case OID.safeContentsBag:
        await readBags(value, password, passwords, keys, certificates, depth + 1);
        break;
      default: // lista de revogação, segredos: não interessam
    }
  }
}

// ---------- Senha e MAC ----------

// Senha no formato do PKCS#12: UTF-16 big-endian com dois zeros no fim. Senha vazia tem duas formas por aí
// (só os dois zeros, ou nada), e o MAC diz qual é.
function bmpPasswords(password) {
  const bmp = new Uint8Array((password.length + 1) * 2);
  for (let i = 0; i < password.length; i++) {
    const code = password.charCodeAt(i);
    bmp[2 * i] = code >> 8;
    bmp[2 * i + 1] = code & 0xff;
  }
  return password ? [bmp] : [bmp, new Uint8Array(0)];
}

async function checkMac(macData, content, passwords) {
  const [digestInfo, salt, iterationsNode] = sequence(macData);
  const [algorithm, expected] = sequence(digestInfo);
  const algorithmOid = oid(sequence(algorithm)[0]);
  if (algorithmOid === OID.pbmac1) throw unsupported('PBMAC1');
  const hash = HASHES[algorithmOid];
  if (!hash) throw unsupported(`MAC ${algorithmOid}`);
  const iterations = iterationsNode ? integer(iterationsNode) : 1;
  const want = octets(expect(expected, TAG.OCTET_STRING));
  for (let i = 0; i < passwords.length; i++) {
    const key = await pkcs12Kdf(hash, passwords[i], octets(expect(salt, TAG.OCTET_STRING)), 3, iterations, HASH_SIZE[hash]);
    const hmac = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, content));
    if (mac.length === want.length && mac.every((b, j) => b === want[j])) {
      if (i > 0) passwords.reverse(); // a forma da senha vazia que o arquivo usa vem primeiro
      return;
    }
  }
  throw new Pkcs12Error('password', 'A senha não confere. Confira maiúsculas e minúsculas e tente de novo.');
}

const HASH_SIZE = { 'SHA-1': 20, 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 };
const HASH_BLOCK = { 'SHA-1': 64, 'SHA-256': 64, 'SHA-384': 128, 'SHA-512': 128 };

/**
 * Derivação de chave do PKCS#12 (RFC 7292, apêndice B.2).
 * @param {string} hash nome do Web Crypto (SHA-1, SHA-256…)
 * @param {Uint8Array} password senha em BMPString (bmpPasswords)
 * @param {number} id 1 = chave, 2 = vetor inicial, 3 = chave do MAC
 * @param {number} n bytes pedidos
 */
export async function pkcs12Kdf(hash, password, salt, id, iterations, n) {
  if (!(iterations >= 1 && iterations <= MAX_KDF_ITERATIONS)) throw unsupported(`${iterations} iterações`);
  const u = HASH_SIZE[hash];
  const v = HASH_BLOCK[hash];
  const fill = (source) => {
    const out = new Uint8Array(source.length ? v * Math.ceil(source.length / v) : 0);
    for (let i = 0; i < out.length; i++) out[i] = source[i % source.length];
    return out;
  };
  const d = new Uint8Array(v).fill(id);
  const s = fill(salt);
  const p = fill(password);
  const block = new Uint8Array(v + s.length + p.length);
  block.set(d);
  block.set(s, v);
  block.set(p, v + s.length);
  const i = block.subarray(v);
  const out = new Uint8Array(n);
  for (let pos = 0; ; pos += u) {
    let a = new Uint8Array(await crypto.subtle.digest(hash, block));
    for (let r = 1; r < iterations; r++) a = new Uint8Array(await crypto.subtle.digest(hash, a));
    out.set(a.subarray(0, Math.min(u, n - pos)), pos);
    if (pos + u >= n) break;
    // I_j = (I_j + B + 1) mod 2^(v·8), com B = A repetido até v bytes.
    const b = fill(a).subarray(0, v);
    for (let j = 0; j < i.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        carry += i[j + k] + b[k];
        i[j + k] = carry & 0xff;
        carry >>= 8;
      }
    }
  }
  block.fill(0);
  return out;
}

// ---------- Decifrar ----------

async function decrypt(algorithm, data, password, passwords) {
  const [algorithmOid, params] = sequence(algorithm);
  const kind = oid(algorithmOid);
  const legacy = { [OID.pbeSha1TripleDes]: 24, [OID.pbeSha1TwoKeyTripleDes]: 16, [OID.pbeSha1Rc2128]: 16, [OID.pbeSha1Rc240]: 5 };
  if (kind in legacy) {
    const [salt, iterationsNode] = sequence(params);
    const iterations = integer(iterationsNode);
    const saltBytes = octets(expect(salt, TAG.OCTET_STRING));
    // A senha certa é a que passou no MAC; sem MAC, tenta as formas possíveis (só muda na senha vazia).
    let lastError;
    for (const bmp of passwords) {
      const key = await pkcs12Kdf('SHA-1', bmp, saltBytes, 1, iterations, legacy[kind]);
      const iv = await pkcs12Kdf('SHA-1', bmp, saltBytes, 2, iterations, 8);
      try {
        return kind === OID.pbeSha1Rc240 || kind === OID.pbeSha1Rc2128
          ? decryptRc2Cbc(key, legacy[kind] * 8, iv, data)
          : decryptTripleDesCbc(key, iv, data);
      } catch (err) {
        lastError = err;
      } finally {
        key.fill(0);
      }
    }
    if (lastError instanceof CipherError) throw new Pkcs12Error('password', 'A senha não confere. Confira maiúsculas e minúsculas e tente de novo.');
    throw lastError;
  }
  if (kind === OID.pbes2) return decryptPbes2(params, data, password);
  throw unsupported(`cifra ${kind}`);
}

// PBES2 (RFC 8018): PBKDF2 e AES (ou 3DES), com a senha em UTF-8, como o OpenSSL e o Windows gravam.
async function decryptPbes2(params, data, password) {
  const [kdf, scheme] = sequence(params);
  const [kdfOid, kdfParams] = sequence(kdf);
  if (oid(kdfOid) !== OID.pbkdf2) throw unsupported(`derivação ${oid(kdfOid)}`);
  const [salt, iterationsNode, ...rest] = sequence(kdfParams);
  const iterations = integer(iterationsNode);
  if (!(iterations >= 1 && iterations <= MAX_PBKDF2_ITERATIONS)) throw unsupported(`${iterations} iterações`);
  let prf = 'SHA-1';
  for (const node of rest) {
    if (node.tag === TAG.SEQUENCE && node.cls === UNIVERSAL) {
      prf = HMACS[oid(sequence(node)[0])];
      if (!prf) throw unsupported('derivação com hash desconhecido');
    }
  }
  const [schemeOid, ivNode] = sequence(scheme);
  const cipher = oid(schemeOid);
  const iv = octets(expect(ivNode, TAG.OCTET_STRING));
  const keyLength = AES[cipher] ?? (cipher === OID.desEde3Cbc ? 24 : 0);
  if (!keyLength) throw unsupported(`cifra ${cipher}`);

  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const key = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: octets(expect(salt, TAG.OCTET_STRING)), iterations, hash: prf }, base, keyLength * 8));
  try {
    if (cipher === OID.desEde3Cbc) return decryptTripleDesCbc(key, iv, data);
    let aes;
    try {
      aes = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
    } catch {
      throw unsupported(`AES de ${keyLength * 8} bits`); // AES-192: o Chrome não tem
    }
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aes, data));
    } catch {
      throw new Pkcs12Error('password', 'A senha não confere. Confira maiúsculas e minúsculas e tente de novo.');
    }
  } finally {
    key.fill(0);
  }
}
