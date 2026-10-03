# Scanner Doc & PDF Engine

Foto de documento vira PDF, **100% no navegador**. Sem upload, sem cadastro, sem rastreio.
Feito pela comunidade, para a comunidade.

## O que faz

- Tirar foto com a câmera do celular, com **botão de luz** para ambientes escuros, ou escolher várias imagens — também aceita arrastar e colar (Ctrl+V)
- **Recorte automático do papel** com correção de perspectiva, ajustável arrastando os cantos
- Ver cada página em tela cheia, como vai sair no PDF
- Reordenar, girar e remover páginas
- Filtros: **Documento** (remove sombra, fundo branco, reforça texto fraco), **Cor realçada**, **Preto e branco** e **Original**
- Tamanho A4, Carta ou igual à imagem; margem e qualidade ajustáveis
- Baixar ou compartilhar o PDF (no celular)
- Abre fotos **HEIC** do iPhone em qualquer navegador (decodificador embutido, carregado só quando precisa)
- Funciona offline depois do primeiro acesso

## Privacidade (o ponto principal)

| Garantia | Como |
| --- | --- |
| Nenhum arquivo sai do aparelho | Todo o processamento é feito em `<canvas>` no navegador. Não há backend. |
| Nem dá para enviar | CSP com `connect-src 'none'`: o navegador bloqueia fetch/XHR/WebSocket/beacon na página e no Worker dos filtros, que são os únicos lugares por onde as imagens passam. |
| Zero terceiros | Sem analytics, cookies, CDN ou fontes externas. As duas bibliotecas (libheif, para HEIC, e um gerador de QR Code) são servidas pelo próprio site. |
| Nada guardado | Sem `localStorage`/IndexedDB. O service worker só faz cache dos arquivos do app. |
| PDF limpo | A foto é redesenhada, o que descarta o EXIF (GPS, modelo do celular, data). O PDF não tem `/Info`, datas nem "Producer". |

Dá para conferir: F12 → aba **Rede** enquanto gera um PDF. As únicas requisições são os arquivos do próprio app e URLs `blob:` (memória local).

### Limites dessa garantia

- A política vale para a página e para o Worker dos filtros. O service worker (`sw.js`, cache offline) não é coberto por ela, porque o GitHub Pages não permite enviar cabeçalhos; ele não recebe imagens, só os arquivos do próprio app.
- Nenhuma política de navegador impede o próprio site de ser alterado. A proteção contra isso é o código ser aberto e toda mudança passar por revisão.
- Quem hospeda uma cópia modificada pode trocar qualquer coisa, inclusive a chave Pix. O endereço oficial é o que está na descrição do repositório.

Achou uma falha de segurança? Veja [SECURITY.md](SECURITY.md).

## Contribuindo

Veja [CONTRIBUTING.md](CONTRIBUTING.md). Regra de ouro: **nada de requisições externas nem rastreamento.**

## Licença

[MIT](LICENSE). O decodificador de HEIC em `web/vendor/libheif/` é o [libheif-js](https://github.com/catdad-experiments/libheif-js), sob LGPL-3.0, distribuído sem alterações.
