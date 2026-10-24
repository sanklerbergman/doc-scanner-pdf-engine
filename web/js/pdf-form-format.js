// Formatos do Acrobat nos campos de formulário: as ações de formato (/AA /F) e de teclado (/AA /K) com AFNumber,
// AFPercent, AFDate, AFTime e AFSpecial. Nenhum script do PDF roda: a chamada é lida como texto, por expressão
// regular, e o app formata o valor por conta própria. Falha fechada: argumento estranho, função própria do formulário
// (o validarCNPJ() da Receita) ou mais de uma chamada dão null, e o valor sai como digitado. Código puro, sem DOM.

/**
 * O formato de um campo, como readFieldFormat devolve.
 * - number: decimals (casas decimais); separator (estilo do Acrobat: 0 = 1,234.56, 1 = 1234.56, 2 = 1.234,56,
 *   3 = 1234,56, 4 = 1'234.56); negative (0 = sinal de menos, 1 = vermelho sem sinal, 2 = entre parênteses,
 *   3 = parênteses e vermelho); currency (o símbolo, com o espaço que o formulário puser); prepend (símbolo antes).
 * - percent: decimals, separator e prepend (o % antes do número).
 * - date e time: format (como o valor aparece) e input (como se digita: o do teclado, ou o próprio format), nos
 *   códigos do Acrobat (dd/mm/yyyy, h:MM tt...).
 * - special: style (0 = CEP americano, 1 = CEP + 4, 2 = telefone americano, 3 = SSN).
 * - mask: mask (9 = algarismo, A = letra, O = letra ou algarismo, X = qualquer; o resto é literal).
 * @typedef {{kind: 'number', decimals: number, separator: number, negative: number, currency: string, prepend: boolean}
 *   | {kind: 'percent', decimals: number, separator: number, prepend: boolean}
 *   | {kind: 'date'|'time', format: string, input: string}
 *   | {kind: 'special', style: number}
 *   | {kind: 'mask', mask: string}} FieldFormat
 */

const MAX_SCRIPT = 1000; // um formato do Acrobat tem algumas dezenas de caracteres
const MAX_DECIMALS = 15;
const MAX_DIGITS = 100;

// Separador de milhar e de decimal de cada estilo (sepStyle). Não achamos estilo além do 4 nem no PDF.js nem no
// PDFium: o 5 em diante é tratado como argumento estranho.
const SEPARATORS = [[',', '.'], ['', '.'], ['.', ','], ['', ','], ["'", '.']];

// Formatos fixos do AFDate_Format e do AFTime_Format, pelo índice (os mesmos do Acrobat, do PDF.js e do PDFium).
const DATE_FORMATS = ['m/d', 'm/d/yy', 'mm/dd/yy', 'mm/yy', 'd-mmm', 'd-mmm-yy', 'dd-mmm-yy', 'yy-mm-dd', 'mmm-yy',
  'mmmm-yy', 'mmm d, yyyy', 'mmmm d, yyyy', 'm/d/yy h:MM tt', 'm/d/yy HH:MM'];
const TIME_FORMATS = ['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt'];

// Máscaras do AFSpecial_Format; no telefone, a segunda vale a partir de 8 algarismos.
const SPECIAL_MASKS = [['99999'], ['99999-9999'], ['999-9999', '(999) 999-9999'], ['999-99-9999']];

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const isFlag = (value) => typeof value === 'boolean' || value === 0 || value === 1;

// --- Leitura do script ---

// Um argumento literal (texto entre aspas, número, true ou false) e a vírgula que vem depois, ou o fim.
const ARGUMENT = /\s*(?:"((?:[^"\\\n\r]|\\[\s\S])*)"|'((?:[^'\\\n\r]|\\[\s\S])*)'|([+-]?(?:\d+(?:\.\d*)?|\.\d+))|(true|false))\s*(,|$)/y;

const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

// Escapes de texto do JavaScript ("R$ " é "R$ ", como na Receita). Escape incompleto ou octal: null.
function unescapeJs(raw) {
  let invalid = false;
  const text = raw.replace(/\\(?:u\{([0-9A-Fa-f]+)\}|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2})|(\r\n|[\s\S]))/g,
    (match, braced, unicode, hex, char, offset, whole) => {
      if (braced !== undefined) {
        const code = parseInt(braced, 16);
        if (code > 0x10ffff) invalid = true;
        return invalid ? '' : String.fromCodePoint(code);
      }
      if (unicode !== undefined || hex !== undefined) return String.fromCharCode(parseInt(unicode ?? hex, 16));
      if (char === 'u' || char === 'x' || /[1-9]/.test(char) || (char === '0' && /\d/.test(whole[offset + 2] ?? ''))) {
        invalid = true;
        return '';
      }
      if (/^(?:\r\n|[\n\r\u2028\u2029])$/.test(char)) return ''; // continuação de linha
      return SIMPLE_ESCAPES[char] ?? char;
    });
  return invalid ? null : text;
}

/**
 * Lê um script que seja só uma chamada de função com argumentos literais. Nada é executado.
 * @param {string} js texto da ação JavaScript
 * @returns {{name: string, args: Array<string|number|boolean>}|null} null para qualquer outra coisa: duas chamadas,
 *   variável, expressão, comentário ou texto que não fecha
 */
export function parseCall(js) {
  if (typeof js !== 'string' || js.length > MAX_SCRIPT) return null;
  const match = /^\s*([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(js);
  if (!match) return null;
  const [, name, text] = match;
  const args = [];
  if (!text.trim()) return { name, args };
  ARGUMENT.lastIndex = 0;
  for (;;) {
    const found = ARGUMENT.exec(text);
    if (!found) return null;
    const [, double, single, number, flag, comma] = found;
    const value = double !== undefined ? unescapeJs(double)
      : single !== undefined ? unescapeJs(single)
        : number !== undefined ? Number(number)
          : flag === 'true';
    if (value === null) return null;
    args.push(value);
    if (comma !== ',') return { name, args };
  }
}

// --- Argumentos de cada função ---

function numberArgs(args) {
  if (args.length !== 6) return null;
  const [decimals, separator, negative, currencyStyle, currency, prepend] = args;
  if (!isInt(decimals, 0, MAX_DECIMALS) || !isInt(separator, 0, 4) || !isInt(negative, 0, 3)) return null;
  if (!Number.isInteger(currencyStyle) || !isFlag(prepend) || !validCurrency(currency)) return null;
  return { kind: 'number', decimals, separator, negative, currency, prepend: Boolean(prepend) };
}

// Símbolo da moeda: sem algarismo, sinal, parênteses ou caractere de controle, e não só pontuação de número.
const validCurrency = (currency) => typeof currency === 'string' && currency.length <= 8
  && !/[\d\p{C}()+\-−]/u.test(currency) && (!currency.trim() || /[^.,'’\s]/.test(currency));

function percentArgs(args, most) {
  if (args.length < 2 || args.length > most) return null;
  const [decimals, separator, prepend = false] = args;
  if (!isInt(decimals, 0, MAX_DECIMALS) || !isInt(separator, 0, 4) || !isFlag(prepend)) return null;
  return { kind: 'percent', decimals, separator, prepend: Boolean(prepend) };
}

const dateArgs = (kind) => (args) => (args.length === 1 && splitDateFormat(args[0]) ? { kind, format: args[0] } : null);
const dateIndexArgs = (kind, list) => (args) => (args.length === 1 && isInt(args[0], 0, list.length - 1)
  ? { kind, format: list[args[0]] } : null);
const specialArgs = (args) => (args.length === 1 && isInt(args[0], 0, 3) ? { kind: 'special', style: args[0] } : null);
const maskArgs = (args) => (args.length === 1 && validMask(args[0]) ? { kind: 'mask', mask: args[0] } : null);

// Funções reconhecidas: se valem no formato (/F) ou no teclado (/K), e a leitura dos argumentos.
const CALLS = {
  AFNumber_Format: ['format', numberArgs],
  AFNumber_Keystroke: ['keystroke', numberArgs],
  AFPercent_Format: ['format', (args) => percentArgs(args, 3)],
  AFPercent_Keystroke: ['keystroke', (args) => percentArgs(args, 2)],
  AFDate_FormatEx: ['format', dateArgs('date')],
  AFDate_KeystrokeEx: ['keystroke', dateArgs('date')],
  AFDate_Format: ['format', dateIndexArgs('date', DATE_FORMATS)],
  AFDate_Keystroke: ['keystroke', dateIndexArgs('date', DATE_FORMATS)],
  AFTime_FormatEx: ['format', dateArgs('time')],
  AFTime_KeystrokeEx: ['keystroke', dateArgs('time')],
  AFTime_Format: ['format', dateIndexArgs('time', TIME_FORMATS)],
  AFTime_Keystroke: ['keystroke', dateIndexArgs('time', TIME_FORMATS)],
  AFSpecial_Format: ['format', specialArgs],
  AFSpecial_Keystroke: ['keystroke', specialArgs],
  AFSpecial_KeystrokeEx: ['keystroke', maskArgs],
};

// Data e hora usam a mesma leitura; o resto só combina com o próprio tipo.
const FAMILY = { number: 'number', percent: 'percent', date: 'date', time: 'date', special: 'special', mask: 'mask' };

// O script de uma ação: undefined se não há script; null se há e não é um formato conhecido.
function readScript(js, role) {
  if (js === undefined || js === null || (typeof js === 'string' && !js.trim())) return undefined;
  const call = parseCall(js);
  if (!call || !Object.hasOwn(CALLS, call.name)) return null;
  const [expected, read] = CALLS[call.name];
  return expected === role ? read(call.args) : null;
}

/**
 * Reconhece o formato de um campo de texto pelos scripts de formato e de teclado, sem rodá-los.
 * @param {string|null|undefined} format texto JS do /AA /F
 * @param {string|null|undefined} keystroke texto JS do /AA /K
 * @returns {FieldFormat|null} null se não há formato, se algum dos dois não é reconhecido ou se não combinam: aí o
 *   valor sai como digitado. Com os dois, vale o de formato (a data é digitada na ordem do de teclado); só com o de
 *   teclado, o valor é formatado por ele (o Acrobat só conferiria, mas a máscara já põe os literais)
 */
export function readFieldFormat(format, keystroke) {
  const shown = readScript(format, 'format');
  const typed = readScript(keystroke, 'keystroke');
  if (shown === null || typed === null) return null;
  const main = shown ?? typed;
  if (!main) return null;
  if (shown && typed && (FAMILY[shown.kind] !== FAMILY[typed.kind] || (shown.kind === 'special' && shown.style !== typed.style))) return null;
  if (FAMILY[main.kind] === 'date') return { kind: main.kind, format: main.format, input: (typed ?? main).format };
  return main;
}

// --- Números ---

/**
 * Lê um número digitado: aceita o jeito brasileiro (1.234,56) e o americano (1,234.56), com sinal, parênteses e
 * símbolos. Uma vírgula sozinha é decimal; um ponto sozinho também, menos quando o campo usa vírgula decimal e o ponto
 * separa três algarismos ("1.234" é mil duzentos e trinta e quatro).
 * @returns {{negative: boolean, whole: string, fraction: string}|null}
 */
function readAmount(text, separator, symbols) {
  let rest = text;
  // O símbolo mais comprido primeiro: "R$" antes de "$".
  for (const symbol of [...symbols].sort((a, b) => b.length - a.length)) if (symbol) rest = rest.split(symbol).join(' ');
  rest = rest.trim();
  let negative = false;
  const paren = /^\(([\s\S]*)\)$/.exec(rest);
  if (paren) {
    negative = true;
    rest = paren[1].trim();
  }
  const sign = /^([-+−])\s*/.exec(rest);
  if (sign) {
    if (paren) return null;
    negative = sign[1] !== '+';
    rest = rest.slice(sign[0].length);
  }
  if (rest.length > MAX_DIGITS || !/^[\d.,'’\s]*\d[\d.,'’\s]*$/.test(rest)) return null;
  const dots = rest.split('.').length - 1;
  const commas = rest.split(',').length - 1;
  let decimal = null;
  if (dots && commas) decimal = rest.lastIndexOf('.') > rest.lastIndexOf(',') ? '.' : ',';
  else if (commas === 1) decimal = ',';
  else if (dots === 1) decimal = SEPARATORS[separator][1] === ',' && /^\d{1,3}\.\d{3}$/.test(rest) ? null : '.';
  const at = decimal ? rest.lastIndexOf(decimal) : rest.length;
  const fraction = rest.slice(at + 1);
  if (!/^\d*$/.test(fraction)) return null;
  // Milhar: depois do primeiro grupo, só grupos de três.
  const groups = rest.slice(0, at).split(/[.,'’\s]/);
  if (groups.length > 1 && !(/^\d{1,3}$/.test(groups[0]) && groups.slice(1).every((group) => /^\d{3}$/.test(group)))) return null;
  return { negative, whole: groups.join(''), fraction };
}

// Soma 1 a um número escrito em algarismos.
function increment(digits) {
  const list = digits.split('');
  let i = list.length - 1;
  while (i >= 0 && list[i] === '9') list[i--] = '0';
  if (i < 0) return `1${list.join('')}`;
  list[i] = String(Number(list[i]) + 1);
  return list.join('');
}

// O número sem sinal, arredondado (metade para cima, sem passar por ponto flutuante) e com os separadores do estilo.
function printAmount({ whole, fraction }, decimals, separator) {
  let digits = (whole || '0') + fraction.padEnd(decimals, '0').slice(0, decimals);
  if (fraction.length > decimals && fraction[decimals] >= '5') digits = increment(digits);
  const cut = digits.length - decimals;
  const [thousands, mark] = SEPARATORS[separator];
  const integer = digits.slice(0, cut).replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+$)/g, thousands);
  return decimals ? `${integer}${mark}${digits.slice(cut)}` : integer;
}

function formatNumber(spec, text) {
  const amount = readAmount(text, spec.separator, [spec.currency.trim(), 'R$']);
  if (!amount) return fail(text, 'Não é um número.');
  const body = printAmount(amount, spec.decimals, spec.separator);
  const negative = amount.negative && /[1-9]/.test(body); // -0,001 com duas casas é zero, sem sinal
  let out = spec.prepend ? spec.currency + body : body + spec.currency;
  if (negative && spec.negative >= 2) out = `(${out})`;
  else if (negative && spec.negative === 0) out = `-${out}`;
  return { ok: true, text: out, red: negative && spec.negative % 2 === 1 };
}

// Porcentagem: o número digitado já é a porcentagem ("15" é 15%). No Acrobat o valor guardado é a fração (0,15), mas
// aqui só o texto vai para a página, e quem digita 15 quer ver 15%.
function formatPercent(spec, text) {
  const amount = readAmount(text, spec.separator, ['%']);
  if (!amount) return fail(text, 'Não é um número.');
  const body = printAmount(amount, spec.decimals, spec.separator);
  const signed = amount.negative && /[1-9]/.test(body) ? `-${body}` : body;
  return { ok: true, text: spec.prepend ? `%${signed}` : `${signed}%` };
}

// --- Datas e horas ---

const DATE_TOKENS = ['mmmm', 'mmm', 'mm', 'm', 'dddd', 'ddd', 'dd', 'd', 'yyyy', 'yy', 'HH', 'H', 'hh', 'h', 'MM', 'M', 'ss', 's', 'tt', 't'];
const DATE_PART = {
  d: 'day', dd: 'day', ddd: 'weekday', dddd: 'weekday', m: 'month', mm: 'month', mmm: 'monthName', mmmm: 'monthName',
  yy: 'year', yyyy: 'year', H: 'hour', HH: 'hour', h: 'hour', hh: 'hour', M: 'minute', MM: 'minute', s: 'second',
  ss: 'second', t: 'ampm', tt: 'ampm',
};
const NUMERIC_PARTS = new Set(['day', 'month', 'year', 'hour', 'minute', 'second']);

/**
 * Separa um formato de data do Acrobat em códigos e literais. A barra invertida escapa um caractere. Letra que não é
 * código, a mesma parte duas vezes, dia sem mês ou dia da semana sem a data inteira: null.
 * @returns {Array<{token?: string, text?: string}>|null}
 */
function splitDateFormat(format) {
  if (typeof format !== 'string' || !format || format.length > 64) return null;
  const parts = [];
  for (let i = 0; i < format.length;) {
    const char = format[i];
    if (char === '\\') {
      if (i + 1 >= format.length) return null;
      parts.push({ text: format[i + 1] });
      i += 2;
    } else if (/[A-Za-z]/.test(char)) {
      const token = DATE_TOKENS.find((item) => format.startsWith(item, i));
      if (!token) return null;
      parts.push({ token });
      i += token.length;
    } else if (/\p{C}/u.test(char)) {
      return null;
    } else {
      parts.push({ text: char });
      i++;
    }
  }
  const names = parts.filter((part) => part.token).map((part) => DATE_PART[part.token].replace('monthName', 'month'));
  const has = (name) => names.includes(name);
  if (!names.length || new Set(names).size !== names.length) return null;
  if ((has('day') && !has('month')) || (has('weekday') && !(has('day') && has('year'))) || (has('ampm') && !has('hour'))) return null;
  return parts;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_PT = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_PT = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'feira'];
// Palavras que podem vir no meio da data digitada ("5 de fevereiro", "14h30", "às 10:00").
const FILLERS = new Set(['de', 'do', 'da', 'of', 'h', 'as', 'at']);

const fold = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// Nome por extenso ou abreviado (três letras ou mais), em inglês ou português.
const byPrefix = (word, ...lists) => {
  if (word.length < 3) return -1;
  const found = new Set();
  for (const list of lists) list.forEach((name, i) => { if (name.toLowerCase().startsWith(word)) found.add(i); });
  return found.size === 1 ? [...found][0] : -1;
};

// Dias do mês; sem o ano, fevereiro aceita o 29.
function daysInMonth(month, year) {
  const leap = year === undefined || (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

// Algarismos digitados sem separador ("05022024", "1430"): corta pela largura de cada parte. O ano pode vir com dois
// ou quatro algarismos, a hora com um só, e minutos e segundos no fim podem faltar.
function splitDigits(digits, fields) {
  for (let count = fields.length; count > 1; count--) {
    if (!fields.slice(count).every((field) => field.part === 'minute' || field.part === 'second')) break;
    const used = fields.slice(0, count);
    const widths = used.map((field) => (field.part === 'year' && field.token === 'yyyy' ? 4 : 2));
    const options = [widths];
    const year = used.findIndex((field) => field.part === 'year');
    if (year >= 0) options.push(widths.map((width, i) => (i === year ? 6 - width : width)));
    if (used[0].part === 'hour') options.push(widths.map((width, i) => (i === 0 ? 1 : width)));
    for (const option of options) {
      if (option.reduce((sum, width) => sum + width, 0) !== digits.length) continue;
      let at = 0;
      return option.map((width) => digits.slice(at, (at += width)));
    }
  }
  return null;
}

/**
 * Lê uma data digitada na ordem das partes do formato (dd/mm: dia antes do mês).
 * @returns {{values: object}|{error: 'format'|'date'|'time'}}
 */
function readDate(text, parts, output) {
  const fields = parts.filter((part) => part.token).map((part) => ({ token: part.token, part: DATE_PART[part.token] }));
  const has = (name) => fields.some((field) => field.part === name);
  const literal = new Set(fold(parts.map((part) => part.text ?? ' ').join('')).match(/\p{L}+/gu) ?? []);
  const values = {};
  const numbers = [];
  for (const piece of fold(text).replace(/\b([ap])\.\s?m\b\.?/g, '$1m').match(/\d+|\p{L}+/gu) ?? []) {
    if (/^\d/.test(piece)) {
      numbers.push(piece);
      continue;
    }
    if (literal.has(piece) || FILLERS.has(piece)) continue;
    const month = byPrefix(piece, MONTHS, MONTHS_PT);
    if (month >= 0 && values.month === undefined && (has('month') || has('monthName'))) values.month = month + 1;
    else if (['am', 'pm', 'a', 'p'].includes(piece) && values.pm === undefined && has('hour')) values.pm = piece[0] === 'p';
    else if (byPrefix(piece, WEEKDAYS, WEEKDAYS_PT) < 0) return { error: 'format' };
  }
  const numeric = fields.filter((field) => (field.part === 'month' || field.part === 'monthName'
    ? values.month === undefined : NUMERIC_PARTS.has(field.part)));
  let pieces = numbers;
  if (numbers.length === 1 && numeric.length > 1) pieces = splitDigits(numbers[0], numeric) ?? numbers;
  const missing = numeric.slice(pieces.length);
  if (pieces.length > numeric.length || (missing.length && (!pieces.length || missing.some((field) => field.part !== 'minute' && field.part !== 'second')))) {
    return { error: 'format' };
  }
  for (const [i, digits] of pieces.entries()) {
    const { part } = numeric[i];
    if (part === 'year') {
      if (!/^(?:\d{1,2}|\d{4})$/.test(digits)) return { error: 'format' };
      const year = Number(digits);
      values.year = digits.length > 2 ? year : year < 50 ? 2000 + year : 1900 + year; // como o Acrobat: 50 vira 1950
    } else {
      if (digits.length > 2) return { error: 'format' };
      values[part === 'monthName' ? 'month' : part] = Number(digits);
    }
  }
  // O que a data mostrada precisa e não foi digitado.
  for (const part of output.filter((item) => item.token)) {
    const name = DATE_PART[part.token].replace('monthName', 'month').replace('weekday', 'day');
    if ((name === 'day' || name === 'month' || name === 'year') && values[name] === undefined) return { error: 'format' };
  }
  const { year, month, day } = values;
  if (month !== undefined && (month < 1 || month > 12)) return { error: 'date' };
  if (day !== undefined && (day < 1 || day > daysInMonth(month, year))) return { error: 'date' };
  if (year !== undefined && year < 1) return { error: 'date' };
  let hour = values.hour ?? 0;
  if (values.pm !== undefined && values.hour !== undefined) {
    if (hour < 1 || hour > 12) return { error: 'time' };
    hour = (hour % 12) + (values.pm ? 12 : 0);
  }
  const minute = values.minute ?? 0;
  const second = values.second ?? 0;
  if (hour > 23 || minute > 59 || second > 59) return { error: 'time' };
  return { values: { year, month, day, hour, minute, second } };
}

const pad = (value, size = 2) => String(value).padStart(size, '0');
function weekday({ year, month, day }) {
  const date = new Date(Date.UTC(2000, 0, 1));
  date.setUTCFullYear(year, month - 1, day); // o Date.UTC leva os anos 0 a 99 para 1900
  return date.getUTCDay();
}
// Como o Acrobat escreve cada código. Os nomes de mês e de dia saem em inglês, como no Acrobat, no PDF.js e no PDFium.
const PRINT = {
  d: (v) => String(v.day), dd: (v) => pad(v.day), ddd: (v) => WEEKDAYS[weekday(v)].slice(0, 3), dddd: (v) => WEEKDAYS[weekday(v)],
  m: (v) => String(v.month), mm: (v) => pad(v.month), mmm: (v) => MONTHS[v.month - 1].slice(0, 3), mmmm: (v) => MONTHS[v.month - 1],
  yy: (v) => pad(v.year % 100), yyyy: (v) => pad(v.year, 4),
  H: (v) => String(v.hour), HH: (v) => pad(v.hour), h: (v) => String(v.hour % 12 || 12), hh: (v) => pad(v.hour % 12 || 12),
  M: (v) => String(v.minute), MM: (v) => pad(v.minute), s: (v) => String(v.second), ss: (v) => pad(v.second),
  t: (v) => (v.hour < 12 ? 'a' : 'p'), tt: (v) => (v.hour < 12 ? 'am' : 'pm'),
};

const printDate = (parts, values) => parts.map((part) => part.text ?? PRINT[part.token](values)).join('');

// Dica em português: aaaa para o ano, hh:mm para a hora. Com letra literal no formato ("14h30"), as letras da dica se
// confundiriam com ela ("hhhmm"): aí a dica é um exemplo.
const DATE_HINT = { yy: 'aa', yyyy: 'aaaa', H: 'h', HH: 'hh', M: 'm', MM: 'mm', t: 'a/p', tt: 'am/pm' };
const SAMPLE = { year: 2024, month: 12, day: 31, hour: 23, minute: 59, second: 59 };
const dateHint = (parts) => (parts.some((part) => part.text && /\p{L}/u.test(part.text))
  ? printDate(parts, SAMPLE)
  : parts.map((part) => part.text ?? DATE_HINT[part.token] ?? part.token).join(''));

function formatDate(spec, text) {
  const output = splitDateFormat(spec.format);
  const input = splitDateFormat(spec.input);
  if (!output || !input) return { ok: true, text };
  let error = null;
  // Primeiro na ordem do teclado; depois na do formato mostrado, para o texto já formatado continuar igual.
  for (const parts of spec.input === spec.format ? [input] : [input, output]) {
    const read = readDate(text, parts, output);
    if (read.values) return { ok: true, text: printDate(output, read.values) };
    if (!error || error === 'format') error = read.error;
  }
  const message = error === 'date' ? 'Esta data não existe.' : error === 'time' ? 'Esta hora não existe.' : `Use o formato ${dateHint(input)}.`;
  return fail(text, message);
}

// --- Máscaras ---

// O que cada caractere da máscara aceita; o resto da máscara é literal.
const MASK_SLOTS = { 9: /^[0-9]$/, A: /^[A-Za-z]$/, O: /^[A-Za-z0-9]$/, X: /^\P{Cc}$/u };
const MASK_HINT = { 9: '0', A: 'A', O: 'X', X: '_' };
// Espaço e pontuação fora do lugar são ignorados: "11 222 333 0001 81" serve para o CNPJ.
const LOOSE = /^[\s\p{P}\p{S}]$/u;

const validMask = (mask) => typeof mask === 'string' && mask.length <= 64 && !/\p{C}/u.test(mask) && /[9AOX]/.test(mask);
const maskHint = (mask) => Array.from(mask, (char) => MASK_HINT[char] ?? char).join('');

// Encaixa o texto na máscara: os literais que faltam entram. Algo que não cabe, que falta ou que sobra: null.
function fillMask(mask, text) {
  const chars = Array.from(text);
  let i = 0;
  let out = '';
  for (const slot of Array.from(mask)) {
    const accepts = MASK_SLOTS[slot];
    if (!accepts) {
      if (chars[i] === slot) i++;
      out += slot;
      continue;
    }
    while (i < chars.length && !accepts.test(chars[i]) && LOOSE.test(chars[i])) i++;
    if (i >= chars.length || !accepts.test(chars[i])) return null;
    out += chars[i++];
  }
  while (i < chars.length && LOOSE.test(chars[i])) i++;
  return i === chars.length ? out : null;
}

function formatMask(mask, text) {
  const out = fillMask(mask, text);
  return out === null ? fail(text, `Use o formato ${maskHint(mask)}.`) : { ok: true, text: out };
}

const specialMask = (style, text) => {
  const masks = SPECIAL_MASKS[style];
  return masks.length > 1 && (text.match(/\d/g)?.length ?? 0) > 7 ? masks[1] : masks[0];
};

// --- O que o painel usa ---

const fail = (text, message) => ({ ok: false, text, message });

/**
 * Formata o valor digitado pelo formato do campo.
 * @param {FieldFormat|null} spec o que readFieldFormat devolveu
 * @param {string} value o que a pessoa digitou
 * @returns {{ok: boolean, text: string, message?: string, red?: boolean}} text: o valor formatado ou, se não serve
 *   (ok false), o valor como digitado (sem os espaços das pontas), com a mensagem para o aviso no campo. Sem formato,
 *   o valor volta como veio.
 *   red (só em número): negativo nos estilos 1 e 3, que pintam de vermelho em vez de mostrar o sinal; quem desenha
 *   tem que pintar, senão o sinal se perde
 */
export function formatFieldValue(spec, value) {
  const typed = String(value ?? '');
  if (!spec || !Object.hasOwn(FAMILY, spec.kind)) return { ok: true, text: typed };
  const text = typed.trim();
  if (!text) return { ok: true, text: '' };
  switch (spec.kind) {
    case 'number': return formatNumber(spec, text);
    case 'percent': return formatPercent(spec, text);
    case 'special': return formatMask(specialMask(spec.style, text), text);
    case 'mask': return formatMask(spec.mask, text);
    default: return formatDate(spec, text);
  }
}

/**
 * A dica para mostrar no campo vazio e o teclado do celular.
 * @param {FieldFormat|null} spec
 * @returns {{placeholder: string, inputMode: 'numeric'|'decimal'|'text'}} decimal só com casas decimais (a vírgula);
 *   numeric quando bastam algarismos: data e hora sem nome de mês nem am/pm são lidas também sem separador
 *   ("05022024"), e a máscara põe os literais sozinha
 */
export function fieldInputHints(spec) {
  switch (spec?.kind) {
    case 'number':
    case 'percent':
      return { placeholder: formatFieldValue(spec, '0').text, inputMode: spec.decimals ? 'decimal' : 'numeric' };
    case 'date':
    case 'time': {
      const parts = splitDateFormat(spec.input);
      if (!parts) break;
      const digitsOnly = parts.every((part) => !part.token || NUMERIC_PARTS.has(DATE_PART[part.token]));
      return { placeholder: dateHint(parts), inputMode: digitsOnly ? 'numeric' : 'text' };
    }
    case 'special':
      return { placeholder: maskHint(SPECIAL_MASKS[spec.style].at(-1)), inputMode: 'numeric' };
    case 'mask':
      return { placeholder: maskHint(spec.mask), inputMode: /[AOX]/.test(spec.mask) ? 'text' : 'numeric' };
    default:
  }
  return { placeholder: '', inputMode: 'text' };
}
