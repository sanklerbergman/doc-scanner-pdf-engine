// O que o app faz com um PDF, sem o navegador: abrir (com os avisos), juntar, dividir e comprimir. Cada PDF
// gerado é reaberto pelo próprio leitor e, se pedido, passa pelo qpdf --check.
// Usado pela varredura (varrer-pdfs.mjs) e pelo fuzzing (fuzz-pdf.mjs), sempre dentro de um Worker com tempo e
// memória limitados (isolar.mjs): um PDF que trava o leitor derruba só o Worker dele.
//
// Resultado: 'ok', 'recusado' (o leitor recusou com PdfError e mensagem clara, como o app mostra) ou 'erro'
// (qualquer outra exceção, ou falha depois de abrir: no app, isso é "Algo deu errado").
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { openPdf, copyPages, PdfError } from '../../web/js/pdf-reader.js';
import { compressObjects, compressibleBytes } from '../../web/js/pdf-compress.js';
import { buildPdf } from '../../web/js/pdf.js';

// O app recodifica as imagens num canvas; aqui, toda imagem vira o mesmo JPEG pequeno. Basta para passar pela
// leitura das imagens (descompactar, preditores, cores) e pela montagem do PDF com objetos trocados.
const SMALL_JPEG = new Uint8Array(readFileSync(new URL('../../test/fixtures/gray-16x24.jpg', import.meta.url)));
const encode = async () => ({ data: SMALL_JPEG, width: 16, height: 24 });

class OutputError extends Error {}

// Copia as páginas (girando uma sim, outra não, como o app permite), monta o PDF e reabre com o leitor.
async function rebuild(doc, indices, replace) {
  const copy = copyPages(doc, indices, { replace });
  const out = buildPdf(indices.map((index, i) => ({ copy: { source: copy, page: copy.pages.get(index) }, rotation: (i % 2) * 90 })));
  let again;
  try {
    again = await openPdf(out);
  } catch (err) {
    throw new OutputError(`o PDF gerado não reabre: ${err.message}`);
  }
  if (again.pages.length !== indices.length) throw new OutputError(`o PDF gerado tem ${again.pages.length} páginas, e não ${indices.length}`);
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{status: 'ok' | 'recusado' | 'erro', stage?: string, message?: string, stack?: string,
 *   pages?: number, ms: number, warnings: string[], outputs: Uint8Array[]}>}
 */
export async function exercise(bytes) {
  const warnings = [];
  const outputs = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' ')); // ex.: imagem que ficou como estava
  const start = performance.now();
  const done = (result) => ({ ...result, ms: Math.round(performance.now() - start), warnings: [...new Set(warnings)], outputs });
  let stage = 'abrir';
  try {
    const doc = await openPdf(bytes);
    stage = 'avisos';
    doc.isSigned();
    doc.hasAnnotations();
    compressibleBytes(doc);
    const all = doc.pages.map((_, i) => i);
    stage = 'juntar';
    outputs.push(await rebuild(doc, all));
    stage = 'dividir';
    outputs.push(await rebuild(doc, all.length > 1 ? [all.length - 1, 0] : [0]));
    stage = 'comprimir';
    const replace = await compressObjects(doc, all, { encode });
    outputs.push(await rebuild(doc, all, replace));
    return done({ status: 'ok', pages: doc.pages.length });
  } catch (err) {
    if (stage === 'abrir' && err instanceof PdfError) return done({ status: 'recusado', message: err.message });
    const message = err instanceof OutputError ? err.message : `${err?.name}: ${err?.message}`;
    return done({ status: 'erro', stage, message, stack: err instanceof OutputError ? undefined : err?.stack });
  } finally {
    console.warn = warn;
  }
}

// qpdf --check de um PDF: {status, text}. status 0: sem problemas; 3: avisos; 2: erros.
export function qpdfCheck(bytes, qpdf) {
  const dir = mkdtempSync(join(tmpdir(), 'qpdf-'));
  try {
    writeFileSync(join(dir, 'arquivo.pdf'), bytes);
    const result = spawnSync(qpdf, ['--check', join(dir, 'arquivo.pdf')], { encoding: 'utf8', timeout: 60000 });
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.split(/\r?\n/)
      .filter((line) => line && !/^(checking |PDF Version|File is not|No syntax|errors that qpdf)/.test(line))
      .map((line) => line.replace(join(dir, 'arquivo.pdf'), 'arquivo.pdf'));
    return { status: result.status ?? -1, text: text.slice(0, 200) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Dentro do Worker: recebe {path} ou {bytes} e devolve o resultado. Com qpdf, confere o arquivo de entrada e os
// PDFs gerados (fora do tempo medido).
parentPort?.on('message', async ({ path, bytes, qpdf }) => {
  const input = bytes ?? new Uint8Array(readFileSync(path));
  const { outputs, ...result } = await exercise(input);
  if (qpdf) {
    result.qpdf = { input: qpdfCheck(input, qpdf), outputs: outputs.map((out) => qpdfCheck(out, qpdf)) };
  }
  result.outputSizes = outputs.map((out) => out.length);
  parentPort.postMessage(result);
});
