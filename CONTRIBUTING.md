# Contribuindo

Valeu por querer ajudar! Issues, ideias, traduções e PRs são bem-vindos.

## Regras que não negociamos

1. **Nenhum dado do usuário sai do navegador.** Nada de upload, API externa ou "só um log".
2. **Nada de rastreamento.** Sem analytics, cookies, pixels, fingerprinting ou armazenamento persistente de dados do usuário.
3. **Nada de terceiros em runtime.** Sem CDN, fontes externas ou scripts de outros domínios. Não afrouxe a Content-Security-Policy do `index.html` nem os cabeçalhos de `web/_headers`.
4. **Sem dependências sem conversa prévia.** O app é JavaScript puro de propósito: fácil de auditar e de rodar. As exceções ficam em `web/vendor/` (decodificador de HEIC, renderizador de PDF e gerador de QR Code), copiadas para o repositório e carregadas sob demanda.

## Fluxo

```bash
npm start   # servidor local em http://localhost:8080
npm test    # testes
```

- Abra uma issue antes de mudanças grandes.
- Mantenha o estilo do código existente (ES modules, sem build).
- Teste no celular (ou no modo responsivo do navegador) quando mexer na interface.
- Mudou arquivo do app? Aumente a versão de `CACHE` em `web/sw.js`.
- Os PDFs que os testes geram passam pelo `qpdf --check` quando ele está instalado (no CI é obrigatório; a variável `QPDF` aponta o programa).
- Mexeu no leitor de PDF? Rode também a varredura com PDFs reais (`node scripts/varrer-pdfs.mjs <pasta> --qpdf`) e uma rodada longa de fuzzing (`node scripts/fuzz-pdf.mjs`). Como usar cada um está no começo do arquivo.
- O `npm start` não envia os cabeçalhos de segurança. Para ver o site como ele fica no ar: `cd deploy && npm ci --ignore-scripts && npx wrangler telemetry disable && npx wrangler dev` (o `telemetry disable` impede o wrangler de enviar estatísticas de uso ao Cloudflare).
- Nova release: a versão fica em `package.json` e no rodapé do `web/index.html` (o teste confere que batem); depois `gh release create vX.Y.Z --generate-notes`.
- Regras de segurança (bibliotecas, política da página, workflow): veja [SECURITY.md](SECURITY.md).

## Ideias de próximos passos

- Detectar o papel também com sombra forte ou fundo claro
- Lupa ao arrastar os cantos do recorte
- Arrastar para reordenar páginas
- Interface em outros idiomas

Funcionalidades maiores (abrir .docx, juntar, dividir e comprimir PDF, reconhecer texto com OCR, assinar com certificado digital, gerar PDF/A, tarjar dados e abrir PDF com senha) estão planejadas em [MELHORIAS.md](MELHORIAS.md).
