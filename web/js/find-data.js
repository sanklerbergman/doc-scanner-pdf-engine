// Busca automática de dados para tarjar: CPF e CNPJ (com dígito verificador, inclusive o CNPJ alfanumérico),
// e-mail, telefone, CEP e número de cartão (com o dígito de Luhn). Os padrões são brasileiros.
// Só sugere: a pessoa confirma cada dado antes de virar tarja (app.js). Os dados achados só existem na memória e
// nunca vão para o console. Código puro, sem DOM.

export const TYPE_LABELS = { cpf: 'CPF', cnpj: 'CNPJ', email: 'E-mail', telefone: 'Telefone', cep: 'CEP', cartao: 'Cartão' };

// Prioridade quando dois achados se sobrepõem: fica o de cima (um CPF não vira também "telefone").
const PRIORITY = ['cpf', 'cnpj', 'cartao', 'email', 'cep', 'telefone'];

// Sem dígito, ponto, barra ou hífen colado antes; nem dígito (ou separador seguido de dígito) depois. Assim um
// número maior (processo, boleto, código de barras) não vira CPF por ter 11 dígitos no meio.
const BEFORE = String.raw`(?<![\p{L}\p{N}.\/-])`;
const AFTER = String.raw`(?![\p{L}\p{N}]|[.\/-]\p{N})`;

const PATTERNS = {
  cpf: new RegExp(`${BEFORE}\\d{3}\\.?\\d{3}\\.?\\d{3}-?\\d{2}${AFTER}`, 'gu'),
  // CNPJ numérico (com ou sem pontuação) e alfanumérico (só com a pontuação, para não pegar palavras soltas).
  cnpj: new RegExp(`${BEFORE}(?:\\d{2}\\.?\\d{3}\\.?\\d{3}\\/?\\d{4}-?\\d{2}|[0-9A-Z]{2}\\.[0-9A-Z]{3}\\.[0-9A-Z]{3}\\/[0-9A-Z]{4}-\\d{2})${AFTER}`, 'gu'),
  email: /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}])/gu,
  // Telefone: com DDD entre parênteses, com +55, com DDD e celular com hífen, ou só o número com hífen.
  telefone: new RegExp(`${BEFORE}(?:(?:\\+55\\s?)?\\(\\d{2}\\)\\s?9?\\d{4}[\\s-]?\\d{4}|\\+55\\s?\\d{2}\\s?9?\\d{4}[\\s-]?\\d{4}|\\d{2}\\s9\\d{4}-\\d{4}|9\\d{4}-\\d{4}|[2-5]\\d{3}-\\d{4})${AFTER}`, 'gu'),
  cep: new RegExp(`(?:${BEFORE}(?:\\d{5}-\\d{3}|\\d{2}\\.\\d{3}-\\d{3})|(?<=\\bCEP:?\\s{0,3})\\d{8})${AFTER}`, 'gu'),
  // Cartão: 4 grupos de 4 (com espaço ou hífen) ou de 13 a 19 dígitos seguidos, começando como as bandeiras.
  cartao: new RegExp(`${BEFORE}(?:[2-6]\\d{3}([ -])\\d{4}\\1\\d{4}\\1\\d{1,7}|[2-6]\\d{12,18})${AFTER}`, 'gu'),
};

const digits = (text) => text.replace(/\D/g, '');

export function validCpf(text) {
  const d = digits(text);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const size of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Number(d[i]) * (size + 1 - i);
    const check = ((sum * 10) % 11) % 10;
    if (check !== Number(d[size])) return false;
  }
  return true;
}

// CNPJ numérico e alfanumérico (Receita Federal, a partir de 2026): cada caractere vale o código ASCII menos 48
// (os dígitos continuam valendo 0 a 9), com os pesos de sempre. Os dois dígitos verificadores são numéricos.
export function validCnpj(text) {
  const c = text.toUpperCase().replace(/[.\/-]/g, '');
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || /^(.)\1{13}$/.test(c)) return false;
  const value = (char) => char.charCodeAt(0) - 48;
  const check = (size) => {
    const weights = size === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((total, weight, i) => total + value(c[i]) * weight, 0);
    return sum % 11 < 2 ? 0 : 11 - (sum % 11);
  };
  return check(12) === Number(c[12]) && check(13) === Number(c[13]);
}

export function validLuhn(text) {
  const d = digits(text);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

// DDD válido: dois dígitos de 1 a 9 (não existe DDD com zero).
const validPhone = (text) => {
  const ddd = text.match(/\((\d{2})\)|\+55\s?(\d{2})|^(\d{2})\s/);
  const code = ddd && (ddd[1] ?? ddd[2] ?? ddd[3]);
  return !code || /^[1-9]{2}$/.test(code);
};

const VALIDATE = { cpf: validCpf, cnpj: validCnpj, cartao: validLuhn, telefone: validPhone };

/**
 * Dados num texto.
 * @param {string} text
 * @returns {Array<{type: string, start: number, end: number, value: string}>} em ordem, sem sobreposição
 */
export function findSensitive(text) {
  const plain = text.replace(/[   ]/g, ' '); // espaços especiais viram espaço (mesmo tamanho)
  const found = [];
  for (const type of PRIORITY) {
    for (const match of plain.matchAll(PATTERNS[type])) {
      const value = match[0];
      if (VALIDATE[type] && !VALIDATE[type](value)) continue;
      const start = match.index;
      const end = start + value.length;
      if (found.some((other) => start < other.end && other.start < end)) continue; // um de prioridade maior já pegou
      found.push({ type, start, end, value: text.slice(start, end) });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Acha os dados no texto de uma página e devolve a área de cada um, para virar tarja.
 * @param {Array<{str: string, xs: number[], y0: number, y1: number}>} pieces trechos de texto, com a posição de
 *   cada caractere (xs: str.length + 1 valores, de 0 a 1) e a altura da linha (de 0 a 1), com o texto em pé
 * @param {{width: number, height: number}} size tamanho da página (qualquer unidade), para medir os espaços
 * @returns {Array<{type: string, value: string, rect: {x0: number, y0: number, x1: number, y1: number}}>}
 */
export function findInPieces(pieces, { width, height }) {
  const lines = [];
  const sorted = pieces.filter((piece) => piece.str).sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1) || a.xs[0] - b.xs[0]);
  for (const piece of sorted) {
    const middle = (piece.y0 + piece.y1) / 2;
    const line = lines.find((item) => middle > item.y0 && middle < item.y1);
    if (line) {
      line.pieces.push(piece);
      line.y0 = Math.min(line.y0, piece.y0);
      line.y1 = Math.max(line.y1, piece.y1);
    } else {
      lines.push({ y0: piece.y0, y1: piece.y1, pieces: [piece] });
    }
  }
  const out = [];
  for (const line of lines) {
    line.pieces.sort((a, b) => a.xs[0] - b.xs[0]);
    // Texto da linha, com um espaço entre trechos afastados; map: de cada caractere para o trecho e a posição.
    let text = '';
    const map = [];
    let previous = null;
    for (const piece of line.pieces) {
      if (previous) {
        const gap = (piece.xs[0] - previous.xs[previous.xs.length - 1]) * width;
        const lineHeight = (line.y1 - line.y0) * height;
        // O OCR às vezes parte um número na pontuação ("123.456" e ".789-09"), com um vão entre as palavras: perto
        // assim, número e pontuação continuam juntos, sem espaço.
        const split = gap < lineHeight * 1.5 && (/\d$/.test(previous.str) && /^[.\/-]\d/.test(piece.str) || /\d[.\/-]$/.test(previous.str) && /^\d/.test(piece.str));
        if (gap > lineHeight * 0.2 && !split && !/\s$/.test(text) && !/^\s/.test(piece.str)) {
          text += ' ';
          map.push(null);
        }
      }
      for (let i = 0; i < piece.str.length; i++) {
        text += piece.str[i];
        map.push({ piece, i });
      }
      previous = piece;
    }
    for (const { type, start, end, value } of findSensitive(text)) {
      let rect = null;
      for (let k = start; k < end; k++) {
        const at = map[k];
        if (!at) continue;
        const box = { x0: at.piece.xs[at.i], x1: at.piece.xs[at.i + 1], y0: at.piece.y0, y1: at.piece.y1 };
        rect = rect ? { x0: Math.min(rect.x0, box.x0), y0: Math.min(rect.y0, box.y0), x1: Math.max(rect.x1, box.x1), y1: Math.max(rect.y1, box.y1) } : box;
      }
      if (rect) out.push({ type, value, rect });
    }
  }
  return out;
}

/**
 * Margem em volta da área achada, para cobrir a borda das letras (a posição de cada letra é estimada no PDF e na
 * foto). pad: em proporção da altura da linha.
 */
export function padRect({ x0, y0, x1, y1 }, { width, height }, pad = 0.15) {
  const extra = (y1 - y0) * pad;
  const extraX = (extra * height) / width;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return { x0: clamp(x0 - extraX), y0: clamp(y0 - extra), x1: clamp(x1 + extraX), y1: clamp(y1 + extra) };
}
