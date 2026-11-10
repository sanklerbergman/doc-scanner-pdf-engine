// Todo arquivo do app passa pela leitura do JavaScript (node --check): um erro de sintaxe num módulo que os testes não
// carregam (viewer.js, editor.js, as telas) só aparecia no navegador, com o app inteiro parado. Ex.: um nome declarado
// duas vezes na mesma função.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../web/js/', import.meta.url));

test('os módulos do app não têm erro de sintaxe', () => {
  const files = readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 30);
  const broken = [];
  for (const name of files) {
    try {
      execFileSync(process.execPath, ['--check', `${dir}${name}`], { stdio: 'pipe' });
    } catch (err) {
      broken.push(`${name}: ${String(err.stderr).split('\n').find((line) => /Error/.test(line)) ?? err.message}`);
    }
  }
  assert.deepEqual(broken, []);
});
