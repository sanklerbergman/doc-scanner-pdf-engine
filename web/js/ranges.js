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
  return parts.map((part) => {
    const match = /^(\d+)\s*(?:(?:[-–—a]|to)\s*(\d*))?$/i.exec(part); // 1-3, 1 a 3 ou 1 to 3 (#22)
    if (!match) throw new Error(t('Não entendi "{part}". Use algo como 1-3, 4-10.', { part }));
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : match[2] === '' ? total : Number(match[2]); // "5-" vai até o fim
    if (first < 1 || last < 1) throw new Error(t('As páginas começam no 1.'));
    if (first > total || last > total) throw new Error(plural(total, 'A página {page} não existe: a lista tem {n} página.', 'A página {page} não existe: a lista tem {n} páginas.', { page: Math.max(first, last) }));
    if (first > last) throw new Error(t('Em "{part}", o começo vem depois do fim.', { part }));
    return Array.from({ length: last - first + 1 }, (_, i) => first - 1 + i);
  });
}
