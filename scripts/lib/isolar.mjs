// Roda o exercitar-pdf.mjs em Workers, com tempo e memória limitados. Um PDF que trava o leitor (laço sem fim)
// ou estoura a memória derruba só o Worker dele, que é trocado por outro; o resultado vira 'tempo' ou 'memoria'.
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

const WORKER = new URL('./exercitar-pdf.mjs', import.meta.url);

export const DEFAULTS = {
  timeout: 30000, // ms por PDF
  memory: 1536, // MB de heap por Worker
  concurrency: Math.max(1, Math.min(8, availableParallelism() - 1)),
};

/**
 * @param {object[]} jobs cada uma {path} ou {bytes}, ou o que o prepare transformar nisso
 * @param {{timeout?: number, memory?: number, concurrency?: number, qpdf?: string | null,
 *   prepare?: (job: object) => {path?: string, bytes?: Uint8Array},
 *   onResult?: (result: object, job: object, index: number) => void}} [options]
 *   prepare: monta a tarefa na hora de rodar (no fuzzing, a variação do PDF), sem guardar todas na memória
 * @returns {Promise<object[]>} um resultado por tarefa, na mesma ordem
 */
export async function runIsolated(jobs, options = {}) {
  const { timeout, memory, concurrency, qpdf = null, prepare = (job) => job, onResult } = { ...DEFAULTS, ...options };
  const results = new Array(jobs.length);
  let next = 0;

  const spawn = () => {
    const worker = new Worker(WORKER, { resourceLimits: { maxOldGenerationSizeMb: memory } });
    worker.on('error', () => {}); // o erro chega pelo runOne; este só evita "erro sem tratamento" depois dele
    return worker;
  };

  // Uma tarefa num Worker. dead: o Worker não serve mais (tempo esgotado, memória, saída inesperada).
  const runOne = (worker, job) => new Promise((resolve) => {
    const { path, bytes } = prepare(job);
    const onMessage = (result) => finish(result);
    const onError = (err) => finish(err.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? { status: 'memoria', message: `passou de ${memory} MB` }
      : { status: 'erro', stage: 'worker', message: `${err.name}: ${err.message}`, stack: err.stack }, true);
    const onExit = (code) => finish({ status: 'erro', stage: 'worker', message: `o Worker saiu (código ${code})` }, true);
    const timer = setTimeout(() => finish({ status: 'tempo', message: `passou de ${timeout / 1000} s` }, true), timeout);
    function finish(result, dead = false) {
      clearTimeout(timer);
      worker.off('message', onMessage).off('error', onError).off('exit', onExit);
      resolve({ result, dead });
    }
    worker.once('message', onMessage).once('error', onError).once('exit', onExit);
    worker.postMessage({ path, bytes, qpdf });
  });

  async function lane() {
    let worker = null;
    while (next < jobs.length) {
      const index = next++;
      worker ??= spawn();
      const { result, dead } = await runOne(worker, jobs[index]);
      if (dead) {
        worker.terminate();
        worker = null;
      }
      results[index] = result;
      onResult?.(result, jobs[index], index);
    }
    await worker?.terminate();
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, lane));
  return results;
}
