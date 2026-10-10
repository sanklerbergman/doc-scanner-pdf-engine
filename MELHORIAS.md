# Melhorias

Planejamento de funcionalidades maiores. Ideias menores ficam em [CONTRIBUTING.md](CONTRIBUTING.md#ideias-de-próximos-passos).

## Abrir arquivos .docx (Word)

**Objetivo:** escolher um `.docx` e sair com um PDF, do mesmo jeito que acontece com fotos. Tudo no navegador, sem biblioteca nova e sem afrouxar a CSP.

**Por que só .docx:** é o formato editável mais comum no Brasil. É o padrão do Word, do Word no celular e da exportação do Google Docs, e é o que chega por e-mail e WhatsApp.

**Fora do escopo:**

- `.doc` (Word 97–2003): é binário (OLE) e não há biblioteca JS leve para ele. O app só avisa "salve como .docx".
- `.odt` e XML (NF-e): ficam para depois. O `.odt` também é ZIP com XML, então reaproveita boa parte deste trabalho.

### Abordagem

O PDF terá **texto de verdade**, e não uma foto do documento:

- texto selecionável e pesquisável;
- arquivos de poucos KB;
- nenhuma dependência.

As fontes padrão do PDF (Helvetica e Times, com `WinAnsiEncoding`) já cobrem os acentos do português sem embutir fonte.

**Descartado:** transformar o documento em imagem (HTML → canvas). O navegador não tem API para isso. O truque com SVG `foreignObject` bloqueia a exportação do canvas no Safari, e o iPhone é o aparelho de referência. O html2canvas seria uma dependência grande.

O caminho das fotos não muda. O PDF gerado a partir de imagens deve continuar igual byte a byte, e os testes de `test/pdf.test.js` garantem isso.

### Fases

#### Fase 1: só texto

- [x] Leitor de ZIP mínimo (`web/js/zip.js`): ler o diretório central e descompactar com `DecompressionStream('deflate-raw')`
- [x] Leitor de XML mínimo (`web/js/xml.js`): o Node não tem `DOMParser`, e os testes rodam em Node
- [x] Leitura do `word/document.xml` (`web/js/docx.js`):
  - [x] parágrafos e quebras de linha
  - [x] negrito, itálico e sublinhado
  - [x] títulos (`Heading1`… via `word/styles.xml`)
  - [x] listas simples com marcador e número
  - [x] alinhamento
- [x] Layout de texto (`web/js/layout.js`):
  - [x] tabela de larguras da Helvetica e da Times (AFM)
  - [x] quebra de linha por palavra
  - [x] paginação respeitando o tamanho da página (A4/Carta) e a margem
- [x] `pdf.js`: páginas de texto com fontes padrão, além das páginas de imagem
- [x] Interface:
  - [x] `accept` do input com `.docx`
  - [x] `addFiles` aceita `.docx`
  - [x] página com tipo `foto` ou `documento`
  - [x] recorte, filtros e "Ajustar recorte" escondidos em páginas de documento
  - [x] miniatura desenhada a partir do layout
- [x] Um `.docx` vira várias páginas na lista, que podem ser reordenadas e misturadas com fotos
- [x] Carregar os módulos de documento só quando aparecer um `.docx`, como acontece com o libheif
- [x] Novos arquivos em `APP_FILES` e aumento da versão de `CACHE` no `web/sw.js`

#### Fase 2: imagens e tabelas

- [x] Imagens embutidas: JPEG entra direto (DCTDecode) e PNG ou outros formatos viram JPEG via canvas. Imagens na linha do texto e flutuantes (posicionadas pela âncora, sem contorno do texto)
- [x] Tabelas: colunas do documento (encolhem para caber), bordas do estilo e da célula, fundo, células mescladas, alinhamento vertical e linha de cabeçalho repetida em cada página. Uma linha não é dividida entre páginas
- [x] Cabeçalho e rodapé do documento: primeira página diferente, páginas pares, herança entre seções e "Página X de Y" (campos PAGE e NUMPAGES)

#### Fase 3: acabamento

- [x] Fonte serifada ou sem serifa conforme o documento
- [x] Recuo de primeira linha e espaçamento entre parágrafos
- [x] Quebra de página manual (`w:br w:type="page"`)
- [x] Aviso do que foi ignorado (ex.: "o documento tinha gráficos que não aparecem no PDF")

### Segurança e privacidade

- **ZIP bomb:** limitar o tamanho descompactado total e por arquivo e o número de entradas, e recusar acima disso.
- **Conteúdo do documento** nunca vai para `innerHTML`. Usar só `textContent` ou desenho no canvas.
- **Imagens externas linkadas** (`TargetMode="External"`) são ignoradas. A CSP já as bloquearia, e isso mantém a garantia de "nenhuma requisição externa".
- **XML:** o leitor próprio não resolve entidades externas nem DTD.
- **Metadados:** `docProps/core.xml` (autor, empresa, datas) **não** vai para o PDF, mantendo a regra de PDF sem `/Info`.
- O `.docx` não deve conter macros (isso é `.docm`). Mesmo assim, nada do arquivo é executado.

### Testes

- [x] ZIP: arquivo armazenado e comprimido, ZIP corrompido e limites de ZIP bomb
- [x] XML: entidades (`&amp;`, `&#233;`), CDATA e namespaces (`w:`)
- [x] DOCX: parágrafo, negrito, lista, título e acentos, com os .docx montados pelos próprios testes (`test/helpers/docx.js`)
- [x] Layout: quebra de linha, paginação e palavra maior que a linha
- [x] PDF: estrutura válida (xref) com páginas de texto e mistura de texto com foto
- [x] PDF de fotos continua idêntico ao de antes
- [ ] Teste real no iPhone, no site publicado

### Decisões

- **Tamanho da página e margem:** seguem o documento (`w:pgSz` e `w:pgMar`; A4 e 2,5 cm quando faltam). A paginação acontece ao abrir o arquivo, e as opções do app (A4/Carta, margem, filtro, qualidade) valem só para fotos.
- **Recurso não suportado:** o PDF é gerado mesmo assim, e o app avisa o que ficou de fora (gráficos, formas e caixas de texto, equações, notas de rodapé e imagens em formatos que o navegador não desenha, como EMF e WMF).
- **Caracteres fora das fontes padrão** (grego, emoji, setas): viram "?", com aviso. Bullets das fontes Symbol e Wingdings viram "•".

## Ferramentas de PDF: juntar, dividir e comprimir

**Objetivo:** abrir PDFs que já existem e juntar vários num só, separar páginas e reduzir o tamanho. Tudo no navegador, como o resto do app.

### A base comum: ler PDF

Hoje o app só **escreve** PDF. As três funções dependem de **ler** um PDF de qualquer origem, e essa é a parte difícil:

- Tabela xref clássica e xref em stream (PDF 1.5+)
- Object streams (objetos comprimidos dentro de outros objetos)
- Streams com `FlateDecode`, descompactados com `DecompressionStream('deflate')`, que é nativo
- Atualizações incrementais (vários `%%EOF` no mesmo arquivo)
- Atributos herdados da árvore de páginas: `Resources`, `MediaBox`, `CropBox` e `Rotate`
- Arquivo com xref quebrada: reconstruir varrendo os `n 0 obj`

**Fora do escopo:** PDF com senha ou criptografado. O app avisa e recusa.

**Juntar e dividir são a mesma operação:** escolher páginas de um ou mais PDFs e gravar um PDF novo. Isso encaixa na lista de páginas que o app já tem. Abrir um PDF adiciona as páginas dele à lista, e elas podem ser reordenadas, removidas e misturadas com fotos (e futuramente com .docx).

### Decisão em aberto: miniaturas das páginas

Para ler e copiar páginas não é preciso **desenhar** o PDF. Para mostrar miniaturas, é. São duas opções:

1. **Sem renderizador:** a página aparece como um cartão ("PDF X, página 3", com o tamanho e a orientação). Assim não há dependência, mas é mais difícil saber qual página é qual.
2. **Com o [pdf.js da Mozilla](https://github.com/mozilla/pdf.js)** (Apache-2.0) em `web/vendor/`, carregado só quando necessário: miniaturas reais, mas com uns 1–2 MB a mais e uma dependência nova. Pela regra 4 do CONTRIBUTING, precisa de conversa antes. O nome também conflita com o nosso `web/js/pdf.js`, que teria que mudar.

Dá para começar pela opção 1 e decidir a 2 depois.

### Fase 1: ler PDF

- [x] Leitor de PDF (`web/js/pdf-reader.js`):
  - [x] objetos
  - [x] xref clássica e em stream
  - [x] object streams
  - [x] árvore de páginas com herança
- [x] Copiar uma página com tudo o que ela usa (fontes, imagens, conteúdo), renumerando os objetos no PDF novo
- [x] `pdf.js` (escritor): aceitar páginas copiadas de outro PDF, além das de imagem (e de texto, do .docx)

### Fase 2: juntar e dividir

- [x] `accept` do input e `addFiles` aceitam `.pdf`
- [x] Cada página do PDF entra na lista como uma página do tipo `pdf`. Recorte e filtros ficam escondidos, e girar fica disponível, usando `/Rotate`.
- [x] **Juntar:** abrir vários PDFs e gerar um só
- [x] **Dividir:**
  - [x] gerar um PDF só com as páginas que ficaram na lista
  - [x] opção "um PDF por página" ou por intervalos (ex.: 1-3, 4-10)
  - [x] vários arquivos de saída: baixar um por um ou compartilhar todos de uma vez (`navigator.share` com vários arquivos)

### Fase 3: comprimir

O ganho depende do tipo de PDF, e isso precisa estar claro na interface:

- **PDF escaneado ou de fotos** é o que mais diminui: as imagens são recodificadas em JPEG com qualidade e resolução menores. A imagem JPEG (`DCTDecode`) é desenhada no canvas e exportada de novo.
- **PDF de texto** (gerado pelo Word, por exemplo) quase não diminui. O tamanho está nas fontes, e reduzir fontes (subsetting) fica fora do escopo.

Tarefas:

- [x] Recodificar imagens `DCTDecode`, limitando o lado maior (reaproveitar os níveis de `QUALITY`)
- [x] Recodificar imagens `FlateDecode` em RGB ou cinza, com preditores PNG. CMYK, `Indexed` e máscaras ficam como estão.
- [x] Comprimir com `CompressionStream('deflate')` os streams que estão sem compressão
- [x] Descartar objetos não usados e versões antigas de atualizações incrementais (a cópia só leva o que as páginas usam)
- [x] Mostrar "antes → depois". Se o arquivo não diminuir, avisar e manter o original.

### Segurança e privacidade

- **PDF malicioso:** o app só lê a estrutura. Nada do PDF é executado: JavaScript, `/OpenAction` e `/Launch` são descartados na saída.
- **Limites:** número de objetos, profundidade de referências, tamanho descompactado (bomba de compressão) e número de páginas. Acima disso, recusar com mensagem clara.
- **Metadados dos PDFs de entrada:** `/Info` e XMP (autor, programa, datas) **não** vão para a saída, mantendo a regra de PDF sem metadados.
- **Assinatura digital:** juntar, dividir ou comprimir um PDF assinado (gov.br, ICP-Brasil) **invalida a assinatura**. O app precisa detectar `/Sig` e avisar antes, porque é um caso comum no Brasil e o usuário pode achar que o documento continua válido.
- **Links e formulários:** decidir o que preservar (ver perguntas abaixo). Links externos (`/URI`) no PDF de saída não geram requisição no app, só no leitor de PDF de quem abrir.

### Testes

- [x] PDFs pequenos montados pelos próprios testes (`test/helpers/pdf.js`):
  - [x] PDF gerado pelo próprio app
  - [x] PDF com xref em stream
  - [x] PDF com atualização incremental
  - [x] PDF com xref quebrada
  - [x] PDF criptografado (deve recusar)
- [x] Juntar: número de páginas, ordem e xref válida
- [x] Dividir: intervalos e páginas com atributos herdados
- [x] Comprimir: tamanho menor em PDF de fotos e original mantido quando não diminui
- [x] Saída sem `/Info`, XMP nem JavaScript
- [x] Detecção de assinatura digital
- [ ] Abrir os PDFs gerados no Acrobat, no Chrome e no visualizador do iPhone

### Decisões

- **Miniaturas:** começou sem renderizador (um cartão com o formato da folha) e passou a usar o PDF.js da Mozilla 6.3.289 (`web/vendor/pdfjs/`, ~1,7 MB, carregado só quando aparece um PDF), a pedido, para dar para ver as páginas. O cartão continua como reserva se o desenho falhar. O nosso gerador continua sendo o `js/pdf.js`; o PDF.js só desenha (`js/pdf-render.js`).
- **Prévia do resultado:** antes de gerar, o app mostra os arquivos que vão sair e as páginas de cada um, acompanhando a opção "Gerar", os intervalos e o nome do arquivo.
- **Links e campos de formulário:** não são copiados como anotações. O que eles mostram (o valor preenchido num campo, um carimbo, o selo de uma assinatura) é desenhado na própria página, então o PDF novo fica igual ao que se via, mas sem nada clicável nem editável.
- **PDF assinado:** o app avisa que a assinatura deixa de valer no PDF novo e deixa seguir.
- **Versão:** ler, juntar, dividir e comprimir saem junto com o .docx, na v2.0.0.
- **Comprimir:** é a opção "Imagens dos PDFs" (manter, comprimir com a qualidade Leve ou com a Equilibrada). Quando o PDF é pesado por causa de imagens (1 MB ou mais de imagens recomprimíveis, pelo menos 40% do arquivo), o app já liga a compressão e mostra um aviso no topo da lista, com um botão para manter o original; se a pessoa já escolheu a opção, o app não mexe. Máscaras de transparência (SMask) também ficam como estão. PDF assinado: só o aviso que já aparece ao abrir, como em juntar e dividir.

### Perguntas em aberto

- Dividir em vários arquivos: limite de arquivos por vez, por causa da memória no celular?
