// Assinar um PDF que já existe sem reescrever o arquivo (pdf-append.js e signExisting, em sign.js): o original fica
// intacto, as assinaturas anteriores continuam valendo (inclusive as feitas por outro programa), e o PDF certificado
// sem permitir alterações é recusado. Só certificados de TESTE (test/fixtures/certificados) e PDFs assinados com
// eles pelo pyHanko (test/fixtures/assinados, gerados pelo gerar.py de lá).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash, verify as nodeVerify, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCertificate, SignError } from '../web/js/sign.js';
import { openPdf } from '../web/js/pdf-reader.js';
import { appendBlocker, buildAppendToSign, changePermission } from '../web/js/pdf-append.js';
import { readSignedData } from '../web/js/cms.js';
import { parse, sequence, CONTEXT } from '../web/js/asn1.js';
import { layoutPage } from '../web/js/pdf.js';
import { makeRawPdf, textPageObjects, samplePdfs } from './helpers/pdf.js';
import { qpdfCheck } from './helpers/qpdf.js';

const PASSWORD = 'senha-de-teste';
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const TIME = new Date(2026, 9, 16, 14, 32, 5);

const PAGES = [
  { jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(40, 30, 'a4', 18) },
  { width: 595.28, height: 841.89, items: [{ type: 'text', x: 72, y: 100, text: 'Contrato assinado por duas pessoas', font: 'Helvetica', size: 12 }] },
];

// Certificados que vieram dentro do CMS (SignedData, campo [0]).
function cmsCertificates(cms) {
  const [, wrapped] = sequence(parse(cms));
  const fields = sequence(sequence(wrapped, 0, CONTEXT)[0]);
  const set = fields.find((node) => node.cls === CONTEXT && node.tag === 0);
  return set.children.map((node) => new X509Certificate(Buffer.from(node.der)));
}

// Cada assinatura do PDF, conferida por conta própria: o /ByteRange, o messageDigest e a assinatura RSA com o
// certificado que ela traz. Devolve o nome (CN) de quem assinou, em ordem.
function verifyAll(bytes) {
  const text = latin1(bytes);
  const ranges = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)].map((m) => m.slice(1).map(Number));
  return ranges.map(([a, b, c, d]) => {
    assert.equal(a, 0);
    const hex = text.slice(b + 1, c - 1).replace(/(00)+$/, '');
    const cms = new Uint8Array(Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex'));
    const length = 4 + ((cms[2] << 8) | cms[3]);
    const { signed, digest, signature } = readSignedData(cms.subarray(0, length));
    const content = Buffer.concat([bytes.subarray(0, b), bytes.subarray(c, c + d)]);
    assert.equal(Buffer.from(digest).toString('hex'), createHash('sha256').update(content).digest('hex'), 'messageDigest');
    const signer = cmsCertificates(cms.subarray(0, length)).find((cert) => nodeVerify('sha256', signed, cert.publicKey, signature));
    assert.ok(signer, 'assinatura RSA');
    return signer.subject.match(/CN=([^\n]+)/)[1];
  });
}

// Objetos gravados na atualização (depois do original): "num gen".
const appended = (bytes, original) => [...latin1(bytes.subarray(original.length)).matchAll(/^(\d+) (\d+) obj$/gm)].map((m) => `${m[1]} ${m[2]}`);

test('coassinatura: a primeira assinatura continua válida depois da segunda, e o original fica intacto', async () => {
  const first = await openCertificate(fixture('certificados/titular-aes.pfx'), PASSWORD);
  const second = await openCertificate(fixture('certificados/segundo-titular.pfx'), PASSWORD);
  const one = await first.sign(PAGES, TIME, { stamp: { page: 'last', position: 'bottom-left' } });
  const two = await second.signExisting(await openPdf(one), TIME, { stamp: { page: 'last', position: 'bottom-right' } });
  assert.deepEqual(two.subarray(0, one.length), one, 'o PDF da primeira assinatura continua byte a byte');
  qpdfCheck(two);
  assert.deepEqual(verifyAll(two), ['PESSOA DE TESTE:00000000191', 'SEGUNDA PESSOA DE TESTE:00000000272']);

  // A segunda assinatura cobre o arquivo todo; a primeira, só o que existia quando ela foi feita.
  const ranges = [...latin1(two).matchAll(/\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\s*\]/g)].map((m) => m.slice(1).map(Number));
  assert.equal(ranges[0][2] + ranges[0][3], one.length);
  assert.equal(ranges[1][2] + ranges[1][3], two.length);

  // Dois campos de assinatura, com nomes diferentes, e a mesma página.
  const doc = await openPdf(two);
  assert.equal(doc.pages.length, 2);
  assert.equal(doc.repaired, false);
  const form = doc.resolve(doc.catalog().get('AcroForm'));
  const names = doc.resolve(form.get('Fields')).map((ref) => latin1(doc.resolve(doc.resolve(ref).get('T')).bytes));
  assert.deepEqual(names, ['Assinatura', 'Assinatura 2']);
  assert.equal(doc.resolve(form.get('SigFlags')), 3);
  assert.equal(doc.resolve(doc.pages[1].node.get('Annots')).length, 2);

  // A segunda assinatura também é só a hora (/M): nada de nome, motivo ou local.
  const update = latin1(two.subarray(one.length));
  assert.match(update, /\/Filter \/Adobe\.PPKLite \/SubFilter \/ETSI\.CAdES\.detached \/M \(D:20261016143205/);
  assert.doesNotMatch(update, /\/Name|\/Reason|\/Location|\/ContactInfo/);
  first.discard();
  second.discard();
});

test('coassinatura de PDF assinado por outro programa (pyHanko): a assinatura dele continua valendo', async () => {
  const original = fixture('assinados/assinado.pdf');
  const signer = await openCertificate(fixture('certificados/segundo-titular.pfx'), PASSWORD);
  const bytes = await signer.signExisting(await openPdf(original), TIME, { stamp: { page: 1, position: 'top-left' } });
  assert.deepEqual(bytes.subarray(0, original.length), original);
  qpdfCheck(bytes);
  assert.deepEqual(verifyAll(bytes), ['PESSOA DE TESTE:00000000191', 'SEGUNDA PESSOA DE TESTE:00000000272']);
  // O campo do outro programa se chama "Autor"; o nosso, "Assinatura". A xref nova é clássica, como a dele.
  const tail = latin1(bytes.subarray(original.length));
  assert.match(tail, /\/T <417373696e617475726[0-9a-f]*>/);
  assert.match(tail, /\nxref\n[\s\S]*trailer\n<< \/Size \d+ \/Prev \d+ \/Root/);
  signer.discard();
});

test('xref em stream no original: a atualização também vai em stream, com /Prev apontando para a dele', async () => {
  const original = fixture('assinados/certificado-p2.pdf');
  const doc = await openPdf(original);
  assert.equal(doc.repaired, false, 'xref com campos de 8 bytes (/W [1 8 2]) lida sem reparo');
  const { bytes } = buildAppendToSign(doc, { reserve: 64, time: TIME });
  const tail = latin1(bytes.subarray(original.length));
  assert.match(tail, new RegExp(`/Type /XRef /Size \\d+ /Index \\[[\\d ]+\\] /W \\[1 4 2\\] /Prev ${doc.startxref} /Root`));
  assert.doesNotMatch(tail, /\ntrailer\n/);
  qpdfCheck(bytes);
  const again = await openPdf(bytes);
  assert.equal(again.repaired, false);
  assert.equal(again.pages.length, 2);
});

test('PDF certificado: sem permitir alterações é recusado; com permissão de assinar, entra sem carimbo', async () => {
  const signer = await openCertificate(fixture('certificados/segundo-titular.pfx'), PASSWORD);
  const locked = await openPdf(fixture('assinados/certificado-p1.pdf'));
  assert.equal(changePermission(locked), 1);
  assert.equal(appendBlocker(locked).kind, 'locked');
  await assert.rejects(signer.signExisting(locked, TIME), (err) => err instanceof SignError && /certificou este PDF sem permitir/.test(err.message));
  assert.throws(() => buildAppendToSign(locked, { reserve: 64, time: TIME }), /certificou/);

  const certified = await openPdf(fixture('assinados/certificado-p2.pdf'));
  assert.equal(changePermission(certified), 2);
  assert.equal(appendBlocker(certified), null);
  await assert.rejects(signer.signExisting(certified, TIME, { stamp: { page: 'last', position: 'top-left' } }), /sem carimbo/);
  const bytes = await signer.signExisting(certified, TIME);
  assert.deepEqual(verifyAll(bytes), ['PESSOA DE TESTE:00000000191', 'SEGUNDA PESSOA DE TESTE:00000000272']);
  // O campo novo é invisível (/Rect zerado).
  assert.match(latin1(bytes.subarray(certified.bytes.length)), /\/FT \/Sig \/T <[0-9a-f]+> \/F 132 \/Rect \[0 0 0 0\]/);
  signer.discard();
});

test('/DocMDP: permissão padrão (2), a mais restritiva vence, e /FieldMDP com /P (PDF 2.0) também conta', async () => {
  const pdf = (perms, fields = '') => openPdf(makeRawPdf({
    1: `<< /Type /Catalog /Pages 2 0 R${perms} /AcroForm << /Fields [${fields}] >> >>`,
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] >>',
    ...textPageObjects('Certificado'),
    6: '<< /Type /Sig /Reference [<< /TransformMethod /DocMDP >>] >>',
    7: '<< /Type /Sig /Reference [<< /TransformMethod /DocMDP /TransformParams << /P 3 >> >>] >>',
    8: '<< /FT /Sig /T (Campo) /V 9 0 R >>',
    9: '<< /Type /Sig /Reference [<< /TransformMethod /FieldMDP /TransformParams << /Action /All /P 1 >> >>] >>',
    10: '<< /FT /Sig /T (Outro) /V 7 0 R >>',
  }).bytes);
  assert.equal(changePermission(await pdf('')), null);
  assert.equal(changePermission(await pdf(' /Perms << /DocMDP 6 0 R >>')), 2);
  assert.equal(changePermission(await pdf(' /Perms << /DocMDP 7 0 R >>')), 3);
  assert.equal(changePermission(await pdf(' /Perms << /DocMDP 7 0 R >>', '10 0 R')), 3);
  assert.equal(changePermission(await pdf(' /Perms << /DocMDP 7 0 R >>', '10 0 R 8 0 R')), 1);
});

test('PDF com senha ou com a xref quebrada: o app monta um PDF novo em vez de acrescentar', async () => {
  const encrypted = await openPdf(fixture('pdf-senha/r6-so-restricoes.pdf'));
  assert.equal(appendBlocker(encrypted).kind, 'rewrite');
  assert.match(appendBlocker(encrypted).message, /senha/);
  const { bytes } = makeRawPdf({ 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', ...textPageObjects('X') });
  const broken = bytes.slice();
  const at = latin1(broken).lastIndexOf('startxref\n') + 10;
  broken[at] = 0x39; // offset da xref errado: o leitor reconstrói varrendo o arquivo
  const repaired = await openPdf(broken);
  assert.equal(repaired.repaired, true);
  assert.equal(appendBlocker(repaired).kind, 'rewrite');
  const signer = await openCertificate(fixture('certificados/titular-aes.pfx'), PASSWORD);
  await assert.rejects(signer.signExisting(repaired, TIME), (err) => err instanceof SignError && /danificada/.test(err.message));
  signer.discard();
});

test('lista /Annots e formulário em objetos à parte: só eles são regravados, com o mesmo número', async () => {
  const { bytes: original } = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm 11 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] >>',
    ...textPageObjects('Formulario', { extra: ' /Annots 10 0 R' }),
    10: '[12 0 R]',
    11: '<< /Fields 13 0 R /SigFlags 3 /DA (/Helv 0 Tf 0 g) >>',
    12: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Assinatura) /Rect [72 600 300 620] /P 3 0 R >>',
    13: '[12 0 R]',
  });
  const doc = await openPdf(original);
  const { bytes } = buildAppendToSign(doc, { reserve: 64, time: TIME, stamp: { name: 'PESSOA DE TESTE', page: 'last', position: 'top-right' } });
  // Lista de anotações (10) e de campos (13) regravadas; página, catálogo e formulário (SigFlags já é 3) não.
  // Depois, o campo novo (14), o carimbo (16) e o dicionário da assinatura (15).
  assert.deepEqual(appended(bytes, original), ['10 0', '13 0', '14 0', '16 0', '15 0']);
  qpdfCheck(bytes);
  const again = await openPdf(bytes);
  assert.deepEqual(again.resolve(again.pages[0].node.get('Annots')).map((ref) => ref.num), [12, 14]);
  // Já existe um campo "Assinatura" (de texto): o novo vira "Assinatura 2".
  assert.equal(latin1(again.resolve(again.object(14).get('T')).bytes), 'Assinatura 2');
  assert.equal(again.isSigned(), true);
  // O formulário guarda o que tinha (a aparência padrão /DA).
  assert.ok(again.resolve(again.catalog().get('AcroForm')).has('DA'));
});

test('sem formulário: o catálogo é regravado com um /AcroForm novo, e a página ganha a lista /Annots', async () => {
  const original = samplePdfs()['xref-stream']; // catálogo, páginas e a página dentro de object stream
  const doc = await openPdf(original);
  const { bytes } = buildAppendToSign(doc, { reserve: 64, time: TIME });
  assert.deepEqual(appended(bytes, original).slice(0, 2), ['1 0', '3 0']);
  qpdfCheck(bytes);
  const again = await openPdf(bytes);
  const form = again.resolve(again.catalog().get('AcroForm'));
  assert.equal(again.resolve(form.get('SigFlags')), 3);
  assert.equal(again.resolve(form.get('Fields')).length, 1);
  assert.equal(again.resolve(again.pages[0].node.get('Annots')).length, 1);
  assert.equal(again.isSigned(), true);
});

test('o openssl cms -verify confere as duas assinaturas da coassinatura com a cadeia de teste', async (t) => {
  const OPENSSL = process.env.OPENSSL || 'openssl';
  if (spawnSync(OPENSSL, ['version']).error) {
    if (process.env.CI) throw new Error('openssl não encontrado: no CI ele é obrigatório.');
    t.skip('openssl não encontrado');
    return;
  }
  const first = await openCertificate(fixture('certificados/titular-legacy.pfx'), PASSWORD);
  const second = await openCertificate(fixture('certificados/segundo-titular.pfx'), PASSWORD);
  const bytes = await second.signExisting(await openPdf(await first.sign(PAGES, TIME)), TIME);
  const text = latin1(bytes);
  const dir = mkdtempSync(join(tmpdir(), 'cms-'));
  try {
    writeFileSync(join(dir, 'raiz.pem'), new X509Certificate(Buffer.from(fixture('certificados/ac-raiz.cer'))).toString());
    for (const [i, m] of [...text.matchAll(/\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\s*\]/g)].entries()) {
      const [, b, c, d] = m.slice(1).map(Number);
      const cms = Buffer.from(text.slice(b + 1, c - 1), 'hex');
      writeFileSync(join(dir, `assinatura-${i}.der`), cms.subarray(0, 4 + ((cms[2] << 8) | cms[3])));
      writeFileSync(join(dir, `conteudo-${i}.bin`), Buffer.concat([bytes.subarray(0, b), bytes.subarray(c, c + d)]));
      const result = spawnSync(OPENSSL, ['cms', '-verify', '-binary', '-inform', 'DER', '-in', join(dir, `assinatura-${i}.der`),
        '-content', join(dir, `conteudo-${i}.bin`), '-CAfile', join(dir, 'raiz.pem'), '-purpose', 'any', '-out', join(dir, 'saida.bin')],
      { encoding: 'utf8' });
      assert.equal(result.status, 0, `assinatura ${i + 1}: ${result.stdout}${result.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  first.discard();
  second.discard();
});

test('estrutura danificada que o leitor ainda abre: o app monta um PDF novo em vez de acrescentar', async () => {
  const objects = (extra = {}) => ({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] >>',
    ...textPageObjects('Danificado'),
    ...extra,
  });
  const cases = {
    '/Size menor que o maior objeto': makeRawPdf(objects(), { trailer: '/Root 1 0 R /Size 3' }).bytes,
    'referência com outra geração': makeRawPdf(objects(), { trailer: '/Root 1 7 R' }).bytes,
    'geração impossível': makeRawPdf(objects(), { trailer: '/Root 1 99999999999 R' }).bytes,
    'página sem MediaBox': makeRawPdf(objects({ 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' })).bytes,
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const doc = await openPdf(bytes);
    assert.equal(doc.repaired, false, `${name}: abre sem reparo`);
    assert.equal(appendBlocker(doc)?.kind, 'rewrite', name);
  }
  // O mesmo PDF, sem defeito, recebe a assinatura no fim.
  assert.equal(appendBlocker(await openPdf(makeRawPdf(objects()).bytes)), null);
});
