// Reconhecimento de texto (OCR) das fotos, com o Tesseract (web/vendor/tesseract). Tudo no aparelho.
// Carregado só quando a pessoa liga "Texto pesquisável (OCR)": o motor e o modelo somam uns 5,5 MB.
//
// Segurança:
// - O worker nasce de um blob que importa o worker.min.js, então herda a política da página, incluindo o
//   connect-src 'none': ele não consegue abrir conexão nenhuma. O núcleo (.wasm.js) traz o WebAssembly embutido.
// - O modelo vem de um módulo JS do próprio site (por.traineddata.js) e chega ao worker em bytes: o Tesseract
//   nunca usa fetch. Se algum caminho dele tentar, a política bloqueia e o OCR falha, em vez de vazar.
// - Nada guardado: sem cache no IndexedDB (cacheMethod 'none'), sem logs, e o texto só existe na memória.
// - Um worker por vez, encerrado no fim: a memória do WebAssembly (centenas de MB) volta para o aparelho.
//
// O app conversa direto com o worker do Tesseract.js, sem a biblioteca da página (tesseract.esm.min.js): na
// versão 7.0.0 ela manda os bytes do modelo no lugar do nome do idioma ao inicializar, e o Tesseract não inicia.

const VENDOR = new URL('../vendor/tesseract/', import.meta.url).href;
const OEM_LSTM_ONLY = 1;
const PSM_AUTO = 3; // página inteira, com colunas e blocos, sem detectar a orientação

export class OcrError extends Error {
  name = 'OcrError';
}
export class OcrCancelled extends Error {
  name = 'OcrCancelled';
  constructor() {
    super('Reconhecimento de texto cancelado.');
  }
}

let model; // promessa do módulo com o modelo em base64; sem rede e sem cache, tenta de novo na próxima vez

function loadModel() {
  model ??= import('../vendor/tesseract/por.traineddata.js').catch((err) => {
    model = undefined;
    throw err;
  });
  return model;
}

function decodeBase64(text) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text);
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Worker do Tesseract.js e o protocolo dele: {workerId, jobId, action, payload} na ida; {jobId, status, data} na volta.
function spawn() {
  const entry = URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(`${VENDOR}worker.min.js`)});`], { type: 'text/javascript' }));
  const worker = new Worker(entry);
  const jobs = new Map();
  let nextJob = 1;
  let stopped = null;
  const stop = (err) => {
    if (stopped) return;
    stopped = err;
    worker.terminate();
    URL.revokeObjectURL(entry);
    for (const job of jobs.values()) job.reject(err);
    jobs.clear();
  };
  worker.addEventListener('message', ({ data }) => {
    if (data?.status !== 'resolve' && data?.status !== 'reject') return; // progresso: o app mostra por página
    const job = jobs.get(data.jobId);
    if (!job) return;
    jobs.delete(data.jobId);
    if (data.status === 'resolve') job.resolve(data.data);
    else if (job.action === 'recognize') job.reject(new OcrError('O reconhecimento de texto falhou nesta foto.'));
    else job.reject(new OcrError('O reconhecimento de texto não carregou. Confira a conexão e tente de novo.'));
  });
  // Script que não carregou (sem rede e sem cache) ou erro fora de um trabalho: o worker não serve mais.
  worker.addEventListener('error', (event) => {
    event.preventDefault();
    stop(new OcrError('O reconhecimento de texto não carregou. Confira a conexão e tente de novo.'));
  });
  return {
    call(action, payload, transfer = []) {
      if (stopped) return Promise.reject(stopped);
      const jobId = `${action}-${nextJob++}`;
      return new Promise((resolve, reject) => {
        jobs.set(jobId, { action, resolve, reject });
        worker.postMessage({ workerId: 'scanner-doc', jobId, action, payload }, transfer);
      });
    },
    stop,
  };
}

/**
 * Liga o motor de OCR com o modelo de português.
 * @returns {Promise<{recognize: (canvas: HTMLCanvasElement, options?: {dpi?: number}) => Promise<OcrWord[]>,
 *   cancel: () => void, terminate: () => void}>}
 */
export async function startOcr() {
  const { default: base64 } = await loadModel().catch(() => {
    throw new OcrError('Não deu para carregar o reconhecimento de texto. Confira a conexão e tente de novo.');
  });
  const engine = spawn();
  try {
    await engine.call('load', { options: { lstmOnly: true, corePath: VENDOR, logging: false } });
    const data = decodeBase64(base64);
    await engine.call('loadLanguage', {
      langs: [{ code: 'por', data }],
      options: { cacheMethod: 'none', gzip: true, lstmOnly: true },
    }, [data.buffer]);
    await engine.call('initialize', { langs: 'por', oem: OEM_LSTM_ONLY, config: { tessedit_pageseg_mode: PSM_AUTO } });
  } catch (err) {
    engine.stop(err);
    throw err;
  }
  return {
    // dpi: resolução da imagem na página do PDF. Sem ela, o Tesseract estima pela altura das letras.
    async recognize(canvas, { dpi } = {}) {
      const { width, height } = canvas;
      const image = toPgm(canvas);
      const options = dpi ? { user_defined_dpi: String(Math.round(Math.min(2400, Math.max(70, dpi)))) } : {};
      const result = await engine.call('recognize', { image, options, output: { text: false, blocks: true } }, [image.buffer]);
      return readWords(result?.blocks, width, height);
    },
    cancel: () => engine.stop(new OcrCancelled()),
    terminate: () => engine.stop(new OcrCancelled()),
  };
}

// Imagem em tons de cinza no formato PGM (P5): rápido de montar e sem perda, e o Tesseract trabalha em cinza.
// O cabeçalho tem um comentário que o leva a 512 bytes: o worker procura a orientação EXIF nos primeiros 500
// bytes da imagem, e assim os pixels nunca são confundidos com ela.
function toPgm(canvas) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  const tail = `\n${width} ${height}\n255\n`;
  const header = new TextEncoder().encode(`P5\n#${' '.repeat(512 - 4 - tail.length)}${tail}`);
  const out = new Uint8Array(header.length + width * height);
  out.set(header);
  for (let i = 0, p = 0, o = header.length; p < data.length; i++, p += 4, o++) {
    out[o] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return out;
}

/**
 * @typedef {{text: string, x0: number, y0: number, x1: number, y1: number, baseline: number, size: number,
 *   last: boolean, confidence: number}} OcrWord
 * Medidas de 0 a 1, relativas à imagem (origem no canto superior esquerdo). baseline: altura da linha de base no
 * meio da palavra; size: altura da linha (tamanho da letra); last: última palavra da linha.
 */

// Palavras do resultado do Tesseract (blocos → parágrafos → linhas → palavras), em medidas relativas à imagem.
export function readWords(blocks, width, height) {
  const words = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const list = (line.words ?? []).filter((word) => word.text?.trim() && validBox(word.bbox) && !isNoise(word));
        if (!list.length || !validBox(line.bbox)) continue;
        const row = line.rowAttributes?.row_height;
        const size = row > 0 ? row : line.bbox.y1 - line.bbox.y0;
        const base = line.baseline;
        const hasBaseline = base && base.has_baseline !== false && Number.isFinite(base.y0) && Number.isFinite(base.y1);
        list.forEach((word, i) => {
          const { x0, y0, x1, y1 } = word.bbox;
          const middle = (x0 + x1) / 2;
          const baseline = hasBaseline && base.x1 !== base.x0
            ? base.y0 + ((base.y1 - base.y0) * (middle - base.x0)) / (base.x1 - base.x0)
            : hasBaseline ? base.y0 : y1 - (line.rowAttributes?.descenders ?? 0);
          words.push({
            text: word.text.trim(),
            x0: x0 / width, y0: y0 / height, x1: x1 / width, y1: y1 / height,
            baseline: Math.min(1, Math.max(0, baseline / height)),
            size: size / height,
            last: i === list.length - 1,
            confidence: word.confidence ?? 0,
          });
        });
      }
    }
  }
  return words;
}

const validBox = (box) => box && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) && box.x1 > box.x0 && box.y1 > box.y0;

// Notas medidas com o próprio app (Tesseract de verdade, Chromium e WebKit) em 56 imagens de teste: documento nítido,
// desfocado, tremido, com pouca resolução, ruído, sombra, girado, foto de tela, JPEG ruim, letra de mão, só figura,
// bordas escuras, furos, espiral, carimbo e assinaturas, com e sem o filtro Documento.

// Ruído: palavra só de sinais (sem letra, dígito nem §, &, %, $, @ ou #) com nota baixa, que o Tesseract lê em borda,
// risco, sombra e foto ruim ("|", ":", "==", "«", "...."). Nas medições saíram umas 80 de 19 mil palavras, quase todas
// lixo; o resto, travessões de fotos ruins. Palavra com letra ou dígito nunca sai, nem com nota 0: no documento
// nítido com o filtro Documento, o CPF veio partido em duas palavras certas com nota 0, e nas fotos desfocadas
// vieram certos com nota 0 "R$", "500,00" e o número do protocolo.
const NOISE_CONFIDENCE = 50;
const isNoise = (word) => !/[\p{L}\p{N}§&%$@#]/u.test(word.text) && (word.confidence ?? 0) < NOISE_CONFIDENCE;

// Confiança baixa. Documento nítido (também com letra de 8 pt, pouca luz, bordas, furos, carimbo e assinaturas) tem
// média de 90 a 95; foto mediana (desfoque leve, JPEG ruim, verso aparecendo), de 83 a 90; desfocado, tremido, com
// pouca resolução, foto de tela e letra de mão ficam abaixo de 80, com 14% a 98% das palavras erradas. O limite
// fica no vão. A nota não mostra o que o Tesseract leu errado com certeza (riscos do scanner) nem o que ele pulou
// (sombra forte, página torta): aí a página passa sem aviso.
const LOW_MEAN = 82;
// Palavra com nota abaixo de 70: só 14% delas estavam certas (com 90 ou mais, 95%). Com mais de 20% do texto nelas,
// a página tem confiança baixa mesmo que a média não caia tanto (um trecho ruim numa página boa).
const WEAK_WORD = 70;
const WEAK_SHARE = 0.2;

/**
 * Qualidade do texto reconhecido numa página, pelas notas que o Tesseract dá a cada palavra (0 a 100).
 * @param {OcrWord[]} words
 * @returns {{mean: number, weak: number}} mean: média das notas, ponderada pelo número de caracteres de cada
 *   palavra; weak: fração dos caracteres em palavras com nota abaixo de 70. Sem palavras: 100 e 0.
 */
export function ocrQuality(words) {
  let total = 0;
  let sum = 0;
  let weak = 0;
  for (const { text, confidence } of words) {
    const size = [...text].length;
    total += size;
    sum += size * confidence;
    if (confidence < WEAK_WORD) weak += size;
  }
  return total ? { mean: sum / total, weak: weak / total } : { mean: 100, weak: 0 };
}

/** Página de confiança baixa: parte do texto pode ter saído errada (foto tremida, escura, deitada ou letra pequena). */
export function lowConfidence(words) {
  const { mean, weak } = ocrQuality(words);
  return mean < LOW_MEAN || weak > WEAK_SHARE;
}
