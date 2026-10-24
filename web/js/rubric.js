// Rubrica em todas as páginas (#14), no painel de opções do PDF ("Em todas as páginas", all-pages.js). Desenhada uma
// vez num quadro próprio, com o desenho à mão do editor (prepareStroke e o tipo "ink"), e repetida em toda página de
// cada arquivo, no lugar (a grade de seis do carimbo) e no tamanho escolhidos. No PDF, vai como um Form XObject gravado
// uma vez e chamado em cada página (edit-media.js). Fica só na memória da aba: some ao limpar a lista (forgetMedia) ou
// ao fechar. O desenho à mão não tem caminho pelo teclado, como no editor.
import { addAllPagesOption, spotGrid } from './all-pages.js';
import { prepareStroke, paintEdits, boxAround, editType } from './edits.js';
import { rubricFromStrokes, rubricEdit, onForget, RUBRIC_SIZES } from './edit-media.js';

// Espessura do traço: proporcional à largura do quadro (uns 3 pixels no celular), para a mesma rubrica sair com a mesma
// espessura no PDF, feita no celular ou no computador (no tamanho médio, perto de 1 ponto).
const pen = (width) => Math.max(2, width * 0.009);
const COLORS = [['#1d4ed8', 'Azul'], ['#000000', 'Preto']];

let rubric = null; // a rubrica em uso (Rubric, em edit-media.js)
let nextId = 1;

// Cria um elemento. Chaves "aria-*", "data-*" e role viram atributos; o resto, propriedades.
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (/^(aria|data)-/.test(key) || key === 'role') node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

// Canvas na densidade da tela, com o contexto em pixels CSS.
function sized(canvas, width, height) {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

// ---------- Quadro para desenhar ----------

let pad = null; // {dialog, open()}, criado na primeira vez

function createPad() {
  const canvas = el('canvas', { className: 'rubric-pad', role: 'img', 'aria-label': 'Quadro para desenhar a rubrica' });
  const status = el('p', { className: 'sheet-status', role: 'status', 'aria-live': 'polite' });
  const colors = el('fieldset', { className: 'edit-prop edit-prop-swatch rubric-colors' }, [
    el('legend', { textContent: 'Cor' }),
    ...COLORS.map(([value, name], i) => {
      const sample = el('span', { className: 'edit-sample', 'aria-hidden': 'true' });
      sample.style.background = value;
      return el('label', { className: 'edit-option', title: name }, [
        el('input', { type: 'radio', name: 'rubric-color', value, checked: i === 0 }),
        sample, el('span', { className: 'sr-only', textContent: name }),
      ]);
    }),
  ]);
  const clear = el('button', { type: 'button', className: 'btn', textContent: 'Limpar' });
  const cancel = el('button', { type: 'button', className: 'btn', textContent: 'Cancelar' });
  const use = el('button', { type: 'button', className: 'btn btn-primary', textContent: 'Usar esta rubrica' });
  const dialog = el('dialog', { className: 'sheet rubric-dialog', 'aria-labelledby': 'rubric-title', 'aria-describedby': 'rubric-text' }, [
    el('h2', { id: 'rubric-title', textContent: 'Desenhe a rubrica' }),
    el('p', { id: 'rubric-text', textContent: 'Com o dedo, a caneta ou o mouse, dentro do quadro. Ela vai igual em todas as páginas e fica só na memória desta aba.' }),
    canvas, colors, status,
    el('div', { className: 'sheet-actions' }, [clear, cancel, use]),
  ]);
  document.body.append(dialog);

  let strokes = []; // traços prontos, de 0 a 1 no quadro
  let current = null; // o traço em andamento: {id, points}
  let penSeen = false; // com caneta, o dedo (a palma da mão) não desenha
  let size = { width: 1, height: 1 }; // o quadro, em pixels CSS
  let settle = null;
  const color = () => colors.querySelector('input:checked')?.value ?? COLORS[0][0];

  // Desenha tudo de novo: a linha de base (só de guia, não vai para o PDF) e os traços, lisos.
  function redraw() {
    size = { width: canvas.clientWidth || 300, height: canvas.clientHeight || 160 };
    const ctx = sized(canvas, size.width, size.height);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.strokeStyle = '#d0d5dd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(size.width * 0.08, size.height * 0.75);
    ctx.lineTo(size.width * 0.92, size.height * 0.75);
    ctx.stroke();
    if (strokes.length) {
      editType('ink').paint(ctx, { type: 'ink', strokes, color: color(), width: pen(size.width) }, { w: size.width, h: size.height });
    }
  }
  // O quadro mudou de tamanho (celular girado): desenha de novo no quadro seguinte, fora do aviso do ResizeObserver
  // (mudar o canvas ali dentro pode pedir outra medida no mesmo quadro).
  new ResizeObserver(() => { if (dialog.open) requestAnimationFrame(redraw); }).observe(canvas);

  const at = (event) => {
    const box = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))];
  };
  // Enquanto o dedo anda, o traço vai direto no canvas (rápido); ao soltar, ele é suavizado e desenhado de novo.
  function segment(from, to) {
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = color();
    ctx.lineWidth = pen(size.width);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from[0] * size.width, from[1] * size.height);
    ctx.lineTo(to[0] * size.width, to[1] * size.height);
    ctx.stroke();
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (current || event.button > 0) return;
    if (event.pointerType === 'pen') penSeen = true;
    if (event.pointerType === 'touch' && penSeen) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const point = at(event);
    current = { id: event.pointerId, points: [point] };
    segment(point, point);
    status.textContent = '';
  });
  canvas.addEventListener('pointermove', (event) => {
    if (current?.id !== event.pointerId) return;
    const events = event.getCoalescedEvents?.() ?? [];
    for (const each of events.length ? events : [event]) {
      const point = at(each);
      const last = current.points[current.points.length - 1];
      if (point[0] === last[0] && point[1] === last[1]) continue;
      current.points.push(point);
      segment(last, point);
    }
  });
  canvas.addEventListener('pointerup', (event) => {
    if (current?.id !== event.pointerId) return;
    current.points.push(at(event));
    strokes.push(prepareStroke(current.points, size));
    current = null;
    redraw();
  });
  // O navegador cancelou o toque: o traço em andamento sai.
  const drop = (event) => {
    if (current?.id !== event.pointerId) return;
    current = null;
    redraw();
  };
  canvas.addEventListener('pointercancel', drop);
  canvas.addEventListener('lostpointercapture', drop);

  colors.addEventListener('change', redraw);
  clear.addEventListener('click', () => {
    strokes = [];
    redraw();
    status.textContent = 'Quadro limpo.';
  });
  cancel.addEventListener('click', () => dialog.close());
  use.addEventListener('click', () => {
    if (!strokes.length) {
      status.dataset.kind = 'error';
      status.textContent = 'Desenhe a rubrica no quadro antes de usar.';
      return;
    }
    rubric = rubricFromStrokes(strokes, { color: color(), width: pen(size.width) }, size, nextId++);
    settle?.(true);
    dialog.close();
  });
  // Fechou sem usar (Cancelar ou Esc): o desenho do quadro sai da memória.
  dialog.addEventListener('close', () => {
    strokes = [];
    current = null;
    settle?.(false);
  });

  return {
    /** @returns {Promise<boolean>} true se a pessoa escolheu uma rubrica nova */
    open() {
      return new Promise((resolve) => {
        settle = (ok) => {
          settle = null;
          resolve(ok);
        };
        strokes = [];
        status.textContent = '';
        delete status.dataset.kind;
        dialog.showModal();
        redraw();
        clear.focus();
      });
    },
  };
}

// ---------- Opção "em todas as páginas" ----------

let controls = null; // {check, grid, select}, depois de build

addAllPagesOption({
  id: 'rubric',
  build(container, changed) {
    const check = el('input', { type: 'checkbox', id: 'rubric-on', 'aria-describedby': 'rubric-note' });
    const note = el('p', {
      id: 'rubric-note', className: 'field-note',
      textContent: 'Desenhada uma vez e repetida em toda página, no lugar escolhido, sem cobrir a numeração, o cabeçalho e o rodapé. Fica só na memória desta aba: some ao limpar a lista ou fechar.',
    });
    const sample = el('canvas', { className: 'rubric-sample', role: 'img', 'aria-label': 'Sua rubrica' });
    const draw = el('button', { type: 'button', className: 'btn', textContent: 'Desenhar de novo' });
    const grid = el('div', { className: 'stamp-grid' });
    spotGrid(grid, 'rubric-position');
    const select = el('select', { id: 'rubric-size' }, Object.entries(RUBRIC_SIZES).map(([value, { label }]) => (
      el('option', { value, textContent: label, selected: value === 'medium' }))));
    const options = el('div', { className: 'rubric-options', hidden: true }, [
      el('div', { className: 'rubric-drawn' }, [sample, draw]),
      el('div', { className: 'rubric-place' }, [
        el('fieldset', { className: 'stamp-positions' }, [el('legend', { textContent: 'Lugar na página' }), grid]),
        el('label', { className: 'field' }, [el('span', { textContent: 'Tamanho (o lado maior)' }), select]),
      ]),
    ]);
    container.append(el('label', { className: 'check' }, [check, ' Rubrica em todas as páginas']), note, options);
    controls = { check, grid, select };

    // A rubrica no quadrinho de amostra, inteira e centrada.
    function update() {
      options.hidden = !(check.checked && rubric);
      if (options.hidden) return;
      const width = 120;
      const height = 48;
      const ctx = sized(sample, width, height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      const scale = Math.min((width - 8) / rubric.w, (height - 8) / rubric.h);
      paintEdits(ctx, [{ type: 'rubric', ...boxAround(0.5, 0.5, [rubric.w * scale, rubric.h * scale], { width, height }), rubric }],
        { width, height });
    }
    const drawNew = async () => {
      pad ??= createPad();
      return pad.open();
    };

    check.addEventListener('change', async () => {
      if (check.checked && !rubric && !(await drawNew())) {
        check.checked = false;
        check.focus();
        return;
      }
      update();
      changed();
    });
    draw.addEventListener('click', async () => {
      if (await drawNew()) {
        update();
        changed();
      }
      draw.focus();
    });
    grid.addEventListener('change', changed);
    select.addEventListener('change', changed);
    // "Limpar tudo": a rubrica sai da memória junto com as páginas.
    onForget(() => {
      rubric = null;
      check.checked = false;
      update();
      changed();
    });
  },
  active: () => !!(rubric && controls?.check.checked),
  // placed: a numeração, o cabeçalho e o rodapé (montados antes, all-pages.js): a rubrica não cobre nenhum deles.
  produce({ size, placed }) {
    if (!rubric || !controls?.check.checked) return [];
    const spot = controls.grid.querySelector('input:checked')?.value ?? 'bottom-right';
    return [rubricEdit(rubric, spot, RUBRIC_SIZES[controls.select.value]?.side ?? RUBRIC_SIZES.medium.side, size, placed)];
  },
});
