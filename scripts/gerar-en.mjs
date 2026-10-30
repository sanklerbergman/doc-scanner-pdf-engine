// Gera a página em inglês (web/en/index.html) a partir da página em português (web/index.html) e do dicionário
// (web/js/i18n-en.js), como os outros geradores daqui: não há build no deploy, o arquivo gerado vai para o
// repositório, e o test/i18n.test.js confere que ele está em dia (#22).
//
// O que muda:
// - <html lang="en">;
// - textos entre as tags e os atributos de texto (aria-label, alt, title, placeholder, a descrição da página e o valor
//   inicial dos campos de texto), pelo dicionário. Texto sem tradução faz o gerador parar, com a lista do que falta;
// - caminhos relativos ganham "../" (a CSP tem base-uri 'none', então não dá para usar <base>). O manifesto é o da
//   pasta en/, e o link da marca ("./") continua apontando para a própria página;
// - o link de troca de idioma aponta para o português.
// Os comentários do HTML continuam em português: são para quem desenvolve.
//
// Uso: node scripts/gerar-en.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Textos que ficam iguais nas duas línguas (nomes e siglas).
const KEEP = new Set([
  'Scanner Doc', 'Scanner Doc → PDF', 'Sankler', 'PDF', 'PDF/A', 'OCR', 'Pix', 'GitHub', 'Português', 'A4', 'Ctrl+V',
  "connect-src 'none'", 'scanner.sankler.com.br', '.pfx', '.p12',
]);
const TEXT_ATTRIBUTES = ['aria-label', 'alt', 'title', 'placeholder'];
const SWITCH = /<a class="lang-switch" href="en\/" hreflang="en" lang="en">English<\/a>/;

const hasLetter = (text) => /\p{L}/u.test(text);

/**
 * @param {string} html página em português
 * @param {Record<string, string>} dictionary
 * @returns {{html: string, missing: string[], used: Set<string>}} used: as chaves do dicionário que a página usou
 */
export function buildEnglishPage(html, dictionary) {
  const missing = new Set();
  const used = new Set();
  const translate = (text) => {
    const key = text.replace(/\s+/g, ' ').trim();
    if (!hasLetter(key) || KEEP.has(key)) return text;
    const english = dictionary[key];
    if (english === undefined) {
      missing.add(key);
      return text;
    }
    used.add(key);
    // Mantém o espaço das pontas, que separa o texto das tags vizinhas.
    return text.match(/^\s*/)[0] + english + text.match(/\s*$/)[0];
  };
  if (!SWITCH.test(html)) throw new Error('Falta o link "English" de troca de idioma no web/index.html');
  let out = html
    .replace('<html lang="pt-BR">', '<html lang="en">')
    .replace(SWITCH, '<a class="lang-switch" href="../" hreflang="pt-BR" lang="pt-BR">Português</a>');

  // Tags (com comentários) e o texto entre elas.
  out = out.replace(/(<!--[\s\S]*?-->|<[^>]+>)|([^<]+)/g, (match, tag, text) => {
    if (text !== undefined) return translate(text);
    if (tag.startsWith('<!--')) return tag;
    return tag
      .replace(/ (href|src|srcset)="([^"]*)"/g, (attr, name, value) => {
        if (/^(#|\/|\.\.\/|[a-z]+:|\.\/$)/.test(value) || / rel="manifest"/.test(tag)) return attr;
        return ` ${name}="../${value}"`;
      })
      .replace(new RegExp(` (${TEXT_ATTRIBUTES.join('|')})="([^"]*)"`, 'g'), (attr, name, value) => ` ${name}="${translate(value)}"`)
      .replace(/^(<meta name="description" content=")([^"]*)"/, (attr, start, value) => `${start}${translate(value)}"`)
      // Valor inicial de campo de texto (o nome do arquivo); o value das opções é código e fica.
      .replace(/^(<input [^>]*type="text"[^>]* value=")([^"]*)"/, (attr, start, value) => `${start}${translate(value)}"`);
  });
  return { html: out, missing: [...missing], used };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const web = new URL('../web/', import.meta.url);
  const { default: dictionary } = await import(new URL('js/i18n-en.js', web));
  const { html, missing } = buildEnglishPage(readFileSync(new URL('index.html', web), 'utf8'), dictionary);
  if (missing.length) {
    console.error(`Sem tradução em web/js/i18n-en.js (${missing.length}):\n${missing.map((text) => `  ${JSON.stringify(text)}`).join('\n')}`);
    process.exit(1);
  }
  writeFileSync(new URL('en/index.html', web), html);
  console.log('web/en/index.html gerado.');
}
