// Fuzzing simples do leitor de PDF: variações das amostras (bytes trocados, arquivo cortado, números absurdos,
// palavras da estrutura trocadas...) passam pelo que o app faz com um PDF (abrir, juntar, dividir, comprimir).
// Cada variação tem que abrir ou ser recusada com mensagem clara, sem travar, estourar a memória nem dar erro
// inesperado. Cada uma roda num Worker com tempo e memória limitados.
// Só para quem desenvolve. O npm test roda uma rodada curta (test/pdf-fuzz.test.js); esta é a longa.
//
// Uso: node scripts/fuzz-pdf.mjs [--casos 2000] [--semente 1] [--sementes <pasta>] [--ate 200] [--saida <pasta>]
//        [--qpdf] [--tempo 10] [--memoria 1024] [--paralelo 8]
//   sem --sementes: as amostras de test/helpers/pdf.js; com: os PDFs da pasta (até --ate KB cada)
//   --saida: grava cada variação que falhou, para virar teste de regressão
//   --qpdf: confere os PDFs gerados com o qpdf --check (o programa vem da variável QPDF ou do PATH)
// O caso i usa a amostra i % (número de amostras) e a semente --semente + i: a mesma linha de comando repete
// exatamente os mesmos casos.
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { samplePdfs } from '../test/helpers/pdf.js';
import { newQpdfProblems } from './lib/exercitar-pdf.mjs';
import { DEFAULTS, runIsolated } from './lib/isolar.mjs';
import { fuzzCases, mutate } from './lib/mutar.mjs';

const { values } = parseArgs({
  options: {
    casos: { type: 'string', default: '2000' },
    semente: { type: 'string', default: '1' },
    sementes: { type: 'string' },
    ate: { type: 'string', default: '200' },
    saida: { type: 'string' },
    qpdf: { type: 'boolean', default: false },
    tempo: { type: 'string', default: '10' },
    memoria: { type: 'string', default: '1024' },
    paralelo: { type: 'string', default: String(DEFAULTS.concurrency) },
  },
});
const qpdf = values.qpdf ? process.env.QPDF || 'qpdf' : null;
if (qpdf && spawnSync(qpdf, ['--version']).error) {
  console.error(`qpdf não encontrado (${qpdf}). Instale ou aponte o programa na variável QPDF.`);
  process.exit(2);
}

let samples = samplePdfs();
if (values.sementes) {
  samples = {};
  const max = Number(values.ate) * 1024;
  for (const entry of await readdir(values.sementes, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && /\.pdf$/i.test(entry.name) && (await stat(path)).size <= max) samples[basename(path)] = new Uint8Array(await readFile(path));
  }
}
const names = Object.keys(samples).sort();
const cases = fuzzCases(names, { seed: Number(values.semente), count: Number(values.casos) });
console.log(`${cases.length} variações de ${names.length} amostras, sementes ${cases[0].seed} a ${cases.at(-1).seed}`);

let count = 0;
const results = await runIsolated(cases, {
  timeout: Number(values.tempo) * 1000,
  memory: Number(values.memoria),
  concurrency: Number(values.paralelo),
  qpdf,
  prepare: ({ sample, seed }) => ({ bytes: mutate(samples[sample], seed).bytes }),
  onResult: () => {
    if (++count % 100 === 0 || count === cases.length) process.stderr.write(`\r${count} de ${cases.length}`);
  },
});
process.stderr.write('\n');

const counts = Object.groupBy(results, (r) => r.status);
console.log(Object.entries(counts).map(([status, list]) => `${status}: ${list.length}`).join(' | '));

// Falhas, agrupadas pela mensagem (sem os números, que mudam de um caso para outro).
const failures = results.map((result, i) => ({ ...cases[i], result, qpdf: newQpdfProblems(result) }))
  .filter(({ result, qpdf: problems }) => ['erro', 'tempo', 'memoria'].includes(result.status) || problems.length);
const groups = Object.groupBy(failures, ({ result, qpdf: problems }) => {
  const message = problems.length ? `PDF gerado com problema novo no qpdf: ${problems[0]}` : `${result.status} [${result.stage ?? ''}] ${result.message}`;
  return message.replace(/\d+/g, 'N');
});
for (const [message, list] of Object.entries(groups)) {
  console.log(`\n## ${list.length}× ${message}`);
  for (const { sample, seed, result } of list.slice(0, 5)) {
    console.log(`- ${sample}, semente ${seed} (${mutate(samples[sample], seed).applied.join(', ')})`);
    if (result.stack) console.log(result.stack.split('\n').slice(1, 4).map((line) => `    ${line.trim()}`).join('\n'));
  }
}
if (values.saida && failures.length) {
  await mkdir(values.saida, { recursive: true });
  for (const { sample, seed } of failures) {
    await writeFile(join(values.saida, `${sample.replace(/\.pdf$/i, '')}-${seed}.pdf`), mutate(samples[sample], seed).bytes);
  }
  console.log(`\n${failures.length} variações gravadas em ${values.saida}`);
}
process.exitCode = failures.length ? 1 : 0;
