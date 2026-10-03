// Web Worker dos filtros: o processamento pesado de pixels sai da thread principal,
// então a página continua respondendo enquanto o PDF é gerado.
// Os pixels chegam e voltam como ArrayBuffer transferido (sem cópia). Nada sai do aparelho.
import { applyFilter } from './filters.js';

self.addEventListener('message', ({ data: job }) => {
  const { id, buffer, width, height, filter } = job;
  try {
    applyFilter({ data: new Uint8ClampedArray(buffer), width, height }, filter);
    self.postMessage({ id, buffer }, [buffer]);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
});
