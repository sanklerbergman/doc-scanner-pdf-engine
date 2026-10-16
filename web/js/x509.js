// Certificado digital (X.509): o que o app precisa saber para assinar. Titular, emissor, validade, uso da chave
// e chave pública. Não valida a cadeia nem consulta revogação (isso exige rede; quem confere é o validador).
import { parse, sequence, oid, unsigned, bitString, time, text, expect, octets, TAG, CONTEXT, UNIVERSAL } from './asn1.js';

const NAMES = { '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.10': 'O', '2.5.4.11': 'OU' };
const RSA = '1.2.840.113549.1.1.1';
const EC = '1.2.840.10045.2.1';
const KEY_USAGE = '2.5.29.15';
const BASIC_CONSTRAINTS = '2.5.29.19';

/**
 * @typedef {{der: Uint8Array, serial: Uint8Array, issuerDer: Uint8Array, subjectDer: Uint8Array,
 *   issuer: Record<string, string>, subject: Record<string, string>, notBefore: Date, notAfter: Date,
 *   spki: Uint8Array, keyType: 'RSA' | 'EC' | string, modulus: Uint8Array | null, bits: number,
 *   keyUsage: {digitalSignature: boolean, nonRepudiation: boolean} | null, ca: boolean}} Certificate
 */

/** @returns {Certificate} */
export function readCertificate(der) {
  const [tbs] = sequence(parse(der));
  const fields = sequence(tbs);
  let i = 0;
  if (fields[0].cls === CONTEXT && fields[0].tag === 0) i++; // versão
  const serial = unsigned(fields[i++]);
  i++; // algoritmo da assinatura (repetido fora do TBS)
  const issuer = fields[i++];
  const [notBefore, notAfter] = sequence(fields[i++]);
  const subject = fields[i++];
  const spki = fields[i++];
  const [algorithm, publicKey] = sequence(spki);
  const keyType = oid(sequence(algorithm)[0]);

  let modulus = null;
  let bits = 0;
  if (keyType === RSA) {
    const [n] = sequence(parse(bitString(publicKey).bytes));
    modulus = unsigned(n);
    bits = modulus.length * 8 - Math.clz32(modulus[0]) + 24;
  }

  let keyUsage = null;
  let ca = false;
  const extensions = fields.find((node) => node.cls === CONTEXT && node.tag === 3);
  if (extensions) {
    for (const extension of sequence(sequence(extensions, 3, CONTEXT)[0])) {
      const parts = sequence(extension);
      const id = oid(parts[0]);
      const value = octets(expect(parts[parts.length - 1], TAG.OCTET_STRING));
      if (id === KEY_USAGE) {
        const { bytes } = bitString(parse(value));
        keyUsage = { digitalSignature: !!(bytes[0] & 0x80), nonRepudiation: !!(bytes[0] & 0x40) };
      } else if (id === BASIC_CONSTRAINTS) {
        const [first] = sequence(parse(value));
        ca = first?.cls === UNIVERSAL && first.tag === TAG.BOOLEAN && first.content[0] !== 0;
      }
    }
  }

  return {
    der, serial,
    issuerDer: issuer.der, subjectDer: subject.der,
    issuer: readName(issuer), subject: readName(subject),
    notBefore: time(notBefore), notAfter: time(notAfter),
    spki: spki.der,
    keyType: keyType === RSA ? 'RSA' : keyType === EC ? 'EC' : keyType,
    modulus, bits, keyUsage, ca,
  };
}

// Nome (sequência de conjuntos de pares tipo-valor): o último valor de cada tipo conhecido.
function readName(node) {
  const out = {};
  for (const rdn of sequence(node)) {
    for (const pair of sequence(rdn, TAG.SET)) {
      const [type, value] = sequence(pair);
      const name = NAMES[oid(type)];
      if (name) out[name] = text(value);
    }
  }
  return out;
}

// Módulo da chave privada RSA (PKCS#8 → RSAPrivateKey), para achar o certificado da mesma chave.
export function privateKeyInfo(pkcs8) {
  const [, algorithm, key] = sequence(parse(pkcs8));
  const type = oid(sequence(algorithm)[0]);
  if (type !== RSA) return { keyType: type === EC ? 'EC' : type, modulus: null, rsaKey: null };
  const rsaKey = octets(expect(key, TAG.OCTET_STRING));
  const [, n] = sequence(parse(rsaKey));
  return { keyType: 'RSA', modulus: unsigned(n), rsaKey };
}

export const sameBytes = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

// Nome para mostrar: no e-CPF e no e-CNPJ o CN é "NOME:NÚMERO"; o número fica de fora.
export function displayName(certificate) {
  const cn = certificate.subject.CN ?? certificate.subject.O ?? '';
  return cn.replace(/:\d{11,14}$/, '').trim();
}
