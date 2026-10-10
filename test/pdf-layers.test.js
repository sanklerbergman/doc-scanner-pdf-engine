import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPdf, copyPages, PdfError, PdfStream } from '../web/js/pdf-reader.js';
import { buildPdf } from '../web/js/pdf.js';
import { makeRawPdf } from './helpers/pdf.js';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

// PDF de uma página com camadas. objects acrescenta ou troca objetos (6 = camada "Notas internas").
function layered({ content, ocProperties = '/OCGs [6 0 R] /D << /OFF [6 0 R] >>', properties = '/oc1 6 0 R', objects = {}, page = '' }) {
  return makeRawPdf({
    1: `<< /Type /Catalog /Pages 2 0 R /OCProperties << ${ocProperties} >> >>`,
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /Properties << ${properties} >> /XObject << /Im1 7 0 R >> >> /Contents 4 0 R${page} >>`,
    4: { data: content, deflate: true },
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    6: '<< /Type /OCG /Name (Notas internas) >>',
    7: { dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', data: 'X' },
    ...objects,
  }).bytes;
}

// Copia todas as páginas para um PDF novo e devolve o texto de todos os objetos dele, já descompactados.
async function copied(bytes) {
  const doc = await openPdf(bytes);
  const indices = doc.pages.map((_, i) => i);
  const copy = copyPages(doc, indices);
  const out = buildPdf(indices.map((i) => ({ copy: { source: copy, page: copy.pages.get(i) } })));
  const reopened = await openPdf(out);
  const texts = [];
  for (const num of reopened.entries.keys()) {
    const value = reopened.object(num);
    texts.push(value instanceof PdfStream ? latin1(await reopened.decode(value)) : '');
  }
  return { doc, raw: latin1(out), text: `${latin1(out)}\n${texts.join('\n')}` };
}

const refused = (bytes) => assert.rejects(openPdf(bytes), (err) => err instanceof PdfError && /camadas ocultas/.test(err.message));

test('camada oculta: o conteúdo dela sai do PDF novo, junto com o nome da camada', async () => {
  const { doc, text } = await copied(layered({
    content: 'BT /F1 24 Tf 72 700 Td (VISIVEL) Tj ET /OC /oc1 BDC BT /F1 24 Tf 72 600 Td (SEGREDO) Tj ET EMC',
  }));
  assert.equal(doc.layers.removed, true);
  assert.match(text, /\(VISIVEL\) Tj/);
  for (const forbidden of ['SEGREDO', 'Notas internas', '/OCProperties', '/OCG', '/oc1']) assert.ok(!text.includes(forbidden), forbidden);
  assert.match(text, /\/OC BMC/, 'a marca continua, sem apontar para a camada');
});

test('camada visível: o conteúdo continua e nada é dado como removido', async () => {
  const { doc, text } = await copied(layered({
    content: '/OC /oc1 BDC BT /F1 24 Tf 72 600 Td (LIGADA) Tj ET EMC',
    ocProperties: '/OCGs [6 0 R] /D << /ON [6 0 R] >>',
  }));
  assert.equal(doc.layers.removed, false);
  assert.match(text, /\(LIGADA\) Tj/);
  assert.ok(!text.includes('Notas internas'));
});

test('estado da camada: BaseState /OFF, lista /ON e estado automático de tela (/AS)', async () => {
  const objects = {
    8: '<< /Type /OCG /Name (Ligada) >>',
    9: '<< /Type /OCG /Name (So na impressao) /Usage << /View << /ViewState /OFF >> >> >>',
  };
  const { text } = await copied(layered({
    content: '/OC /oc1 BDC BT (A) Tj ET EMC /OC /oc2 BDC BT (B) Tj ET EMC /OC /oc3 BDC BT (C) Tj ET EMC',
    ocProperties: '/OCGs [6 0 R 8 0 R 9 0 R] /D << /BaseState /OFF /ON [8 0 R 9 0 R] /AS [<< /Event /View /Category [/View] /OCGs [9 0 R] >>] >>',
    properties: '/oc1 6 0 R /oc2 8 0 R /oc3 9 0 R',
    objects,
  }));
  assert.ok(!text.includes('(A) Tj'), 'BaseState /OFF esconde a camada fora da lista /ON');
  assert.match(text, /\(B\) Tj/);
  assert.ok(!text.includes('(C) Tj'), '/AS com ViewState /OFF esconde na tela');
});

test('grupos de camadas (OCMD): regra /P e expressão /VE', async () => {
  const objects = {
    8: '<< /Type /OCG /Name (Ligada) >>',
    10: '<< /Type /OCMD /OCGs [6 0 R 8 0 R] /P /AllOn >>',
    11: '<< /Type /OCMD /OCGs 6 0 R /P /AllOff >>',
    12: '<< /Type /OCMD /VE [/And 8 0 R [/Not 6 0 R]] >>',
  };
  const { text } = await copied(layered({
    content: '/OC /m1 BDC BT (TODAS) Tj ET EMC /OC /m2 BDC BT (DESLIGADA) Tj ET EMC /OC /m3 BDC BT (EXPRESSAO) Tj ET EMC',
    ocProperties: '/OCGs [6 0 R 8 0 R] /D << /OFF [6 0 R] >>',
    properties: '/m1 10 0 R /m2 11 0 R /m3 12 0 R',
    objects,
  }));
  assert.ok(!text.includes('TODAS'), 'AllOn com uma camada desligada esconde');
  assert.match(text, /\(DESLIGADA\) Tj/, 'AllOff com a camada desligada mostra');
  assert.match(text, /\(EXPRESSAO\) Tj/);
});

test('desenho e imagem ocultos saem, mas posição, cor e recorte continuam', async () => {
  const { text } = await copied(layered({
    content: 'q /OC /oc1 BDC 1 0 0 1 50 50 cm 1 0 0 rg 0 0 100 100 re W n 0 0 10 10 re f /Im1 Do EMC 0 0 5 5 re f Q',
  }));
  assert.match(text, /1 0 0 1 50 50 cm\n1 0 0 rg/, 'posição e cor continuam');
  assert.match(text, /0 0 10 10 re\nn/, 'o preenchimento oculto vira só o fim do caminho');
  assert.match(text, /W\nn/, 'o recorte continua');
  assert.match(text, /0 0 5 5 re\nf/, 'o desenho fora da camada continua');
  assert.ok(!text.includes('/Im1 Do'));
  assert.ok(!text.includes('/Im1'), 'a imagem só usada pela camada oculta sai dos recursos');
});

test('imagem e formulário com /OC próprio, e formulário com camada oculta dentro', async () => {
  const objects = {
    7: { dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /OC 6 0 R', data: 'X' },
    13: { dict: '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F1 5 0 R >> /Properties << /c 6 0 R >> >>', data: '(NO FORM) Tj /OC /c BDC (FORM OCULTO) Tj EMC', deflate: true },
  };
  const { text } = await copied(layered({
    content: '/Im1 Do /Fm1 Do',
    objects: { ...objects, 3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 7 0 R /Fm1 13 0 R >> >> /Contents 4 0 R >>' },
  }));
  assert.ok(!text.includes('/Im1 Do'), 'imagem de camada oculta não é desenhada');
  assert.match(text, /\/Fm1 Do/);
  assert.match(text, /\(NO FORM\) Tj/);
  assert.ok(!text.includes('FORM OCULTO'));
});

test("texto oculto com ' e \" vira só a mudança de linha", async () => {
  const { text } = await copied(layered({
    content: "BT /F1 12 Tf 14 TL 72 700 Td /OC /oc1 BDC (UM) ' 2 1 (DOIS) \" EMC ET",
  }));
  assert.ok(!text.includes('UM') && !text.includes('DOIS'));
  assert.match(text, /T\*\n2 Tw 1 Tc T\*/);
});

test('textos com parênteses, EMC e BDC dentro de strings não confundem a leitura', async () => {
  const { text } = await copied(layered({
    content: 'BT (fora \\) EMC BDC) Tj ET /OC /oc1 BDC BT (dentro \\( EMC) Tj <53454752> Tj ET EMC BT (depois) Tj ET',
  }));
  assert.match(text, /\(fora \\\) EMC BDC\) Tj/);
  assert.ok(!text.includes('dentro'));
  assert.ok(!text.includes('<53454752>'));
  assert.match(text, /\(depois\) Tj/);
});

test('imagem embutida (BI/ID/EI) numa camada oculta sai; fora dela continua', async () => {
  const { text } = await copied(layered({
    content: '/OC /oc1 BDC BI /W 1 /H 1 /CS /G /BPC 8 ID Z EI EMC BI /W 1 /H 1 /CS /G /BPC 8 ID Y EI',
  }));
  assert.ok(!text.includes('ID Z EI'));
  assert.match(text, /ID Y EI/);
});

test('camada que atravessa dois streams do conteúdo da página', async () => {
  const bytes = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R] /D << /OFF [6 0 R] >> >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Properties << /oc1 6 0 R >> >> /Contents [4 0 R 8 0 R] >>',
    4: { data: 'BT (A) Tj ET /OC /oc1 BDC BT (OCULTO1) Tj', deflate: true },
    6: '<< /Type /OCG /Name (N) >>',
    8: { data: '(OCULTO2) Tj ET EMC BT (B) Tj ET' },
  }).bytes;
  const { text } = await copied(bytes);
  assert.match(text, /\(A\) Tj/);
  assert.match(text, /\(B\) Tj/);
  assert.ok(!text.includes('OCULTO'));
});

test('anotação numa camada oculta não é desenhada; aparência com camada oculta é refeita', async () => {
  const objects = {
    20: '<< /Type /Annot /Subtype /Stamp /F 4 /Rect [100 100 200 120] /OC 6 0 R /AP << /N 22 0 R >> >>',
    21: '<< /Type /Annot /Subtype /Stamp /F 4 /Rect [100 300 200 320] /AP << /N 23 0 R >> >>',
    22: { dict: '/BBox [0 0 100 20]', data: '(CARIMBO OCULTO) Tj' },
    23: { dict: '/BBox [0 0 100 20] /Resources << /Properties << /c 6 0 R >> >>', data: '(CARIMBO) Tj /OC /c BDC (NOTA OCULTA) Tj EMC' },
  };
  const { text } = await copied(layered({ content: '(PAGINA) Tj', objects, page: ' /Annots [20 0 R 21 0 R]' }));
  assert.ok(!text.includes('CARIMBO OCULTO'));
  assert.match(text, /\(CARIMBO\) Tj/);
  assert.ok(!text.includes('NOTA OCULTA'));
});

test('recusa: texto visível na mesma linha de um texto oculto perderia a posição', async () => {
  await refused(layered({ content: 'BT 72 700 Td /OC /oc1 BDC (OCULTO) Tj EMC ( visivel) Tj ET' }));
  // Com mudança de posição no meio, dá: Td parte do começo da linha, não do fim do texto.
  const { text } = await copied(layered({ content: 'BT 72 700 Td /OC /oc1 BDC (OCULTO) Tj EMC 0 -14 Td (visivel) Tj ET' }));
  assert.match(text, /\(visivel\) Tj/);
});

test('recusa: texto oculto usado como recorte, e conteúdo num filtro que o app não lê', async () => {
  await refused(layered({ content: '7 Tr /OC /oc1 BDC BT (CLIP) Tj ET EMC' }));
  await refused(makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R] /D << /OFF [6 0 R] >> >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    4: { dict: '/Filter /ASCII85Decode', data: '87cURD]i,"Ebo80~>' },
    6: '<< /Type /OCG /Name (N) >>',
  }).bytes);
});

test('PDF sem tabela de camadas: nada muda', async () => {
  const bytes = makeRawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Properties << /oc1 6 0 R >> >> /Contents 4 0 R >>',
    4: { data: '/OC /oc1 BDC (TUDO VISIVEL) Tj EMC' },
    6: '<< /Type /OCG /Name (N) >>',
  }).bytes;
  const { doc, text } = await copied(bytes);
  assert.equal(doc.layers, undefined);
  assert.match(text, /\/OC \/oc1 BDC \(TUDO VISIVEL\) Tj EMC/);
});
