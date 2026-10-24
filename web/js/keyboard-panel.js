// Painel que abre de baixo e fica acima do teclado virtual. No iPhone, o teclado não encolhe a página: ele cobre a
// parte de baixo da tela, e o que está preso no fundo (position: fixed; bottom: 0) fica escondido atrás dele. O
// visualViewport diz quanto da tela sobrou: o painel sobe essa diferença e não passa da altura que sobrou.
// Usado pelo painel do texto (edit-text-tool.js); serve para o painel dos formulários.

/**
 * Quanto da tela, em px, o teclado virtual cobre embaixo (0 sem teclado ou sem visualViewport).
 * @param {number} innerHeight altura da janela (a viewport de layout)
 * @param {{height: number, offsetTop: number} | null | undefined} viewport window.visualViewport
 */
export function keyboardOverlap(innerHeight, viewport) {
  if (!viewport) return 0;
  return Math.max(0, Math.round(innerHeight - viewport.height - viewport.offsetTop));
}

/**
 * Mantém o elemento (preso no fundo da tela) acima do teclado e dentro do que sobrou da tela, enquanto ele estiver
 * aberto. Devolve a função que para de acompanhar.
 * @param {HTMLElement} element
 */
export function followKeyboard(element) {
  const viewport = window.visualViewport;
  const place = () => {
    element.style.bottom = `${keyboardOverlap(window.innerHeight, viewport)}px`;
    element.style.maxHeight = `${Math.max(120, Math.floor((viewport?.height ?? window.innerHeight) - 8))}px`;
  };
  place();
  viewport?.addEventListener('resize', place);
  viewport?.addEventListener('scroll', place);
  window.addEventListener('resize', place);
  return () => {
    viewport?.removeEventListener('resize', place);
    viewport?.removeEventListener('scroll', place);
    window.removeEventListener('resize', place);
    element.style.bottom = '';
    element.style.maxHeight = '';
  };
}
