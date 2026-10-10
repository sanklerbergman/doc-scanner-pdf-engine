// Confere o site no ar depois do deploy: cada arquivo de web/ tem que chegar byte a byte igual ao do repositório
// (nada injetado pelo caminho, como script de analytics ou de verificação de robô) e com a CSP certa.
// Uso: node conferir.mjs [endereço]
import { readFile, readdir } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'https://scanner.sankler.com.br/';
const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const TRIES = 10;
const WAIT_MS = 6000;

const files = (await readdir(WEB, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== '_headers')
  .map((entry) => relative(WEB, `${entry.parentPath}/${entry.name}`).replaceAll('\\', '/'));

const expectedCsp = {
  '': /connect-src 'none'.*frame-ancestors 'none'$/, // a página (o /index.html redireciona para /)
  'sw.js': /^default-src 'none'; connect-src 'self'$/,
};

async function check(file) {
  const path = file === 'index.html' ? '' : file;
  const response = await fetch(new URL(path, BASE), { cache: 'no-store', redirect: 'error' });
  if (!response.ok) return `${path || '/'}: HTTP ${response.status}`;
  const live = Buffer.from(await response.arrayBuffer());
  if (!live.equals(await readFile(WEB + file))) return `${path || '/'}: conteúdo diferente do repositório`;
  const csp = response.headers.get('content-security-policy') ?? '';
  if (path in expectedCsp && !expectedCsp[path].test(csp)) return `${path || '/'}: CSP inesperada (${csp || 'nenhuma'})`;
  if (!/default-src/.test(csp) || response.headers.get('x-content-type-options') !== 'nosniff') {
    return `${path || '/'}: faltam cabeçalhos de segurança`;
  }
  return null;
}

for (let attempt = 1; ; attempt++) {
  const problems = (await Promise.all(files.map((file) => check(file).catch((err) => `${file}: ${err.message}`)))).filter(Boolean);
  if (!problems.length) {
    console.log(`${files.length} arquivos no ar iguais aos do repositório, com os cabeçalhos de segurança.`);
    break;
  }
  if (attempt === TRIES) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`Tentativa ${attempt}: ${problems.length} diferença(s); esperando a publicação propagar...`);
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
}
