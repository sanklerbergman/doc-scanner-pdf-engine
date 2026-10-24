// Edições da página: o que a pessoa acrescenta por cima dela (desenho à mão, retângulo, seta, ✓ e ✗; nas próximas
// fases, texto, marcações e imagem). No PDF, a edição vira parte do conteúdo da página (um stream a mais, com
// recursos de nomes novos), não anotação: quem recebe não tira, e todo leitor e impressora mostra.
//
// Cada edição é {type, x0, y0, x1, y1, turn?, ...}: a caixa, de 0 a 1 na página como ela aparece (com o giro), com a
// origem no canto superior esquerdo, como as tarjas (redact.js). Na foto, a página é a folha inteira, com a margem.
// turn (0, 90, 180 ou 270, no sentido horário): quanto o desenho está girado dentro da caixa; girar a página soma 90.
// O resto (cor, espessura, pontos) é de cada tipo. Nada sai da memória da aba.
// Código puro, sem DOM: o canvas da prévia chega pronto.
//
// Pontos de encaixe das próximas fases (texto e numeração, marcações e marca d'água, imagem e rubrica):
// - registerEditType: como o tipo se desenha na prévia (paint, num canvas 2D) e vira operadores do PDF (pdf). Os dois
//   desenham no quadro da edição de pé: origem no canto de cima à esquerda, y para baixo, em pontos (size.w × size.h).
//   No PDF, texto nesse quadro vai com "1 0 0 -1 x y Tm" (senão sai de cabeça para baixo); imagem, com
//   "w 0 0 -h x y+h cm". O tipo novo entra pela lista de edit-types.js.
// - resourceCollector: os recursos que o conteúdo usa (fonte, ExtGState, XObject) e o nome a pôr nele. Quem monta a
//   página (pdf.js; copyPages, em pdf-reader.js) grava os objetos, com nomes que a página ainda não usa.
// - editCharacters: letras por fonte, para as fontes embutidas do PDF/A (pdfa-fonts.js).
// - redactEdits: o que sai do arquivo sob as tarjas (o tipo com texto implementa redact).
// - fileExtras: "em todas as páginas" (all-pages.js), as edições a mais de cada página de cada arquivo gerado.

/**
 * @typedef {{type: string, x0: number, y0: number, x1: number, y1: number, turn?: number}} Edit
 * @typedef {{w: number, h: number}} Size medidas do quadro da edição de pé, em pontos
 *
 * @typedef {object} EditType
 * @property {string} label nome para a tela e o leitor de tela ("Retângulo")
 * @property {'m' | 'f'} gender para os avisos ("Retângulo criado", "Seta criada")
 * @property {(ctx: CanvasRenderingContext2D, edit: Edit, size: Size) => void} paint desenha na prévia, com o ctx já no
 *   quadro da edição
 * @property {(edit: Edit, size: Size, res: ReturnType<typeof resourceCollector>) => string} pdf operadores do PDF no
 *   mesmo quadro, só ASCII (cada edição já vai entre q e Q)
 * @property {[number, number]} [size] tamanho, em pontos, da edição criada pelo teclado ("Novo") ou por um toque
 * @property {boolean} [keepRatio] a proporção fica travada ao mudar o tamanho
 * @property {(edit: Edit) => string} [describe] o nome da edição para o leitor de tela, no lugar do label
 *   (o texto diz o que está escrito)
 * @property {(edit: Edit) => Map<string, string>} [characters] letras usadas, por fonte padrão do PDF
 * @property {(edit: Edit, rects: object[], page: {width: number, height: number}) => Edit[]} [redact] a edição sem o
 *   que fica sob as tarjas (rects, na página como aparece; page em pontos); sem isso, a edição inteira sob uma tarja
 *   sai, e a que só encosta fica, coberta
 */

const TYPES = new Map();

/**
 * Registra um tipo de edição.
 * @param {string} name o type das edições
 * @param {EditType} type
 */
export function registerEditType(name, type) {
  if (TYPES.has(name)) throw new Error(`Tipo de edição repetido: ${name}`);
  TYPES.set(name, type);
}

/** @returns {EditType | undefined} */
export const editType = (name) => TYPES.get(name);

// ---------- Modelo ----------

export const MIN_SIDE = 0.004; // lado mínimo da caixa, de 0 a 1 (menos que isso some na tela)
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const round = (v) => Math.round(v * 1e6) / 1e6; // de 0 a 1: seis casas bastam e a cópia não acumula ruído

/** Cópia profunda da lista (o editor guarda uma por passo do Desfazer). */
export const cloneEdits = (list) => structuredClone(list ?? []);

// Caixa com os cantos em ordem e dentro da página.
export function normalizeBox({ x0, y0, x1, y1 }) {
  return {
    x0: clamp01(Math.min(x0, x1)), y0: clamp01(Math.min(y0, y1)),
    x1: clamp01(Math.max(x0, x1)), y1: clamp01(Math.max(y0, y1)),
  };
}

// Pontos de 0 a 1 que giram junto com a página (ROTATE, em geometry.js), aqui para não depender do DOM.
const TURN = {
  0: ([x, y]) => [x, y],
  90: ([x, y]) => [1 - y, x],
  180: ([x, y]) => [1 - x, 1 - y],
  270: ([x, y]) => [y, 1 - x],
};

/**
 * Edições de uma página que acabou de girar `degrees` graus no sentido horário: a caixa vai junto com o conteúdo, e
 * o desenho dentro dela gira junto (turn).
 * @param {Edit[]} list
 * @param {number} degrees múltiplo de 90
 */
export function rotateEdits(list, degrees) {
  const turn = ((degrees % 360) + 360) % 360;
  const map = TURN[turn];
  return list.map((edit) => {
    const a = map([edit.x0, edit.y0]);
    const b = map([edit.x1, edit.y1]);
    return {
      ...edit, x0: round(Math.min(a[0], b[0])), y0: round(Math.min(a[1], b[1])),
      x1: round(Math.max(a[0], b[0])), y1: round(Math.max(a[1], b[1])), turn: ((edit.turn ?? 0) + turn) % 360,
    };
  });
}

/** Move a edição sem sair da página e sem mudar o tamanho. dx e dy de 0 a 1. */
export function moveEdit(edit, dx, dy) {
  const mx = Math.min(1 - edit.x1, Math.max(-edit.x0, dx));
  const my = Math.min(1 - edit.y1, Math.max(-edit.y0, dy));
  return { ...edit, x0: round(edit.x0 + mx), x1: round(edit.x1 + mx), y0: round(edit.y0 + my), y1: round(edit.y1 + my) };
}

/**
 * Muda o tamanho arrastando um canto (0 superior esquerdo, 1 superior direito, 2 inferior direito, 3 inferior
 * esquerdo) até (x, y); o canto oposto fica parado. O canto não passa do oposto nem sai da página. Com a proporção
 * travada (keepRatio), vale o lado que mais mudou.
 * @param {number} aspect largura ÷ altura da página, em pontos (a proporção é medida na página, não de 0 a 1)
 */
export function resizeEdit(edit, corner, x, y, aspect = 1) {
  const left = corner === 0 || corner === 3;
  const top = corner === 0 || corner === 1;
  const fx = left ? edit.x1 : edit.x0; // canto fixo
  const fy = top ? edit.y1 : edit.y0;
  let w = Math.max(MIN_SIDE, left ? fx - clamp01(x) : clamp01(x) - fx);
  let h = Math.max(MIN_SIDE, top ? fy - clamp01(y) : clamp01(y) - fy);
  if (editType(edit.type)?.keepRatio) {
    const ratio = ((edit.x1 - edit.x0) / (edit.y1 - edit.y0)) * aspect; // largura ÷ altura, em pontos
    if ((w * aspect) / ratio > h) h = (w * aspect) / ratio;
    else w = (h * ratio) / aspect;
    // Sem passar da borda: encolhe os dois lados juntos.
    const roomX = left ? fx : 1 - fx;
    const roomY = top ? fy : 1 - fy;
    const shrink = Math.min(1, roomX / w, roomY / h);
    w *= shrink;
    h *= shrink;
  }
  w = Math.min(w, left ? fx : 1 - fx);
  h = Math.min(h, top ? fy : 1 - fy);
  return {
    ...edit,
    x0: round(left ? fx - w : fx), x1: round(left ? fx : fx + w),
    y0: round(top ? fy - h : fy), y1: round(top ? fy : fy + h),
  };
}

/**
 * Muda o tamanho pelo teclado (Shift e setas): o canto de baixo à direita anda dx e dy, sem sair da página e sem
 * ficar menor que o mínimo. Com a proporção travada, os dois lados mudam juntos.
 */
export function growEdit(edit, dx, dy, aspect = 1) {
  if (editType(edit.type)?.keepRatio) {
    const w = edit.x1 - edit.x0;
    const h = edit.y1 - edit.y0;
    const factor = dx ? (w + dx) / w : (h + dy) / h;
    return resizeEdit(edit, 2, edit.x0 + w * factor, edit.y0 + h * factor, aspect);
  }
  return resizeEdit(edit, 2, edit.x1 + dx, edit.y1 + dy, aspect);
}

/** Cópia um pouco deslocada (para baixo e para a direita, ou para onde couber), dentro da página. */
export function duplicateEdit(edit, step = 0.03) {
  const dx = edit.x1 + step <= 1 ? step : -step;
  const dy = edit.y1 + step <= 1 ? step : -step;
  return moveEdit(structuredClone(edit), dx, dy);
}

/**
 * Caixa de 0 a 1 com o tamanho em pontos, centrada em (cx, cy) e dentro da página.
 * @param {{width: number, height: number}} page a página como aparece, em pontos
 */
export function boxAround(cx, cy, [w, h], page) {
  const bw = Math.min(1, w / page.width);
  const bh = Math.min(1, h / page.height);
  const x0 = Math.min(1 - bw, Math.max(0, cx - bw / 2));
  const y0 = Math.min(1 - bh, Math.max(0, cy - bh / 2));
  return { x0: round(x0), y0: round(y0), x1: round(x0 + bw), y1: round(y0 + bh) };
}

// ---------- Matrizes ----------
// [a b c d e f], como o cm do PDF e o setTransform do canvas: x' = a·x + c·y + e, y' = b·x + d·y + f.

/** m depois de n: o ponto passa primeiro por n. */
export const multiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

/**
 * Quadro da edição de pé → página como aparece (em pontos, y para baixo).
 * @param {Edit} edit
 * @param {number} width largura da página como aparece, em pontos
 * @param {number} height
 * @returns {{size: Size, matrix: number[]}}
 */
export function editFrame(edit, width, height) {
  const u = edit.x0 * width;
  const v = edit.y0 * height;
  const bw = (edit.x1 - edit.x0) * width;
  const bh = (edit.y1 - edit.y0) * height;
  const turn = ((edit.turn ?? 0) % 360 + 360) % 360;
  const sideways = turn % 180 !== 0;
  const matrix = {
    0: [1, 0, 0, 1, u, v],
    90: [0, 1, -1, 0, u + bw, v],
    180: [-1, 0, 0, -1, u + bw, v + bh],
    270: [0, -1, 1, 0, u, v + bh],
  }[turn];
  return { size: { w: sideways ? bh : bw, h: sideways ? bw : bh }, matrix };
}

/**
 * Página como aparece (em pontos, y para baixo) → coordenadas do PDF. A mesma conta de visibleToPdf (geometry.js),
 * como matriz.
 * @param {number[]} box a área visível [x1 y1 x2 y2] (CropBox ou MediaBox)
 * @param {number} rotate 0, 90, 180 ou 270 (/Rotate)
 */
export function pageMatrix([x1, y1, x2, y2], rotate) {
  return {
    0: [1, 0, 0, -1, x1, y2],
    90: [0, 1, 1, 0, x1, y1],
    180: [-1, 0, 0, 1, x2, y1],
    270: [0, -1, -1, 0, x2, y2],
  }[rotate] ?? [1, 0, 0, -1, x1, y2];
}

// ---------- Recursos ----------

/** Referência a um objeto do coletor (object), para pôr dentro de um dict. */
export class ObjectRef {
  constructor(key) { this.key = key; }
}

/**
 * Coletor dos recursos que o conteúdo das edições de uma página usa. Cada pedido devolve o nome para o conteúdo
 * (/Ed1, /Ed2…), sempre um que a página ainda não usa (taken); o mesmo pedido devolve o mesmo nome.
 * - font(base): fonte padrão do PDF (Helvetica, Times-Roman…), com WinAnsi. Com o PDF/A, quem monta embute.
 * - extGState(params): estado gráfico, como {ca: 0.3, CA: 0.3, BM: 'Multiply'}.
 * - xObject(key, {dict, data}): imagem ou formulário (Form XObject). key identifica o objeto: a mesma key em várias
 *   páginas vai uma vez só para o arquivo (a rubrica repetida). data: os bytes do stream.
 * - object(key, {dict, data?}): objeto sem nome nos recursos (a máscara /SMask de uma imagem); devolve um ObjectRef
 *   para pôr num dict.
 * Nos dicts: número vira número, texto vira nome (/DeviceRGB), lista vira lista, objeto vira dicionário.
 * @param {Iterable<string>} [taken] nomes que a página já usa nos recursos
 */
export function resourceCollector(taken = []) {
  const used = new Set(taken);
  let next = 1;
  const fresh = () => {
    let name;
    do name = `Ed${next++}`; while (used.has(name));
    used.add(name);
    return name;
  };
  const fonts = new Map(); // nome → fonte padrão
  const states = new Map(); // nome → parâmetros
  const xobjects = new Map(); // nome → {key, dict, data}
  const objects = new Map(); // key → {dict, data}
  const names = new Map(); // pedido → nome
  const once = (id, make) => {
    if (!names.has(id)) names.set(id, make());
    return `/${names.get(id)}`;
  };
  return {
    fonts, states, xobjects, objects,
    font(base) {
      return once(`font:${base}`, () => {
        const name = fresh();
        fonts.set(name, base);
        return name;
      });
    },
    extGState(params) {
      return once(`state:${JSON.stringify(params)}`, () => {
        const name = fresh();
        states.set(name, params);
        return name;
      });
    },
    xObject(key, body) {
      if (!names.has(key)) {
        const name = fresh();
        xobjects.set(name, { key, ...body });
        names.set(key, name);
      }
      return `/${names.get(key)}`;
    },
    object(key, body) {
      if (!objects.has(key)) objects.set(key, body);
      return new ObjectRef(key);
    },
    get empty() {
      return !fonts.size && !states.size && !xobjects.size;
    },
  };
}

// Número em PDF, sem notação exponencial.
export const pdfNumber = (v, places = 4) => String(Math.round(v * 10 ** places) / 10 ** places || 0);

/**
 * Valor de um dict do coletor em texto do PDF. ObjectRef vira a referência que refOf devolve ("12 0 R").
 * @param {(key: unknown) => string} refOf
 */
export function pdfValue(value, refOf) {
  if (typeof value === 'number') return pdfNumber(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    if (!/^[A-Za-z0-9.+-]+$/.test(value)) throw new Error(`Nome inválido nos recursos da edição: ${value}`);
    return `/${value}`;
  }
  if (value instanceof ObjectRef) return refOf(value.key);
  if (Array.isArray(value)) return `[${value.map((item) => pdfValue(item, refOf)).join(' ')}]`;
  if (value && typeof value === 'object') {
    return `<<${Object.entries(value).map(([key, item]) => ` ${pdfValue(key, refOf)} ${pdfValue(item, refOf)}`).join('')} >>`;
  }
  throw new Error('Valor inválido nos recursos da edição');
}

// ---------- Conteúdo ----------

/**
 * Edições que vão para o arquivo, com as tarjas (na página como aparece): o tipo que sabe tirar o que fica sob elas
 * (redact) tira; dos outros, sai a edição inteira sob uma tarja, e a que só encosta fica (a tarja vai por cima).
 * @param {Edit[]} edits
 * @param {Array<{x0: number, y0: number, x1: number, y1: number}>} rects
 * @param {{width: number, height: number}} [page] a página como aparece, em pontos (para o tipo medir as letras)
 */
export function redactEdits(edits, rects, page) {
  if (!rects?.length) return edits ?? [];
  return (edits ?? []).flatMap((edit) => {
    const type = editType(edit.type);
    if (type?.redact && page) return type.redact(edit, rects, page);
    if (rects.some((r) => covers(r, edit))) return [];
    // Tipo que não sabe tirar o que fica sob a tarja e é pego só em parte: nada sai (a tarja nunca só cobre).
    if (rects.some((r) => overlaps(r, edit))) throw new Error(`A edição (${edit.type}) sob a tarja não pôde ser apagada`);
    return [edit];
  });
}

const covers = (r, edit) => edit.x0 >= r.x0 && edit.y0 >= r.y0 && edit.x1 <= r.x1 && edit.y1 <= r.y1;
const overlaps = (r, edit) => r.x0 < edit.x1 && r.x1 > edit.x0 && r.y0 < edit.y1 && r.y1 > edit.y0;

// ---------- Corte pelas tarjas ----------
// A tarja apaga, não só cobre: da edição que ela pega em parte (desenho, forma, marcação, rubrica) sai o pedaço do
// desenho que fica dentro dela. O tipo põe redact: cutRedact, que leva as tarjas para o quadro da edição (cuts), e corta
// os caminhos com cutPath antes de escrever os operadores. As curvas viram linhas retas (achatadas com erro de 0,1
// ponto), e o corte fica um pouco para fora da borda da tarja (EDGE): nenhum ponto do caminho fica dentro dela, nem
// depois do arredondamento do PDF. A prévia não muda: lá a tarja é pintada por cima, e o que se vê é o mesmo.

const FLAT = 0.1; // erro máximo, em pontos, ao achatar as curvas
const EDGE = 0.02; // folga, em pontos, entre o corte e a borda da tarja

const invert = ([a, b, c, d, e, f]) => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
const transform = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * As tarjas (de 0 a 1 na página como aparece) no quadro da edição de pé, em pontos: [x0, y0, x1, y1]. O giro é de 90 em
 * 90 graus, então a tarja continua um retângulo reto no quadro.
 * @param {{width: number, height: number}} page em pontos
 */
export function frameRects(edit, rects, page) {
  const back = invert(editFrame(edit, page.width, page.height).matrix);
  return rects.map((r) => {
    const [ax, ay] = transform(back, [r.x0 * page.width, r.y0 * page.height]);
    const [bx, by] = transform(back, [r.x1 * page.width, r.y1 * page.height]);
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  });
}

/**
 * redact dos tipos feitos de caminhos: a edição inteira sob uma tarja sai; a pega em parte leva as tarjas no quadro
 * dela (cuts), e o tipo corta os caminhos (cutPath); a que a tarja não pega fica como está.
 */
export function cutRedact(edit, rects, page) {
  const hit = rects.filter((r) => overlaps(r, edit));
  if (!hit.length) return [edit];
  if (hit.some((r) => covers(r, edit))) return [];
  return [{ ...edit, cuts: frameRects(edit, hit, page) }];
}

// Subcaminhos do caminho, com as curvas achatadas: [{points, closed}].
function flatten(path) {
  const out = [];
  let current = null;
  let at = [0, 0];
  let start = [0, 0];
  const steps = (deviation) => Math.max(1, Math.min(200, Math.ceil(Math.sqrt(deviation / FLAT))));
  const lineTo = (point) => {
    if (!current) out.push((current = { points: [at], closed: false }));
    current.points.push(point);
    at = point;
  };
  for (const [op, ...v] of path) {
    if (op === 'M') {
      out.push((current = { points: [[v[0], v[1]]], closed: false }));
      at = start = [v[0], v[1]];
    } else if (op === 'L') lineTo([v[0], v[1]]);
    else if (op === 'Q') {
      const [p0, c, p1] = [at, [v[0], v[1]], [v[2], v[3]]];
      const n = steps(Math.hypot(p0[0] - 2 * c[0] + p1[0], p0[1] - 2 * c[1] + p1[1]) / 4);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const s = 1 - t;
        lineTo([s * s * p0[0] + 2 * s * t * c[0] + t * t * p1[0], s * s * p0[1] + 2 * s * t * c[1] + t * t * p1[1]]);
      }
    } else if (op === 'C') {
      const [p0, c1, c2, p1] = [at, [v[0], v[1]], [v[2], v[3]], [v[4], v[5]]];
      const d1 = Math.hypot(p0[0] - 2 * c1[0] + c2[0], p0[1] - 2 * c1[1] + c2[1]);
      const d2 = Math.hypot(c1[0] - 2 * c2[0] + p1[0], c1[1] - 2 * c2[1] + p1[1]);
      const n = steps(0.75 * Math.max(d1, d2));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const s = 1 - t;
        lineTo([0, 1].map((k) => s * s * s * p0[k] + 3 * s * s * t * c1[k] + 3 * s * t * t * c2[k] + t * t * t * p1[k]));
      }
    } else if (op === 'Z' && current) {
      current.closed = true;
      current = null;
      at = start;
    }
  }
  return out;
}

// Trecho do segmento p→q dentro do retângulo aberto (Liang-Barsky): [t0, t1], ou null.
function inside(p, q, [x0, y0, x1, y1]) {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  for (const [pk, qk] of [[-dx, p[0] - x0], [dx, x1 - p[0]], [-dy, p[1] - y0], [dy, y1 - p[1]]]) {
    if (pk === 0) {
      if (qk <= 0) return null;
    } else if (pk < 0) t0 = Math.max(t0, qk / pk);
    else t1 = Math.min(t1, qk / pk);
  }
  return t0 < t1 ? [t0, t1] : null;
}

// Traço: os pedaços da linha que ficam fora de todas as tarjas.
function cutStroke({ points, closed }, rects) {
  const line = closed ? [...points, points[0]] : points;
  const pieces = [];
  let open = null; // o pedaço que continua no próximo segmento
  let removed = false;
  for (let i = 0; i < line.length - 1; i++) {
    const p = line[i];
    const q = line[i + 1];
    const gone = rects.map((rect) => inside(p, q, rect)).filter(Boolean).sort((a, b) => a[0] - b[0]);
    if (gone.length) removed = true;
    const kept = [];
    let from = 0;
    for (const [a, b] of gone) {
      if (a > from) kept.push([from, a]);
      from = Math.max(from, b);
    }
    if (from < 1) kept.push([from, 1]);
    const at = (t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    let next = null;
    for (const [a, b] of kept) {
      if (open && a === 0) open.push(at(b));
      else pieces.push((open = [at(a), at(b)]));
      next = b === 1 ? open : null;
      open = next;
    }
    open = next;
  }
  if (!removed) return [{ points, closed }];
  return pieces.filter((piece) => piece.length > 1).map((piece) => ({ points: piece, closed: false }));
}

// Polígono cortado por um semiplano: eixo (0 = x, 1 = y), limite e o lado que fica (-1: menor, 1: maior).
function clip(polygon, axis, limit, side) {
  const out = [];
  polygon.forEach((p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    const pIn = (p[axis] - limit) * side >= 0;
    const qIn = (q[axis] - limit) * side >= 0;
    if (pIn) out.push(p);
    if (pIn !== qIn) {
      const t = (limit - p[axis]) / (q[axis] - p[axis]);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  });
  return out;
}

// Área cheia menos o retângulo: as partes do polígono nas quatro faixas de fora dele.
function subtract(polygon, [x0, y0, x1, y1]) {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  if (Math.max(...xs) <= x0 || Math.min(...xs) >= x1 || Math.max(...ys) <= y0 || Math.min(...ys) >= y1) return [polygon];
  const middle = clip(clip(polygon, 0, x0, 1), 0, x1, -1);
  return [clip(polygon, 0, x0, -1), clip(polygon, 0, x1, 1), clip(middle, 1, y0, -1), clip(middle, 1, y1, 1)]
    .filter((part) => part.length > 2);
}

/**
 * O caminho sem o que fica dentro das tarjas (cuts, no mesmo quadro, de cutRedact). Sem tarja, o mesmo caminho.
 * @param {Array<Array<string | number>>} path comandos M, L, Q, C e Z
 * @param {number[][] | undefined} cuts [x0, y0, x1, y1] de cada tarja
 * @param {{fill?: boolean}} [options] fill: área cheia (cortada em polígonos); sem isso, traço (cortado em pedaços)
 * @returns {Array<Array<string | number>>} vazio quando nada fica de fora
 */
export function cutPath(path, cuts, { fill = false } = {}) {
  if (!cuts?.length) return path;
  const rects = cuts.map(([x0, y0, x1, y1]) => [x0 - EDGE, y0 - EDGE, x1 + EDGE, y1 + EDGE]);
  const parts = flatten(path).flatMap((sub) => {
    if (!fill) return cutStroke(sub, rects);
    let polygons = [sub.points];
    for (const rect of rects) polygons = polygons.flatMap((polygon) => subtract(polygon, rect));
    return polygons.map((points) => ({ points, closed: true }));
  });
  return parts.flatMap(({ points, closed }) => [
    ['M', ...points[0]], ...points.slice(1).map((point) => ['L', ...point]), ...(closed ? [['Z']] : []),
  ]);
}

/**
 * Operadores do PDF das edições de uma página, por cima do que já está nela. Só ASCII.
 * @param {Edit[]} edits
 * @param {{box: number[], rotate?: number, unit?: number}} frame a área visível [x1 y1 x2 y2], o /Rotate e o
 *   /UserUnit da página
 * @param {ReturnType<typeof resourceCollector>} res
 * @returns {string} vazio sem edição
 */
export function editsContent(edits, { box, rotate = 0, unit = 1 }, res) {
  const [x1, y1, x2, y2] = box;
  const sideways = rotate % 180 !== 0;
  const width = (sideways ? y2 - y1 : x2 - x1) * unit;
  const height = (sideways ? x2 - x1 : y2 - y1) * unit;
  const page = multiply(pageMatrix(box, rotate), [1 / unit, 0, 0, 1 / unit, 0, 0]);
  const out = [];
  for (const edit of edits ?? []) {
    const type = editType(edit.type);
    if (!type) throw new Error(`Tipo de edição desconhecido: ${edit.type}`);
    const { size, matrix } = editFrame(edit, width, height);
    if (!(size.w > 0 && size.h > 0)) continue;
    const ops = type.pdf(edit, size, res);
    if (!ops) continue;
    if (/[^\n\x20-\x7e]/.test(ops)) throw new Error(`Conteúdo da edição (${edit.type}) fora do ASCII`);
    out.push(`q ${multiply(page, matrix).map((v) => pdfNumber(v)).join(' ')} cm\n${ops}\nQ`);
  }
  return out.join('\n');
}

/**
 * Pinta as edições num canvas 2D que mostra a página como ela aparece.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Edit[]} edits
 * @param {{width: number, height: number}} page a página como aparece, em pontos (a espessura dos traços)
 * @param {{x: number, y: number, width: number, height: number}} [area] onde a página fica no canvas, em pixels
 *   (o canvas inteiro, se faltar)
 */
export function paintEdits(ctx, edits, page, area = { x: 0, y: 0, width: ctx.canvas.width, height: ctx.canvas.height }) {
  if (!edits?.length) return;
  const scale = [area.width / page.width, 0, 0, area.height / page.height, area.x, area.y];
  for (const edit of edits) {
    const type = editType(edit.type);
    if (!type) continue;
    const { size, matrix } = editFrame(edit, page.width, page.height);
    if (!(size.w > 0 && size.h > 0)) continue;
    ctx.save();
    ctx.setTransform(...multiply(scale, matrix));
    type.paint(ctx, edit, size);
    ctx.restore();
  }
}

/**
 * Letras usadas pelas edições, por fonte padrão (para o subconjunto das fontes embutidas do PDF/A).
 * @returns {Map<string, string>}
 */
export function editCharacters(edits) {
  const out = new Map();
  for (const edit of edits ?? []) {
    for (const [font, text] of editType(edit.type)?.characters?.(edit) ?? []) out.set(font, (out.get(font) ?? '') + text);
  }
  return out;
}

// ---------- Caminhos ----------
// Lista de comandos ['M', x, y], ['L', x, y], ['Q', cx, cy, x, y], ['C', c1x, c1y, c2x, c2y, x, y] e ['Z'], no
// quadro da edição (em pontos, y para baixo). O mesmo caminho vai para o canvas e para o PDF.

/** Desenha o caminho no canvas (sem pintar: quem chama faz o stroke ou o fill). */
export function tracePath(ctx, path) {
  ctx.beginPath();
  for (const [op, ...v] of path) {
    if (op === 'M') ctx.moveTo(...v);
    else if (op === 'L') ctx.lineTo(...v);
    else if (op === 'Q') ctx.quadraticCurveTo(...v);
    else if (op === 'C') ctx.bezierCurveTo(...v);
    else if (op === 'Z') ctx.closePath();
  }
}

/** O caminho em operadores do PDF (a curva quadrática vira cúbica, que é a que o PDF tem). */
export function pathOps(path) {
  const n = (v) => pdfNumber(v, 2);
  const out = [];
  let at = [0, 0];
  let start = [0, 0];
  for (const [op, ...v] of path) {
    if (op === 'M') {
      out.push(`${n(v[0])} ${n(v[1])} m`);
      at = start = [v[0], v[1]];
    } else if (op === 'L') {
      out.push(`${n(v[0])} ${n(v[1])} l`);
      at = [v[0], v[1]];
    } else if (op === 'Q') {
      const [cx, cy, x, y] = v;
      const c1 = [at[0] + (2 / 3) * (cx - at[0]), at[1] + (2 / 3) * (cy - at[1])];
      const c2 = [x + (2 / 3) * (cx - x), y + (2 / 3) * (cy - y)];
      out.push(`${n(c1[0])} ${n(c1[1])} ${n(c2[0])} ${n(c2[1])} ${n(x)} ${n(y)} c`);
      at = [x, y];
    } else if (op === 'C') {
      out.push(`${v.map(n).join(' ')} c`);
      at = [v[4], v[5]];
    } else if (op === 'Z') {
      out.push('h');
      at = start;
    }
  }
  return out.join(' ');
}

/** Círculo (quatro curvas), para o ponto do desenho à mão: igual no canvas e em qualquer leitor de PDF. */
export function circlePath(x, y, r) {
  const k = 0.5523 * r;
  return [
    ['M', x + r, y], ['C', x + r, y + k, x + k, y + r, x, y + r], ['C', x - k, y + r, x - r, y + k, x - r, y],
    ['C', x - r, y - k, x - k, y - r, x, y - r], ['C', x + k, y - r, x + r, y - k, x + r, y], ['Z'],
  ];
}

// ---------- Traço à mão ----------
// O dedo e a caneta mandam pontos com tremidas de um pixel: o traço é suavizado (média com os vizinhos), simplificado
// (Ramer-Douglas-Peucker: fica só o ponto que muda o desenho) e desenhado com curvas que passam pelo meio de cada
// trecho. Fica liso na tela e no PDF, e leve na memória do celular.

/**
 * Média de cada ponto com os vizinhos (1/4, 1/2, 1/4), sem mexer nas pontas.
 * @param {number[][]} points
 */
export function smoothStroke(points, passes = 1) {
  let out = points;
  for (let pass = 0; pass < passes && out.length > 2; pass++) {
    const prev = out;
    out = prev.map((p, i) => (i === 0 || i === prev.length - 1 ? p
      : [(prev[i - 1][0] + 2 * p[0] + prev[i + 1][0]) / 4, (prev[i - 1][1] + 2 * p[1] + prev[i + 1][1]) / 4]));
  }
  return out;
}

// Distância do ponto p ao segmento a-b.
function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * Ramer-Douglas-Peucker: fica o menor conjunto de pontos que passa a menos de `tolerance` de todos os outros. As
 * pontas ficam sempre. Sem recursão (traço comprido não estoura a pilha).
 * @param {number[][]} points
 * @param {number} tolerance na mesma unidade dos pontos
 */
export function simplifyStroke(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let worst = -1;
    let index = 0;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(points[i], points[first], points[last]);
      if (d > worst) [worst, index] = [d, i];
    }
    if (worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Caminho liso por pontos: curvas que passam pelo meio de cada trecho, do primeiro ao último ponto.
 * @param {number[][]} points pelo menos dois
 */
export function strokePath(points) {
  const path = [['M', ...points[0]]];
  if (points.length === 2) return [...path, ['L', ...points[1]]];
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    path.push(i === points.length - 2 ? ['Q', x, y, nx, ny] : ['Q', x, y, (x + nx) / 2, (y + ny) / 2]);
  }
  return path;
}

/**
 * Traço pronto: pontos de 0 a 1 na página → suavizados e simplificados, medidos em pontos da página.
 * @param {number[][]} points de 0 a 1, na página como aparece
 * @param {{width: number, height: number}} page em pontos
 * @param {number} [tolerance] em pontos: menos que meio pixel de uma tela de celular de alta densidade
 * @returns {number[][]} de 0 a 1
 */
export function prepareStroke(points, page, tolerance = 0.35) {
  // Pontos colados no anterior (a caneta manda até 240 por segundo) saem antes: a simplificação fica rápida.
  const inPoints = [];
  points.forEach(([x, y], i) => {
    const point = [x * page.width, y * page.height];
    const last = inPoints[inPoints.length - 1];
    if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < tolerance / 2) {
      // A ponta final fica sempre, no lugar do ponto colado nela (um toque continua um ponto só).
      if (i === points.length - 1 && inPoints.length > 1) inPoints[inPoints.length - 1] = point;
      return;
    }
    inPoints.push(point);
  });
  const simple = simplifyStroke(smoothStroke(inPoints, 2), tolerance);
  return simple.map(([x, y]) => [clamp01(x / page.width), clamp01(y / page.height)]);
}

// ---------- Em todas as páginas ----------

/**
 * Edições a mais de cada página de cada arquivo gerado ("em todas as páginas", all-pages.js). A posição e o total
 * contam dentro do arquivo: com "um PDF por página" ou por intervalos, cada arquivo começa do 1 (decisão do dono,
 * 2026-10-24).
 * @param {number[][]} groups as posições da lista em cada arquivo
 * @param {(context: {position: number, total: number, file: number, files: number, index: number}) => Edit[]} produce
 *   index: a posição da página na lista
 * @returns {Edit[][][]} por arquivo e por página do arquivo
 */
export function fileExtras(groups, produce) {
  return groups.map((group, g) => group.map((index, p) => produce({
    position: p + 1, total: group.length, file: g + 1, files: groups.length, index,
  }) ?? []));
}

/**
 * Caixa de 0 a 1 num dos seis lugares da grade (STAMP_POSITIONS, em stamp.js: em cima ou embaixo, à esquerda, no
 * centro ou à direita), a `margin` pontos da borda, como o carimbo da assinatura.
 * @param {string} spot 'top-left', 'bottom-center'…
 * @param {[number, number]} size em pontos
 * @param {{width: number, height: number}} page a página como aparece, em pontos
 */
export function spotBox(spot, [w, h], page, margin = 24) {
  const [row, column] = spot.split('-');
  const bw = Math.min(w, page.width);
  const bh = Math.min(h, page.height);
  const mx = Math.max(0, Math.min(margin, (page.width - bw) / 2));
  const my = Math.max(0, Math.min(margin, (page.height - bh) / 2));
  const u = column === 'left' ? mx : column === 'center' ? (page.width - bw) / 2 : page.width - bw - mx;
  const v = row === 'top' ? my : page.height - bh - my;
  return { x0: round(u / page.width), y0: round(v / page.height), x1: round((u + bw) / page.width), y1: round((v + bh) / page.height) };
}
