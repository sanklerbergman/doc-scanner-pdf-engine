# Liberation Fonts 2.1.5 (PDF/A dos documentos do Word)

O PDF/A exige a fonte dentro do arquivo, e as fontes padrão do PDF (Helvetica, Times e Courier) não vão embutidas. Com o PDF/A ligado, o texto das páginas de Word sai nas Liberation, que têm as mesmas larguras em toda a WinAnsi (menos ¯ ± µ · ÷, com diferença de até 0,4 ponto em letra 12). O app embute só o subconjunto das letras usadas (`js/ttf.js` e `js/pdfa-fonts.js`), uns 10 KB por fonte.

| Fonte padrão | Arquivo | SHA-256 do `.ttf` |
| --- | --- | --- |
| Helvetica | `LiberationSans-Regular.ttf.js` | `76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8` |
| Helvetica-Bold | `LiberationSans-Bold.ttf.js` | `788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173` |
| Helvetica-Oblique | `LiberationSans-Italic.ttf.js` | `e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0` |
| Helvetica-BoldOblique | `LiberationSans-BoldItalic.ttf.js` | `698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee` |
| Times-Roman | `LiberationSerif-Regular.ttf.js` | `058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74` |
| Times-Bold | `LiberationSerif-Bold.ttf.js` | `d754ba427cfe0bca54ae052384baa8f842da5bd6550ad4da024ac441e7a7d5ce` |
| Times-Italic | `LiberationSerif-Italic.ttf.js` | `0e3dea9f8d613e006ccfa62201f33e265d19167bd0907725c3e145368b04fc2e` |
| Times-BoldItalic | `LiberationSerif-BoldItalic.ttf.js` | `f17db8af71e24d2066b587546021d4f0b296be389512b658dec3c09affeb11a7` |
| Courier | `LiberationMono-Regular.ttf.js` | `f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1` |
| Courier-Bold | `LiberationMono-Bold.ttf.js` | `bd62a0672d0b9b6710b01df434c80ad54fa5f0835207eb7b17b7a761463067bb` |
| Courier-Oblique | `LiberationMono-Italic.ttf.js` | `605c01c711b44480a7508d349dfbf3264e81fa43d69e61cfa7d10b86e764c4d1` |
| Courier-BoldOblique | `LiberationMono-BoldItalic.ttf.js` | `79451f3c09fe25116098853b7a2ca6e2436220ccc11af022979adbcf195be130` |

Origem: [liberationfonts/liberation-fonts](https://github.com/liberationfonts/liberation-fonts), release 2.1.5, arquivo `liberation-fonts-ttf-2.1.5.tar.gz` (SHA-256 `7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0`). O `LICENSE` é o do pacote (SHA-256 `93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b`).

Os `.ttf` entram sem nenhuma alteração. Só mudam de forma: cada um vira um módulo JS em base64, pelo `scripts/gerar-fontes-pdfa.mjs` (que confere o SHA-256 de cada arquivo).

## Licença

SIL Open Font License 1.1 (ver `LICENSE`), com "Liberation" como nome reservado. A licença permite distribuir as fontes junto com software e embutir subconjuntos delas em documentos, que é o que o app faz; o nome reservado só restringe versões modificadas distribuídas como fonte.

## Como o app usa

- Carregado sob demanda por `js/pdfa-fonts.js`, só quando o PDF/A está ligado e a lista tem página de Word, e só as fontes que o documento usa (cada uma tem de 0,4 a 0,55 MB em base64). Depois, os arquivos ficam no cache do service worker, como os do PDF.js e do Tesseract.
- **Sem rede:** a fonte vem de um módulo JS do próprio site, carregado como script (`script-src 'self'`). A página continua sem conexão nenhuma (`connect-src 'none'`).
- **O que vai no PDF:** o subconjunto das letras usadas (os números das letras do original, as não usadas vazias), com o cmap refeito só com elas e sem as tabelas de tipografia avançada. A fonte vai como TrueType simples, com `WinAnsiEncoding`, o `/Widths` tirado da própria fonte e `ToUnicode`, para o texto continuar selecionável e pesquisável.

## Para atualizar

1. Baixe o `liberation-fonts-ttf-<versão>.tar.gz` da release e extraia numa pasta fora do repositório.
2. Atualize os SHA-256 em `scripts/gerar-fontes-pdfa.mjs` e rode `node scripts/gerar-fontes-pdfa.mjs <pasta>`.
3. Confira as larguras contra as fontes padrão (as diferenças anotadas acima) e o PDF/A no veraPDF (`VERAPDF=… npm test`).
4. Atualize versões e SHA-256 aqui e aumente o `CACHE` do `sw.js`.
