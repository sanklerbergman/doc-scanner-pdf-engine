# Scanner Doc

Foto, Word ou PDF: tudo vira PDF, **100% no navegador**. Sem upload, sem cadastro, sem rastreio.
Feito pela comunidade, para a comunidade.

**Usar agora: https://scanner.sankler.com.br/**

## O que faz

- Tirar foto com a câmera do celular, com **botão de luz**, aviso de ambiente escuro e contorno do papel ao vivo, ou escolher várias imagens (também aceita arrastar e colar)
- **Recorte automático do papel** com correção de perspectiva e de proporção, ajustável arrastando os cantos
- Ver cada página em tela cheia, como vai sair no PDF
- Reordenar, girar e remover páginas
- Filtros: **Documento** (remove sombra, fundo branco, reforça texto fraco), **Cor realçada**, **Preto e branco** e **Original**
- Tamanho A4, Carta ou igual à imagem; margem e qualidade ajustáveis
- Baixar ou compartilhar o PDF (no celular)
- Abre **documentos do Word (.docx)**: o PDF sai com texto de verdade (selecionável e pesquisável), com títulos, listas, negrito e itálico, tabelas, imagens, cabeçalho e rodapé (com "Página X de Y"), no tamanho de página e nas margens do documento. As páginas podem ser misturadas com fotos
- **Junta, separa e comprime PDFs**: abra um ou mais PDFs, reordene, remova ou misture as páginas com fotos e documentos, e gere um PDF só, um por página ou um por intervalo (ex.: 1-3, 4-10). Dá para ver cada página antes e conferir, numa prévia, os arquivos que vão sair. As páginas vão como estão no original, com o texto selecionável; links, formulários, scripts e metadados ficam de fora. Para diminuir PDFs escaneados ou de fotos, as imagens podem ser recomprimidas, com o "antes → depois" do tamanho. Avisa quando o PDF tem assinatura digital, que deixa de valer no arquivo novo
- Abre fotos **HEIC** do iPhone em qualquer navegador (decodificador embutido, carregado só quando precisa)
- Funciona offline depois do primeiro acesso

## Privacidade (o ponto principal)

| Garantia | Como |
| --- | --- |
| Nenhum arquivo sai do aparelho | Todo o processamento é feito no navegador (`<canvas>` e um Web Worker). Não há backend. |
| Nem dá para enviar | CSP com `connect-src 'none'`: o navegador bloqueia fetch/XHR/WebSocket/beacon na página e no Worker dos filtros, que são os únicos lugares por onde as imagens passam. |
| Zero terceiros | Sem analytics, cookies, CDN ou fontes externas. As três bibliotecas (libheif, para HEIC, o PDF.js, para mostrar as páginas dos PDFs, e um gerador de QR Code) são servidas pelo próprio site e só carregam quando precisam. |
| Nada guardado | Sem `localStorage`/IndexedDB. O service worker só faz cache dos arquivos do app. |
| PDF limpo | A foto é redesenhada, o que descarta o EXIF (GPS, modelo do celular, data). Do .docx, os metadados (autor, empresa, datas) nem são lidos. O PDF não tem `/Info`, datas nem "Producer". |

Dá para conferir: F12 → aba **Rede** enquanto gera um PDF. As únicas requisições são os arquivos do próprio app e URLs `blob:` (memória local).

### Limites dessa garantia

- A política vale para a página e para o Worker dos filtros. O service worker (`sw.js`, cache offline) não é coberto por ela, porque o GitHub Pages não permite enviar cabeçalhos; ele não recebe imagens, só os arquivos do próprio app.
- Nenhuma política de navegador impede o próprio site de ser alterado. A proteção contra isso é o código ser aberto, com o histórico de mudanças público.
- Quem hospeda uma cópia modificada pode trocar qualquer coisa, inclusive a chave Pix. O endereço oficial é https://scanner.sankler.com.br/.

Achou uma falha de segurança? Veja [SECURITY.md](SECURITY.md).

## Contribuindo

Veja [CONTRIBUTING.md](CONTRIBUTING.md). Regra de ouro: **nada de requisições externas nem rastreamento.**

## Licença

[MIT](LICENSE). As três bibliotecas em `web/vendor/` são distribuídas sem alterações e têm licença própria: o decodificador de HEIC [libheif-js](https://github.com/catdad-experiments/libheif-js) (LGPL-3.0), o renderizador de PDF [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0) e o gerador de QR Code [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT).
