// Versão em inglês (#22): a página /en/ gerada em dia, o dicionário sem falta nem sobra e o t() (i18n.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildEnglishPage } from '../scripts/gerar-en.mjs';
import dictionary from '../web/js/i18n-en.js';
import { LANG, t, plural } from '../web/js/i18n.js';

const web = new URL('../web/', import.meta.url);
const read = (path) => readFileSync(new URL(path, web), 'utf8');

// Textos do código: t('...') e plural(n, '...', '...'), com aspas simples, como no resto do código.
function codeTexts() {
  const texts = new Set();
  const literal = String.raw`'((?:[^'\\]|\\.)*)'`;
  const calls = new RegExp(String.raw`\bt\(\s*${literal}|\bplural\([^,]+,\s*${literal},\s*${literal}`, 'g');
  for (const file of readdirSync(new URL('js/', web)).filter((name) => name.endsWith('.js') && !name.startsWith('i18n'))) {
    for (const match of read(`js/${file}`).matchAll(calls)) {
      for (const text of match.slice(1)) if (text !== undefined) texts.add(text.replace(/\\(.)/g, '$1'));
    }
  }
  return texts;
}

test('a página em inglês está em dia com a em português e o dicionário (node scripts/gerar-en.mjs)', () => {
  const { html, missing } = buildEnglishPage(read('index.html'), dictionary);
  assert.deepEqual(missing, [], 'textos da página sem tradução');
  assert.equal(read('en/index.html'), html, 'rode node scripts/gerar-en.mjs');
});

test('a página em inglês não tem texto em português, fora os comentários e o link "Português"', () => {
  const visible = read('en/index.html').replace(/<!--[\s\S]*?-->/g, '').replace('>Português<', '><');
  assert.deepEqual(visible.match(/.*[ãõçáéíóúâêôà].*/g) ?? [], []);
  assert.match(visible, /<html lang="en">/);
});

test('dicionário: todo texto do código tem tradução, e nenhuma tradução sobra', () => {
  const { used } = buildEnglishPage(read('index.html'), dictionary);
  const code = codeTexts();
  assert.deepEqual([...code].filter((text) => !(text in dictionary)), [], 'textos do código sem tradução');
  assert.deepEqual(Object.keys(dictionary).filter((key) => !used.has(key) && !code.has(key)), [], 'traduções que ninguém usa');
});

test('dicionário: cada tradução tem os mesmos marcadores {nome} do texto em português', () => {
  const marks = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  assert.deepEqual(Object.entries(dictionary).filter(([key, value]) => marks(key) !== marks(value)).map(([key]) => key), []);
});

test('t() e plural() só com texto literal entre aspas simples (o teste do dicionário só acha esses)', () => {
  const loose = [];
  for (const file of readdirSync(new URL('js/', web)).filter((name) => name.endsWith('.js') && !name.startsWith('i18n'))) {
    for (const match of read(`js/${file}`).matchAll(/\b(t\(\s*[^'\s)]|plural\([^,]+,\s*[^'\s])/g)) loose.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(loose, []);
});

test('t(): no Node o idioma é o português, com os marcadores trocados', () => {
  assert.equal(LANG, 'pt');
  assert.equal(t('Gerar PDF'), 'Gerar PDF');
  assert.equal(t('{n} de {total}', { n: 2, total: 5 }), '2 de 5');
  assert.equal(t('{fica} {sem} valor', { fica: 'x' }), 'x {sem} valor');
  assert.equal(plural(1, '{n} página', '{n} páginas'), '1 página');
  assert.equal(plural(3, '{n} página', '{n} páginas'), '3 páginas');
});
