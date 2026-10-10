// Varredura de PDFs reais: abre, junta, divide e comprime cada PDF de uma pasta, como o app faz, e anota o que
// travou, estourou a memória, deu erro inesperado, demorou ou gerou um PDF inválido.
// Só para quem desenvolve. Os arquivos são de terceiros e não confiáveis: ficam numa pasta fora do repositório,
// e o script só os lê (nada do PDF é executado; o leitor só lê a estrutura).
//
// Uso: node scripts/varrer-pdfs.mjs <pasta> [--qpdf] [--saida relatorio.json] [--tempo 30] [--lento 3]
//        [--memoria 1536] [--paralelo 8]
//   --qpdf: confere a entrada e os PDFs gerados com o qpdf --check (o programa vem da variável QPDF ou do PATH)
//   --saida: grava o resultado de cada arquivo em JSON
//
// Conjunto de teste do PDF.js (cerca de mil PDFs, muitos quebrados de propósito), numa pasta fora do repositório:
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/mozilla/pdf.js
//   cd pdf.js && git sparse-checkout set test/pdfs
//   node <este repositório>/scripts/varrer-pdfs.mjs test/pdfs --qpdf
import { spawnSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { newQpdfProblems } from './lib/exercitar-pdf.mjs';
import { DEFAULTS, runIsolated } from './lib/isolar.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    qpdf: { type: 'boolean', default: false },
    saida: { type: 'string' },
    tempo: { type: 'string', default: String(DEFAULTS.timeout / 1000) },
    lento: { type: 'string', default: '3' },
    memoria: { type: 'string', default: String(DEFAULTS.memory) },
    paralelo: { type: 'string', default: String(DEFAULTS.concurrency) },
  },
});
const [folder] = positionals;
if (!folder) {
  console.error('Uso: node scripts/varrer-pdfs.mjs <pasta> [--qpdf] [--saida relatorio.json] [--tempo 30] [--lento 3]');
  process.exit(2);
}
const qpdf = values.qpdf ? process.env.QPDF || 'qpdf' : null;
if (qpdf && spawnSync(qpdf, ['--version']).error) {
  console.error(`qpdf não encontrado (${qpdf}). Instale ou aponte o programa na variável QPDF.`);
  process.exit(2);
}

const files = (await readdir(folder, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.pdf$/i.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();
console.log(`${files.length} PDFs em ${folder}`);

const slowMs = Number(values.lento) * 1000;
let count = 0;
const results = await runIsolated(files.map((path) => ({ path })), {
  timeout: Number(values.tempo) * 1000,
  memory: Number(values.memoria),
  concurrency: Number(values.paralelo),
  qpdf,
  onResult: () => {
    if (++count % 50 === 0 || count === files.length) process.stderr.write(`\r${count} de ${files.length}`);
  },
});
process.stderr.write('\n');

const report = results.map((result, i) => ({ file: relative(folder, files[i]).replaceAll('\\', '/'), ...result }));
if (values.saida) await writeFile(values.saida, JSON.stringify(report, null, 1));

// ---------- Resumo ----------

const by = (status) => report.filter((r) => r.status === status);
const counts = Object.groupBy(report, (r) => r.status);
console.log(Object.entries(counts).map(([status, list]) => `${status}: ${list.length}`).join(' | '));

const section = (title, list, line) => {
  if (!list.length) return;
  console.log(`\n## ${title} (${list.length})`);
  for (const item of list) console.log(`- ${line(item)}`);
};

section('Erro inesperado', by('erro'), (r) => `${r.file} [${r.stage}] ${r.message}`);
section('Tempo esgotado', by('tempo'), (r) => `${r.file} ${r.message}`);
section('Memória estourada', by('memoria'), (r) => `${r.file} ${r.message}`);
section('Lentos', report.filter((r) => r.ms > slowMs).sort((a, b) => b.ms - a.ms),
  (r) => `${r.file} ${(r.ms / 1000).toFixed(1)} s (${r.pages ?? '?'} páginas, ${r.status})`);

// Mensagens de recusa, agrupadas (o que a pessoa leria no app).
const refusals = Object.entries(Object.groupBy(by('recusado'), (r) => r.message)).sort((a, b) => b[1].length - a[1].length);
section('Recusas', refusals, ([message, list]) => `${list.length}× ${message}`);

// Avisos (ex.: imagem que ficou como estava na compressão). Mensagem de erro de programação aqui é falha escondida.
const warnings = new Map();
for (const r of report) for (const w of r.warnings ?? []) warnings.set(w, [...(warnings.get(w) ?? []), r.file]);
section('Avisos', [...warnings].sort((a, b) => b[1].length - a[1].length),
  ([warning, list]) => `${list.length}× ${warning} (ex.: ${list[0]})`);

let worse = [];
if (qpdf) {
  worse = report.filter((r) => newQpdfProblems(r).length);
  section('PDF gerado com problema novo no qpdf (que a entrada não tinha)', worse,
    (r) => `${r.file}: ${newQpdfProblems(r).slice(0, 3).join(' / ')}`);
  const readable = by('recusado').filter((r) => r.qpdf?.input.status === 0 && !/senha/.test(r.message));
  section('Recusados que o qpdf lê sem nenhum aviso', readable, (r) => `${r.file}: ${r.message}`);
}

const failures = by('erro').length + by('tempo').length + by('memoria').length + worse.length;
process.exitCode = failures ? 1 : 0;
