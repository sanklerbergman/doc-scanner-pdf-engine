// O que o app faz com um PDF, sem o navegador: abrir (com os avisos), juntar, dividir, comprimir, acrescentar a
// camada do OCR (com palavras simuladas), acrescentar edições (formas e desenho, como as da tela cheia) e acrescentar
// uma assinatura sem reescrever o arquivo (só a estrutura, com o espaço reservado: a chave não muda nada nela).
// Cada PDF gerado é reaberto pelo próprio leitor e, se pedido, passa pelo qpdf --check.
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
import { appendBlocker, buildAppendToSign } from '../../web/js/pdf-append.js';
import { rotateEdits } from '../../web/js/edits.js';

// O app recodifica as imagens num canvas; aqui, toda imagem vira o mesmo JPEG pequeno. Basta para passar pela
// leitura das imagens (descompactar, preditores, cores) e pela montagem do PDF com objetos trocados.
const SMALL_JPEG = new Uint8Array(readFileSync(new URL('../../test/fixtures/gray-16x24.jpg', import.meta.url)));
const encode = async () => ({ data: SMALL_JPEG, width: 16, height: 24 });

class OutputError extends Error {}

// Palavras de um OCR simulado: passam pela camada de texto invisível das páginas escaneadas.
const WORDS = [
  { text: 'Texto', x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.14, baseline: 0.135, size: 0.04, last: false },
  { text: '(reconhecido)', x0: 0.32, y0: 0.1, x1: 0.6, y1: 0.14, baseline: 0.135, size: 0.04, last: true },
];

// Edições simuladas (edits.js): as formas e o desenho da fase 1 e o texto da fase 2 (com fonte nos recursos), que viram
// conteúdo da página, com recursos de nomes novos.
const EDITS = [
  { type: 'rect', x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.3, color: '#dc2626', width: 2 },
  { type: 'arrow', x0: 0.2, y0: 0.5, x1: 0.6, y1: 0.6, color: '#1d4ed8', width: 2, from: [0.06, 0.88], to: [0.94, 0.12] },
  { type: 'check', x0: 0.6, y0: 0.1, x1: 0.65, y1: 0.14, color: '#15803d', width: 2 },
  { type: 'cross', x0: 0.7, y0: 0.7, x1: 0.75, y1: 0.74, color: '#000000', width: 4 },
  { type: 'ink', x0: 0.1, y0: 0.8, x1: 0.5, y1: 0.9, color: '#000000', width: 2, strokes: [[[0, 0.5], [0.3, 0.1], [1, 0.5]], [[0.5, 0.5]]] },
  { type: 'text', x0: 0.1, y0: 0.05, x1: 0.5, y1: 0.08, text: 'Texto (novo) \\ ação', family: 'serif', color: '#000000' },
];

// Copia as páginas (girando uma sim, outra não, como o app permite), monta o PDF e reabre com o leitor.
async function rebuild(doc, indices, replace, ocr, edits) {
  const copy = copyPages(doc, indices, { replace, ocr, edits });
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

// Limites dos leitores de PDF (ISO 32000-1, anexo C): número de objeto e de geração.
const MAX_OBJECT = 8388607;

// Assinar sem reescrever, quando o PDF permite: o original continua no começo, e o PDF com a assinatura acrescentada
// (com carimbo na última página) reabre inteiro, sem precisar de reparo, e com a assinatura reconhecida. Cada objeto
// do trecho acrescentado tem número e geração válidos e é o que o leitor acha por aquele número (a tabela xref nova
// aponta para ele). O resto do arquivo é o original, com os defeitos que ele tiver.
async function append(doc) {
  if (appendBlocker(doc)) return null;
  const { bytes } = buildAppendToSign(doc, {
    reserve: 64, time: new Date(2026, 0, 2, 3, 4, 5), stamp: { name: 'PESSOA DE TESTE', page: 'last', position: 'bottom-right' },
  });
  if (!doc.bytes.every((b, i) => bytes[i] === b)) throw new OutputError('o original mudou ao acrescentar a assinatura');
  let again;
  try {
    again = await openPdf(bytes);
  } catch (err) {
    throw new OutputError(`o PDF com a assinatura acrescentada não reabre: ${err.message}`);
  }
  if (again.repaired) throw new OutputError('o PDF com a assinatura acrescentada só abre com reparo');
  if (again.pages.length !== doc.pages.length) throw new OutputError(`o PDF com a assinatura acrescentada tem ${again.pages.length} páginas, e não ${doc.pages.length}`);
  if (!again.isSigned()) throw new OutputError('a assinatura acrescentada não é reconhecida');
  const tail = new TextDecoder('latin1').decode(bytes.subarray(doc.bytes.length));
  for (const [header, num, gen] of tail.matchAll(/^(\d+) (\d+) obj$/gm)) {
    if (Number(num) < 1 || Number(num) >= MAX_OBJECT || Number(gen) > 65535) throw new OutputError(`objeto acrescentado inválido: ${header}`);
    const offset = doc.bytes.length + tail.indexOf(`${header}\n`);
    if (again.entries.get(Number(num))?.offset !== offset) throw new OutputError(`a xref nova não aponta para ${header}`);
  }
  return bytes;
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
    stage = 'OCR';
    outputs.push(await rebuild(doc, all, undefined, new Map(all.map((i) => [i, { words: WORDS, rotation: (i % 2) * 90 }]))));
    stage = 'edição';
    outputs.push(await rebuild(doc, all, undefined, undefined, new Map(all.map((i) => [i, { edits: rotateEdits(EDITS, (i % 2) * 90), rotation: (i % 2) * 90 }]))));
    stage = 'assinar sem reescrever';
    const signed = await append(doc);
    if (signed) outputs.push(signed);
    return done({ status: 'ok', pages: doc.pages.length, appended: signed ? outputs.length - 1 : -1 });
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

// Problemas que o qpdf achou num PDF gerado e não na entrada. O app copia o conteúdo byte a byte: um stream
// corrompido na entrada continua corrompido no PDF gerado, e o qpdf avisa nos dois. Isso não é falha do app.
// Numa entrada danificada, o qpdf às vezes nem chega aos streams dela (o leitor do app recupera mais do que
// ele): aí, dado de stream ou conteúdo de página com defeito também conta como herdado.
const CONTENT = /error decoding stream data|input stream is complete|\(content, offset|content stream/;

// O PDF com a assinatura acrescentada guarda o original byte a byte, com os defeitos dele: o qpdf os descreve de
// outro jeito (e passa a conferir o formulário, que antes nem existia). Nele só conta erro (status 2) que a entrada
// não tinha; a estrutura do trecho acrescentado é conferida à parte (append).
export function newQpdfProblems(result) {
  if (!result.qpdf) return [];
  const appended = result.appended ?? -1;
  const kinds = (check) => new Set(check.text
    .filter((line) => !/^qpdf: |re-processed without filtering/.test(line))
    .map((line) => line.replace(/^(WARNING|ERROR): arquivo\.pdf[^:]*:\s*/, '$1: ').replace(/decode: .*$/, 'decode').replace(/\d+/g, 'N').trim()));
  const input = kinds(result.qpdf.input);
  const damaged = result.qpdf.input.status !== 0;
  return result.qpdf.outputs.flatMap((out, i) => {
    if (i === appended) return out.status === 2 && result.qpdf.input.status !== 2 ? out.text.slice(0, 3) : [];
    return [...kinds(out)].filter((kind) => !input.has(kind) && !(damaged && CONTENT.test(kind)));
  });
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
