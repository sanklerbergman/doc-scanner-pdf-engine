// Os tipos de edição (edits.js) que o app conhece: cada módulo registra os seus ao ser carregado. Quem monta o PDF ou
// desenha a prévia importa esta lista, para os tipos já estarem registrados. Tipo novo: um import a mais aqui.
import './edit-shapes.js'; // retângulo, seta, ✓, ✗ e desenho à mão (fase 1)
import './edit-text.js'; // texto, numeração, cabeçalho e rodapé (fase 2)
import './edit-marks.js'; // marca-texto, sublinhado, riscado e marca d'água (fase 3)
import './edit-media.js'; // imagem e rubrica (fase 4)
