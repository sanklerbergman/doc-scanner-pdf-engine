// PDF/A-2b: identificação do padrão (XMP), perfil sRGB (icc.js), /ID tirado do conteúdo e, nas páginas de Word e no
// carimbo da assinatura, as fontes embutidas (subconjunto das Liberation, pdfa-fonts.js e ttf.js).
// Conferência independente: o veraPDF (validador de referência do PDF/A), quando a variável VERAPDF aponta o
// programa (verapdf ou verapdf.bat). Sem ele, esse teste é pulado; o resto roda sempre.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash, verify as nodeVerify, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layoutPage } from '../web/js/pdf.js';
import { srgbProfile } from '../web/js/icc.js';
import { md5 } from '../web/js/md5.js';
import { openCertificate, verifySignedPdf } from '../web/js/sign.js';
import { readPkcs12 } from '../web/js/pkcs12.js';
import { readCertificate } from '../web/js/x509.js';
import { buildPdf, qpdfCheck } from './helpers/qpdf.js';
import { embedFonts, usedCharacters } from '../web/js/pdfa-fonts.js';
import { openPdf } from '../web/js/pdf-reader.js';
import { readTrueType } from '../web/js/ttf.js';
import { inflate } from '../web/js/inflate.js';
import { stampCharacters } from '../web/js/stamp.js';
import { readSignedData } from '../web/js/cms.js';
import { textWidth, winAnsiCode } from '../web/js/fonts.js';
import { allPagesText } from '../web/js/edit-text.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const hex = (bytes) => Buffer.from(bytes).toString('hex');

const WORDS = [
  { text: 'Contrato', x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.14, baseline: 0.135, size: 0.04, last: false, confidence: 95 },
  { text: 'ação nº 1', x0: 0.32, y0: 0.1, x1: 0.6, y1: 0.14, baseline: 0.135, size: 0.04, last: true, confidence: 90 },
];
const PAGES = [
  { jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(40, 30, 'a4', 18), ocr: WORDS },
  { jpeg: fixture('gray-16x24.jpg'), ...layoutPage(16, 24, 'letter', 0) },
];

// Página de Word com as três famílias, em estilos diferentes, e acentos e símbolos da WinAnsi.
const WORD = {
  width: 595.28, height: 841.89, items: [
    { type: 'text', x: 72, y: 100, text: 'Contrato de locação — cláusula 1ª', font: 'Times-Bold', size: 14 },
    { type: 'text', x: 72, y: 130, text: 'R$ 1.500,00 (mil e quinhentos reais), “aspas” e €', font: 'Times-Roman', size: 11, wordSpacing: 0.4 },
    { type: 'text', x: 72, y: 150, text: 'Helvetica em itálico: ação', font: 'Helvetica-Oblique', size: 11 },
    { type: 'text', x: 72, y: 170, text: 'Código 0123', font: 'Courier', size: 10 },
    { type: 'line', x1: 72, x2: 520, y: 180, width: 0.5 },
  ],
};

test('PDF/A desligado: o PDF sai igual ao de sempre', () => {
  const plain = buildPdf(PAGES);
  assert.deepEqual(buildPdf(PAGES, { pdfa: false }), plain);
  assert.doesNotMatch(latin1(plain), /\/Metadata|\/OutputIntents|\/ID/);
});

test('PDF/A: catálogo com /Metadata e /OutputIntents, trailer com /ID, e o XMP só com a identificação', () => {
  const text = latin1(buildPdf(PAGES, { pdfa: true })); // conferido pelo qpdf
  assert.match(text, /\/Type \/Catalog \/Pages 2 0 R \/Metadata (\d+) 0 R \/OutputIntents \[<< \/Type \/OutputIntent \/S \/GTS_PDFA1 \/OutputConditionIdentifier \(sRGB IEC61966-2\.1\) \/Info \(sRGB IEC61966-2\.1\) \/DestOutputProfile (\d+) 0 R >>\]/);
  const [, metadataId, iccId] = text.match(/\/Metadata (\d+) 0 R .*\/DestOutputProfile (\d+) 0 R/);
  // XMP: sem compressão, com o /Length em bytes (a marca U+FEFF ocupa 3), e nada além da parte e do nível.
  const xmp = text.match(new RegExp(`${metadataId} 0 obj\\n<< /Type /Metadata /Subtype /XML /Length (\\d+) >>\\nstream\\n([\\s\\S]*?)\\nendstream`));
  assert.ok(xmp, 'objeto do XMP');
  assert.equal(Number(xmp[1]), xmp[2].length, 'em latin1, cada byte é um caractere');
  assert.ok(xmp[2].startsWith('<?xpacket begin="\xef\xbb\xbf"'), 'marca de ordem dos bytes em UTF-8');
  assert.match(xmp[2], /<pdfaid:part>2<\/pdfaid:part>/);
  assert.match(xmp[2], /<pdfaid:conformance>B<\/pdfaid:conformance>/);
  assert.doesNotMatch(xmp[2], /Date|Producer|Creator|Author|Title|dc:|xmp:|tool/i, 'sem datas, autor, título nem programa');
  assert.match(text, new RegExp(`${iccId} 0 obj\\n<< /N 3 /Length ${srgbProfile().length} >>`));
  assert.match(text, /trailer\n<< \/Size \d+ \/Root 1 0 R \/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\] >>/);
  assert.doesNotMatch(text, /\/Info \d+ 0 R|\/Producer|\/CreationDate/);
});

test('PDF/A: o /ID é o MD5 do conteúdo: igual para o mesmo PDF e diferente quando ele muda', () => {
  const idOf = (bytes) => latin1(bytes).match(/\/ID \[<([0-9a-f]{32})>/)[1];
  const a = buildPdf(PAGES, { pdfa: true });
  assert.equal(idOf(a), idOf(buildPdf(PAGES, { pdfa: true })));
  assert.notEqual(idOf(a), idOf(buildPdf(PAGES.slice(1), { pdfa: true })));
  const body = a.subarray(0, latin1(a).lastIndexOf('trailer\n'));
  assert.equal(idOf(a), hex(md5(body)), 'MD5 de tudo o que vem antes do trailer');
});

test('perfil sRGB: cabeçalho ICC v2, assinatura acsp, tags obrigatórias e brancos coerentes', () => {
  const icc = srgbProfile();
  const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const tag = (offset) => latin1(icc.subarray(offset, offset + 4));
  assert.equal(view.getUint32(0), icc.length, 'tamanho no cabeçalho');
  assert.equal(view.getUint32(8), 0x02100000, 'versão 2.1');
  assert.deepEqual([tag(12), tag(16), tag(20), tag(36)], ['mntr', 'RGB ', 'XYZ ', 'acsp']);
  const count = view.getUint32(128);
  const tags = new Map();
  for (let i = 0; i < count; i++) {
    const at = view.getUint32(136 + i * 12);
    const size = view.getUint32(140 + i * 12);
    assert.ok(at % 4 === 0 && at + size <= icc.length, `tag ${tag(132 + i * 12)} dentro do perfil`);
    tags.set(tag(132 + i * 12), { at, size });
  }
  assert.deepEqual([...tags.keys()].sort(), ['bTRC', 'bXYZ', 'cprt', 'desc', 'gTRC', 'gXYZ', 'rTRC', 'rXYZ', 'wtpt']);
  const xyz = (name) => [8, 12, 16].map((k) => view.getInt32(tags.get(name).at + k) / 65536);
  // As três colunas da matriz somam o branco D50 do espaço de conexão.
  const sum = [0, 1, 2].map((k) => xyz('rXYZ')[k] + xyz('gXYZ')[k] + xyz('bXYZ')[k]);
  [0.9642, 1, 0.8249].forEach((v, k) => assert.ok(Math.abs(sum[k] - v) < 0.002, `branco D50, componente ${k}`));
  // Curva do sRGB: começa em 0, termina em 1 e só sobe.
  const { at } = tags.get('rTRC');
  const points = view.getUint32(at + 8);
  const values = Array.from({ length: points }, (_, i) => view.getUint16(at + 12 + i * 2));
  assert.equal(values[0], 0);
  assert.equal(values.at(-1), 65535);
  assert.ok(values.every((v, i) => i === 0 || v >= values[i - 1]));
});

test('PDF/A assinado: o catálogo leva a assinatura e a identificação, e a assinatura confere', async () => {
  const pfx = fixture('certificados/titular-aes.pfx');
  const signer = await openCertificate(pfx, 'senha-de-teste');
  const bytes = await signer.sign(PAGES, new Date(), { pdfa: true });
  qpdfCheck(bytes);
  const text = latin1(bytes);
  assert.match(text, /\/Metadata \d+ 0 R \/OutputIntents \[.*\] \/AcroForm << \/Fields \[\d+ 0 R\] \/SigFlags 3 >>/);
  assert.match(text, /\/F 132 /, 'o campo da assinatura imprime (o PDF/A exige)');
  const { certificates } = await readPkcs12(pfx, 'senha-de-teste');
  const holder = certificates.map((der) => readCertificate(der)).find((cert) => cert.subject.CN.startsWith('PESSOA'));
  assert.equal(await verifySignedPdf(bytes, holder.spki), true);
  await assert.rejects(signer.sign(PAGES, new Date(), { pdfa: true, password: 'x' }), /não permite senha/);
  signer.discard();
});

test('letras usadas: por fonte, no Word e, na Helvetica, também as da camada do OCR', () => {
  const used = usedCharacters([WORD, ...PAGES]);
  assert.deepEqual([...used.keys()].sort(), ['Courier', 'Helvetica-Oblique', 'Times-Bold', 'Times-Roman']);
  assert.ok(used.get('Times-Bold').has('ª') && used.get('Times-Bold').has('—'));
  // A Helvetica só aparece no OCR (texto invisível): continua sem embutir.
  assert.equal(used.has('Helvetica'), false);
  const withHelvetica = { ...WORD, items: [...WORD.items, { type: 'text', x: 72, y: 200, text: 'Sem serifa', font: 'Helvetica', size: 11 }] };
  const both = usedCharacters([withHelvetica, ...PAGES]).get('Helvetica');
  for (const char of 'Sem serifaContrato ação nº 1') assert.ok(both.has(char), `"${char}"`);
});

test('PDF/A com Word: TrueType embutida (subconjunto), larguras da própria fonte, ToUnicode e o resto igual', async () => {
  const fonts = await embedFonts([WORD]);
  const bytes = buildPdf([WORD], { pdfa: true, fonts });
  const text = latin1(bytes);
  assert.equal(text.match(/\/Subtype \/TrueType/g).length, 4);
  assert.doesNotMatch(text, /\/Subtype \/Type1/, 'nenhuma fonte sem embutir no texto visível');
  const doc = await openPdf(bytes);
  const fontsOf = doc.resolve(doc.resolve(doc.pages[0].attrs.Resources).get('Font'));
  for (const ref of fontsOf.values()) {
    const font = doc.resolve(ref);
    const name = font.get('BaseFont').value;
    assert.match(name, /^[A-Z]{6}\+Liberation(Sans|Serif|Mono)/);
    assert.equal(font.get('Encoding').value, 'WinAnsiEncoding');
    const descriptor = doc.resolve(font.get('FontDescriptor'));
    assert.equal(descriptor.get('FontName').value, name);
    assert.equal(descriptor.get('Flags') & 32, 32, 'não simbólica');
    // O /Widths bate com a fonte embutida, código a código.
    const file = doc.resolve(descriptor.get('FontFile2'));
    const program = await inflate(file.data, 'deflate', 10 * 1024 * 1024);
    assert.equal(program.length, file.dict.get('Length1'));
    const ttf = readTrueType(program);
    const first = font.get('FirstChar');
    font.get('Widths').forEach((width, i) => {
      const code = first + i;
      const char = new TextDecoder('windows-1252').decode(Uint8Array.of(code));
      const glyph = ttf.glyphOf(char.codePointAt(0));
      assert.equal(width, glyph ? ttf.width(char.codePointAt(0)) : 0, `${name}, código ${code}`);
    });
    const unicode = latin1(doc.resolve(font.get('ToUnicode')).data);
    assert.match(unicode, /beginbfchar/);
  }
  assert.match(latin1(doc.resolve(doc.resolve(fontsOf.get('F1')).get('ToUnicode')).data), /<AA> <00AA>/, 'ª (código AA)');
  // O mesmo documento dá o mesmo PDF (a tag do subconjunto sai do conteúdo).
  assert.deepEqual(buildPdf([WORD], { pdfa: true, fonts: await embedFonts([WORD]) }), bytes);
  // Sem PDF/A, as fontes passadas são ignoradas: o PDF sai como sempre.
  assert.deepEqual(buildPdf([WORD], { fonts }), buildPdf([WORD]));
});

// ---------- Carimbo da assinatura com o PDF/A ----------

const STAMP = { position: 'bottom-right', page: 'last' };
const TIME = new Date(2026, 9, 24, 9, 41, 7);
const HOLDER = 'PESSOA DE TESTE'; // o nome do certificado de teste, sem o CPF
const signerOf = () => openCertificate(fixture('certificados/titular-aes.pfx'), 'senha-de-teste');
// Página de Word que também usa a Helvetica normal e a negrito, as fontes do carimbo.
const WORD_SANS = {
  ...WORD,
  items: [...WORD.items,
    { type: 'text', x: 72, y: 200, text: 'Sem serifa', font: 'Helvetica', size: 11 },
    { type: 'text', x: 72, y: 220, text: 'Negrito: Wx', font: 'Helvetica-Bold', size: 11 }],
};

// Fontes da aparência do carimbo (o campo da assinatura, na última página).
function stampFontsOf(doc) {
  const widget = doc.resolve(doc.resolve(doc.pages.at(-1).node.get('Annots'))[0]);
  const appearance = doc.resolve(doc.resolve(widget.get('AP')).get('N'));
  return doc.resolve(doc.resolve(appearance.dict.get('Resources')).get('Font'));
}

// Fonte embutida: TrueType com FontFile2 (FlateDecode), WinAnsiEncoding e ToUnicode, e cada letra pedida no
// subconjunto e no ToUnicode.
async function assertEmbedded(doc, ref, baseName, chars) {
  const font = doc.resolve(ref);
  assert.equal(font.get('Subtype').value, 'TrueType');
  assert.match(font.get('BaseFont').value, new RegExp(`^[A-Z]{6}\\+${baseName}$`));
  assert.equal(font.get('Encoding').value, 'WinAnsiEncoding');
  const file = doc.resolve(doc.resolve(font.get('FontDescriptor')).get('FontFile2'));
  assert.equal(file.dict.get('Filter').value, 'FlateDecode');
  const ttf = readTrueType(await inflate(file.data, 'deflate', 10 * 1024 * 1024));
  const unicode = latin1(doc.resolve(font.get('ToUnicode')).data);
  const code = (n, size) => n.toString(16).toUpperCase().padStart(size, '0');
  for (const char of chars) {
    assert.ok(ttf.glyphOf(char.codePointAt(0)), `"${char}" no subconjunto da ${baseName}`);
    assert.ok(unicode.includes(`<${code(winAnsiCode(char), 2)}> <${code(char.codePointAt(0), 4)}>`), `"${char}" no ToUnicode da ${baseName}`);
  }
  return font;
}

// Assinatura conferida como no sign.test.js: o hash do que o /ByteRange cobre bate com o messageDigest, e a
// assinatura RSA confere com a chave pública do titular, pelo node:crypto e pelo próprio app.
async function assertSigned(bytes) {
  const text = latin1(bytes);
  const [, b, c] = text.match(/\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\s*\]/).slice(1).map(Number);
  const { signed, digest, signature } = readSignedData(new Uint8Array(Buffer.from(text.slice(b + 1, c - 1), 'hex')));
  const content = Buffer.concat([bytes.subarray(0, b), bytes.subarray(c)]);
  assert.equal(hex(digest), createHash('sha256').update(content).digest('hex'), 'messageDigest');
  const { certificates } = await readPkcs12(fixture('certificados/titular-aes.pfx'), 'senha-de-teste');
  const holder = certificates.map((der) => new X509Certificate(Buffer.from(der))).find((cert) => cert.subject.includes(HOLDER));
  assert.ok(nodeVerify('sha256', signed, holder.publicKey, signature), 'assinatura RSA sobre os atributos');
  assert.equal(await verifySignedPdf(bytes, new Uint8Array(holder.publicKey.export({ type: 'spki', format: 'der' }))), true);
  assert.equal((await openPdf(bytes)).isSigned(), true);
}

test('letras usadas com o carimbo: as dele e, na Helvetica embutida para ele, também as da camada do OCR', () => {
  const used = usedCharacters(PAGES, stampCharacters(HOLDER));
  assert.deepEqual([...used.keys()].sort(), ['Helvetica', 'Helvetica-Bold']);
  for (const char of 'Contrato ação nº 1 Assinado em às 0123456789/:()UTC+-…') assert.ok(used.get('Helvetica').has(char), `"${char}"`);
  for (const char of `${HOLDER}?…`) assert.ok(used.get('Helvetica-Bold').has(char), `"${char}"`);
});

test('PDF/A com carimbo e só fotos: a aparência leva a Liberation Sans normal e negrito embutidas, e a assinatura confere', async () => {
  const signer = await signerOf();
  const fonts = await embedFonts(PAGES, stampCharacters(signer.name));
  const bytes = await signer.sign(PAGES, TIME, { pdfa: true, stamp: STAMP, fonts });
  qpdfCheck(bytes);
  await assertSigned(bytes);
  const text = latin1(bytes);
  assert.doesNotMatch(text, /\/Subtype \/Type1/, 'nenhuma fonte sem embutir');
  assert.equal(text.match(/\/Subtype \/TrueType/g).length, 2);
  assert.match(text, /\/Metadata \d+ 0 R \/OutputIntents/);
  const doc = await openPdf(bytes);
  const stampFonts = stampFontsOf(doc);
  await assertEmbedded(doc, stampFonts.get('F1'), 'LiberationSans', 'Assinado digitalmente por em às 0123456789/:()UTC+-…');
  await assertEmbedded(doc, stampFonts.get('F2'), 'LiberationSans-Bold', `${HOLDER}?…`);
  // A camada do OCR da foto usa o mesmo objeto da Helvetica embutida, com as letras dela.
  const ocrFonts = doc.resolve(doc.resolve(doc.pages[0].attrs.Resources).get('Font'));
  assert.deepEqual([...ocrFonts.values()].map((ref) => ref.num), [stampFonts.get('F1').num]);
  await assertEmbedded(doc, stampFonts.get('F1'), 'LiberationSans', 'Contrato ação nº 1');
  signer.discard();
});

test('PDF/A com Word e carimbo: o carimbo usa os mesmos objetos de fonte do Word, com as letras dos dois', async () => {
  const signer = await signerOf();
  const fonts = await embedFonts([WORD_SANS], stampCharacters(signer.name));
  const bytes = await signer.sign([WORD_SANS], TIME, { pdfa: true, stamp: STAMP, fonts });
  qpdfCheck(bytes);
  await assertSigned(bytes);
  const text = latin1(bytes);
  assert.doesNotMatch(text, /\/Subtype \/Type1/, 'nenhuma fonte sem embutir');
  assert.equal(text.match(/\/Subtype \/TrueType/g).length, 6, 'uma fonte por estilo, sem repetir as do carimbo');
  const doc = await openPdf(bytes);
  const pageFonts = doc.resolve(doc.resolve(doc.pages[0].attrs.Resources).get('Font'));
  const byName = new Map([...pageFonts.values()].map((ref) => [doc.resolve(ref).get('BaseFont').value.slice(7), ref.num]));
  const stampFonts = stampFontsOf(doc);
  assert.equal(stampFonts.get('F1').num, byName.get('LiberationSans'));
  assert.equal(stampFonts.get('F2').num, byName.get('LiberationSans-Bold'));
  const regular = await assertEmbedded(doc, stampFonts.get('F1'), 'LiberationSans', 'Sem serifa Assinado em às 0123456789/:()UTC+-…');
  const bold = await assertEmbedded(doc, stampFonts.get('F2'), 'LiberationSans-Bold', `Negrito: Wx ${HOLDER}?…`);
  // O desenho do carimbo não muda: o /Widths da fonte embutida tem as larguras das fontes padrão, que o stamp.js usa.
  for (const [font, dict] of [['Helvetica', regular], ['Helvetica-Bold', bold]]) {
    for (const char of stampCharacters(signer.name).get(font)) {
      assert.equal(dict.get('Widths')[winAnsiCode(char) - dict.get('FirstChar')], textWidth(char, font, 1000), `"${char}" na ${font}`);
    }
  }
  signer.discard();
});

test('carimbo sem PDF/A: as fontes passadas não mudam nada (continua com as fontes padrão)', async () => {
  const signer = await signerOf();
  const fonts = await embedFonts([WORD_SANS, ...PAGES], stampCharacters(signer.name));
  for (const pages of [PAGES, [WORD_SANS, ...PAGES]]) {
    const plain = await signer.sign(pages, TIME, { stamp: STAMP });
    assert.deepEqual(await signer.sign(pages, TIME, { stamp: STAMP, fonts }), plain);
    assert.match(latin1(plain), /\/F1 << \/Type \/Font \/Subtype \/Type1 \/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding >> \/F2 << \/Type \/Font \/Subtype \/Type1 \/BaseFont \/Helvetica-Bold /);
  }
  signer.discard();
});

// Edições da fase 1 (edits.js): retângulo, seta, ✓, ✗ e desenho, só caminhos em RGB.
const EDITS = [
  { type: 'rect', x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.3, color: '#dc2626', width: 2 },
  { type: 'arrow', x0: 0.2, y0: 0.5, x1: 0.6, y1: 0.6, color: '#1d4ed8', width: 2, from: [0.06, 0.88], to: [0.94, 0.12] },
  { type: 'check', x0: 0.6, y0: 0.1, x1: 0.65, y1: 0.14, color: '#15803d', width: 2, turn: 90 },
  { type: 'cross', x0: 0.7, y0: 0.7, x1: 0.75, y1: 0.74, color: '#000000', width: 4 },
  { type: 'ink', x0: 0.1, y0: 0.8, x1: 0.5, y1: 0.9, color: '#000000', width: 2, strokes: [[[0, 0.5], [0.3, 0.1], [0.6, 0.9], [1, 0.5]], [[0.5, 0.5]]] },
];

// Texto novo (fase 2), nas três famílias, e numeração com cabeçalho em todas as páginas.
const TEXTS = [
  { type: 'text', x0: 0.1, y0: 0.4, x1: 0.5, y1: 0.43, text: 'Recebido em 24/10/2026 — ação', family: 'sans', color: '#1d4ed8' },
  { type: 'text', x0: 0.1, y0: 0.5, x1: 0.4, y1: 0.53, text: 'Com serifa: “citação”', family: 'serif', color: '#000000' },
  { type: 'text', x0: 0.1, y0: 0.6, x1: 0.4, y1: 0.66, text: 'De máquina\nnº 0123', family: 'mono', color: '#dc2626', turn: 90 },
];
const numbered = (pages) => pages.map((page, i) => ({
  ...page,
  edits: [...(page.edits ?? []), ...allPagesText({ number: { format: 'page-n-of', spot: 'bottom-right' }, header: { text: 'Contrato nº 12', spot: 'top-center' } },
    { position: i + 1, total: pages.length, size: page.jpeg || !(page.rotation % 180) ? page : { width: page.height, height: page.width } })],
}));

test('veraPDF (perfil PDF/A-2B): fotos, OCR, Word com as fontes embutidas, PDF assinado, carimbo e edições', async (t) => {
  const verapdf = process.env.VERAPDF;
  if (!verapdf) {
    t.skip('VERAPDF não definido: a conferência com o veraPDF é pulada');
    return;
  }
  const signer = await openCertificate(fixture('certificados/titular-aes.pfx'), 'senha-de-teste');
  const withHelvetica = { ...WORD, items: [...WORD.items, { type: 'text', x: 72, y: 200, text: 'Sem serifa', font: 'Helvetica', size: 11 }] };
  const mixed = [withHelvetica, ...PAGES]; // Word e foto com OCR dividindo a Helvetica, que vai embutida
  const fonts = await embedFonts(mixed);
  const photos = PAGES.map(({ ocr, ...page }) => page);
  // Carimbo: só com o PDF/A e as fontes com as letras dele (normal e negrito), em cima de foto, de Word girado e de
  // Word com foto e OCR (a Helvetica dividida pelos três).
  const stamped = async (pages, stamp = STAMP) => signer.sign(pages, new Date(), {
    pdfa: true, stamp, fonts: await embedFonts(pages, stampCharacters(signer.name)),
  });
  const withFonts = async (pages) => buildPdf(pages, { pdfa: true, fonts: await embedFonts(pages) });
  const files = {
    'fotos.pdf': buildPdf(photos, { pdfa: true }),
    'ocr.pdf': buildPdf(PAGES, { pdfa: true }),
    // A camada do OCR numa página torta: o texto vai inclinado (ocr-layer.js).
    'ocr-torto.pdf': buildPdf([{ ...PAGES[0], ocr: WORDS.map((word) => ({ ...word, angle: 0.1, straight: word })) }], { pdfa: true }),
    'assinado.pdf': await signer.sign(PAGES, new Date(), { pdfa: true }),
    'word.pdf': buildPdf([WORD], { pdfa: true, fonts: await embedFonts([WORD]) }),
    'word-fotos-ocr.pdf': buildPdf(mixed, { pdfa: true, fonts }),
    'word-assinado.pdf': await signer.sign(mixed, new Date(), { pdfa: true, fonts }),
    'fotos-carimbo.pdf': await stamped(photos),
    'fotos-ocr-carimbo.pdf': await stamped(PAGES, { position: 'top-left', page: 'first' }),
    'word-carimbo.pdf': await stamped([{ ...WORD, rotation: 90 }]),
    'word-fotos-ocr-carimbo.pdf': await stamped([WORD_SANS, ...PAGES], { position: 'top-center', page: 2 }),
    // Edições fixas na página: foto com OCR e tarja, Word girado com fontes embutidas, e assinado com carimbo.
    'fotos-edicoes.pdf': buildPdf([{ ...PAGES[0], edits: EDITS, redactions: [{ x0: 0, y0: 0, x1: 0.3, y1: 0.3 }] }, PAGES[1]], { pdfa: true }),
    'word-edicoes.pdf': buildPdf([{ ...WORD, rotation: 90, edits: EDITS }], { pdfa: true, fonts: await embedFonts([WORD]) }),
    'edicoes-carimbo.pdf': await stamped([{ ...PAGES[0], edits: EDITS }]),
    // Texto novo e numeração: a Liberation embutida, com as letras deles (e a Helvetica do OCR junto).
    'texto-fotos.pdf': await withFonts(numbered([{ ...PAGES[0], edits: TEXTS }, PAGES[1]])),
    'texto-word.pdf': await withFonts(numbered([{ ...WORD, rotation: 90, edits: TEXTS }, PAGES[0]])),
    'texto-carimbo.pdf': await stamped(numbered([{ ...PAGES[0], edits: TEXTS }])),
  };
  signer.discard();
  const dir = mkdtempSync(join(tmpdir(), 'verapdf-'));
  try {
    for (const [name, bytes] of Object.entries(files)) {
      writeFileSync(join(dir, name), bytes);
      const windows = /\.bat$/i.test(verapdf);
      const result = spawnSync(windows ? 'cmd.exe' : verapdf, [...(windows ? ['/c', verapdf] : []), '--flavour', '2b', '--format', 'xml', join(dir, name)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const failed = [...result.stdout.matchAll(/clause="([^"]+)" testNumber="(\d+)" status="failed"/g)].map((m) => `${m[1]}-${m[2]}`);
      assert.match(result.stdout, /isCompliant="true"/, `${name}: ${failed.join(', ') || result.stderr.slice(0, 300)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
