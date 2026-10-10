import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Lê o web/_headers (formato do Cloudflare): linha sem recuo = caminho; linha recuada = "Nome: valor" ou "! Nome".
function readRules() {
  const rules = new Map();
  let current;
  for (const line of readFileSync(new URL('../web/_headers', import.meta.url), 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { headers: new Map(), detached: new Set() };
      rules.set(line.trim(), current);
    } else if (line.trim().startsWith('! ')) {
      current.detached.add(line.trim().slice(2).toLowerCase());
    } else {
      const at = line.indexOf(':');
      current.headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
    }
  }
  return rules;
}

const rules = readRules();
const metaCsp = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  .match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];

test('todo arquivo sai com os cabeçalhos de segurança', () => {
  const all = rules.get('/*');
  assert.ok(all, 'falta a regra /*');
  assert.match(all.headers.get('strict-transport-security'), /^max-age=\d{8,}/);
  assert.equal(all.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(all.headers.get('x-frame-options'), 'DENY');
  assert.equal(all.headers.get('referrer-policy'), 'no-referrer');
  assert.match(all.headers.get('permissions-policy'), /camera=\(self\)/);
  // CSP em /* se juntaria à da página no "/" (o Cloudflare soma regras que casam com o mesmo caminho).
  assert.ok(!all.headers.has('content-security-policy'), 'a CSP fica só nas regras da página e do service worker');
  for (const rule of rules.values()) assert.equal(rule.detached.size, 0, 'o "! Cabeçalho" não funcionou no "/" em produção');
});

test('a página recebe a mesma CSP do <meta>, mais frame-ancestors', () => {
  for (const path of ['/', '/index.html']) {
    const rule = rules.get(path);
    assert.ok(rule, `falta a regra ${path}`);
    assert.equal(rule.headers.get('content-security-policy'), `${metaCsp}; frame-ancestors 'none'`);
  }
  assert.match(metaCsp, /connect-src 'none'/);
});

test('o service worker só consegue buscar arquivos do próprio site', () => {
  const rule = rules.get('/sw.js');
  assert.ok(rule, 'falta a regra /sw.js');
  assert.equal(rule.headers.get('content-security-policy'), "default-src 'none'; connect-src 'self'");
});
