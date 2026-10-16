// Assinatura com certificado A1: leitura do .pfx, conferências do certificado e PDF assinado.
// Só certificados de TESTE (test/fixtures/certificados, gerados pelo gerar.sh de lá). Nunca um certificado real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash, verify as nodeVerify, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPkcs12, pkcs12Kdf, Pkcs12Error } from '../web/js/pkcs12.js';
import { readCertificate } from '../web/js/x509.js';
import { readSignedData } from '../web/js/cms.js';
import { openCertificate, verifySignedPdf, SignError } from '../web/js/sign.js';
import { parse } from '../web/js/asn1.js';
import { layoutPage, pdfDate, buildPdfToSign } from '../web/js/pdf.js';
import { openPdf } from '../web/js/pdf-reader.js';
import { qpdfCheck } from './helpers/qpdf.js';

const PASSWORD = 'senha-de-teste';
const certificate = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/certificados/${name}`, import.meta.url)));
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const hex = (text) => Uint8Array.from(Buffer.from(text, 'hex'));
const toHex = (bytes) => Buffer.from(bytes).toString('hex');
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const bmp = (text) => Uint8Array.from(Buffer.from(`${text}\0`, 'utf16le').swap16());

const PAGES = [
  { jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(40, 30, 'a4', 18) },
  { width: 595.28, height: 841.89, items: [{ type: 'text', x: 72, y: 100, text: 'Contrato assinado', font: 'Helvetica', size: 12 }] },
];

// ---------- PKCS#12 ----------

test('KDF do PKCS#12 bate com o OpenSSL', async () => {
  // Valores de "openssl kdf -keylen N -kdfopt digest:H -kdfopt hexpass:... -kdfopt hexsalt:... -kdfopt id:I
  //   -kdfopt iter:C PKCS12KDF" (OpenSSL 3.5). O primeiro é o vetor do conjunto de testes do próprio OpenSSL.
  assert.equal(toHex(await pkcs12Kdf('SHA-1', bmp('smeg'), hex('0a58cf64530d823f'), 1, 1, 24)), '8aaae6297b6cb04642ab5b077851284eb7128f1a2a7fbca3');
  assert.equal(toHex(await pkcs12Kdf('SHA-1', bmp('smeg'), hex('0a58cf64530d823f'), 2, 1, 8)), '79993dfe048d3b76');
  assert.equal(toHex(await pkcs12Kdf('SHA-256', bmp(PASSWORD), hex('0102030405060708'), 3, 2048, 32)), '098a57690317489fd529df07aa1ff7da9272c12ea468513a83ba3449c3403274');
  assert.equal(toHex(await pkcs12Kdf('SHA-1', bmp(PASSWORD), hex('0102030405060708090a'), 1, 1000, 24)), 'b1ea09a03b7c19458dde975bc08be1a102e7463b8adcf8f4');
});

test('.pfx com AES (OpenSSL 3), com RC2 e 3DES (formato antigo) e só com 3DES: chave e cadeia', async () => {
  for (const name of ['titular-aes.pfx', 'titular-legacy.pfx', 'titular-3des.pfx']) {
    const { keys, certificates } = await readPkcs12(certificate(name), PASSWORD);
    assert.equal(keys.length, 1, name);
    assert.equal(certificates.length, 3, name);
    const subjects = certificates.map((der) => readCertificate(der).subject.CN).sort();
    assert.deepEqual(subjects, ['AC DE TESTE', 'AC RAIZ DE TESTE', 'PESSOA DE TESTE:00000000191'], name);
  }
  const { certificates } = await readPkcs12(certificate('titular-sem-cadeia.pfx'), PASSWORD);
  assert.equal(certificates.length, 1);
});

test('.pfx: senha errada tem mensagem própria, em todos os formatos', async () => {
  for (const name of ['titular-aes.pfx', 'titular-legacy.pfx', 'titular-3des.pfx']) {
    await assert.rejects(readPkcs12(certificate(name), 'senha-errada'), (err) => err instanceof Pkcs12Error && err.reason === 'password', name);
    await assert.rejects(readPkcs12(certificate(name), ''), (err) => err.reason === 'password', `${name}, senha vazia`);
  }
});

test('.pfx corrompido, cortado ou que não é certificado é recusado como corrompido', async () => {
  const good = certificate('titular-legacy.pfx');
  const cases = [
    good.subarray(0, good.length - 100),
    good.subarray(0, 40),
    new Uint8Array(0),
    new TextEncoder().encode('isto não é um certificado'),
    fixture('rgb-40x30.jpg'),
  ];
  for (const bytes of cases) {
    await assert.rejects(readPkcs12(bytes, PASSWORD), (err) => err instanceof Pkcs12Error && err.reason === 'corrupt');
  }
  // Byte trocado no meio: o MAC não confere (a senha está certa, mas o conteúdo mudou).
  const flipped = good.slice();
  flipped[Math.floor(flipped.length / 2)] ^= 0xff;
  await assert.rejects(readPkcs12(flipped, PASSWORD), (err) => err instanceof Pkcs12Error);
});

// Regrava o .pfx em BER, como o Windows faz: comprimento indefinido e OCTET STRING em pedaços.
function toBer(bytes) {
  const node = parse(bytes);
  const encode = (n) => {
    const id = (n.cls << 6) | (n.tag & 0x1f);
    if (n.children) return Buffer.concat([Buffer.from([id | 0x20, 0x80]), ...n.children.map(encode), Buffer.from([0, 0])]);
    const isOctets = (n.cls === 0 && n.tag === 4) || (n.cls === 2 && n.tag === 0);
    if (isOctets && n.content.length > 40) {
      const chunks = [];
      for (let i = 0; i < n.content.length; i += 37) chunks.push(Buffer.from(n.der.subarray(0, 0)), encodePrimitive(4, n.content.subarray(i, i + 37)));
      return Buffer.concat([Buffer.from([id | 0x20, 0x80]), ...chunks, Buffer.from([0, 0])]);
    }
    return Buffer.from(n.der);
  };
  return new Uint8Array(encode(node));
}
function encodePrimitive(tag, content) {
  const length = content.length < 0x80 ? [content.length] : [0x81, content.length];
  return Buffer.concat([Buffer.from([tag, ...length]), Buffer.from(content)]);
}

test('.pfx em BER (comprimento indefinido e strings em pedaços) abre igual', async () => {
  for (const name of ['titular-legacy.pfx', 'titular-aes.pfx']) {
    const ber = toBer(certificate(name));
    assert.notDeepEqual(ber, certificate(name));
    const { keys, certificates } = await readPkcs12(ber, PASSWORD);
    assert.equal(keys.length, 1);
    assert.equal(certificates.length, 3);
  }
});

// ---------- Certificado ----------

test('certificado do titular: nome sem o CPF, emissor, validade e cadeia completa', async () => {
  for (const name of ['titular-aes.pfx', 'titular-legacy.pfx', 'titular-3des.pfx']) {
    const signer = await openCertificate(certificate(name), PASSWORD);
    assert.equal(signer.name, 'PESSOA DE TESTE');
    assert.equal(signer.issuer, 'AC DE TESTE');
    assert.ok(signer.notAfter > new Date());
    assert.equal(signer.chainComplete, true);
    signer.discard();
  }
  assert.equal((await openCertificate(certificate('titular-sem-cadeia.pfx'), PASSWORD)).chainComplete, false);
});

test('certificado vencido, sem uso para assinar, com chave pequena ou de curva elíptica é recusado com o motivo', async () => {
  await assert.rejects(openCertificate(certificate('vencido.pfx'), PASSWORD), (err) => err instanceof SignError && /venceu em 01\/01\/2021/.test(err.message));
  await assert.rejects(openCertificate(certificate('sem-assinatura.pfx'), PASSWORD), /não serve para assinar/);
  await assert.rejects(openCertificate(certificate('chave-1024.pfx'), PASSWORD), /pequena demais \(1024 bits\)/);
  await assert.rejects(openCertificate(certificate('ec.pfx'), PASSWORD), /curva elíptica/);
  await assert.rejects(openCertificate(certificate('titular-aes.pfx'), PASSWORD, new Date('2000-01-01')), /só vale a partir/);
  await assert.rejects(openCertificate(certificate('titular-aes.pfx'), 'errada'), (err) => err instanceof SignError && /senha não confere/.test(err.message));
});

// ---------- PDF assinado ----------

// Lê o /ByteRange e o /Contents do PDF assinado.
function signatureOf(bytes) {
  const text = latin1(bytes);
  const [a, b, c, d] = text.match(/\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\s*\]/).slice(1).map(Number);
  const cms = Buffer.from(text.slice(b + 1, c - 1), 'hex');
  return { byteRange: [a, b, c, d], cms: new Uint8Array(cms) };
}

test('PDF assinado: /ByteRange cobre o arquivo todo menos o /Contents, o hash bate e a assinatura confere', async () => {
  const signer = await openCertificate(certificate('titular-legacy.pfx'), PASSWORD);
  const time = new Date();
  const bytes = await signer.sign(PAGES, time);
  qpdfCheck(bytes);
  const text = latin1(bytes);
  const { byteRange: [a, b, c, d], cms } = signatureOf(bytes);
  assert.equal(a, 0);
  assert.equal(text[b], '<');
  assert.equal(text[c - 1], '>');
  assert.equal(c + d, bytes.length, 'vai até o fim do arquivo');
  assert.match(text.slice(b + 1, c - 1), /^[0-9a-f]+$/);

  const { signed, digest, signature } = readSignedData(cms);
  const content = Buffer.concat([bytes.subarray(0, b), bytes.subarray(c)]);
  assert.equal(toHex(digest), createHash('sha256').update(content).digest('hex'), 'messageDigest');

  // Conferência independente: a chave pública do certificado do titular, pelo node:crypto.
  const { certificates } = await readPkcs12(certificate('titular-legacy.pfx'), PASSWORD);
  const holder = certificates.map((der) => new X509Certificate(Buffer.from(der))).find((cert) => cert.subject.includes('PESSOA DE TESTE'));
  assert.ok(nodeVerify('sha256', signed, holder.publicKey, signature), 'assinatura RSA sobre os atributos');
  assert.equal(await verifySignedPdf(bytes, new Uint8Array(holder.publicKey.export({ type: 'spki', format: 'der' }))), true);

  // Estrutura: campo de assinatura invisível, PAdES, hora em /M e nada mais sobre a pessoa ou o aparelho.
  assert.ok(text.startsWith('%PDF-1.7\n'));
  assert.match(text, /\/AcroForm << \/Fields \[\d+ 0 R\] \/SigFlags 3 >>/);
  assert.match(text, /\/Subtype \/Widget \/FT \/Sig .*\/Rect \[0 0 0 0\]/);
  assert.match(text, /\/Filter \/Adobe\.PPKLite \/SubFilter \/ETSI\.CAdES\.detached/);
  assert.ok(text.includes(`/M (${pdfDate(time)})`));
  assert.doesNotMatch(text, /\/Name|\/Reason|\/Location|\/ContactInfo|\/Info|\/Metadata|\/CreationDate/);
  assert.ok(!Buffer.from(signed).includes(Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x05])), 'sem signingTime no CMS');

  // O próprio leitor do app abre e reconhece a assinatura.
  assert.equal((await openPdf(bytes)).isSigned(), true);
  signer.discard();
});

test('PDF assinado: o openssl cms -verify confere a assinatura e a cadeia de teste', async (t) => {
  const OPENSSL = process.env.OPENSSL || 'openssl';
  if (spawnSync(OPENSSL, ['version']).error) {
    if (process.env.CI) throw new Error('openssl não encontrado: no CI ele é obrigatório.');
    t.skip('openssl não encontrado');
    return;
  }
  const signer = await openCertificate(certificate('titular-aes.pfx'), PASSWORD);
  const bytes = await signer.sign(PAGES);
  const { byteRange: [, b, c], cms } = signatureOf(bytes);
  const length = 4 + ((cms[2] << 8) | cms[3]); // SEQUENCE com comprimento em 2 bytes (o CMS tem alguns KB)
  const dir = mkdtempSync(join(tmpdir(), 'cms-'));
  try {
    writeFileSync(join(dir, 'assinatura.der'), cms.subarray(0, length));
    writeFileSync(join(dir, 'conteudo.bin'), Buffer.concat([bytes.subarray(0, b), bytes.subarray(c)]));
    writeFileSync(join(dir, 'raiz.pem'), new X509Certificate(Buffer.from(certificate('ac-raiz.cer'))).toString());
    const result = spawnSync(OPENSSL, ['cms', '-verify', '-binary', '-inform', 'DER', '-in', join(dir, 'assinatura.der'),
      '-content', join(dir, 'conteudo.bin'), '-CAfile', join(dir, 'raiz.pem'), '-purpose', 'any', '-out', join(dir, 'saida.bin')],
    { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /Verification successful/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PDF assinado: qualquer byte mudado fora da assinatura invalida a conferência', async () => {
  const signer = await openCertificate(certificate('titular-3des.pfx'), PASSWORD);
  const bytes = await signer.sign(PAGES);
  const { certificates } = await readPkcs12(certificate('titular-3des.pfx'), PASSWORD);
  const holder = certificates.map((der) => readCertificate(der)).find((cert) => cert.subject.CN.startsWith('PESSOA'));
  assert.equal(await verifySignedPdf(bytes, holder.spki), true);
  for (const at of [20, Math.floor(bytes.length / 2), bytes.length - 3]) {
    const changed = bytes.slice();
    const { byteRange: [, b, c] } = signatureOf(changed);
    if (at > b && at < c) continue; // dentro do /Contents: outro teste
    changed[at] ^= 0x01;
    assert.equal(await verifySignedPdf(changed, holder.spki), false, `byte ${at}`);
  }
});

test('vários arquivos com a mesma senha: a chave assina todos e é descartada no fim', async () => {
  const signer = await openCertificate(certificate('titular-aes.pfx'), PASSWORD);
  const first = await signer.sign(PAGES.slice(0, 1));
  const second = await signer.sign(PAGES.slice(1));
  assert.notDeepEqual(first, second);
  signer.discard();
  await assert.rejects(signer.sign(PAGES), /já foi fechado/);
});

test('PDF sem assinatura continua igual: o espaço da assinatura só existe em buildPdfToSign', () => {
  assert.throws(() => buildPdfToSign(PAGES, {}), /sem espaço/);
  const { bytes, contents } = buildPdfToSign(PAGES, { reserve: 100, time: new Date(2026, 9, 16, 9, 30, 0) });
  assert.equal(contents.length, 200);
  assert.match(latin1(bytes), /\/M \(D:20261016093000(Z|[+-]\d\d'\d\d')\)/);
  assert.match(pdfDate(new Date(2026, 0, 2, 3, 4, 5)), /^D:20260102030405(Z|[+-]\d\d'\d\d')$/);
});
