// Nome do arquivo sugerido (#43): o tipo do documento pelo texto da primeira página que tem texto (comprovante, RG,
// contrato…) ou, sem tipo, o nome do primeiro arquivo, com a data de hoje: "rg-2026-11-20". O nome sai seguro para
// sistemas que recusam acento, espaço e nome longo (PJe e outros). Código puro, sem DOM: quem chama passa o texto, o
// nome do arquivo, a data e o idioma. Nada fica guardado.

/** Tamanho máximo do nome seguro, sem o ".pdf". */
export const SAFE_MAX = 50;

// A primeira linha que casa, de cima para baixo, ganha. "Comprovante" fica por último: aparece no rodapé de quase
// todos os outros (boleto, nota, extrato).
export const TYPES = [
  { pt: 'rg', en: 'id-card', words: ['REGISTRO GERAL', 'CARTEIRA DE IDENTIDADE'] },
  { pt: 'cnh', en: 'driver-license', words: ['CARTEIRA NACIONAL DE H', 'PERMISSAO PARA DIRIGIR'] },
  { pt: 'contracheque', en: 'payslip', words: ['CONTRACHEQUE', 'HOLERITE', 'DEMONSTRATIVO DE PAGAMENTO'] },
  { pt: 'nota-fiscal', en: 'invoice', words: ['NOTA FISCAL', 'DANFE'] },
  { pt: 'boleto', en: 'bank-slip', words: ['BOLETO'] },
  { pt: 'fatura', en: 'bill', words: ['FATURA'] },
  { pt: 'extrato', en: 'statement', words: ['EXTRATO'] },
  { pt: 'procuracao', en: 'power-of-attorney', words: ['PROCURAÇAO'] },
  { pt: 'certidao', en: 'certificate', words: ['CERTIDAO'] },
  { pt: 'contrato', en: 'contract', words: ['CONTRATO'] },
  { pt: 'declaracao', en: 'declaration', words: ['DECLARAÇAO'] },
  { pt: 'recibo', en: 'receipt', words: ['RECIBO', 'RECEBI DE', 'RECEBEMOS DE', 'A QUANTIA DE', 'A IMPORTANCIA DE'] },
  { pt: 'curriculo', en: 'resume', words: ['CURRICULO'] },
  { pt: 'comprovante', en: 'proof', words: ['COMPROVANTE'] },
];

// Sem acento (a cedilha também sai: "ç" vira "c").
const unaccent = (text) => text.normalize('NFD').replace(/\p{M}+/gu, '');

// Cada palavra casa no começo de uma palavra do texto ("CONTRATOS" casa, "SUBCONTRATO" não); entre as palavras de
// uma expressão, qualquer espaço ou quebra de linha. O OCR em inglês (página /en/) lê o "Ç" como "G"
// ("HABILITAGAO", "DECLARAGAO"): na tabela, "Ç" aceita o C e as leituras erradas dele; a CNH casa só até
// o "H", o que já basta depois de "CARTEIRA NACIONAL DE" (#50: foto ruim lê "H/" e "HARILITACA"). Expressão que termina em "DE" exige a palavra inteira:
// "RECEBI DEZ" e "A QUANTIA DEVIDA" não casam.
const MISREAD_C = '[CG¢Q(]';
const wordPattern = (words) => `(?<![\\p{L}\\p{N}])${words.split(' ').join('\\s+').replaceAll('Ç', MISREAD_C)}${words.endsWith(' DE') ? '(?![\\p{L}\\p{N}])' : ''}`;
const PATTERNS = TYPES.map((type) => ({ type, re: new RegExp(type.words.map(wordPattern).join('|'), 'u') }));

// Uma letra errada no título (#50): só palavra-chave de uma palavra e com 6 letras ou mais.
const TOLERANT_MIN = 6;
const TOLERANT = TYPES.map((type) => ({
  type,
  keys: type.words.filter((words) => !words.includes(' ') && words.length >= TOLERANT_MIN).map((words) => words.replaceAll('Ç', 'C')),
})).filter(({ keys }) => keys.length);

// Palavras de verdade a uma letra de uma chave: nunca casam pela tolerância.
const NOT_A_TYPE = new Set([
  'BOLETIM', 'RECEBIDO', 'RECEITA', 'CONTRATE', 'EXTRAIDO', 'CERTIFICADO', 'DECLARA', 'PROCURADOR', 'PROCURAR', 'HABILITADO', 'CURRICULAR',
  'RECEBO', 'RECIBA', 'RECIBE', 'RECITO', 'CONTRATA', 'CONTATO', 'CONTRAIO', 'CONTRITO', 'CONTRASTO', 'FARTURA', 'FATURE', 'FATURO', 'FATUA',
  'BOLETA', 'BOLERO', 'EXTRATA', 'EXTRAIO', 'CURRICULA',
]);

// Uma letra trocada, faltando ou sobrando: tirado o começo e o fim iguais, sobra no máximo uma letra de cada lado.
function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  return Math.max(a.length, b.length) - start - end === 1;
}

const nearKey = (word, key) => word.startsWith(key.slice(0, 2)) && oneEdit(word, key);

/**
 * O tipo do documento pelo texto, sem diferença de acento e maiúscula. Um tipo que casa exato ganha de um que casa só
 * com uma letra errada, mesmo mais abaixo na tabela.
 * @param {string} text
 * @returns {{pt: string, en: string} | null}
 */
export function documentType(text) {
  if (!text) return null;
  const upper = unaccent(text).toUpperCase();
  const exact = PATTERNS.find(({ re }) => re.test(upper));
  if (exact) return { pt: exact.type.pt, en: exact.type.en };
  const read = [...new Set(upper.match(/[\p{L}\p{N}]+/gu) ?? [])].filter((word) => !NOT_A_TYPE.has(word));
  const near = TOLERANT.find(({ keys }) => keys.some((key) => read.some((word) => nearKey(word, key))));
  return near ? { pt: near.type.pt, en: near.type.en } : null;
}

/**
 * Nome seguro para sistemas: minúsculas, sem acento, só a-z 0-9 - _, hífen no lugar do resto, sem hífen repetido nem
 * nas pontas, com no máximo `max` caracteres (o corte não deixa hífen sobrando). Vazio vira `fallback`.
 * @param {string} name
 * @param {{max?: number, fallback?: string}} [options]
 */
export function safeName(name, { max = SAFE_MAX, fallback = 'documento' } = {}) {
  const clean = (text) => text.replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  const out = clean(unaccent(String(name ?? '')).toLowerCase().replace(/[^a-z0-9_-]+/g, '-'));
  return clean(out.slice(0, max)) || fallback;
}

/** O nome digitado tem acento, espaço ou letra maiúscula: o app oferece o nome seguro. */
export const needsSafeName = (name) => /[\s\p{Lu}]/u.test(name) || unaccent(name) !== name;

// Nomes que câmeras, celulares e apps dão sozinhos: não dizem nada do documento.
const CAMERA = /^(img[_-]|pxl_|dsc|dcim|scan|whatsapp image|screenshot|captura de tela)/i;

/**
 * O nome do arquivo sem a extensão, ou null quando é nome de câmera ou de app, ou só número, data ou hora.
 * @param {string} fileName
 * @returns {string | null}
 */
export function fileStem(fileName) {
  const stem = String(fileName ?? '').replace(/\.[^.]*$/, '').trim();
  if (!stem || CAMERA.test(stem) || /^[\d\s._:-]+$/.test(stem)) return null;
  return stem;
}

/** AAAA-MM-DD da data, no fuso do aparelho. */
export function isoDate(date) {
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/**
 * A sugestão: o tipo achado no texto vence o nome do arquivo; sem nenhum dos dois, null (o campo fica "documento").
 * @param {{text?: string, fileName?: string, date: Date, lang?: 'pt' | 'en'}} input
 * @returns {{name: string, from: 'content' | 'file'} | null}
 */
export function suggestName({ text = '', fileName = '', date, lang = 'pt' }) {
  const suffix = `-${isoDate(date)}`;
  const max = SAFE_MAX - suffix.length;
  const type = documentType(text);
  if (type) return { name: `${safeName(type[lang], { max })}${suffix}`, from: 'content' };
  const stem = fileStem(fileName);
  const base = stem && safeName(stem, { max, fallback: '' });
  return base ? { name: `${base}${suffix}`, from: 'file' } : null;
}
