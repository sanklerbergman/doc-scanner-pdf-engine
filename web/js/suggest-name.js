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
  { pt: 'cnh', en: 'driver-license', words: ['CARTEIRA NACIONAL DE HABILITACAO'] },
  { pt: 'contracheque', en: 'payslip', words: ['CONTRACHEQUE', 'HOLERITE', 'DEMONSTRATIVO DE PAGAMENTO'] },
  { pt: 'nota-fiscal', en: 'invoice', words: ['NOTA FISCAL', 'DANFE'] },
  { pt: 'boleto', en: 'bank-slip', words: ['BOLETO'] },
  { pt: 'fatura', en: 'bill', words: ['FATURA'] },
  { pt: 'extrato', en: 'statement', words: ['EXTRATO'] },
  { pt: 'procuracao', en: 'power-of-attorney', words: ['PROCURACAO'] },
  { pt: 'certidao', en: 'certificate', words: ['CERTIDAO'] },
  { pt: 'contrato', en: 'contract', words: ['CONTRATO'] },
  { pt: 'declaracao', en: 'declaration', words: ['DECLARACAO'] },
  { pt: 'recibo', en: 'receipt', words: ['RECIBO'] },
  { pt: 'curriculo', en: 'resume', words: ['CURRICULO'] },
  { pt: 'comprovante', en: 'proof', words: ['COMPROVANTE'] },
];

// Sem acento (a cedilha também sai: "ç" vira "c").
const unaccent = (text) => text.normalize('NFD').replace(/\p{M}+/gu, '');

// Cada palavra casa no começo de uma palavra do texto ("CONTRATOS" casa, "SUBCONTRATO" não); entre as palavras de
// uma expressão, qualquer espaço ou quebra de linha.
const PATTERNS = TYPES.map((type) => ({
  type,
  re: new RegExp(type.words.map((words) => `(?<![\\p{L}\\p{N}])${words.split(' ').join('\\s+')}`).join('|'), 'u'),
}));

/**
 * O tipo do documento pelo texto, sem diferença de acento e maiúscula.
 * @param {string} text
 * @returns {{pt: string, en: string} | null}
 */
export function documentType(text) {
  if (!text) return null;
  const upper = unaccent(text).toUpperCase();
  const found = PATTERNS.find(({ re }) => re.test(upper));
  return found ? { pt: found.type.pt, en: found.type.en } : null;
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
