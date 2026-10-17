// Reconhecimento de texto (OCR) das fotos, com o Tesseract (web/vendor/tesseract). Tudo no aparelho.
// Carregado só quando a pessoa liga "Texto pesquisável (OCR)": o motor e o modelo somam uns 5,5 MB.
//
// Segurança:
// - O worker nasce de um blob que importa o worker.min.js, então herda a política da página, incluindo o
//   connect-src 'none': ele não consegue abrir conexão nenhuma. O núcleo (.wasm.js) traz o WebAssembly embutido.
// - O modelo vem de um módulo JS do próprio site (por.traineddata.js) e chega ao worker em bytes: o Tesseract
//   nunca usa fetch. Se algum caminho dele tentar, a política bloqueia e o OCR falha, em vez de vazar.
// - Nada guardado: sem cache no IndexedDB (cacheMethod 'none'), sem logs, e o texto só existe na memória.
// - Um worker por vez (dois só onde sobra memória, ocr-plan.js), encerrado no fim: a memória do WebAssembly
//   (centenas de MB) volta para o aparelho.
//
// O app conversa direto com o worker do Tesseract.js, sem a biblioteca da página (tesseract.esm.min.js): na
// versão 7.0.0 ela manda os bytes do modelo no lugar do nome do idioma ao inicializar, e o Tesseract não inicia.
import { textSkew, unskew, unskewRect } from './geometry.js';

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

// Aquecimento: quando a pessoa liga o OCR, o modelo já começa a baixar, sem ligar o worker (que só liga ao gerar).
// Sem rede, a falha não fica guardada: tenta de novo ao gerar.
export function preloadOcr() {
  loadModel().catch(() => {});
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

// Um worker do Tesseract pronto para ler: o núcleo, o modelo de português e os parâmetros.
async function startEngine(base64, engine = spawn()) {
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
  return engine;
}

// Leituras de um worker antes de trocá-lo por um novo. No WebKit (Safari, iPhone), a memória do worker cresce uns
// 4 MB a cada página lida e só volta quando ele é encerrado (40 leituras: +130 MB; no Chromium, fica estável).
// Trocando a cada 10, a memória fica no nível das primeiras páginas, e o novo liga enquanto o app monta a página
// seguinte (custa uns 0,3 s a cada 10 páginas, medido no desktop).
const RECYCLE_AFTER = 10;

// Vários workers com a mesma cara de um só (call e stop): cada trabalho vai para o primeiro que estiver livre, e
// os outros esperam na fila, na ordem em que chegaram. O worker gasto (RECYCLE_AFTER) é encerrado antes de o novo
// ligar, nunca dois no lugar de um; e o novo já conta como vivo: se a leitura acabar enquanto ele liga, o stop o
// encerra na hora.
function pool(engines, restart) {
  const live = new Set(engines);
  const idle = [...engines];
  const queue = [];
  const reads = new Map();
  let stopped = null;
  const stop = (err) => {
    if (stopped) return;
    stopped = err;
    for (const engine of live) engine.stop(err);
    for (const waiting of queue.splice(0)) waiting.reject(err);
  };
  const release = (engine) => {
    const next = queue.shift();
    if (next) next.resolve(engine);
    else idle.push(engine);
  };
  // Se o novo não ligar, segue com os outros; sem nenhum, as leituras que esperam falham com o erro.
  const renew = async (engine) => {
    live.delete(engine);
    engine.stop(new OcrCancelled());
    const fresh = spawn();
    live.add(fresh);
    try {
      await restart(fresh);
      if (!stopped) release(fresh);
    } catch (err) {
      live.delete(fresh);
      if (!live.size) stop(err);
    }
  };
  return {
    async call(action, payload, transfer) {
      if (stopped) throw stopped;
      const engine = idle.pop() ?? await new Promise((resolve, reject) => queue.push({ resolve, reject }));
      try {
        return await engine.call(action, payload, transfer);
      } finally {
        const count = (reads.get(engine) ?? 0) + 1;
        reads.set(engine, count);
        if (stopped) {
          // encerrado: nada volta para a fila
        } else if (action === 'recognize' && count >= RECYCLE_AFTER) {
          reads.delete(engine);
          renew(engine);
        } else {
          release(engine);
        }
      }
    },
    stop,
  };
}

/**
 * Liga o motor de OCR com o modelo de português.
 * @param {{workers?: number}} [options] workers: quantos workers do Tesseract ligar (ocr-plan.js). Cada um tem a
 *   própria memória do WebAssembly; as leituras vão para o que estiver livre.
 * @returns {Promise<{recognize: (canvas: HTMLCanvasElement, options?: {dpi?: number}) => Promise<OcrWord[]>,
 *   cancel: () => void, terminate: () => void, workers: number}>}
 * O recognize lê os pixels do canvas na hora da chamada, antes de esperar o worker: quem chama pode liberar o
 * canvas (ou desenhar outra coisa nele) sem esperar o resultado.
 */
export async function startOcr({ workers = 1 } = {}) {
  const { default: base64 } = await loadModel().catch(() => {
    throw new OcrError('Não deu para carregar o reconhecimento de texto. Confira a conexão e tente de novo.');
  });
  // Um worker a mais que não ligou (falta de memória, por exemplo) não impede o OCR: segue com os que ligaram.
  const started = await Promise.allSettled(Array.from({ length: Math.max(1, workers) }, () => startEngine(base64)));
  const ready = started.filter(({ status }) => status === 'fulfilled').map(({ value }) => value);
  if (!ready.length) throw started[0].reason;
  const engine = pool(ready, (fresh) => startEngine(base64, fresh));
  return {
    workers: ready.length,
    // dpi: resolução da imagem na página do PDF. Sem ela, o Tesseract estima pela altura das letras.
    async recognize(canvas, { dpi } = {}) {
      const options = dpi ? { user_defined_dpi: String(Math.round(Math.min(2400, Math.max(70, dpi)))) } : {};
      return readLevel(canvas, (image, turn) => engine.call('recognize', {
        image, options: { ...options, ...turn }, output: { text: false, blocks: true },
      }, [image.buffer]));
    },
    cancel: () => engine.stop(new OcrCancelled()),
    terminate: () => engine.stop(new OcrCancelled()),
  };
}

// Página torta. Medido com o Tesseract do app (Chromium e WebKit), num documento nítido: girado 3°, sai de 42% a
// 64% do texto; de 5° a 12°, de 0 a 52% (com 5°, menos de 25%), quase sempre com nota alta, e o aviso de confiança
// baixa não pega. O app mede a inclinação antes (textSkew, uns 20 ms):
// - página reta (abaixo de 2,5°): lida como está, como antes. Com rotateAuto em toda página, o Tesseract endireitava
//   também a foto quase reta, e a leitura ficava uns 10% mais lenta e às vezes pior (foto difícil: de 92% para 63%);
// - torta: lida com rotateAuto, que mede o ângulo melhor que o app (numa foto difícil girada 3°: 99% contra 76%). Com
//   7° ou mais, às vezes ele não acha linha nenhuma e não endireita; aí vai de novo, com o ângulo do app, que leu
//   tudo até 15°;
// - sem linhas para medir (ruído, sombra, figura grande): rotateAuto, como reserva (nessas, girada 5°, ele leu de
//   1,4 a 3,5 vezes mais palavras).
// As palavras voltam medidas na imagem original (readWords).
async function readLevel(canvas, recognize) {
  const { width, height } = canvas;
  const read = async (image, turn) => {
    const result = await recognize(image, turn);
    return readWords(result?.blocks, width, height, result?.rotateRadians);
  };
  const image = toPgm(canvas);
  const angle = textSkew(image.subarray(image.length - width * height), width, height);
  if (angle === 0) return read(image, {});
  if (angle === null) return read(image, { rotateAuto: true });
  // Vai uma cópia da imagem: se precisar da segunda leitura, ela ainda está aqui (sem ler o canvas de novo).
  const words = await read(image.slice(), { rotateAuto: true });
  if (words.some((word) => word.angle)) return words;
  const again = await read(image, { rotateRadians: angle });
  return goodText(again) > goodText(words) ? again : words;
}

// Caracteres em palavras com nota boa: para escolher entre duas leituras da mesma página.
const goodText = (words) => words.reduce((sum, word) => sum + (word.confidence >= WEAK_WORD ? [...word.text].length : 0), 0);

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
 *   last: boolean, confidence: number, angle: number,
 *   straight?: {x0: number, y0: number, x1: number, y1: number, baseline: number}}} OcrWord
 * Medidas de 0 a 1, relativas à imagem (origem no canto superior esquerdo). baseline: altura da linha de base no
 * meio da palavra; size: altura da linha (tamanho da letra); last: última palavra da linha. angle: inclinação do
 * texto em radianos, no sentido anti-horário, 0 na página reta (geometry.js, unskew). Na página torta, x0 a y1 são
 * a caixa reta que envolve a palavra girada, e straight tem as medidas na imagem endireitada, ao longo da linha.
 */

// Palavras do resultado do Tesseract (blocos → parágrafos → linhas → palavras), em medidas relativas à imagem.
// angle: o giro que o Tesseract fez para endireitar a imagem antes de ler (as caixas vêm na imagem endireitada).
export function readWords(blocks, width, height, angle = 0) {
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
          const item = {
            text: word.text.trim(),
            x0: x0 / width, y0: y0 / height, x1: x1 / width, y1: y1 / height,
            baseline: Math.min(1, Math.max(0, baseline / height)),
            size: size / height,
            last: i === list.length - 1,
            confidence: word.confidence ?? 0,
            angle: 0,
          };
          words.push(angle ? tilted(item, angle, width, height) : item);
        });
      }
    }
  }
  return words;
}

const validBox = (box) => box && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) && box.x1 > box.x0 && box.y1 > box.y0;

// Palavra medida na imagem endireitada → na imagem original (a que vai para o PDF, ainda torta). A caixa vira a
// caixa reta que envolve a palavra girada: as tarjas tiram toda palavra que encosta nelas (filterWords), e com a
// caixa maior continua seguro. As medidas ao longo da linha ficam em straight, para a camada de texto e a busca.
function tilted(word, angle, width, height) {
  const [, baseline] = unskew(((word.x0 + word.x1) / 2) * width, word.baseline * height, angle, width, height);
  return {
    ...word,
    ...unskewRect(word, angle, { width, height }),
    baseline: Math.min(1, Math.max(0, baseline / height)),
    angle,
    straight: { x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1, baseline: word.baseline },
  };
}

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
