// Assinatura digital do PDF com o certificado A1 da pessoa (PAdES básico, B-B), toda no aparelho.
// Carregado só quando a pessoa escolhe "Assinar com certificado digital".
//
// Segurança:
// - O .pfx, a senha e a chave só existem na memória desta aba. A página não tem rede (connect-src 'none').
// - A chave é importada no Web Crypto como não extraível e só para assinar: depois disso o JS não lê mais a
//   chave. Os bytes decifrados são zerados logo depois da importação.
// - Nada vai para o console nem para as mensagens de erro: nem nome, nem CPF, nem número de série.
// - Assinatura conferida antes de sair: o app refaz o hash e verifica com a chave pública. Se algo não bater,
//   o arquivo não é entregue.
import { readPkcs12, Pkcs12Error } from './pkcs12.js';
import { readCertificate, privateKeyInfo, sameBytes, displayName } from './x509.js';
import { signedAttributes, signedData, readSignedData } from './cms.js';
import { buildPdfToSign, fillSignature, signedRanges } from './pdf.js';
import { seq, encodeInteger, encodeOid, nullValue, octetString } from './asn1.js';

export class SignError extends Error {
  name = 'SignError';
}

const RSA_OID = '1.2.840.113549.1.1.1';
const RSA_PKCS1 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const MIN_BITS = 2048;
const SLACK = 32; // folga do espaço reservado, em bytes (o tamanho do CMS já é conhecido antes de assinar)
const MAX_CHAIN = 10;

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const day = (date) => date.toLocaleDateString('pt-BR', { timeZone: 'UTC' });

// Recusa, com o motivo, o certificado que não serve para assinar agora.
function check(certificate, now) {
  if (certificate.ca) throw new SignError('Este é o certificado de uma autoridade certificadora, não de uma pessoa ou empresa.');
  if (now < certificate.notBefore) throw new SignError(`O certificado só vale a partir de ${day(certificate.notBefore)}. Confira a data e a hora do aparelho.`);
  if (now > certificate.notAfter) throw new SignError(`O certificado venceu em ${day(certificate.notAfter)}. Para assinar, renove com a certificadora.`);
  const usage = certificate.keyUsage;
  if (usage && !usage.digitalSignature && !usage.nonRepudiation) throw new SignError('Este certificado não serve para assinar documentos (o uso dele é outro).');
  if (certificate.bits < MIN_BITS) throw new SignError(`A chave deste certificado é pequena demais (${certificate.bits} bits). O mínimo para assinar é ${MIN_BITS}.`);
}

// Cadeia do titular até a raiz, com os certificados que vieram no arquivo.
function buildChain(holder, certificates) {
  const chain = [holder];
  let current = holder;
  while (chain.length < MAX_CHAIN && !sameBytes(current.issuerDer, current.subjectDer)) {
    const issuer = certificates.find((cert) => sameBytes(cert.subjectDer, current.issuerDer) && !chain.includes(cert));
    if (!issuer) break;
    chain.push(issuer);
    current = issuer;
  }
  return chain;
}

/**
 * Abre o certificado A1 e prepara a chave para assinar.
 * @param {Uint8Array} file o .pfx (quem chama zera depois)
 * @param {string} password
 * @param {Date} [now] relógio do aparelho
 * @returns {Promise<{name: string, issuer: string, notBefore: Date, notAfter: Date, chainComplete: boolean,
 *   sign: (pages: object[], time?: Date) => Promise<Uint8Array>, discard: () => void}>}
 */
export async function openCertificate(file, password, now = new Date()) {
  let content;
  try {
    content = await readPkcs12(file, password);
  } catch (err) {
    if (err instanceof Pkcs12Error) throw new SignError(err.message);
    throw err;
  }
  const { keys, certificates } = content;
  let rsaKey = null;
  try {
    const certs = certificates.flatMap((der) => {
      try {
        return [readCertificate(der)];
      } catch {
        return []; // certificado que não dá para ler: fica de fora
      }
    });
    let holder = null;
    let elliptic = false;
    for (const key of keys) {
      const info = privateKeyInfo(key);
      if (info.keyType === 'EC') elliptic = true;
      if (info.keyType !== 'RSA') continue;
      holder = certs.find((cert) => cert.modulus && sameBytes(cert.modulus, info.modulus));
      if (holder) {
        rsaKey = info.rsaKey;
        break;
      }
    }
    if (!holder && elliptic) throw new SignError('Este certificado usa chave de curva elíptica, que o app ainda não assina.');
    if (!holder) throw new SignError('O arquivo não tem o certificado da chave. Exporte de novo, com o certificado.');
    check(holder, now);
    const chain = buildChain(holder, certs);
    const chainDer = chain.map((cert) => cert.der);
    const certificateHash = await sha256(holder.der);

    // PKCS#8 montado de novo, só com a chave RSA: o do Windows pode trazer atributos que o navegador recusa.
    const pkcs8 = seq(encodeInteger(0), seq(encodeOid(RSA_OID), nullValue()), octetString(rsaKey));
    let key;
    try {
      key = await crypto.subtle.importKey('pkcs8', pkcs8, RSA_PKCS1, false, ['sign']);
    } catch {
      throw new SignError('Não deu para usar a chave deste certificado.');
    } finally {
      pkcs8.fill(0);
    }

    return {
      name: displayName(holder),
      issuer: holder.issuer.CN ?? holder.issuer.O ?? '',
      notBefore: holder.notBefore,
      notAfter: holder.notAfter,
      chainComplete: sameBytes(chain[chain.length - 1].issuerDer, chain[chain.length - 1].subjectDer),
      /**
       * Monta e assina o PDF. Os bytes que saem são exatamente os que foram assinados e conferidos.
       * @param {object[]} pages as páginas de buildPdf (pdf.js)
       * @param {Date} [time] hora da assinatura (/M)
       * @param {{password?: string, pdfa?: boolean}} [options] password: protege o PDF com senha (pdf-crypt.js)
       *   antes de assinar, porque a assinatura cobre os bytes finais do arquivo; pdfa: PDF/A-2b (não combina com
       *   senha: o PDF/A não permite criptografia)
       */
      async sign(pages, time = new Date(), { password, pdfa = false } = {}) {
        if (password && pdfa) throw new SignError('O PDF/A não permite senha: escolha um dos dois.');
        if (!key) throw new SignError('O certificado já foi fechado. Abra de novo para assinar.');
        check(holder, time);
        // O CMS tem sempre o mesmo tamanho: a assinatura RSA tem o tamanho da chave, e o hash, 32 bytes.
        const sample = signedData({
          signed: signedAttributes(new Uint8Array(32), holder, certificateHash),
          signature: new Uint8Array(holder.modulus.length), certificate: holder, chain: chainDer,
        });
        let prepared = buildPdfToSign(pages, { reserve: sample.length + SLACK, time, pdfa });
        if (password) {
          const { protectPdf } = await import('./pdf-crypt.js');
          prepared = await protectPdf(prepared.bytes, password, { signature: true });
        }
        const digest = await sha256(join(signedRanges(prepared.bytes, prepared.byteRange)));
        const signed = signedAttributes(digest, holder, certificateHash);
        const signature = new Uint8Array(await crypto.subtle.sign(RSA_PKCS1, key, signed));
        fillSignature(prepared, signedData({ signed, signature, certificate: holder, chain: chainDer }));
        if (!(await verifySignedPdf(prepared.bytes, holder.spki))) {
          throw new SignError('A conferência da assinatura falhou, e o PDF não foi entregue. Tente de novo.');
        }
        return prepared.bytes;
      },
      // Solta a chave: sem referência, o navegador descarta.
      discard() {
        key = null;
      },
    };
  } finally {
    for (const key of keys) key.fill(0);
    rsaKey?.fill(0);
  }
}

function join(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
}

const BYTE_RANGE = new TextEncoder().encode('/ByteRange [');

/**
 * Confere a última assinatura do PDF: o /ByteRange cobre o arquivo todo menos o /Contents, o hash bate com o
 * messageDigest, e a assinatura é válida para a chave pública (spki, em DER).
 * @returns {Promise<boolean>}
 */
export async function verifySignedPdf(bytes, spki) {
  try {
    let at = -1;
    for (let i = bytes.length - BYTE_RANGE.length; i >= 0 && at < 0; i--) {
      if (BYTE_RANGE.every((b, j) => bytes[i + j] === b)) at = i;
    }
    if (at < 0) return false;
    const end = bytes.indexOf(0x5d, at); // "]"
    const numbers = new TextDecoder().decode(bytes.subarray(at + BYTE_RANGE.length, end)).trim().split(/\s+/).map(Number);
    const [a, b, c, d] = numbers;
    if (numbers.length !== 4 || a !== 0 || !(b > 0) || !(c > b) || c + d !== bytes.length) return false;
    if (bytes[b] !== 0x3c || bytes[c - 1] !== 0x3e) return false; // "<" e ">"
    const hex = new TextDecoder().decode(bytes.subarray(b + 1, c - 1));
    if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) return false;
    const cms = Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
    const { signed, digest, signature } = readSignedData(cms);
    const actual = await sha256(join([bytes.subarray(0, b), bytes.subarray(c, c + d)]));
    if (!digest || !sameBytes(actual, digest)) return false;
    const key = await crypto.subtle.importKey('spki', spki, RSA_PKCS1, false, ['verify']);
    return await crypto.subtle.verify(RSA_PKCS1, key, signature, signed);
  } catch {
    return false;
  }
}
