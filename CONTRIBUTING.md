# Contribuindo

Valeu por querer ajudar! Issues, ideias, traduções e PRs são bem-vindos.

## Regras que não negociamos

1. **Nenhum dado do usuário sai do navegador.** Nada de upload, API externa ou "só um log".
2. **Nada de rastreamento.** Sem analytics, cookies, pixels, fingerprinting ou armazenamento persistente de dados do usuário.
3. **Nada de terceiros em runtime.** Sem CDN, fontes externas ou scripts de outros domínios. Não afrouxe a Content-Security-Policy do `index.html`.
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
- Nova release: a versão fica em `package.json` e no rodapé do `web/index.html` (o teste confere que batem); depois `gh release create vX.Y.Z --generate-notes`.
- Regras de segurança (bibliotecas, política da página, workflow): veja [SECURITY.md](SECURITY.md).

## Ideias de próximos passos

- Detectar o papel também com sombra forte ou fundo claro
- Lupa ao arrastar os cantos do recorte
- Arrastar para reordenar páginas
- Interface em outros idiomas

Funcionalidades maiores (abrir .docx, juntar, dividir e comprimir PDF) estão planejadas em [MELHORIAS.md](MELHORIAS.md).
