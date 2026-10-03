# Segurança

## Como avisar de uma falha

Mande um e-mail para **sbtecnologia0@gmail.com** com o assunto "Segurança - Scanner Doc", descrevendo o problema e como reproduzir. Por favor, não abra uma issue pública para falhas que possam expor documentos ou dados de quem usa o app.

Este é um projeto de comunidade, mantido no tempo livre: não há recompensa em dinheiro, mas toda falha confirmada é corrigida com prioridade e, se você quiser, creditada.

## O que conta como falha

- Qualquer caminho pelo qual uma imagem, um PDF ou um dado de quem usa o app saia do aparelho.
- Execução de código de terceiros na página (XSS), ou afrouxamento da Content-Security-Policy.
- Metadados da foto (GPS, modelo do aparelho, data) indo parar no PDF.
- Problemas no workflow de publicação que permitam publicar código não revisado.

## Regras para quem contribui

- Não afrouxe a Content-Security-Policy do `web/index.html` e não adicione requisições de rede.
- Bibliotecas de terceiros só entram copiadas em `web/vendor/`, com versão, origem e SHA-256 anotados.
- As ações do GitHub Actions ficam fixadas pelo hash do commit, não pela tag.
