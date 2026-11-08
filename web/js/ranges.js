// Intervalos de páginas digitados pela pessoa ("1-3, 4-10, 12"), para dividir em vários PDFs.
import { t, plural } from './i18n.js';

/**
 * @param {string} text
 * @param {number} total número de páginas na lista
 * @returns {number[][]} cada intervalo como posições a partir de 0, na ordem digitada
 * @throws {Error} com uma mensagem pronta para mostrar
 */
export function parseRanges(text, total) {
  const parts = text.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error(t('Escreva os intervalos, por exemplo: 1-3, 4-10.'));
  // Todos os problemas de uma vez (#37): com "9-2, x", o 9 e o "x" aparecem juntos, sem a pessoa corrigir um, gerar de
  // novo e só então descobrir o próximo. Um por trecho, sem repetir a mesma mensagem.
  const problems = [];
  const groups = parts.map((part) => {
    const problem = rangeProblem(part, total);
    if (problem) {
      if (!problems.includes(problem)) problems.push(problem);
      return [];
    }
    const [first, last] = bounds(part, total);
    return Array.from({ length: last - first + 1 }, (_, i) => first - 1 + i);
  });
  if (problems.length) throw new Error(problems.join(' '));
  return groups;
}

const RANGE = /^(\d+)\s*(?:(?:[-–—a]|to)\s*(\d*))?$/i; // 1-3, 1 a 3 ou 1 to 3 (#22)

function bounds(part, total) {
  const match = RANGE.exec(part);
  const first = Number(match[1]);
  const last = match[2] === undefined ? first : match[2] === '' ? total : Number(match[2]); // "5-" vai até o fim
  return [first, last];
}

/** O que há de errado num trecho ("9-2", "x"), ou null. */
function rangeProblem(part, total) {
  if (!RANGE.test(part)) return t('Não entendi "{part}". Use algo como 1-3, 4-10.', { part });
  const [first, last] = bounds(part, total);
  if (first < 1 || last < 1) return t('As páginas começam no 1.');
  if (first > total || last > total) return plural(total, 'A página {page} não existe: a lista tem {n} página.', 'A página {page} não existe: a lista tem {n} páginas.', { page: Math.max(first, last) });
  if (first > last) return t('Em "{part}", o começo vem depois do fim.', { part });
  return null;
}
