// Idioma da tela (#22). O idioma vem do endereço: / em português, /en/ em inglês (o <html lang> da página). Nada fica
// guardado no aparelho.
// Os textos do código ficam em português, dentro de t(): a chave é o próprio texto. Em português, t() devolve o texto
// como está; em inglês, a tradução do dicionário (i18n-en.js), que só carrega na página em inglês.
// Fora do navegador (testes no Node), o idioma é o português.

/** 'pt' ou 'en' */
export const LANG = globalThis.document?.documentElement?.lang === 'en' ? 'en' : 'pt';

/** Datas e números na tela (toLocaleDateString etc.), no idioma da página. */
export const LOCALE = LANG === 'en' ? 'en-US' : 'pt-BR';

const dictionary =LANG === 'en' ? (await import('./i18n-en.js')).default : null;

/**
 * Texto no idioma da tela. Marcadores {nome} trocados pelos valores: t('{n} páginas', { n: 3 }).
 * Texto sem tradução sai em português (o teste do dicionário acusa a falta).
 * @param {string} text
 * @param {Record<string, string | number>} [values]
 */
export function t(text, values) {
  const out = dictionary?.[text] ?? text;
  return values ? out.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match)) : out;
}

/**
 * Singular ou plural, com {n} trocado pelo número: plural(2, '{n} página', '{n} páginas').
 * @param {number} n
 * @param {string} one
 * @param {string} many
 * @param {Record<string, string | number>} [values]
 */
export function plural(n, one, many, values) {
  return t(n === 1 ? one : many, { n, ...values });
}
