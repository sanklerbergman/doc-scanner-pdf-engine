# Segurança

## Como avisar de uma falha

Mande um e-mail para **sbtecnologia0@gmail.com** com o assunto "Segurança - Scanner Doc", descrevendo o problema e como reproduzir. Por favor, não abra uma issue pública para falhas que possam expor documentos ou dados de quem usa o app.

Este é um projeto de comunidade, mantido no tempo livre: não há recompensa em dinheiro, mas toda falha confirmada é corrigida com prioridade e, se você quiser, creditada.

## O que conta como falha

- Qualquer caminho pelo qual uma imagem, um PDF ou um dado de quem usa o app saia do aparelho.
- Execução de código de terceiros na página (XSS), ou afrouxamento da Content-Security-Policy ou dos outros cabeçalhos de segurança.
- Metadados da foto (GPS, modelo do aparelho, data) indo parar no PDF.
- Problemas no workflow de publicação que permitam publicar código não revisado.

## Regras para quem contribui

- Não afrouxe a Content-Security-Policy do `web/index.html` nem os cabeçalhos de `web/_headers`, e não adicione requisições de rede. A CSP da página aparece nos dois arquivos e tem que ser a mesma (o teste `test/headers.test.js` confere).
- Bibliotecas de terceiros só entram copiadas em `web/vendor/`, com versão, origem e SHA-256 anotados.
- As ações do GitHub Actions ficam fixadas pelo hash do commit, não pela tag.
- A publicação no Cloudflare usa o wrangler fixado em `deploy/package-lock.json`, instalado sem scripts. O token fica no ambiente `producao` do GitHub, que só o libera para a branch `main`.
