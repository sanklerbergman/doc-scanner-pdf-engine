// Nome do arquivo sugerido (#43): tipo pelo texto, nome seguro e recusa de nome de câmera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPES, documentType, safeName, needsSafeName, fileStem, isoDate, suggestName } from '../web/js/suggest-name.js';

const date = new Date(2026, 10, 20, 9, 30); // 20/11/2026, no fuso do aparelho

test('tipo: cada linha da tabela, em português e em inglês', () => {
  const cases = [
    ['REPÚBLICA FEDERATIVA DO BRASIL Registro Geral', 'rg', 'id-card'],
    ['carteira de identidade', 'rg', 'id-card'],
    ['CARTEIRA NACIONAL DE HABILITAÇÃO', 'cnh', 'driver-license'],
    ['Contracheque mensal', 'contracheque', 'payslip'],
    ['HOLERITE', 'contracheque', 'payslip'],
    ['Demonstrativo de Pagamento de Salário', 'contracheque', 'payslip'],
    ['NOTA FISCAL ELETRÔNICA', 'nota-fiscal', 'invoice'],
    ['DANFE - Documento auxiliar', 'nota-fiscal', 'invoice'],
    ['Boleto bancário', 'boleto', 'bank-slip'],
    ['Fatura do cartão', 'fatura', 'bill'],
    ['Extrato de conta corrente', 'extrato', 'statement'],
    ['PROCURAÇÃO AD JUDICIA', 'procuracao', 'power-of-attorney'],
    ['Certidão de nascimento', 'certidao', 'certificate'],
    ['CONTRATO DE LOCAÇÃO', 'contrato', 'contract'],
    ['Declaração de residência', 'declaracao', 'declaration'],
    ['RECIBO de aluguel', 'recibo', 'receipt'],
    ['Currículo', 'curriculo', 'resume'],
    ['COMPROVANTE DE RESIDÊNCIA ... CONTA DE ENERGIA', 'comprovante', 'proof'],
  ];
  for (const [text, pt, en] of cases) assert.deepEqual(documentType(text), { pt, en }, text);
  // Toda linha da tabela tem um caso acima.
  assert.deepEqual([...new Set(cases.map(([, pt]) => pt))], TYPES.map((type) => type.pt));
});

test('tipo: a primeira linha da tabela que casa ganha, onde quer que esteja no texto', () => {
  assert.equal(documentType('Comprovante de pagamento ... BOLETO')?.pt, 'boleto');
  assert.equal(documentType('Comprovante: recibo nº 12')?.pt, 'recibo');
  assert.equal(documentType('Contrato ... Registro Geral do inquilino')?.pt, 'rg');
  assert.equal(documentType('extrato da fatura')?.pt, 'fatura');
});

test('tipo: casa no começo de uma palavra, não no meio; expressão com quebra de linha', () => {
  assert.equal(documentType('CONTRATOS SOCIAIS')?.pt, 'contrato');
  assert.equal(documentType('SUBCONTRATO de obra'), null);
  assert.equal(documentType('desboletos'), null);
  assert.equal(documentType('-contrato-')?.pt, 'contrato');
  assert.equal(documentType('NOTA\nFISCAL')?.pt, 'nota-fiscal');
  assert.equal(documentType('NOTAFISCAL'), null);
});

test('tipo: o fim da palavra mal lido pelo OCR em inglês (Ç virou G) ainda casa', () => {
  // Leitura real do OCR eng na página /en/ (2026-11-20).
  assert.deepEqual(documentType('CARTEIRA NACIONAL DE HABILITAGAO'), { pt: 'cnh', en: 'driver-license' });
  assert.equal(suggestName({ text: 'CARTEIRA NACIONAL\nDE HABILITAGAO', date, lang: 'en' }).name, 'driver-license-2026-11-20');
  assert.equal(documentType('CARTEIRA NACIONAL DE HABILITA¢AO')?.pt, 'cnh');
  assert.equal(documentType('DECLARAGAO DE RESIDENCIA')?.pt, 'declaracao');
  assert.equal(documentType('Declara¢ao')?.pt, 'declaracao');
  assert.equal(documentType('PROCURAGAO AD JUDICIA')?.pt, 'procuracao');
  assert.equal(documentType('CERTIDAO DE NASCIMENTO')?.pt, 'certidao');
  // Sem falso positivo: o verbo e o cargo não viram declaração nem procuração.
  assert.equal(documentType('O inquilino declara que recebeu o recibo')?.pt, 'recibo');
  assert.equal(documentType('Procurador: fulano. Recibo')?.pt, 'recibo');
  assert.equal(documentType('procurar o recibo')?.pt, 'recibo');
  assert.equal(documentType('HABILITADO a dirigir'), null);
});

test('tipo: texto vazio ou sem palavra da tabela', () => {
  assert.equal(documentType(''), null);
  assert.equal(documentType(undefined), null);
  assert.equal(documentType('Ata da reunião de condomínio'), null);
});

test('nome seguro: acentos, cedilha, emoji, barra, espaços, maiúsculas', () => {
  assert.equal(safeName('Conta de Luz Março'), 'conta-de-luz-marco');
  assert.equal(safeName('Ação Çedilha Ñandu'), 'acao-cedilha-nandu');
  assert.equal(safeName('foto 📄 do RG 🎉'), 'foto-do-rg');
  assert.equal(safeName('pasta/arquivo\\outro'), 'pasta-arquivo-outro');
  assert.equal(safeName('  muitos    espaços   '), 'muitos-espacos');
  assert.equal(safeName('a--b__c'), 'a-b__c');
  assert.equal(safeName('-_-nome-_-'), 'nome');
  assert.equal(safeName('nome.com.pontos'), 'nome-com-pontos');
});

test('nome seguro: vazio vira "documento" (ou o nome de reserva)', () => {
  assert.equal(safeName(''), 'documento');
  assert.equal(safeName('   '), 'documento');
  assert.equal(safeName('🎉🎉'), 'documento');
  assert.equal(safeName('///', { fallback: 'document' }), 'document');
});

test('nome seguro: corte em 50, sem hífen sobrando', () => {
  assert.equal(safeName('a'.repeat(80)), 'a'.repeat(50));
  assert.equal(safeName(`${'a'.repeat(49)} b`), 'a'.repeat(49));
  assert.ok(safeName('palavra '.repeat(20)).length <= 50);
  assert.doesNotMatch(safeName('palavra '.repeat(20)), /-$/);
});

test('nome digitado: acento, espaço ou maiúscula pedem o nome seguro', () => {
  assert.equal(needsSafeName('Contrato Ação'), true);
  assert.equal(needsSafeName('contrato acao'), true);
  assert.equal(needsSafeName('Contrato'), true);
  assert.equal(needsSafeName('ação'), true);
  assert.equal(needsSafeName('contrato-acao_2026'), false);
  assert.equal(needsSafeName('documento'), false);
});

test('nome de câmera ou de app: cada prefixo é recusado', () => {
  for (const name of ['IMG_4521.jpg', 'IMG-20261120-WA0001.jpg', 'PXL_20261120_101010.jpg', 'DSC01234.JPG', 'DSCN0001.jpg',
    'DCIM_0001.jpg', 'Scan 2026-11-20.pdf', 'Scanned_Document.pdf', 'WhatsApp Image 2026-11-20 at 10.10.10.jpeg',
    'Screenshot_20261120-101010.png', 'Captura de tela 2026-11-20 101010.png', 'img_0001.heic']) {
    assert.equal(fileStem(name), null, name);
  }
});

test('nome de câmera: só número, data ou hora também é recusado', () => {
  for (const name of ['1234.jpg', '20261120_101010.jpg', '2026-11-20 10.10.10.png', '10:10:10.png', '.jpg', '']) {
    assert.equal(fileStem(name), null, name);
  }
});

test('nome comum passa, sem a extensão', () => {
  assert.equal(fileStem('Conta de Luz Março.jpg'), 'Conta de Luz Março');
  assert.equal(fileStem('contrato.v2.docx'), 'contrato.v2');
  assert.equal(fileStem('Imagem do RG.png'), 'Imagem do RG');
  assert.equal(fileStem('2026 imposto de renda.pdf'), '2026 imposto de renda');
});

test('data de hoje no formato AAAA-MM-DD, no fuso do aparelho', () => {
  assert.equal(isoDate(date), '2026-11-20');
  assert.equal(isoDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('sugestão: exemplos do contrato', () => {
  assert.deepEqual(suggestName({ text: 'COMPROVANTE DE RESIDÊNCIA ... CONTA DE ENERGIA', fileName: 'x.pdf', date }), { name: 'comprovante-2026-11-20', from: 'content' });
  assert.deepEqual(suggestName({ text: 'REGISTRO GERAL', fileName: 'IMG_4521.jpg', date }), { name: 'rg-2026-11-20', from: 'content' });
  assert.equal(suggestName({ text: '', fileName: 'IMG_4521.jpg', date }), null);
  assert.deepEqual(suggestName({ text: 'CONTRATO DE LOCAÇÃO', fileName: 'minuta.docx', date }), { name: 'contrato-2026-11-20', from: 'content' });
  assert.equal(suggestName({ text: 'BOLETO ... Comprovante de pagamento', date }).name, 'boleto-2026-11-20');
  assert.deepEqual(suggestName({ fileName: 'Conta de Luz Março.jpg', date }), { name: 'conta-de-luz-marco-2026-11-20', from: 'file' });
  assert.equal(suggestName({ fileName: 'PXL_20261120_101010.jpg', date }), null);
  assert.equal(suggestName({ text: 'CARTEIRA NACIONAL DE HABILITAÇÃO', date, lang: 'en' }).name, 'driver-license-2026-11-20');
});

test('sugestão: texto sem tipo usa o nome do arquivo; nome de 80 letras dá 50 caracteres com a data inteira', () => {
  assert.deepEqual(suggestName({ text: 'Ata da reunião', fileName: 'Ata Outubro.pdf', date }), { name: 'ata-outubro-2026-11-20', from: 'file' });
  const long = suggestName({ fileName: `${'a'.repeat(80)}.jpg`, date }).name;
  assert.equal(long.length, 50);
  assert.equal(long, `${'a'.repeat(39)}-2026-11-20`);
  const words = suggestName({ fileName: `${'abcdefghi '.repeat(8)}.jpg`, date }).name;
  assert.ok(words.length <= 50);
  assert.match(words, /[a-z]-2026-11-20$/);
  // Nome de arquivo só com emoji: nada aproveitável.
  assert.equal(suggestName({ fileName: '🎉.jpg', date }), null);
});
