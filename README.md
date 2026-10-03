# Scanner Doc & PDF Engine

Foto de documento vira PDF, **100% no navegador**. Sem upload, sem cadastro, sem rastreio.
Feito pela comunidade, para a comunidade.

## O que faz

- Tirar foto (câmera do celular) ou escolher várias imagens — também aceita arrastar e colar (Ctrl+V)
- Reordenar, girar e remover páginas
- Filtros: **Documento** (remove sombra, fundo branco), **Cor realçada**, **Preto e branco** e **Original**
- Tamanho A4, Carta ou igual à imagem; margem e qualidade ajustáveis
- Baixar ou compartilhar o PDF (no celular)
- Abre fotos **HEIC** do iPhone em qualquer navegador (decodificador embutido, carregado só quando precisa)
- Funciona offline depois do primeiro acesso

## Privacidade (o ponto principal)

| Garantia | Como |
| --- | --- |
| Nenhum arquivo sai do aparelho | Todo o processamento é feito em `<canvas>` no navegador. Não há backend. |
| Nem dá para enviar | CSP com `connect-src 'none'`: o navegador bloqueia fetch/XHR/WebSocket/beacon da página. |
| Zero terceiros | Sem analytics, cookies, CDN ou fontes externas. A única biblioteca (libheif, para HEIC) é servida pelo próprio site. |
| Nada guardado | Sem `localStorage`/IndexedDB. O service worker só faz cache dos arquivos do app. |
| PDF limpo | A foto é redesenhada, o que descarta o EXIF (GPS, modelo do celular, data). O PDF não tem `/Info`, datas nem "Producer". |

Dá para conferir: F12 → aba **Rede** enquanto gera um PDF. As únicas requisições são os arquivos do próprio app e URLs `blob:` (memória local).

## Rodando localmente

Precisa só do Node 18+ (sem `npm install`):

```bash
npm start      # http://localhost:8080
npm test       # testes do gerador de PDF
```

## Estrutura

```
web/                 site estático (é isso que vai para o ar)
  index.html         página + Content-Security-Policy
  js/app.js          interface e fluxo
  js/imaging.js      decodificação, rotação e filtros (canvas)
  js/pdf.js          gerador de PDF mínimo (embute JPEG sem recomprimir)
  js/config.js       links de doação e do repositório
  vendor/libheif/    decodificador de HEIC (libheif-js, LGPL-3.0)
  sw.js              cache offline
test/                testes (node:test)
scripts/serve.js     servidor de desenvolvimento
```

## Publicando (GitHub Pages)

1. Em **Settings → Pages**, escolha **Source: GitHub Actions**.
2. Todo push na `main` roda os testes e publica a pasta `web/`.

Ao mudar arquivos do app, aumente a versão de `CACHE` em `web/sw.js` para os usuários offline receberem a atualização.

## Doações

Edite `web/js/config.js`:

```js
donationUrl: 'https://github.com/sponsors/seu-usuario', // ou Ko-fi, Apoia.se…
pixKey: 'sua-chave-pix',
```

Campos vazios escondem o botão correspondente. Doar nunca libera recurso extra — não existe versão Pro.

## Contribuindo

Veja [CONTRIBUTING.md](CONTRIBUTING.md). Regra de ouro: **nada de requisições externas nem rastreamento.**

## Licença

[MIT](LICENSE). O decodificador de HEIC em `web/vendor/libheif/` é o [libheif-js](https://github.com/catdad-experiments/libheif-js), sob LGPL-3.0, distribuído sem alterações.
