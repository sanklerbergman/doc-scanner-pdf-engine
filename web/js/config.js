// Configuração de quem publica o site. Deixe em branco o que não quiser exibir.
export const CONFIG = {
  repoUrl: 'https://github.com/sanklerbergman/doc-scanner-pdf-engine',

  // E-mail que recebe feedback. Vazio = o botão "Mandar um e-mail" não aparece.
  feedbackEmail: 'sbtecnologia0@gmail.com',

  // Link de doação (GitHub Sponsors, Ko-fi, Apoia.se, Buy Me a Coffee…).
  // Vazio = o botão "Pagar um café" não aparece.
  donationUrl: '',

  // Chave Pix. Vazio = o QR Code e o botão de copiar o Pix não aparecem.
  // Prefira chave aleatória de conta pessoa física: chave de CNPJ/MEI expõe o cadastro público da empresa.
  pixKey: '5707572e-eb03-44c6-ba1f-740a74c6763c',

  // Textos que vão dentro do código Pix (sem acento). São só informativos:
  // o banco de quem paga mostra o titular real da chave.
  pixName: 'SCANNER DOC',
  pixCity: 'BRASIL',
};
