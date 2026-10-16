// Assinatura CMS destacada (RFC 5652), com os atributos que o PAdES básico (B-B) exige: contentType,
// messageDigest e signingCertificateV2. Sem signingTime: no PAdES a hora vai no /M do PDF.
// Quem assina é o Web Crypto do navegador (sign.js); aqui só se montam as estruturas.
import { seq, set, der, context, octetString, nullValue, encodeOid, encodeInteger, parse, sequence, oid, octets,
  expect, TAG, CONTEXT } from './asn1.js';

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
};

const sha256Algorithm = () => seq(encodeOid(OID.sha256));
const attribute = (type, value) => seq(encodeOid(type), set(value));

/**
 * Atributos assinados, em DER, como SET (é sobre estes bytes que a chave assina).
 * @param {Uint8Array} digest SHA-256 dos bytes do PDF cobertos pelo /ByteRange
 * @param {import('./x509.js').Certificate} certificate do titular
 * @param {Uint8Array} certificateHash SHA-256 do certificado (DER)
 */
export function signedAttributes(digest, certificate, certificateHash) {
  // ESSCertIDv2: hash do certificado (SHA-256 é o padrão, então o algoritmo fica de fora) e emissor + número de série.
  const issuerSerial = seq(seq(der(0xa4, certificate.issuerDer)), encodeInteger(certificate.serial));
  const signingCertificate = seq(seq(seq(octetString(certificateHash), issuerSerial)));
  return set(
    attribute(OID.contentType, encodeOid(OID.data)),
    attribute(OID.messageDigest, octetString(digest)),
    attribute(OID.signingCertificateV2, signingCertificate),
  );
}

/**
 * ContentInfo com o SignedData, pronto para o /Contents do PDF.
 * @param {{signed: Uint8Array, signature: Uint8Array, certificate: import('./x509.js').Certificate,
 *   chain: Uint8Array[]}} parts signed: os atributos (signedAttributes); chain: todos os certificados a incluir
 */
export function signedData({ signed, signature, certificate, chain }) {
  // Nos atributos dentro do SignerInfo o SET vira [0] IMPLICIT: mesmo conteúdo, outra tag.
  const signedAttrs = Uint8Array.from(signed);
  signedAttrs[0] = 0xa0;
  const signerInfo = seq(
    encodeInteger(1),
    seq(certificate.issuerDer, encodeInteger(certificate.serial)),
    sha256Algorithm(),
    signedAttrs,
    seq(encodeOid(OID.sha256WithRsa), nullValue()),
    octetString(signature),
  );
  const certificates = set(...chain);
  certificates[0] = 0xa0; // CertificateSet [0] IMPLICIT
  const content = seq(
    encodeInteger(1),
    set(sha256Algorithm()),
    seq(encodeOid(OID.data)), // destacada: o conteúdo (o PDF) não vai dentro
    certificates,
    set(signerInfo),
  );
  return seq(encodeOid(OID.signedData), context(0, content));
}

/**
 * Lê de volta o que o app gravou (autoconferência e testes): atributos assinados (como SET), messageDigest e
 * assinatura. Aceita zeros depois do fim (o espaço reservado no PDF é maior que o CMS).
 */
export function readSignedData(bytes) {
  const length = derLength(bytes);
  const [type, wrapped] = sequence(parse(bytes.subarray(0, length)));
  if (oid(type) !== OID.signedData) throw new Error('Não é um SignedData');
  const fields = sequence(sequence(wrapped, 0, CONTEXT)[0]);
  const signerInfo = sequence(fields[fields.length - 1], TAG.SET)[0];
  const parts = sequence(signerInfo);
  const attrs = parts.find((node) => node.cls === CONTEXT && node.tag === 0);
  const signature = octets(expect(parts[parts.length - 1], TAG.OCTET_STRING));
  let digest = null;
  for (const attr of attrs.children) {
    const [attrType, values] = sequence(attr);
    if (oid(attrType) === OID.messageDigest) digest = octets(expect(values.children[0], TAG.OCTET_STRING));
  }
  const signed = Uint8Array.from(attrs.der);
  signed[0] = 0x31;
  return { signed, digest, signature };
}

// Tamanho de um elemento DER pelo cabeçalho (o resto do espaço reservado são zeros).
function derLength(bytes) {
  if (bytes.length < 2) throw new Error('CMS vazio');
  const first = bytes[1];
  if (first < 0x80) return 2 + first;
  const count = first & 0x7f;
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + bytes[2 + i];
  return 2 + count + length;
}
