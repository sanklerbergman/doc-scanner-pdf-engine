import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('versão do rodapé bate com a do package.json', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const footer = html.match(/data-release-link[^>]*>([^<]+)</);
  assert.ok(footer, 'link de versão não encontrado no rodapé');
  assert.equal(footer[1], version);
});
