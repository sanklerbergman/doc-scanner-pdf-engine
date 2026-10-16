// PDF com senha: abrir os PDFs cifrados pelo qpdf (revisões 2 a 6) e proteger o PDF gerado (AES-256).
// Os arquivos de test/fixtures/pdf-senha são gerados pelo gerar.mjs de lá, a partir do base.pdf.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { md5, rc4, preparePassword, protectPdf, openSecurity, PdfPasswordError } from '../web/js/pdf-crypt.js';
import { openPdf, copyPages, PdfError, PdfName, PdfDict } from '../web/js/pdf-reader.js';
import { buildPdf as build, layoutPage } from '../web/js/pdf.js';
import { buildPdf, qpdfCheck, qpdfRun, qpdfShow } from './helpers/qpdf.js';
import { openCertificate, verifySignedPdf } from '../web/js/sign.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const pdfFixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/pdf-senha/${name}`, import.meta.url)));
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

// O que interessa de um PDF aberto: o conteúdo das páginas (descompactado) e as strings do base.pdf.
function contents(doc) {
  const decode = (stream) => latin1(doc.resolve(stream.dict.get('Filter')) instanceof PdfName ? inflateSync(stream.data) : stream.data);
  const field = doc.resolve(doc.resolve(doc.pages[1].node.get('Annots'))?.[0]);
  return {
    pages: doc.pages.map((page) => decode(doc.resolve(page.node.get('Contents')))),
    texto: latin1(doc.resolve(doc.catalog().get('Teste')).get('Texto').bytes),
    campo: field ? latin1(field.get('V').bytes) : null,
    aparencia: field ? decode(doc.resolve(doc.resolve(field.get('AP')).get('N'))) : null,
  };
}

const FIXTURES = {
  'r2-rc4-40.pdf': 'usuario',
  'r3-rc4-128.pdf': 'usuario',
  'r4-aes-128.pdf': 'usuario',
  'r4-aes-128-object-streams.pdf': 'usuario',
  'r5-aes-256.pdf': 'usuario',
  'r6-aes-256.pdf': 'usuario',
  'r6-aes-256-object-streams.pdf': 'usuario',
  'r4-senha-acao.pdf': 'ação',
  'r6-senha-acao.pdf': 'ação',
  'r6-senha-japones.pdf': 'パスワード',
};

// ---------- MD5 e RC4 ----------

test('MD5: vetores da RFC 1321 e bate com o node:crypto', () => {
  const vectors = {
    '': 'd41d8cd98f00b204e9800998ecf8427e',
    a: '0cc175b9c0f1b6a831c399e269772661',
    abc: '900150983cd24fb0d6963f7d28e17f72',
    'message digest': 'f96b697d7cb7938d525a2f31aaf161d0',
    abcdefghijklmnopqrstuvwxyz: 'c3fcd3d76192e4007dfb496cca67e13b',
    ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789: 'd174ab98d277d9f5a5611c2c9f419d9f',
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890': '57edf4a22be3c955ac49da2e2107b67a',
  };
  for (const [text, digest] of Object.entries(vectors)) assert.equal(hex(md5(new TextEncoder().encode(text))), digest, text);
  for (const size of [55, 56, 63, 64, 65, 1000]) {
    const data = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 255);
    assert.equal(hex(md5(data)), createHash('md5').update(data).digest('hex'), `${size} bytes`);
  }
});

test('RC4: vetores conhecidos (RFC 6229 e os clássicos)', () => {
  const text = (value) => new TextEncoder().encode(value);
  assert.equal(hex(rc4(text('Key'), text('Plaintext'))), 'bbf316e8d940af0ad3');
  assert.equal(hex(rc4(text('Wiki'), text('pedia'))), '1021bf0420');
  assert.equal(hex(rc4(text('Secret'), text('Attack at dawn'))), '45a01f645fc35b383552544b9bf5');
  // RFC 6229, chave de 40 bits 0102030405, primeiros 16 bytes da sequência.
  assert.equal(hex(rc4(Uint8Array.from([1, 2, 3, 4, 5]), new Uint8Array(16))), 'b2396305f03dc027ccc3524a0a1118a8');
});

test('senha das revisões 5 e 6: SASLprep (espaços e NFKC) e no máximo 127 bytes sem cortar caractere', () => {
  assert.equal(latin1(preparePassword('a b')), 'a b');
  assert.deepEqual(preparePassword('ﬁ'), new TextEncoder().encode('fi'), 'NFKC: a ligadura vira "fi"');
  assert.deepEqual(preparePassword('ação'), new TextEncoder().encode('ação'));
  const long = preparePassword('ç'.repeat(100)); // 200 bytes em UTF-8
  assert.equal(long.length, 126, 'corta em 127 bytes, sem deixar meio "ç"');
});

// ---------- Abrir ----------

test('abre os PDFs com senha das revisões 2 a 6 (RC4 e AES, com e sem object streams) e decifra tudo', async () => {
  const base = contents(await openPdf(pdfFixture('base.pdf')));
  assert.match(base.pages[0], /Contracheque de teste/);
  for (const [name, password] of Object.entries(FIXTURES)) {
    const bytes = pdfFixture(name);
    // Sem senha: pede a senha (não é "corrompido").
    await assert.rejects(openPdf(bytes), (err) => err instanceof PdfPasswordError && !err.wrong, name);
    await assert.rejects(openPdf(bytes, { password: 'errada' }), (err) => err instanceof PdfPasswordError && err.wrong, name);
    for (const attempt of [password, 'dono']) {
      const doc = await openPdf(bytes, { password: attempt });
      assert.deepEqual(contents(doc), base, `${name} com a senha ${attempt === 'dono' ? 'de proprietário' : 'de usuário'}`);
      assert.deepEqual(doc.security, { hadPassword: true, restricted: false });
      assert.equal(doc.crypt, null, 'a chave não fica guardada');
    }
  }
});

test('PDF só com restrições do autor abre sem senha, e as restrições não são aplicadas', async () => {
  for (const name of ['r6-so-restricoes.pdf', 'r3-so-restricoes.pdf']) {
    const doc = await openPdf(pdfFixture(name));
    assert.deepEqual(doc.security, { hadPassword: false, restricted: true }, name);
    assert.match(contents(doc).pages[0], /Contracheque de teste/);
    // Juntar e separar funcionam: a cópia sai sem /Encrypt, válida para o qpdf.
    const copy = copyPages(doc, [1, 0]);
    const out = buildPdf([1, 0].map((i) => ({ copy: { source: copy, page: copy.pages.get(i) } })));
    assert.doesNotMatch(latin1(out), /\/Encrypt/);
    const merged = await openPdf(out);
    assert.match(latin1(inflateIfNeeded(merged, merged.resolve(merged.pages[1].node.get('Contents')))), /Contracheque de teste/);
  }
});

test('o que o app decifra bate com o qpdf --decrypt', async () => {
  for (const [name, password] of Object.entries(FIXTURES)) {
    const decrypted = qpdfRun(['--decrypt', `--password=${password}`], pdfFixture(name));
    if (!decrypted) return; // sem qpdf fora do CI: o teste anterior já compara com o base.pdf
    assert.deepEqual(contents(await openPdf(pdfFixture(name), { password })), contents(await openPdf(decrypted.output)), name);
  }
});

test('PDF que só cifra os anexos (/EFF) abre sem senha: o documento em si não é cifrado', async () => {
  const name = (value) => new PdfName(value);
  const encrypt = new PdfDict([
    ['Filter', name('Standard')], ['V', 4], ['R', 4], ['Length', 128],
    ['CF', new PdfDict([['StdCF', new PdfDict([['CFM', name('AESV2')], ['AuthEvent', name('EFOpen')]])]])],
    ['StmF', name('Identity')], ['StrF', name('Identity')], ['EFF', name('StdCF')],
  ]);
  const security = await openSecurity(encrypt, new Uint8Array(0), null);
  assert.equal(security.hadPassword, false);
  const value = new PdfDict([['Texto', 'como está']]);
  assert.equal(await security.decrypt(value, 1, 0), value);
});

test('PDF protegido com certificado (não com senha) é recusado com mensagem própria', async () => {
  const encrypt = new PdfDict([['Filter', new PdfName('Adobe.PubSec')], ['V', 4], ['R', 4]]);
  await assert.rejects(openSecurity(encrypt, new Uint8Array(0), null), (err) => err instanceof PdfError && !(err instanceof PdfPasswordError) && /certificado digital/.test(err.message));
});

// ---------- Proteger o PDF gerado ----------

const PAGES = [
  { jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(40, 30, 'a4', 18) },
  { width: 595.28, height: 841.89, items: [{ type: 'text', x: 72, y: 100, text: 'Página com senha (ç) \\ fim', font: 'Helvetica', size: 12 }] },
];

test('proteger com senha: AES-256 (revisão 6), sem senha de proprietário escondida, e o conteúdo volta igual', async () => {
  const plain = build(PAGES);
  for (const password of ['senha-de-teste', 'ação 123', 'パスワード']) {
    const { bytes } = await protectPdf(plain, password);
    const text = latin1(bytes);
    assert.match(text, /\/Filter \/Standard \/V 5 \/R 6 \/Length 256/);
    assert.match(text, /\/CFM \/AESV3/);
    assert.match(text, /\/P -4 /, 'tudo permitido');
    assert.match(text, /\/Extensions << \/ADBE << \/BaseVersion \/1\.7 \/ExtensionLevel 8 >> >>/);
    assert.doesNotMatch(text, /Página com senha|\/Info|\/Producer/, 'nada do conteúdo em claro');
    assert.ok(!text.includes(latin1(PAGES[0].jpeg.subarray(0, 64))), 'nem a foto');

    await assert.rejects(openPdf(bytes), (err) => err instanceof PdfPasswordError && !err.wrong);
    await assert.rejects(openPdf(bytes, { password: 'errada' }), (err) => err instanceof PdfPasswordError && err.wrong);
    const doc = await openPdf(bytes, { password });
    const original = await openPdf(plain);
    for (const i of [0, 1]) {
      const stream = (d) => d.resolve(d.pages[i].node.get('Contents'));
      assert.deepEqual(stream(doc).data, stream(original).data, `conteúdo da página ${i + 1}`);
    }
    const image = (d) => [...d.resolve(d.resolve(d.pages[0].node.get('Resources')).get('XObject')).values()].map((ref) => d.resolve(ref))[0];
    assert.deepEqual(image(doc).data, PAGES[0].jpeg, 'a foto volta byte a byte');

    // Conferência independente: o qpdf abre com a senha, diz que ela é a de usuário e não vê restrição nenhuma.
    qpdfCheck(bytes, password);
    const shown = qpdfShow(['--show-encryption', `--password=${password}`], bytes);
    if (shown) {
      assert.match(shown, /R = 6/);
      assert.doesNotMatch(shown, /not allowed/);
    }
    const decrypted = qpdfRun(['--decrypt', `--password=${password}`], bytes);
    if (decrypted) {
      const back = await openPdf(decrypted.output);
      assert.match(latin1(inflateIfNeeded(back, back.resolve(back.pages[1].node.get('Contents')))), /P\\341gina com senha/);
    }
  }
});

function inflateIfNeeded(doc, stream) {
  return doc.resolve(stream.dict.get('Filter')) instanceof PdfName ? inflateSync(stream.data) : stream.data;
}

test('proteger com senha cada vez gera chaves novas: o mesmo PDF não sai igual duas vezes', async () => {
  const plain = build(PAGES);
  const a = (await protectPdf(plain, 'mesma')).bytes;
  const b = (await protectPdf(plain, 'mesma')).bytes;
  assert.notDeepEqual(a, b);
  await assert.rejects(protectPdf(plain, ''), /Sem senha/);
});

test('assinar e proteger com senha: o /Contents da assinatura fica sem cifrar e a assinatura confere', async () => {
  const signer = await openCertificate(new Uint8Array(readFileSync(new URL('./fixtures/certificados/titular-aes.pfx', import.meta.url))), 'senha-de-teste');
  const bytes = await signer.sign(PAGES, new Date(), { password: 'senha-do-pdf' });
  const text = latin1(bytes);
  assert.match(text, /\/Encrypt \d+ 0 R/);
  assert.match(text, /\/SubFilter \/ETSI\.CAdES\.detached/);
  // O hash e a assinatura conferem sobre o arquivo cifrado, com a chave pública do certificado.
  const { readPkcs12 } = await import('../web/js/pkcs12.js');
  const { readCertificate } = await import('../web/js/x509.js');
  const { certificates } = await readPkcs12(new Uint8Array(readFileSync(new URL('./fixtures/certificados/titular-aes.pfx', import.meta.url))), 'senha-de-teste');
  const holder = certificates.map((der) => readCertificate(der)).find((cert) => cert.subject.CN.startsWith('PESSOA'));
  assert.equal(await verifySignedPdf(bytes, holder.spki), true);
  // Aberto com a senha, o leitor do app vê a assinatura; sem a senha, não abre.
  assert.equal((await openPdf(bytes, { password: 'senha-do-pdf' })).isSigned(), true);
  await assert.rejects(openPdf(bytes), PdfPasswordError);
  qpdfCheck(bytes, 'senha-do-pdf');
  signer.discard();
});

test('PDF sem a opção de senha continua sem /Encrypt nem /ID: proteger é um passo à parte', () => {
  assert.doesNotMatch(latin1(build(PAGES)), /\/Encrypt|\/ID/);
});
