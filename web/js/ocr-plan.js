// Plano do OCR: quantos motores ligar e quanto tempo falta. Funções puras, sem tela (test/ocr-plan.test.js).

/**
 * Quantos motores do Tesseract ligar. Cada um é um Worker com a própria memória do WebAssembly (centenas de MB),
 * então o segundo só liga onde o navegador diz que sobra memória e há núcleos livres, e se houver páginas
 * bastantes para compensar o tempo de ligar mais um. O Safari não informa a memória (deviceMemory): no iPhone,
 * continua um motor só, com a mesma memória de sempre.
 * @param {{deviceMemory?: number, hardwareConcurrency?: number}} device o navigator
 * @param {number} pages páginas para reconhecer
 */
export function ocrWorkers({ deviceMemory, hardwareConcurrency } = {}, pages) {
  return deviceMemory >= 8 && hardwareConcurrency >= 4 && pages >= 3 ? 2 : 1;
}

/**
 * Tempo que falta, pela média das páginas já lidas: o tempo desde o começo da leitura, dividido pelas páginas
 * prontas. Com dois motores, a média já sai pela metade. Sem nenhuma página pronta, não há estimativa.
 * @returns {number | null} milissegundos
 */
export function remainingTime(elapsed, done, total) {
  if (!(done > 0) || !(elapsed > 0) || !(total > done)) return null;
  return (elapsed / done) * (total - done);
}

// Estimativa para a mensagem de andamento, arredondada ao minuto, sem prometer precisão. Vazia sem estimativa.
export function remainingText(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 45000) return ' (falta menos de 1 minuto)';
  const minutes = Math.round(ms / 60000);
  return minutes <= 1 ? ' (falta mais ou menos 1 minuto)' : ` (faltam uns ${minutes} minutos)`;
}

// A partir de quantas páginas para ler o app avisa, logo no começo, que vai demorar. Medido no desktop: de 1 a 1,5 s
// por página; no celular, mais. Com 20, já passa de um minuto.
export const MANY_PAGES = 20;

/**
 * Complemento da mensagem "Reconhecendo o texto: página N de M…": o tempo que falta, depois da primeira página
 * lida; antes dela, com muitas páginas, o aviso de que pode demorar (ainda sem número: o tempo depende do aparelho).
 * @param {number} elapsed milissegundos desde o começo da leitura
 * @param {number} done páginas já lidas
 * @param {number} total páginas para ler
 */
export function progressNote(elapsed, done, total) {
  const left = remainingText(remainingTime(elapsed, done, total));
  if (left || done > 0 || total < MANY_PAGES) return left;
  return ` São ${total} páginas: pode levar alguns minutos.`;
}
