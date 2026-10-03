# Contribuindo

Valeu por querer ajudar! Issues, ideias, traduções e PRs são bem-vindos.

## Regras que não negociamos

1. **Nenhum dado do usuário sai do navegador.** Nada de upload, API externa ou "só um log".
2. **Nada de rastreamento.** Sem analytics, cookies, pixels, fingerprinting ou armazenamento persistente de dados do usuário.
3. **Nada de terceiros em runtime.** Sem CDN, fontes externas ou scripts de outros domínios. Não afrouxe a Content-Security-Policy do `index.html`.
4. **Sem dependências sem conversa prévia.** O app é JavaScript puro de propósito: fácil de auditar e de rodar. A única exceção é o decodificador de HEIC em `web/vendor/`, copiado para o repositório e carregado sob demanda.

## Fluxo

```bash
npm start   # servidor local em http://localhost:8080
npm test    # testes
```

- Abra uma issue antes de mudanças grandes.
- Mantenha o estilo do código existente (ES modules, sem build).
- Teste no celular (ou no modo responsivo do navegador) quando mexer na interface.
- Mudou arquivo do app? Aumente a versão de `CACHE` em `web/sw.js`.

## Ideias de próximos passos

- Recorte manual e correção de perspectiva
- Arrastar para reordenar páginas
- Juntar PDFs existentes
- Interface em outros idiomas
