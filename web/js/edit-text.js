// Texto novo na página (edits.js): a pessoa escreve num painel (edit-text-tool.js) e a caixa vai para a página. Também é
// o texto de "em todas as páginas": numeração, cabeçalho e rodapé (all-pages-text.js). Código puro, sem DOM.
//
// Só as letras das fontes padrão do PDF (WinAnsi), que cobrem todo o português: o resto é avisado e não entra
// (winAnsiText). No PDF, Helvetica, Times ou Courier sem embutir; com o PDF/A, a Liberation embutida (characters), pelo
// caminho do carimbo. O texto vai em hexadecimal: nenhuma letra quebra o conteúdo da página.
//
// A caixa é do tamanho do texto: largura da linha mais comprida e altura das linhas, com uma folga de 0,2 da letra.
// O tamanho da letra sai da caixa, então mudar o tamanho pelas alças aumenta ou diminui a letra (a proporção fica
// travada); só quebra linha onde a pessoa quebrou.
import { registerEditType, editFrame, boxAround, pdfNumber } from './edits.js';
import { textWidth, winAnsiCode } from './fonts.js';
import { t } from './i18n.js';

/** As três famílias, com o nome que aparece na tela. */
export const TEXT_FAMILIES = { sans: t('Sem serifa'), serif: t('Com serifa'), mono: t('De máquina') };
const FONTS = { sans: 'Helvetica', serif: 'Times-Roman', mono: 'Courier' };
// Fontes do aparelho mais parecidas com as do PDF. A prévia usa as larguras do PDF (maxWidth): a diferença entre elas
// aparece só no desenho das letras, nunca no lugar delas.
const CSS_FAMILIES = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  'Times-Roman': '"Times New Roman", Times, "Liberation Serif", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", monospace',
};
/** Tamanhos de letra do painel, em pontos. */
export const TEXT_SIZES = [8, 10, 12, 14, 16, 20, 24, 32, 40, 48];
export const TEXT_MAX = 2000; // letras por caixa

const LINE = 1.25; // altura da linha, em relação ao tamanho da letra
const PAD = 0.2; // folga em volta do texto
const BASE = 0.95; // do alto da linha até a linha de base
const LETTER_TOP = 0.75; // altura das maiúsculas (a mesma conta das tarjas do Word, redact.js)
const LETTER_BOTTOM = 0.22; // abaixo da linha de base
const MIN_COVER = 0.2; // a tarja tira a letra quando cobre pelo menos 20% da altura dela (a conferência acusa 30%)

const COLOR = /^#[0-9a-f]{6}$/i;
const colorOf = (edit) => (COLOR.test(edit.color ?? '') ? edit.color : '#000000');
const rgb = (hex) => [1, 3, 5].map((i) => pdfNumber(parseInt(hex.slice(i, i + 2), 16) / 255, 3)).join(' ');
const hexString = (text) => `<${[...text].map((char) => winAnsiCode(char).toString(16).padStart(2, '0')).join('')}>`;
const n = (v) => pdfNumber(v, 2);

/** A fonte padrão do PDF da família (sem serifa, com serifa, de máquina). */
export const textFont = (family) => FONTS[family] ?? FONTS.sans;

/**
 * Só o que as fontes do PDF têm: quebra de linha fica, tabulação vira espaço, letra fora da WinAnsi sai e é contada.
 * Letras acentuadas compostas (a + acento, como o macOS cola) viram a letra acentuada antes.
 * @returns {{text: string, dropped: string[]}} dropped: as letras que ficaram de fora, uma de cada
 */
export function winAnsiText(text) {
  const dropped = new Set();
  let out = '';
  for (const char of String(text).normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ')) {
    if (char === '\n' || winAnsiCode(char) !== undefined) out += char;
    else if (!/[\u0000-\u001f\u007f-\u009f​-‏︀-️]/.test(char)) dropped.add(char);
  }
  return { text: out, dropped: [...dropped] };
}

/** O aviso das letras que ficaram de fora (winAnsiText), ou vazio. */
export function droppedMessage(dropped) {
  if (!dropped.length) return '';
  if (dropped.length === 1) return t('A letra {char} não existe nas fontes do PDF e ficou de fora.', { char: dropped[0] });
  const list = t('{a} e {b}', { a: dropped.slice(0, -1).join(' '), b: dropped.at(-1) });
  return t('As letras {list} não existem nas fontes do PDF e ficaram de fora.', { list });
}

// Linhas e largura da mais comprida, com a letra de tamanho 1.
function measure(text, font) {
  const lines = String(text ?? '').split('\n');
  return { lines, width: Math.max(0.5, ...lines.map((line) => textWidth(line, font, 1))) };
}

/**
 * Tamanho da caixa do texto, em pontos, com a letra de tamanho size.
 * @returns {[number, number]}
 */
export function textBox(text, family, size) {
  const { lines, width } = measure(text, textFont(family));
  return [size * (width + 2 * PAD), size * (lines.length * LINE + 2 * PAD)];
}

// Letra, linhas e tamanho da letra no quadro da edição (w × h em pontos): o maior que cabe na caixa.
function layout(edit, { w, h }) {
  const font = textFont(edit.family);
  const { lines, width } = measure(edit.text, font);
  const size = Math.min(h / (lines.length * LINE + 2 * PAD), w / (width + 2 * PAD));
  return { font, lines, size };
}

/** Tamanho da letra de uma edição de texto, em pontos, na página como aparece (em pontos). */
export function editTextSize(edit, page) {
  return layout(edit, editFrame(edit, page.width, page.height).size).size;
}

// Trechos visíveis de uma linha: sem as letras escondidas pela tarja (hidden, de redact), cada um no lugar dele.
function runs(line, index, hidden) {
  const out = [];
  let start = -1;
  [...line, null].forEach((char, k) => {
    const visible = char !== null && !hidden.has(`${index}:${k}`);
    if (visible && start < 0) start = k;
    if (!visible && start >= 0) {
      const text = line.slice(start, k);
      if (text.trim()) out.push({ start, text });
      start = -1;
    }
  });
  return out;
}

registerEditType('text', {
  label: t('Texto'), gender: 'm', keepRatio: true,
  describe(edit) {
    const first = String(edit.text ?? '').split('\n')[0];
    return t('Texto "{text}"', { text: first.length > 40 ? `${first.slice(0, 39)}…` : first });
  },
  // Na tela, como no PDF: sem as letras que a tarja tira (hidden), e o resto da linha no mesmo lugar.
  paint(ctx, edit, frame) {
    const { font, lines, size } = layout(edit, frame);
    const hidden = new Set((edit.hidden ?? []).map(([line, k]) => `${line}:${k}`));
    ctx.fillStyle = colorOf(edit);
    ctx.font = `${size}px ${CSS_FAMILIES[font]}`;
    ctx.textBaseline = 'alphabetic';
    lines.forEach((line, i) => {
      for (const run of hidden.size ? runs(line, i, hidden) : [{ start: 0, text: line }]) {
        const width = textWidth(run.text, font, size);
        const x = PAD * size + textWidth(line.slice(0, run.start), font, size);
        if (width > 0) ctx.fillText(run.text, x, (PAD + i * LINE + BASE) * size, width);
      }
    });
  },
  pdf(edit, frame, res) {
    const { font, lines, size } = layout(edit, frame);
    const hidden = new Set((edit.hidden ?? []).map(([line, k]) => `${line}:${k}`));
    const out = [];
    lines.forEach((line, i) => {
      for (const run of runs(line, i, hidden)) {
        const x = (PAD * size) + textWidth(line.slice(0, run.start), font, size);
        // Quadro com y para baixo: a matriz do texto desvira a letra.
        out.push(`1 0 0 -1 ${n(x)} ${n((PAD + i * LINE + BASE) * size)} Tm ${hexString(run.text)} Tj`);
      }
    });
    if (!out.length) return '';
    return [`BT ${res.font(font)} ${n(size)} Tf ${rgb(colorOf(edit))} rg`, ...out, 'ET'].join('\n');
  },
  // Só as letras que ficam: as escondidas pelas tarjas (hidden) não entram nem no subconjunto da fonte do PDF/A.
  characters(edit) {
    const hidden = new Set((edit.hidden ?? []).map(([line, k]) => `${line}:${k}`));
    const kept = String(edit.text ?? '').split('\n').map((line, i) => [...line].filter((_, k) => !hidden.has(`${i}:${k}`)).join(''));
    return new Map([[textFont(edit.family), kept.join('')]]);
  },
  // Letra sob a tarja sai do arquivo, como no Word (redact.js): o resto da linha fica no mesmo lugar.
  redact(edit, rects, page) {
    const { size: frame, matrix } = editFrame(edit, page.width, page.height);
    const { font, lines, size } = layout(edit, frame);
    const boxes = rects.map((r) => ({ x0: r.x0 * page.width, y0: r.y0 * page.height, x1: r.x1 * page.width, y1: r.y1 * page.height }));
    const at = ([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
    const hidden = [];
    let visible = 0;
    lines.forEach((line, i) => {
      const baseline = (PAD + i * LINE + BASE) * size;
      let x = PAD * size;
      [...line].forEach((char, k) => {
        const advance = textWidth(char, font, size);
        const a = at([x, baseline - LETTER_TOP * size]);
        const b = at([x + Math.max(advance, 0.02), baseline + LETTER_BOTTOM * size]);
        const letter = { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) };
        // Medidas na página como aparece: com o giro, a altura da letra pode estar na horizontal.
        const sideways = (edit.turn ?? 0) % 180 !== 0;
        const covered = boxes.some((box) => {
          const across = Math.min(letter.x1, box.x1) - Math.max(letter.x0, box.x0);
          const down = Math.min(letter.y1, box.y1) - Math.max(letter.y0, box.y0);
          const [along, tall, height] = sideways ? [down, across, letter.x1 - letter.x0] : [across, down, letter.y1 - letter.y0];
          return along > 0.01 && tall >= height * MIN_COVER;
        });
        if (covered) hidden.push([i, k]);
        else if (char.trim()) visible++;
        x += advance;
      });
    });
    if (!hidden.length) return [edit];
    return visible ? [{ ...edit, hidden }] : [];
  },
});

/**
 * Caixa de texto nova, com a letra de tamanho size, centrada em (cx, cy) e dentro da página. Texto largo demais para a
 * página fica com a letra menor, para caber.
 * @param {{text: string, family?: string, size: number, color?: string}} content
 * @param {{width: number, height: number}} page a página como aparece, em pontos
 */
export function textEdit({ text, family = 'sans', size, color = '#000000' }, [cx, cy], page, margin = 12) {
  const [w, h] = textBox(text, family, size);
  const fit = Math.min(1, (page.width - 2 * margin) / w, (page.height - 2 * margin) / h);
  return { type: 'text', ...boxAround(cx, cy, [w * fit, h * fit], page), text, family, color };
}

/**
 * A mesma caixa com outro texto, letra, tamanho ou cor: o canto de cima à esquerda e o giro ficam; se não couber,
 * ela anda para dentro da página (e, no limite, a letra diminui).
 */
export function retext(edit, { text, family = 'sans', size, color = '#000000' }, page) {
  const [w, h] = textBox(text, family, size);
  const sideways = (edit.turn ?? 0) % 180 !== 0;
  const bw = (sideways ? h : w) / page.width;
  const bh = (sideways ? w : h) / page.height;
  const fit = Math.min(1, 1 / bw, 1 / bh);
  const x0 = Math.max(0, Math.min(edit.x0, 1 - bw * fit));
  const y0 = Math.max(0, Math.min(edit.y0, 1 - bh * fit));
  return { ...edit, x0, y0, x1: x0 + bw * fit, y1: y0 + bh * fit, text, family, color };
}

// ---------- Em todas as páginas ----------

/** Formatos da numeração, com o exemplo que aparece na tela. */
export const NUMBER_FORMATS = {
  n: '1', 'n-of': t('{n} de {total}', { n: 1, total: 7 }), 'page-n-of': t('Página {n} de {total}', { n: 1, total: 7 }),
};

/** O número da página no formato escolhido. position e total contam dentro do arquivo. */
export function pageNumber(format, position, total) {
  if (format === 'n-of') return t('{n} de {total}', { n: position, total });
  if (format === 'page-n-of') return t('Página {n} de {total}', { n: position, total });
  return String(position);
}

const ALL_PAGES_SIZE = 10; // pontos
const ALL_PAGES_MARGIN = 24; // da borda, como o carimbo
const STACK = 2; // pontos entre textos que caem no mesmo lugar

/**
 * Numeração, cabeçalho e rodapé numa página: cada um num dos seis lugares (STAMP_POSITIONS, em stamp.js), a 24
 * pontos da borda. O que cai no mesmo lugar fica um sobre o outro: embaixo, o número fica mais perto da borda.
 * @param {{number?: {format: string, spot: string}, header?: {text: string, spot: string},
 *   footer?: {text: string, spot: string}}} settings o que estiver ligado
 * @param {{position: number, total: number, size: {width: number, height: number}}} context a posição e o total dentro
 *   do arquivo, e a página como aparece, em pontos
 * @returns {object[]} edições de texto
 */
export function allPagesText(settings, { position, total, size: page }) {
  const items = [];
  if (settings.header?.text?.trim()) items.push({ text: settings.header.text.trim(), spot: settings.header.spot });
  if (settings.footer?.text?.trim()) items.push({ text: settings.footer.text.trim(), spot: settings.footer.spot });
  if (settings.number) items.push({ text: pageNumber(settings.number.format, position, total), spot: settings.number.spot });
  const room = Math.max(10, page.width - 2 * ALL_PAGES_MARGIN);
  const offsets = new Map(); // lugar → pontos já ocupados, a partir da borda
  const ordered = [...items.filter(({ spot }) => spot.startsWith('top')), ...items.filter(({ spot }) => !spot.startsWith('top')).reverse()];
  return ordered.map(({ text, spot }) => {
    const [w, h] = textBox(text, 'sans', ALL_PAGES_SIZE);
    const fit = Math.min(1, room / w);
    const width = w * fit;
    const height = h * fit;
    const [row, column] = spot.split('-');
    const used = offsets.get(spot) ?? 0;
    offsets.set(spot, used + height + STACK);
    const u = column === 'left' ? ALL_PAGES_MARGIN : column === 'center' ? (page.width - width) / 2 : page.width - width - ALL_PAGES_MARGIN;
    const v = row === 'top' ? ALL_PAGES_MARGIN + used : page.height - ALL_PAGES_MARGIN - used - height;
    const x0 = Math.max(0, u / page.width);
    const y0 = Math.min(1 - height / page.height, Math.max(0, v / page.height));
    return { type: 'text', x0, y0, x1: Math.min(1, x0 + width / page.width), y1: y0 + height / page.height, text, family: 'sans', color: '#000000' };
  });
}
