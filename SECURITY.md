# Segurança

## Como avisar de uma falha

Mande um e-mail para **sbtecnologia0@gmail.com** com o assunto "Segurança - Scanner Doc", descrevendo o problema e como reproduzir. Por favor, não abra uma issue pública para falhas que possam expor documentos ou dados de quem usa o app.

Este é um projeto de comunidade, mantido no tempo livre: não há recompensa em dinheiro, mas toda falha confirmada é corrigida com prioridade e, se você quiser, creditada.

## O que conta como falha

- Qualquer caminho pelo qual uma imagem, um PDF ou um dado de quem usa o app saia do aparelho.
- Execução de código de terceiros na página (XSS), ou afrouxamento da Content-Security-Policy ou dos outros cabeçalhos de segurança.
- Metadados da foto (GPS, modelo do aparelho, data) indo parar no PDF.
- O arquivo do certificado digital (.pfx), a chave ou a senha saindo do aparelho, ficando guardados ou aparecendo no console. (O certificado público vai no PDF assinado de propósito: é por ele que quem recebe confere quem assinou.)
- Um PDF entregue como "assinado" sem que a assinatura confira.
- Uma assinatura acrescentada a um PDF que já existe que mude o original ou faça uma assinatura anterior deixar de valer.
- Texto ou imagem que estava sob uma tarja chegando ao PDF gerado (selecionável, escondido ou recuperável de qualquer forma).
- Dados achados pela busca de dados para tarjar indo para o console, ficando guardados ou saindo do aparelho.
- A senha de um PDF (a digitada para abrir ou a escolhida para proteger) saindo do aparelho, ficando guardada ou aparecendo no console, ou um PDF "protegido com senha" que abre sem ela.
- Problemas no workflow de publicação que permitam publicar código não revisado.

## Regras para quem contribui

- Não afrouxe a Content-Security-Policy do `web/index.html` nem os cabeçalhos de `web/_headers`, e não adicione requisições de rede. A CSP da página aparece nos dois arquivos e tem que ser a mesma (o teste `test/headers.test.js` confere).
- Bibliotecas de terceiros só entram copiadas em `web/vendor/`, com versão, origem e SHA-256 anotados.
- As ações do GitHub Actions ficam fixadas pelo hash do commit, não pela tag.
- A publicação no Cloudflare usa o wrangler fixado em `deploy/package-lock.json`, instalado sem scripts. O token fica no ambiente `producao` do GitHub, que só o libera para a branch `main`.
