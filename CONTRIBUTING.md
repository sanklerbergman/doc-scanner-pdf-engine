# Contribuindo

Valeu por querer ajudar! Issues, ideias, traduções e PRs são bem-vindos.

## Regras que não negociamos

1. **Nenhum dado do usuário sai do navegador.** Nada de upload, API externa ou "só um log".
2. **Nada de rastreamento.** Sem analytics, cookies, pixels, fingerprinting ou armazenamento persistente de dados do usuário.
3. **Nada de terceiros em runtime.** Sem CDN, fontes externas ou scripts de outros domínios. Não afrouxe a Content-Security-Policy do `index.html` nem os cabeçalhos de `web/_headers`.
4. **Sem dependências sem conversa prévia.** O app é JavaScript puro de propósito: fácil de auditar e de rodar. As exceções ficam em `web/vendor/` (decodificador de HEIC, renderizador de PDF, OCR, gerador de QR Code e as fontes do PDF/A), copiadas para o repositório e carregadas sob demanda.

## Fluxo

```bash
npm start   # servidor local em http://localhost:8080
npm test    # testes
```

- Abra uma issue antes de mudanças grandes. A issue (descrição e comentários) é o plano da entrega, e o commit cita o número dela (`#N`).
- Mantenha o estilo do código existente (ES modules, sem build).
- Teste no celular (ou no modo responsivo do navegador) quando mexer na interface.
- Mudou arquivo do app? Aumente a versão de `CACHE` em `web/sw.js`. Arquivo novo também entra na lista `APP_FILES` de lá, para funcionar offline.
- Todo texto da interface passa pelo `t()` (`web/js/i18n.js`) e tem tradução em `web/js/i18n-en.js`. A página em inglês (`web/en/index.html`) é gerada: depois de mexer no `web/index.html` ou no dicionário, rode `node scripts/gerar-en.mjs`. O teste confere as duas coisas.
- A aparência segue o [DESIGN.md](DESIGN.md) (cores, letras, cantos, componentes). Os controles são próprios, em HTML e CSS, sem biblioteca de interface: as que existem pedem build ou injetam estilos que a CSP barra.
- Os PDFs que os testes geram passam pelo `qpdf --check` quando ele está instalado (no CI é obrigatório; a variável `QPDF` aponta o programa).
- Os testes da assinatura usam só os certificados **de teste** de `test/fixtures/certificados` (dados fictícios, gerados pelo `gerar.sh` de lá). Nunca coloque um certificado real no repositório nem nos testes. A conferência com o `openssl cms -verify` roda quando o OpenSSL está instalado (no CI é obrigatória).
- O PDF/A é conferido pelo veraPDF (validador de referência, em Java) quando a variável `VERAPDF` aponta o programa (`verapdf` ou `verapdf.bat`); sem ela, esse teste é pulado.
- PDFs com senha para os testes: `test/fixtures/pdf-senha`, gerados pelo `gerar.mjs` de lá com o qpdf (os comandos ficam no próprio arquivo).
- Mexeu no leitor de PDF? Rode também a varredura com PDFs reais (`node scripts/varrer-pdfs.mjs <pasta> --qpdf`) e uma rodada longa de fuzzing (`node scripts/fuzz-pdf.mjs`). Como usar cada um está no começo do arquivo.
- O `npm start` não envia os cabeçalhos de segurança. Para ver o site como ele fica no ar: `cd deploy && npm ci --ignore-scripts && npx wrangler telemetry disable && npx wrangler dev` (o `telemetry disable` impede o wrangler de enviar estatísticas de uso ao Cloudflare).
- Versão: semver. Correção sobe o último número (5.8.0 → 5.8.1), funcionalidade compatível sobe o do meio (5.8.1 → 5.9.0), mudança incompatível sobe o primeiro. Só documentação, testes ou CI não sobe versão. A versão fica em `package.json` e no rodapé do `web/index.html` (o teste confere que batem).
- Publicar: o push na `main` já faz o deploy; depois vêm a tag `vX.Y.Z` e o `gh release create vX.Y.Z --generate-notes`.
- Regras de segurança (bibliotecas, política da página, workflow): veja [SECURITY.md](SECURITY.md).

## Ideias e pendências

Testes que só dão para fazer à mão, perguntas em aberto e ideias de próximos passos ficam em [MELHORIAS.md](MELHORIAS.md). O trabalho em andamento fica nas [issues](https://github.com/sanklerbergman/doc-scanner-pdf-engine/issues).
