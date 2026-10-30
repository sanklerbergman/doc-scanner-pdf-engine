// Ferramentas da fase 3 no modo Editar (editor.js): Marca-texto, Sublinhar e Riscar. Os tipos de edição ficam em
// edit-marks.js. Carregado por loadTools (TOOL_MODULES), antes de a barra ser montada.
import { registerTool, registerProperty } from './editor.js';
import { lineFromDrag, MARK_TINTS, DEFAULT_TINT } from './edit-marks.js';
import { t } from './i18n.js';

// Cor do marca-texto: própria, separada da cor da caneta (sublinhado e riscado usam a da caneta).
registerProperty('tint', { label: t('Cor do marca-texto'), look: 'swatch', value: DEFAULT_TINT, options: MARK_TINTS });

registerTool({
  id: 'highlight', label: t('Marca-texto'), icon: 'highlight', type: 'highlight', pointer: 'box', keyboard: true, props: ['tint'],
  hint: t('Arraste sobre o texto para marcar: ele continua aparecendo por baixo da cor. Pelo teclado, use "Novo".'),
});

// Linha arrastada à mão, com a prévia enquanto o dedo anda. Um toque não cria nada.
const dragLine = (type, again) => (api, start) => {
  const make = (point) => lineFromDrag(type, start, point, api.props(), api.page);
  return {
    move: (point) => api.preview(make(point)),
    up(point) {
      const item = make(point);
      api.preview(null);
      if (item) api.add(item);
      else api.say(again);
    },
    cancel: () => api.preview(null),
  };
};

registerTool({
  id: 'underline', label: t('Sublinhar'), icon: 'underline', type: 'underline', keyboard: true, props: ['color', 'width'],
  pointer: dragLine('underline', t('Arraste por baixo do texto, da primeira à última letra, para sublinhar.')),
  hint: t('Arraste por baixo do texto, da primeira à última letra. Perto da horizontal, a linha fica reta. Pelo teclado, use "Novo".'),
});
registerTool({
  id: 'strike', label: t('Riscar'), icon: 'strike', type: 'strike', keyboard: true, props: ['color', 'width'],
  pointer: dragLine('strike', t('Arraste pelo meio do texto, da primeira à última letra, para riscar.')),
  hint: t('Arraste pelo meio do texto, da primeira à última letra. Perto da horizontal, a linha fica reta. Pelo teclado, use "Novo".'),
});
