// Fuzzing curto e determinístico, a cada npm test: variações das amostras de test/helpers/pdf.js (bytes trocados,
// arquivo cortado, números absurdos...) têm que abrir ou ser recusadas com mensagem clara, sem travar, estourar a
// memória nem dar erro inesperado. Cada variação roda num Worker com tempo limitado (scripts/lib/isolar.mjs), e
// cada PDF que abre também é juntado, dividido e comprimido, e o PDF gerado é reaberto.
// Rodadas longas, com outras sementes ou com PDFs reais: node scripts/fuzz-pdf.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, runIsolated } from '../scripts/lib/isolar.mjs';
import { fuzzCases, mutate } from '../scripts/lib/mutar.mjs';
import { samplePdfs } from './helpers/pdf.js';

const SEED = 1;
const COUNT = 20000;

test('fuzzing: variações das amostras não travam nem dão erro inesperado', async () => {
  const samples = samplePdfs();
  const cases = fuzzCases(Object.keys(samples).sort(), { seed: SEED, count: COUNT });
  const results = await runIsolated(cases, {
    timeout: 10000,
    memory: 512,
    concurrency: Math.min(4, DEFAULTS.concurrency),
    prepare: ({ sample, seed }) => ({ bytes: mutate(samples[sample], seed).bytes }),
  });
  const failures = results.map((result, i) => ({ ...cases[i], ...result }))
    .filter(({ status }) => status !== 'ok' && status !== 'recusado')
    .map(({ sample, seed, status, stage, message }) => `${sample}, semente ${seed}: ${status} [${stage ?? ''}] ${message}`);
  assert.deepEqual(failures, [], `Para repetir: node scripts/fuzz-pdf.mjs --semente ${SEED} --casos ${COUNT} --saida <pasta>`);
  // As variações têm que passar pelos dois caminhos: abrir e recusar.
  const counts = Object.groupBy(results, ({ status }) => status);
  assert.ok(counts.ok?.length > COUNT / 10 && counts.recusado?.length > COUNT / 10, JSON.stringify(Object.keys(counts)));
});
