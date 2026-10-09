import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDocx, formatNumber, fontFamily, DocxError } from '../web/js/docx.js';
import { makeDocx, makeZip, docxFiles, p } from './helpers/docx.js';

const paragraphs = (doc) => doc.sections.flatMap((section) => section.blocks);
const textOf = (block) => block.runs.map((run) => run.text ?? (run.tab ? '\t' : run.break ? '\n' : '')).join('');

const STYLES = `
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Ttulo1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="240" w:after="0"/></w:pPr>
    <w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:b/><w:color w:val="2F5496"/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Ttulo2"><w:name w:val="heading 2"/><w:basedOn w:val="Ttulo1"/>
    <w:rPr><w:b w:val="0"/><w:i/><w:sz w:val="26"/></w:rPr></w:style>
  <w:style w:type="character" w:styleId="Forte"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>`;

const THEME = { major: 'Calibri Light', minor: 'Times New Roman' };

test('parágrafos, negrito, itálico, sublinhado, acentos, tabulação e quebra de linha', async () => {
  const doc = await readDocx(makeDocx({
    body: `
      <w:p><w:r><w:t>Atenção: </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>negrito</w:t></w:r><w:r><w:t xml:space="preserve"> e </w:t></w:r>
        <w:r><w:rPr><w:i/><w:u w:val="single"/></w:rPr><w:t>itálico sublinhado</w:t></w:r></w:p>
      <w:p><w:r><w:t>Nome:</w:t><w:tab/><w:t>Maria</w:t><w:br/><w:t>Linha 2</w:t></w:r></w:p>
      <w:p/>`,
  }));
  const [first, second, empty] = paragraphs(doc);
  assert.equal(textOf(first), 'Atenção: negrito e itálico sublinhado');
  assert.deepEqual(first.runs.map((run) => [run.bold, run.italic, run.underline]),
    [[false, false, false], [true, false, false], [false, false, false], [false, true, true]]);
  assert.equal(textOf(second), 'Nome:\tMaria\nLinha 2');
  assert.equal(empty.runs.length, 0);
  assert.equal(first.mark.size, 10, 'sem estilos, o tamanho padrão do Word é 10 pt');
});

test('títulos e fonte vêm do styles.xml (herança basedOn, tema e estilo de caractere)', async () => {
  const doc = await readDocx(makeDocx({
    styles: STYLES,
    theme: THEME,
    body: p('Capítulo 1', { pPr: '<w:pStyle w:val="Ttulo1"/>' }) + p('Seção 1.1', { pPr: '<w:pStyle w:val="Ttulo2"/>' }) +
      '<w:p><w:r><w:t xml:space="preserve">Texto com </w:t></w:r><w:r><w:rPr><w:rStyle w:val="Forte"/></w:rPr><w:t>ênfase</w:t></w:r></w:p>' +
      p('Em Courier', { rPr: '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="20"/>' }),
  }));
  const [h1, h2, body, mono] = paragraphs(doc);
  const run = (block, i = 0) => block.runs[i];

  assert.equal(run(h1).size, 16);
  assert.equal(run(h1).bold, true);
  assert.equal(run(h1).family, 'sans', 'Calibri Light, do tema (fonte de títulos)');
  assert.deepEqual(run(h1).color.map((c) => Math.round(c * 255)), [0x2f, 0x54, 0x96]);
  assert.equal(h1.keepNext, true);
  assert.equal(h1.spacing.before, 12);
  assert.equal(h1.spacing.after, 0);

  assert.equal(run(h2).size, 13);
  assert.equal(run(h2).bold, false, 'w:b w:val="0" desliga o negrito herdado');
  assert.equal(run(h2).italic, true);
  assert.equal(h2.keepNext, true, 'herdado do Título 1');

  assert.equal(run(body).size, 11);
  assert.equal(run(body).family, 'serif', 'Times New Roman, do tema (fonte do corpo)');
  assert.equal(run(body, 1).bold, true, 'estilo de caractere "Forte"');
  assert.equal(body.spacing.after, 8);
  assert.ok(Math.abs(body.spacing.line - 259 / 240) < 1e-9);

  assert.equal(run(mono).family, 'mono');
  assert.equal(run(mono).size, 10);
});

test('família da fonte pelo nome', () => {
  assert.equal(fontFamily('Arial'), 'sans');
  assert.equal(fontFamily('Calibri'), 'sans');
  assert.equal(fontFamily('Times New Roman'), 'serif');
  assert.equal(fontFamily('Cambria'), 'serif');
  assert.equal(fontFamily('Century Gothic'), 'sans');
  assert.equal(fontFamily('Consolas'), 'mono');
  assert.equal(fontFamily(undefined), 'serif');
});

const NUMBERING = `
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%1.%2.%3"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr>
      <w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`;

const item = (text, numId, ilvl = 0) => p(text, { pPr: `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>` });

test('listas numeradas e com marcador, níveis e reinício', async () => {
  const doc = await readDocx(makeDocx({
    numbering: NUMBERING,
    body: item('um', 1) + item('dois', 1) + item('dois-a', 1, 1) + item('dois-b', 1, 1) + item('dois-b-i', 1, 2) +
      item('três', 1) + item('três-a', 1, 1) + item('marcador', 2) + item('de novo', 3) + item('segue', 1) +
      p('sem lista', { pPr: '<w:numPr><w:numId w:val="0"/></w:numPr>' }),
  }));
  const labels = paragraphs(doc).map((block) => block.label?.text ?? null);
  // Cada %n usa o formato do próprio nível (2, b, i), como no Word.
  assert.deepEqual(labels, ['1.', '2.', 'a)', 'b)', '2.b.i', '3.', 'a)', '', '1.', '2.', null]);

  const [first, , sub] = paragraphs(doc);
  assert.deepEqual(first.indent, { left: 36, right: 0, firstLine: -18 });
  assert.equal(sub.indent.left, 72);
  assert.equal(first.label.suffix, 'tab');
  assert.equal(paragraphs(doc)[7].label.family, 'serif', 'a fonte Symbol do marcador não vale para o rótulo');
});

test('formatos de número', () => {
  assert.deepEqual([1, 4, 9, 14, 40].map((n) => formatNumber(n, 'upperRoman')), ['I', 'IV', 'IX', 'XIV', 'XL']);
  assert.deepEqual([1, 26, 27, 28].map((n) => formatNumber(n, 'lowerLetter')), ['a', 'z', 'aa', 'bb']);
  assert.equal(formatNumber(7, 'decimalZero'), '07');
  assert.equal(formatNumber(3, 'ordinal'), '3º');
  assert.equal(formatNumber(3, 'bullet'), '');
  assert.equal(formatNumber(12, 'algoDesconhecido'), '12');
});

test('alinhamento, recuo e espaçamento direto no parágrafo', async () => {
  const doc = await readDocx(makeDocx({
    body: p('a', { pPr: '<w:jc w:val="center"/>' }) + p('b', { pPr: '<w:jc w:val="both"/>' }) +
      p('c', { pPr: '<w:jc w:val="end"/>' }) + p('d', { pPr: '<w:jc w:val="start"/><w:ind w:left="567" w:firstLine="709"/>' }) +
      p('e', { pPr: '<w:spacing w:before="120" w:after="240" w:line="360" w:lineRule="exact"/><w:pageBreakBefore/>' }),
  }));
  const [a, b, c, d, e] = paragraphs(doc);
  assert.deepEqual([a, b, c, d].map((block) => block.align), ['center', 'justify', 'right', 'left']);
  assert.ok(Math.abs(d.indent.left - 28.35) < 1e-9);
  assert.ok(Math.abs(d.indent.firstLine - 35.45) < 1e-9);
  assert.deepEqual(e.spacing, { before: 6, after: 12, line: 18, lineRule: 'exact' });
  assert.equal(e.pageBreakBefore, true);
});

test('tamanho da página e margens do documento; A4 e 2,5 cm quando faltam', async () => {
  const letter = await readDocx(makeDocx({
    body: p('x') + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:gutter="360"/></w:sectPr>',
  }));
  assert.deepEqual(letter.sections[0].page, { width: 612, height: 792, margin: { top: 72, right: 54, bottom: 72, left: 72 } });

  const bare = await readDocx(makeDocx({ body: p('x') }));
  assert.equal(bare.sections[0].page.width, 595.28);
  assert.equal(bare.sections[0].page.height, 841.89);
  assert.equal(bare.sections[0].page.margin.left, 70.87);

  const absurd = await readDocx(makeDocx({ body: p('x') + '<w:sectPr><w:pgSz w:w="2000" w:h="2000"/><w:pgMar w:left="1800" w:right="1800"/></w:sectPr>' }));
  const { page } = absurd.sections[0];
  assert.ok(page.width - page.margin.left - page.margin.right >= 72, 'sempre sobra espaço para o texto');
});

test('seções: quebra de seção no parágrafo, página deitada e seção contínua', async () => {
  const doc = await readDocx(makeDocx({
    body: p('retrato') +
      `<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr><w:r><w:t>fim da 1</w:t></w:r></w:p>` +
      p('paisagem') +
      `<w:p><w:pPr><w:sectPr><w:type w:val="continuous"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr></w:pPr></w:p>` +
      p('última') + '<w:sectPr><w:cols w:num="2"/></w:sectPr>',
  }));
  assert.equal(doc.sections.length, 3);
  assert.deepEqual(doc.sections.map((s) => s.blocks.map(textOf)), [['retrato', 'fim da 1'], ['paisagem', ''], ['última']]);
  assert.ok(doc.sections[1].page.width > doc.sections[1].page.height);
  assert.equal(doc.sections[1].start, 'continuous');
  assert.equal(doc.sections[2].start, 'nextPage');
  assert.equal(doc.notes.columns, true);
});

test('tabelas viram texto corrido e o que não é desenhado é contado', async () => {
  const drawing = (uri) => `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic><a:graphicData uri="${uri}"/></a:graphic></wp:inline></w:drawing></w:r>`;
  const doc = await readDocx(makeDocx({
    body: `
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>célula A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p>${drawing('http://schemas.openxmlformats.org/drawingml/2006/picture')}${drawing('http://schemas.openxmlformats.org/drawingml/2006/chart')}
        <w:r><mc:AlternateContent><mc:Choice Requires="wps">${drawing('http://schemas.microsoft.com/office/word/2010/wordprocessingShape').slice(5, -6)}</mc:Choice>
        <mc:Fallback><w:pict><v:shape/></w:pict></mc:Fallback></mc:AlternateContent></w:r>
        <w:r><w:t>texto</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>`,
  }));
  assert.deepEqual(paragraphs(doc).map(textOf), ['célula A1', 'B1', 'texto']);
  const { notes } = doc;
  assert.deepEqual([notes.tables, notes.images, notes.charts, notes.shapes, notes.footnotes, notes.equations], [1, 1, 1, 1, 1, 1]);
});

test('texto oculto, revisões apagadas e código de campo ficam de fora; link, inserção e controle de conteúdo entram', async () => {
  const doc = await readDocx(makeDocx({
    body: `<w:p>
      <w:r><w:t xml:space="preserve">A </w:t></w:r>
      <w:r><w:rPr><w:vanish/></w:rPr><w:t>oculto</w:t></w:r>
      <w:del w:id="1"><w:r><w:delText>apagado</w:delText></w:r></w:del>
      <w:ins w:id="2"><w:r><w:t xml:space="preserve">inserido </w:t></w:r></w:ins>
      <w:hyperlink r:id="rId99"><w:r><w:t xml:space="preserve">link </w:t></w:r></w:hyperlink>
      <w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
      <w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
      <w:sdt><w:sdtContent><w:r><w:t xml:space="preserve"> campo</w:t></w:r></w:sdtContent></w:sdt>
      <w:r><w:rPr><w:caps/></w:rPr><w:t xml:space="preserve"> maiúsculas</w:t></w:r>
      <w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r>
    </w:p>`,
  }));
  const [block] = paragraphs(doc);
  assert.equal(textOf(block), 'A inserido link 7 campo MAIÚSCULAS2');
  assert.equal(block.runs[block.runs.length - 1].vertAlign, 'superscript');
});

test('cabeçalho com texto é avisado; vazio, não', async () => {
  const sect = (id) => `<w:sectPr><w:headerReference w:type="default" r:id="${id}"/></w:sectPr>`;
  const withText = await readDocx(makeDocx({ body: p('x') + sect('rId20'), headers: { rId20: p('Empresa') } }));
  assert.equal(withText.notes.headerFooter, true);
  const empty = await readDocx(makeDocx({ body: p('x') + sect('rId20'), headers: { rId20: '<w:p/>' } }));
  assert.equal(empty.notes.headerFooter, false);
});

test('aceita o formato Strict (outro namespace) e prefixos diferentes de "w"', async () => {
  const strict = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
  const doc = await readDocx(makeZip(docxFiles({
    documentXml: `<doc:document xmlns:doc="${strict}"><doc:body><doc:p><doc:r><doc:rPr><doc:b/><doc:sz doc:val="12pt"/></doc:rPr><doc:t>Estrito</doc:t></doc:r></doc:p>` +
      `<doc:sectPr><doc:pgMar doc:top="2cm" doc:bottom="2cm" doc:left="1in" doc:right="1in"/></doc:sectPr></doc:body></doc:document>`,
  })));
  const [block] = paragraphs(doc);
  assert.equal(textOf(block), 'Estrito');
  assert.equal(block.runs[0].bold, true);
  assert.equal(block.runs[0].size, 12);
  assert.ok(Math.abs(doc.sections[0].page.margin.top - 56.69) < 0.01);
  assert.equal(doc.sections[0].page.margin.left, 72);
});

test('não lê metadados (autor, empresa) do docProps', async () => {
  const files = docxFiles({ body: p('conteúdo') });
  files['docProps/core.xml'] = '<cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:creator>Fulana de Tal</dc:creator></cp:coreProperties>';
  files['docProps/app.xml'] = '<Properties><Company>Empresa Secreta</Company></Properties>';
  const doc = await readDocx(makeZip(files));
  const json = JSON.stringify(doc);
  assert.ok(!json.includes('Fulana') && !json.includes('Empresa Secreta'));
});

test('recusa .doc antigo, arquivo que não é Word e documento corrompido', async () => {
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  await assert.rejects(readDocx(ole), (err) => err instanceof DocxError && /\.doc\b/.test(err.message));
  await assert.rejects(readDocx(new TextEncoder().encode('texto qualquer')), DocxError);
  await assert.rejects(readDocx(makeZip({ 'outra.txt': 'x' })), /Não parece um documento do Word/);
  const files = docxFiles({ body: p('x') });
  files['word/document.xml'] = '<w:document><w:body><w:p></w:body>';
  await assert.rejects(readDocx(makeZip(files)), /corrompido/);
  files['word/document.xml'] = '<!DOCTYPE x [<!ENTITY a "b">]><w:document/>';
  await assert.rejects(readDocx(makeZip(files)), /corrompido/);
});
