// Controles da interface (#33), com a anatomia dos componentes do shadcn/ui, mas em HTML e CSS próprios, sem
// biblioteca: o shadcn/ui pede React e build, e os estilos que ele injeta batem na CSP (style-src 'self').
//
// - Escolha em botões (segmented): um <select hidden> dentro de <fieldset class="choice"> continua sendo a fonte do
//   valor (o app.js lê e escreve .value e escuta "change" nele, como antes); aqui ele ganha uma fileira de rádios com
//   o texto das opções. "Leve (bom para e-mail)" vira "Leve" em cima e "bom para e-mail" embaixo, menor. O <legend>
//   dá nome ao grupo; travar o <select> (disabled) trava o grupo.
// - Senha visível: o botão .password-toggle ao lado do campo troca o tipo do campo; aria-pressed diz o estado ao
//   leitor de tela. Fechar a janela, ou setChoice/hidePasswords, volta a esconder.

/**
 * @param {HTMLSelectElement} select
 * @returns {HTMLDivElement} a fileira de rádios
 */
export function segmented(select) {
  const group = document.createElement('div');
  group.className = 'segmented';
  for (const option of select.options) {
    const label = document.createElement('label');
    label.className = 'segment';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = select.id;
    input.value = option.value;
    input.checked = option.selected;
    const [, main, hint] = option.textContent.trim().match(/^(.*?)(?:\s*\((.*)\))?$/);
    const text = document.createElement('span');
    text.className = 'segment-text';
    text.textContent = main;
    label.append(input, text);
    if (hint) {
      const small = document.createElement('span');
      small.className = 'segment-hint';
      small.textContent = hint;
      label.append(small);
    }
    input.addEventListener('change', () => {
      if (!input.checked) return;
      select.value = input.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    group.append(label);
  }
  select.after(group);
  // O app trava o <select> enquanto gera o PDF: o grupo trava junto.
  const fieldset = select.closest('fieldset');
  const sync = () => { fieldset.disabled = select.disabled; };
  new MutationObserver(sync).observe(select, { attributes: true, attributeFilter: ['disabled'] });
  sync();
  return group;
}

/** Muda o valor por código (sem "change"), com o rádio certo marcado. */
export function setChoice(select, value) {
  select.value = value;
  for (const input of select.closest('fieldset').querySelectorAll('input[type="radio"]')) input.checked = input.value === value;
}

/** Foco no rádio marcado do grupo do select. */
export function focusChoice(select) {
  select.closest('fieldset').querySelector('input[type="radio"]:checked')?.focus();
}

/** Volta a esconder as senhas mostradas dentro de root. */
export function hidePasswords(root = document) {
  for (const button of root.querySelectorAll('.password-toggle[aria-pressed="true"]')) {
    button.setAttribute('aria-pressed', 'false');
    button.previousElementSibling.type = 'password';
  }
}

export function setupPasswordToggles() {
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('.password-toggle');
    if (!button) return;
    const input = button.previousElementSibling;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
  });
  // "close" não sobe, mas passa pela captura do document: toda janela que fecha esconde as senhas dela.
  document.addEventListener('close', (event) => hidePasswords(event.target), true);
}
