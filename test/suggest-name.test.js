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

test('tipo tolerante: recibo pelas outras expressões, sem passar na frente da tabela', () => {
  for (const text of ['Recebi de Maria', 'RECEBEMOS DE João', 'a quantia de R$ 50,00', 'A importância de R$ 100', 'A IMPORTANCIA\nDE R$ 100']) {
    assert.equal(documentType(text)?.pt, 'recibo', text);
  }
  assert.equal(documentType('Recebi dez reais'), null);
  assert.equal(documentType('a quantia devida'), null);
  assert.equal(documentType('Contrato ... a quantia de R$ 10')?.pt, 'contrato');
  assert.equal(documentType('Declaração ... recebi de Maria')?.pt, 'declaracao');
});

test('tipo tolerante: CNH pelas outras expressões; HABILITA ou HABILITADO sozinhos não', () => {
  for (const text of ['PERMISSÃO PARA DIRIGIR', 'permissao\npara  dirigir', 'CARTEIRA NACIONAL\nDE HAB1LITAÇÃO', 'CARTEIRA NACIONAL DE HABILITAÇÃO']) {
    assert.equal(documentType(text)?.pt, 'cnh', text);
  }
  for (const text of ['HABILITA', 'HABILITADO', 'CARTEIRA NACIONAL DE TRABALHO']) assert.equal(documentType(text), null, text);
  assert.equal(documentType('Profissional habilitado conforme contrato')?.pt, 'contrato');
});

test('tipo tolerante: textos reais do OCR do app nas fotos do QA (#50)', () => {
  assert.equal(documentType('Recebi de Fulano a quantia de R$ 100,00\nreferente a serviços prestados.\nNOME: FULANO DE TAL DA SILVA')?.pt, 'recibo');
  assert.equal(documentType('REPUBLICA FEDERATIVA DO ERAS\nCARTEIRA NACIONAL DE H/\nDEPARTAMENTO DE TRÂNSITO\nNOVE: FULANO DE TAL DA')?.pt, 'cnh');
  assert.equal(documentType('REPUBLICA FEDERATIVA DO BRAS.\nCARTEIRA NACIONAL DE HARILITACA\nDEPARTAMENTO DE TRANSITO\nNOME: FULANO DE TAL DA')?.pt, 'cnh');
});

test('tipo tolerante: uma letra trocada, faltando ou sobrando no título', () => {
  for (const [text, pt] of [['RECIB0 N° 12', 'recibo'], ['REClBO', 'recibo'], ['RECJBO', 'recibo'], ['RECIBOO', 'recibo'], ['RECBO', 'recibo'],
    ['BOLET0', 'boleto'], ['FATUR4', 'fatura'], ['EXTRAT0', 'extrato'], ['CONTRAT0 de locação', 'contrato'],
    ['CERTIDA0', 'certidao'], ['PROCURACA0', 'procuracao'], ['DECLARACA0', 'declaracao'], ['CURRICUL0', 'curriculo'],
    ['HOLER1TE', 'contracheque'], ['CONTRACHEQU3', 'contracheque'], ['COMPROVANT3', 'comprovante']]) {
    assert.equal(documentType(text)?.pt, pt, text);
  }
});

test('tipo tolerante: fora do limite não casa', () => {
  for (const text of ['RXCIBO', 'R3CIBO', 'RECIB00', 'REC1B0', 'SUBRECIB0', 'RECIB0XY', 'DANF3', 'NOTA F1SCAL', 'REGISTRO GERA1']) {
    assert.equal(documentType(text), null, text);
  }
});

test('tipo tolerante: palavra de verdade perto de uma chave fica sem tipo', () => {
  for (const word of ['BOLETIM', 'RECEBIDO', 'RECEITA', 'CONTRATE', 'EXTRAIDO', 'CERTIFICADO', 'DECLARA', 'PROCURADOR', 'PROCURAR', 'HABILITADO', 'CURRICULAR',
    'RECEBO', 'RECIBA', 'RECIBE', 'RECITO', 'CONTRATA', 'CONTATO', 'CONTRAIO', 'CONTRITO', 'CONTRASTO', 'FARTURA', 'FATURE', 'FATURO', 'FATUA',
    'BOLETA', 'BOLERO', 'EXTRATA', 'EXTRAIO', 'CURRICULA']) {
    assert.equal(documentType(word), null, word);
    assert.equal(documentType(word.toLowerCase()), null, word);
  }
  assert.equal(documentType('Boletim escolar'), null);
  assert.equal(documentType('Contrate já'), null);
  assert.equal(documentType('Certificado de conclusão'), null);
  assert.equal(documentType('A empresa contrata'), null);
  assert.equal(documentType('Eu recebo'), null);
  assert.equal(documentType('Telefone para contato'), null);
});

test('tipo tolerante: o exato ganha do tolerado, mesmo mais abaixo na tabela; entre tolerados, a ordem da tabela', () => {
  assert.equal(documentType('CONTRAT0 de locação ... RECIBO')?.pt, 'recibo');
  assert.equal(documentType('B0LET0 FATUR4 ... COMPROVANTE')?.pt, 'comprovante');
  assert.equal(documentType('CONTRAT0 ... RECIB0')?.pt, 'contrato');
  assert.equal(documentType('REClBO  Recebi de Maria a quantia de R$ 50,00')?.pt, 'recibo');
  assert.equal(documentType('R E C I B O ... A importância de R$ 100')?.pt, 'recibo');
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
