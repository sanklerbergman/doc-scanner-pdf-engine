# Melhorias

Planejamento de funcionalidades maiores. Ideias menores ficam em [CONTRIBUTING.md](CONTRIBUTING.md#ideias-de-próximos-passos).

## O que vale para toda melhoria

Toda funcionalidade nova precisa cumprir estes pontos antes de qualquer outra coisa. São as [regras do CONTRIBUTING](CONTRIBUTING.md#regras-que-não-negociamos) aplicadas ao planejamento:

- **Nenhum dado da pessoa chega ao projeto.** Isso vale para arquivos, texto, certificado, senha, estatística de uso e relatório de erro. Não existe servidor para receber nada disso.
- **Tudo roda no aparelho**, com a CSP como está (`connect-src 'none'`). Se uma ideia só funciona com rede, ela fica fora do escopo, e o plano diz isso.
- **Nada fica guardado.** Não se usa `localStorage`, IndexedDB nem opção de "lembrar". Segredos (senha e chave) ficam na memória só durante a operação e são descartados depois.
- **O PDF leva só o que a pessoa vê e escolhe**, sem metadados escondidos. Quando algo pessoal precisa entrar no arquivo (o certificado, numa assinatura), o app avisa antes.
- **Biblioteca nova** entra só em `web/vendor/`, com versão, origem e SHA-256, e carrega só quando precisa. O Worker dela nasce de um blob para herdar a CSP.
- **Funções pesadas são opcionais** e vêm desligadas: quem não usa não baixa nada a mais.

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
- [x] Teste real no iPhone, no site publicado

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
- [x] Abrir os PDFs gerados no Acrobat, no Chrome e no visualizador do iPhone

### Decisões

- **Miniaturas:** começou sem renderizador (um cartão com o formato da folha) e passou a usar o PDF.js da Mozilla 6.3.289 (`web/vendor/pdfjs/`, ~1,7 MB, carregado só quando aparece um PDF), a pedido, para dar para ver as páginas. O cartão continua como reserva se o desenho falhar. O nosso gerador continua sendo o `js/pdf.js`; o PDF.js só desenha (`js/pdf-render.js`).
- **Prévia do resultado:** antes de gerar, o app mostra os arquivos que vão sair e as páginas de cada um, acompanhando a opção "Gerar", os intervalos e o nome do arquivo.
- **Links e campos de formulário:** não são copiados como anotações. O que eles mostram (o valor preenchido num campo, um carimbo, o selo de uma assinatura) é desenhado na própria página, então o PDF novo fica igual ao que se via, mas sem nada clicável nem editável.
- **PDF assinado:** o app avisa que a assinatura deixa de valer no PDF novo e deixa seguir.
- **Versão:** ler, juntar, dividir e comprimir saem junto com o .docx, na v2.0.0.
- **Comprimir:** é a opção "Imagens dos PDFs" (manter, comprimir com a qualidade Leve ou com a Equilibrada). Quando o PDF é pesado por causa de imagens (1 MB ou mais de imagens recomprimíveis, pelo menos 40% do arquivo), o app já liga a compressão e mostra um aviso no topo da lista, com um botão para manter o original; se a pessoa já escolheu a opção, o app não mexe. Máscaras de transparência (SMask) também ficam como estão. PDF assinado: só o aviso que já aparece ao abrir, como em juntar e dividir.

### Perguntas em aberto

- Dividir em vários arquivos: limite de arquivos por vez, por causa da memória no celular?

## Reconhecer texto (OCR)

**Objetivo:** transformar fotos e PDFs escaneados em **PDF pesquisável**. A imagem continua igual, e embaixo dela vai uma camada de texto invisível, que dá para selecionar, copiar e buscar (Ctrl+F). Tudo no navegador, como o resto do app.

**Por que importa:** hoje um documento escaneado vira um PDF só de imagem. Não dá para buscar um nome num contrato de 20 páginas nem copiar um número de protocolo.

**Fora do escopo:**

- **Letra de mão:** o reconhecimento é para texto impresso, e o app avisa.
- **OCR na nuvem** (Google, Azure ou qualquer "IA" online): mandaria a imagem para fora do aparelho. Descartado.
- **API do próprio navegador** (`TextDetector`): é experimental e não existe no Safari do iPhone. Pode virar um atalho no futuro, se virar padrão.
- **Transformar o escaneado em documento editável (Word):** é outro problema. O objetivo aqui é a camada pesquisável.

### Abordagem

**Motor:** o [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0), que é o Tesseract compilado para WebAssembly. É o único motor maduro que roda offline no navegador e tem modelo de português. Os arquivos ficam em `web/vendor/tesseract/` e só carregam quando a pessoa liga o OCR:

| Arquivo | Origem | Tamanho |
| --- | --- | --- |
| `worker.min.js` | `tesseract.js@7.0.0` | ~0,11 MB |
| `tesseract-core-*-lstm.wasm.js` (três variantes: o aparelho baixa só a que ele suporta, com ou sem SIMD) | `tesseract.js-core@7.0.0` | ~3,9 MB cada |
| Modelo de português (`4.0.0_best_int/por.traineddata.gz`) | `@tesseract.js-data/por@1.0.0` | ~1,4 MB |

Quem usa o OCR baixa uns 5,5 MB uma vez. Depois os arquivos ficam no cache do service worker, como acontece com o PDF.js.

**Como funciona sem rede (e sem afrouxar a CSP):**

- O Worker do Tesseract nasce de um blob, então herda o `connect-src 'none'`, como os Workers dos filtros e do PDF.js.
- O núcleo vem nos arquivos `.wasm.js`, que têm o WebAssembly embutido e são carregados por `importScripts`. Isso já é coberto pelo `script-src 'self' 'wasm-unsafe-eval'` atual.
- O Tesseract.js baixa o modelo com `fetch`, e a CSP bloqueia isso. Em vez de abrir uma exceção, o modelo vira um módulo JS (`por.traineddata.js`, com o `.gz` em base64, ~1,9 MB), gerado por um script em `scripts/`. Os bytes são passados direto ao worker (`loadLanguage` com `{ code: 'por', data }`).
- O app conversa direto com o worker do Tesseract.js, pelo protocolo dele, sem a biblioteca da página (`tesseract.esm.min.js`): na 7.0.0 ela manda os bytes do modelo no lugar do nome do idioma ao inicializar, e o Tesseract não inicia (ver `web/vendor/tesseract/README.md`).
- `cacheMethod: 'none'`: por padrão, o Tesseract.js guarda o modelo no IndexedDB. Isso fica desligado, porque a CSP não bloqueia o IndexedDB e a regra é não guardar nada.

**A camada de texto no PDF:**

- Cada palavra reconhecida entra na posição (caixa) que o Tesseract devolve, convertida para a posição da imagem na página (margem, tamanho do papel e rotação).
- O texto é invisível (`3 Tr`) e usa a Helvetica com `WinAnsiEncoding`, a mesma do .docx. O tamanho da letra sai da altura da linha, e a largura é ajustada com `Tz`, para a seleção cair em cima da palavra.
- O texto entra como string hexadecimal, nunca colado cru no content stream. Assim, um `)` ou um `\` reconhecido na imagem não consegue quebrar o PDF.
- Caracteres fora da fonte padrão viram "?", como no .docx.

**Onde roda:**

- **Páginas de foto:** na imagem que vai para o PDF, depois do recorte, do filtro e da rotação. O filtro "Documento" ajuda no resultado.
- **Páginas de PDF:** o PDF.js, que já está no app, desenha a página. O Tesseract lê o desenho, e o app acrescenta à página copiada um content stream com o texto invisível. Páginas que já têm texto (`getTextContent`) são puladas.
- **Páginas de documento (.docx):** já têm texto de verdade, então são puladas.

### Fases

#### Fase 1: fotos

- [x] Copiar o Tesseract.js, o núcleo e o modelo para `web/vendor/tesseract/`, com um `README.md` (versão, origem, SHA-256 do `.tgz` e de cada arquivo, licenças)
- [x] Script em `scripts/` que gera o `por.traineddata.js` a partir do `.gz` e confere o SHA-256 (`scripts/gerar-modelo-ocr.mjs`)
- [x] `web/js/ocr.js`:
  - [x] carregar só quando o OCR for ligado
  - [x] Worker de blob, com `cacheMethod: 'none'` e sem `logger`
  - [x] um Worker por vez, encerrado (`terminate`) no fim, para liberar a memória. Dois só onde o navegador diz que sobra memória (`deviceMemory` de 8 GB ou mais, 4 núcleos ou mais e 3 páginas ou mais para ler, `ocr-plan.js`); o Safari não informa a memória, e no iPhone continua um só
- [x] Reduzir a imagem antes do OCR: a imagem do PDF serve quando o lado maior está entre 2000 e 3500 px; abaixo disso (qualidade Leve), a foto é desenhada de novo com 2400 px. Medido em 10 fotos de documento (2026-10-17): o tempo de leitura cresce bem menos que os pixels (1600 → 2400 px: +19%; 2400 → 3500: +30%), e o texto certo, pouco (99,2%, 99,3% e 99,7%). A 1600 px fica 16% mais rápido, mas perde letra miúda; na qualidade Alta, a cópia reduzida a 3500 lê melhor que a imagem de 3508 px direto (98,7% contra 98,0%)
- [x] `pdf.js`: páginas de imagem aceitam uma camada de texto invisível
- [x] Interface:
  - [x] opção "Texto pesquisável (OCR)", desligada por padrão
  - [x] progresso por página ("Reconhecendo o texto: página 2 de 5") e botão de cancelar
- [x] Resultado guardado na memória, por página, e descartado se a pessoa mudar o recorte, o filtro ou a rotação
- [x] Novos arquivos em `APP_FILES` e aumento da versão de `CACHE` no `web/sw.js`. O vendor fica fora do `APP_FILES` e entra no cache quando é usado, como o PDF.js

#### Fase 2: PDFs escaneados

- [x] Desenhar a página com o PDF.js na resolução do OCR
- [x] Pular páginas que já têm texto
- [x] Acrescentar o content stream e a fonte à página copiada, sem mexer no que já existe. Recursos compartilhados entre páginas são copiados antes de mudar (`copyPages`, opção `ocr`; a camada saiu do `pdf.js` para o `ocr-layer.js`, que os dois usam)
- [x] Respeitar `/Rotate`, `MediaBox` e `CropBox`
- [x] Página de PDF tarjada (que vira imagem) também é lida, já tarjada, e o que o OCR achar sob uma tarja sai
- [x] A busca de dados para tarjar também lê as páginas escaneadas pelo OCR

#### Fase 3: acabamento

- [x] "Copiar texto" na tela cheia da página (área de transferência, local), em `page-text.js`:
  - foto e página escaneada pelo OCR, que roda na hora se precisar e fica guardado para gerar o PDF; PDF com texto pelo PDF.js; Word pelo layout
  - página tarjada sem nada do que está sob as tarjas: PDF tarjado lido pelo OCR na imagem tarjada, como vai para o arquivo; Word pelo mesmo `redactLayout` e conferido pelo mesmo `textUnderRedactions` do PDF montado (se sobrar texto sob uma tarja, nada é copiado)
  - no Safari, `ClipboardItem` com a promessa do texto, para não perder o toque enquanto o OCR roda; sem ele, `writeText`. Fechar a tela ou trocar de página cancela o OCR, e o motor sai da memória
- [x] Aviso quando a confiança for baixa (o Tesseract dá uma nota para cada palavra): "parte do texto pode ter saído errada", no fim da geração, com o número das páginas. Limites medidos com o Tesseract do app em 56 imagens, no Chromium e no WebKit (iguais nos dois): a página tem confiança baixa com média abaixo de 82 (ponderada pelos caracteres) ou com mais de 20% do texto em palavras com nota abaixo de 70. Documento nítido fica entre 90 e 95; desfocado, tremido, com pouca resolução, foto de tela e letra de mão, abaixo de 80. Palavra com nota abaixo de 70 estava certa em só 14% dos casos (com 90 ou mais, em 95%). A nota não mostra o que o Tesseract leu errado com certeza (riscos do scanner) nem o que ele pulou (sombra forte)
- [x] Ruído fora da camada de texto: sai só a palavra sem nenhuma letra ou dígito (e sem §, &, %, $, @ ou #) com nota abaixo de 50 ("|", ":", "==", "«"). Nas medições, umas 80 de 19 mil palavras, quase todas lixo. Palavra com letra ou dígito nunca sai: o CPF chegou a vir partido em duas palavras certas com nota 0
- [x] Desempenho, medido no desktop com 10 fotos de documento de 12 MP e um PDF escaneado (14 páginas, 13 lidas):
  - o JPEG da página sai enquanto o worker lê, e a foto original sai da memória antes da leitura; o motor liga junto com a primeira foto. Com dois workers, a página seguinte já fica pronta enquanto a anterior é lida. Total: no Chromium, de 16,5 s para 7,4 s (34 páginas: de 46 s para 19 s); no WebKit, com um worker, de 23,5 s para 21,1 s. O texto reconhecido não mudou
  - no WebKit, a memória do worker do Tesseract cresce uns 4 MB a cada página e só volta quando ele é encerrado (40 páginas: +130 MB). Ele é trocado a cada 10 leituras (`RECYCLE_AFTER`), e a memória fica no nível das primeiras páginas; custa uns 0,3 s a cada 10 páginas
  - ao ligar a opção, o modelo já começa a carregar (`preloadOcr`), sem ligar o worker: numa rede de 10 Mbit/s, a primeira leitura começa em 4,2 s em vez de 6,8 s
  - andamento com o tempo que falta, pela média das páginas já lidas ("falta mais ou menos 1 minuto"), também na busca de dados
  - ficaram de fora, medidos: `tessedit_do_invert: '0'` (1% a 3% mais rápido, mas perde texto branco em fundo escuro: um cabeçalho azul caiu de 92% para 81%), resolução menor e ler a próxima página antes de a atual acabar com um worker só (33% mais rápido no WebKit, mas uns 56 MB a mais: fica fora no caminho do iPhone)
- [x] Busca de dados com o CPF que o OCR partiu na pontuação ("123.456" e ".789-09"): número e pontuação a menos de uma linha e meia continuam juntos
- [x] Página torta (foto sem fundo para recortar, folha que entrou torta no scanner, PDF escaneado torto): medido com o Tesseract do app num documento nítido, girado 3° saíam de 42% a 64% do texto, e de 5° a 12°, de 0 a 52%, quase sempre com nota alta (o aviso de confiança baixa não pegava). Agora:
  - antes de ler, o app mede a inclinação pela projeção das bordas de cima e de baixo do que é escuro (`textSkew`, em `geometry.js`, uns 20 ms). Nas 56 imagens de teste e em 10 fotos de documento, nenhuma página reta mediu 2° ou mais (a mais torta, 1,8°), e as tortas, de 2,5° a 15°, saíram com o ângulo certo
  - abaixo de 2°, a página é lida como está, como antes. Endireitar toda página (`rotateAuto` em todas) deixava a leitura uns 10% mais lenta e às vezes pior: uma foto difícil, com cabeçalho branco em fundo azul, carimbo e assinatura, caía de 92% para 63% das palavras certas
  - de 2° a 3°, lida dos dois jeitos, e fica a leitura com mais texto bom: lendo como está, o Tesseract já perde linhas inteiras (PDF escaneado a 2,5°: as linhas do CPF e do CEP sumiram); endireitando, às vezes piora
  - de 3° em diante, o Tesseract mede o ângulo dele e endireita a imagem antes de ler (`rotateAuto`, que já vem no worker do Tesseract.js); com 7° ou mais, às vezes ele não acha linha nenhuma, e aí lê de novo com o ângulo do app. Sem linhas para medir (ruído forte, sombra, figura grande), vai o `rotateAuto`, como reserva
  - resultado: de 97% a 99,9% das palavras certas de 3° a 8° (antes, de 2% a 95%), e uns 97% a 12°, no Chromium e no WebKit; a página torta leva de 1,2 a 1,8 s, contra 1,0 a 1,25 s da reta. Acima de 15°, nada muda
  - a imagem do PDF continua como estava (torta): as palavras voltam para a imagem original, e a camada de texto vai inclinada (`Tm` girada, combinada com o `/Rotate`), com a seleção em cima da palavra. Na página reta, o PDF sai idêntico byte a byte
  - para as tarjas, a palavra torta vale pela caixa reta que a envolve (`filterWords` tira toda palavra que encosta na tarja), e a conferência do PDF montado mede o texto inclinado pelos quatro cantos, com a mesma regra dos 30% da altura. A busca de dados acha CPF, CNPJ e CEP na página torta, agrupando as palavras pela linha que o OCR leu (pela altura, as palavras de uma linha torta 2° já não se encontravam); a tarja sugerida é um retângulo reto, maior que o dado
- [ ] Inglês como segundo idioma, se houver pedido (mais um modelo para baixar)

### Segurança e privacidade

- **A imagem e o texto não saem do aparelho.** O Worker não tem rede (herda a CSP) e nada é enviado. Se algum caminho do Tesseract tentar baixar alguma coisa, a CSP bloqueia e o OCR falha com uma mensagem, em vez de vazar.
- **Nada guardado:** sem IndexedDB (`cacheMethod: 'none'`). O texto reconhecido só existe na memória e some ao limpar a lista ou fechar a aba. Nada vai para o console.
- **Texto escondido continua sendo texto.** O PDF com OCR leva, invisível, tudo o que estava escrito (CPF, endereço, valores), e o app avisa isso na própria opção. Também avisa sobre tarjas: uma tarja desenhada depois por cima da imagem, em outro programa, não apaga o texto invisível que está embaixo. Quem precisa tarjar deve fazer isso antes do OCR, ou não usar o OCR nesse documento.
- **O texto reconhecido é dado, nunca código:** no PDF ele entra como string hexadecimal, e na tela só por `textContent`.
- **Limites:** o tamanho da imagem fica entre 2000 e 3500 px. O número de páginas não é limitado (decidido em 2026-10-17, com as medidas da fase 3): a memória que crescia a cada página no WebKit fica contida pela troca do worker, e o tempo é avisado (o que falta, a partir da segunda página, e, com 20 páginas ou mais, que pode levar alguns minutos).
- **PDF assinado:** acrescentar texto altera a página, e a assinatura deixa de valer. O aviso que já aparece ao abrir cobre esse caso.

### Testes

- [x] Camada de texto montada a partir de um resultado de OCR simulado (palavras e caixas fixas): texto com `3 Tr`, posições dentro da página e rotação (`test/ocr.test.js`)
- [x] `(`, `)`, `\` e acentos não quebram o content stream
- [x] PDF sem OCR continua idêntico byte a byte
- [x] PDF escaneado: a página sem texto ganha a camada, com recursos só dela, e as outras páginas não mudam; com `/Rotate` e CropBox deslocada, o texto fica de pé e em cima da palavra (`test/ocr.test.js`, com o qpdf)
- [x] No navegador (Chromium e WebKit, Tesseract de verdade), num PDF escaneado de teste: a página com texto é pulada, as escaneadas ganham o texto certo e na posição certa (conferido com o PyMuPDF), inclusive a girada pelo `/Rotate`, a gravada deitada e endireitada no app e a tarjada
- [x] No navegador: nenhuma requisição na aba Rede e nada no IndexedDB durante o OCR (Playwright, no Chromium e no WebKit, com e sem o service worker)
- [x] Teste real no iPhone, no site publicado: validado pelo dono no iPhone 16e, no site publicado, na v3.5.0 (2026-10-16)
- [x] Montagem do texto copiado (palavras do OCR, trechos do PDF e do Word, com tarja), notas de qualidade, número de workers e tempo que falta (`test/page-text.test.js`, `test/ocr.test.js`, `test/ocr-plan.test.js`)
- [x] No navegador (Chromium e WebKit): gerar com OCR, cancelar no meio e com o motor ainda ligando, gerar de novo, busca de dados e "Copiar texto": nenhum worker do Tesseract fica vivo no fim
- [x] No navegador (Chromium e WebKit): "Copiar texto" em foto, PDF escaneado (inclusive com `/Rotate`), PDF com texto e Word; cancelar no meio, área de transferência recusada e foto em branco; aviso de confiança baixa no fim da geração, que some depois de endireitar a página; nenhuma requisição e nada guardado
- [x] Página torta: volta das coordenadas (com as do worker de verdade), camada inclinada, página com `/Rotate 90`, PDF/A no veraPDF e conferência das tarjas pelos quatro cantos (`test/geometry.test.js`, `test/ocr.test.js`, `test/redact.test.js`). No navegador (Chromium e WebKit): foto torta 8° e PDF escaneado a 8° e -5°, com 97% do texto extraído pelo PDF.js, as caixas do texto em cima das palavras tortas, e as 12 tarjas sugeridas pela busca conferidas sem sobrar dado no texto. A busca de dados acha CPF, CNPJ, CEP e telefone na foto e no PDF escaneado de -2,5° a 8° (só falha quando o OCR lê o número errado)
- [ ] "Copiar texto" no iPhone 16e, no site publicado (o `ClipboardItem` com promessa depois de vários segundos de OCR)
- [ ] Página torta no Acrobat e no leitor do Chrome (o PDF.js do Firefox e o `pdftotext` quebram mais as linhas do texto inclinado ao copiar, como nos PDFs do próprio Tesseract; cada palavra sai certa)
- [ ] Limite da confiança baixa com fotos reais de câmera no iPhone (as 56 imagens da calibragem são sintéticas)
- [ ] Tempo por página e pico de memória no iPhone 16e com 10 e 30 páginas
- [ ] Seleção do texto no Acrobat

### Decisões

- **Dependência nova:** o Tesseract.js é a quarta biblioteca em `web/vendor/`. Pela regra 4 do CONTRIBUTING, isso precisa de conversa antes; este plano é essa conversa, e o pedido veio do dono do projeto.
- **Desligado por padrão:** pesa ~5,5 MB e leva alguns segundos por página no celular.
- **Modelo `best_int`:** é o que o Tesseract.js usa com o motor LSTM e o menor (~1,4 MB). O modelo maior (~6,8 MB) só acrescenta o motor antigo, que não será usado.
- **Versão:** sai na v3.0.0, junto com a assinatura digital. A fase 2 (PDFs escaneados) sai na próxima versão. A fase 3 (copiar texto e aviso de confiança baixa), a página torta e o desempenho saem na v3.6.0 (2026-10-17).
- **O OCR lê a página como ela aparece no app** (decidido em 2026-10-16), com o `/Rotate` do PDF e o giro escolhido, como nas fotos: é assim que a pessoa deixa de pé uma página que o scanner gravou deitada. O texto vai para o PDF com o giro total. Girar a página depois faz o OCR ler de novo.
- **Assinar sem reescrever não combina com o OCR:** com o OCR ligado, as páginas mudam, e o app monta um PDF novo para assinar.

### Perguntas em aberto

- Quanto tempo e memória o iPhone 16e gasta com 10 e 30 páginas? No desktop, de 1 a 1,5 s por página. Limitar as páginas por vez não foi preciso (ver Limites); falta a medida no aparelho.

## Assinatura com certificado digital (ICP-Brasil)

**Objetivo:** assinar o PDF com o certificado digital da pessoa (e-CPF ou e-CNPJ), no padrão PAdES, que o Adobe Acrobat e o [validador do ITI](https://validar.iti.gov.br) reconhecem. O certificado, a senha e o documento não saem do aparelho.

**Que certificado dá para usar:** só o **A1**, que é um arquivo (`.pfx` ou `.p12`) protegido por senha. Quem tem o A1 instalado no Windows pode exportar pelo Gerenciador de Certificados, marcando "exportar a chave privada".

**Fora do escopo, e por quê:**

- **A3 (token USB ou cartão):** o navegador não conversa com o token sem um programa instalado no computador, e as extensões que fazem isso são de terceiros e de código fechado. No celular, esse caminho nem existe. O app explica e indica o programa do próprio token.
- **Certificado em nuvem** (BirdID, VIDaaS, SafeID, NeoID e outros): a assinatura acontece no servidor da certificadora, então o app precisaria conversar com ele. Isso quebra o `connect-src 'none'`.
- **Assinatura gov.br:** é feita no site do gov.br, com o envio do arquivo para lá.
- **Carimbo do tempo** (servidor de data e hora) e **dados de revogação** (OCSP/CRL) para validação de longo prazo: exigem rede. A assinatura sai no nível básico (PAdES B-B), com a data e a hora do relógio do aparelho.
- **Validar assinaturas de outras pessoas:** a validação completa precisa consultar a revogação online. Para isso existem o validador do ITI e o Acrobat.

### Abordagem

A parte que importa, que é **assinar com a chave privada, é feita pelo próprio navegador**, com o Web Crypto (`RSASSA-PKCS1-v1_5` com SHA-256). O código do app só lê o arquivo do certificado e monta as estruturas, então não é preciso biblioteca nova.

1. **Ler o `.pfx`** (PKCS#12, em `web/js/pkcs12.js`), com um leitor ASN.1/DER próprio (`web/js/asn1.js`):
   - conferir a senha pelo MAC do arquivo (KDF do PKCS#12, com SHA-1 ou SHA-256);
   - decifrar a chave e os certificados. Os arquivos novos usam PBES2 (PBKDF2 com AES), que o Web Crypto já faz. Os exportados pelo Windows e por certificadoras mais antigas costumam usar **3DES** e **RC2-40**, que o Web Crypto não tem. Esses dois entram em JS, só para decifrar (`web/js/legacy-ciphers.js`);
   - importar a chave com `importKey('pkcs8', …)`, não extraível e só para `sign`, e zerar os bytes decifrados logo em seguida.
2. **Escolher o certificado** do titular (o que tem a mesma chave pública) e montar a cadeia. Conferir no aparelho a validade (contra o relógio), o uso da chave (`digitalSignature` ou `nonRepudiation`) e o tamanho da chave RSA (2048 bits ou mais).
3. **Mostrar para confirmar:** titular, emissor e validade.
4. **Montar o PDF com um espaço reservado** para a assinatura:
   - campo de assinatura (`/AcroForm` com `/SigFlags 3` e widget invisível, `/Rect [0 0 0 0]`, na fase 1);
   - dicionário `/Type /Sig` com `/Filter /Adobe.PPKLite`, `/SubFilter /ETSI.CAdES.detached`, `/ByteRange` e `/Contents` preenchido com zeros;
   - sem `/Name`, `/Reason`, `/Location` nem `/ContactInfo`. A única data é o `/M` (hora da assinatura), que faz parte do padrão. É a única exceção à regra de PDF sem datas, e só existe quando a pessoa assina.
5. **Assinar:** calcular o SHA-256 dos bytes fora do `/Contents` e montar um CMS `SignedData` destacado (`web/js/cms.js`) com os atributos assinados `contentType`, `messageDigest` e `signingCertificateV2` (exigido pelo PAdES). O Web Crypto assina, e o DER vai, em hexadecimal, para o espaço reservado. O tamanho do CMS é conhecido antes de assinar (a assinatura RSA tem o tamanho da chave), então a reserva é exata, com uma folga pequena.
6. **Conferir antes de entregar:** o app refaz o hash, confere o `messageDigest` e verifica a assinatura com a chave pública (`crypto.subtle.verify`). Se algo não bater, o arquivo não é entregue.

**Assinar é sempre o último passo.** Qualquer mudança depois (OCR, compressão, girar uma página) invalida a assinatura. Por isso a ordem ao gerar é: montar as páginas, reconhecer o texto, comprimir e, por fim, assinar. O arquivo assinado é exatamente o que a prévia mostrou.

### Fases

#### Fase 1: assinar o PDF que o app gera

- [x] `asn1.js`: leitor e escritor DER (inteiros, OIDs, sequências, sets ordenados e datas). O leitor também aceita BER (comprimento indefinido e strings em pedaços), como o Windows grava o `.pfx`
- [x] `pkcs12.js`: MAC, PBES2, 3DES e RC2-40, com mensagem clara para senha errada e arquivo corrompido (3DES e RC2 em `legacy-ciphers.js`)
- [x] `cms.js`: `SignedData` destacado com os atributos do PAdES
- [x] `pdf.js`: campo de assinatura, espaço reservado, `/ByteRange` e preenchimento
- [x] Autoconferência da assinatura antes de entregar (`sign.js`, que também lê o certificado com o `x509.js`)
- [x] Interface:
  - [x] "Assinar com certificado digital (A1)", junto de "Gerar PDF"
  - [x] escolher o `.pfx`, digitar a senha, ver titular e validade e confirmar
  - [x] aviso de que o certificado vai junto no PDF (ver Segurança)
- [x] Vários arquivos de saída (dividir): a senha é pedida uma vez para todos, e a chave é descartada no fim
- [x] Novos arquivos em `APP_FILES` e aumento da versão de `CACHE` no `web/sw.js`

#### Fase 2: carimbo visível e coassinatura

- [x] Carimbo visível opcional, desligado por padrão ("Assinado digitalmente por NOME em dd/mm/aaaa às hh:mm (UTC-3)"), na página e na posição escolhidas, com prévia (`web/js/stamp.js`). Mostra só o nome: no e-CPF, o CPF vem depois do ":" no nome do certificado e fica de fora do carimbo
  - [x] é a aparência do próprio campo de assinatura, não um desenho no conteúdo da página: serve também para o PDF que já existe
  - [x] página (primeira, última ou o número) e um de seis lugares (em cima ou embaixo; à esquerda, no centro ou à direita), escolhidos na página como ela aparece, com o `/Rotate` e a CropBox
  - [x] nome comprido diminui a letra e, no limite, é cortado com reticências; o que as fontes padrão não têm vira "?"
- [x] **Assinar um PDF que já existe sem reescrever o arquivo** (atualização incremental, `web/js/pdf-append.js`): o original fica intacto, e a assinatura nova vai no fim. É o que permite que duas pessoas assinem o mesmo contrato, uma depois da outra, sem invalidar a primeira assinatura
  - [x] regrava só o que precisa apontar para o campo novo (a página ou a lista `/Annots`, e o catálogo, o formulário ou a lista `/Fields`), com o mesmo número; a tabela xref nova é do mesmo tipo da última do original (clássica ou em stream), com `/Prev`
  - [x] nome do campo sem repetir os que já existem ("Assinatura", "Assinatura 2"…)
  - [x] conferência antes de entregar: o original continua byte a byte no começo, e o PDF assinado reabre com as mesmas páginas e sem reparo
  - [x] só acrescenta em estrutura limpa: o arquivo termina na tabela xref que o leitor usou (sem uma atualização cortada depois dela), `/Size` coerente, geração válida e igual na referência e no objeto que vai ser regravado, e toda página com MediaBox. PDF danificado que o leitor ainda abre vai pelo caminho de sempre (o PDF novo), que conserta essas coisas (achado do fuzzing com o qpdf)
- [x] Respeitar o `/DocMDP`: se o PDF foi certificado sem permitir alterações, recusar e explicar o motivo. Vale a permissão mais restritiva, inclusive a de `/FieldMDP` com `/P` (PDF 2.0)

#### Fase 3: política da ICP-Brasil e cadeia

**Adiada** (decisão do dono, 2026-10-16): só começa depois que alguém com um A1 real testar as fases 1 e 2 no validador do ITI. Sem esse teste, não dá para saber se a política AD-RB é exigida, e a fase inteira seria conferida só com certificado de teste.

- [ ] Identificador da política de assinatura da ICP-Brasil (AD-RB), se o validador do ITI exigir isso para mostrar a assinatura como conforme (ver perguntas)
- [ ] Certificados raiz da ICP-Brasil embutidos (são públicos), para avisar quando o certificado não é da ICP-Brasil ou a cadeia está incompleta. A revogação continua sem consulta
- [ ] ECDSA, se aparecer certificado A1 com curva elíptica

### Segurança e privacidade

Esta é a parte mais sensível do app. Com o `.pfx` e a senha, qualquer pessoa assina **em nome do titular**. Por isso:

- **Nada sai do aparelho:** o arquivo, a senha e a chave só existem na memória da aba. O `connect-src 'none'` vale para a página e para os Workers, então não há rede por onde vazar.
- **Nada fica guardado:** não existe "lembrar certificado" nem "lembrar senha", nem `localStorage` ou IndexedDB. Cada assinatura pede o arquivo e a senha de novo.
- **A chave não volta para o JS:** ela é importada como não extraível e só serve para `sign`. Os bytes decifrados são zerados logo depois da importação, e as referências à chave são soltas ao terminar. Limite conhecido: a senha é uma string do JS, que não dá para apagar da memória; ela some quando a aba é fechada.
- **Campo de senha:** fica fora de formulário (o `form-action 'none'` já impede envio), com `autocomplete="off"`, e é limpo logo depois do uso. Nunca vai para a URL nem para o console. O navegador pode oferecer guardar a senha, mas o app não pede isso.
- **Sem logs:** nada do certificado (nome, CPF, número de série) vai para o console ou para mensagens de erro.
- **O que vai no PDF é avisado antes:** a assinatura leva o certificado da pessoa, com nome e CPF (ou CNPJ). É assim que quem recebe confere quem assinou, e não tem como assinar sem isso. Fora o certificado, nada: sem `/Name`, `/Reason`, `/Location`, `/ContactInfo`, `/Info` ou XMP. A exceção é o XMP de identificação do padrão, quando a pessoa liga o PDF/A (ver a seção PDF/A).
- **A assinatura cobre o que a pessoa viu:** ela é feita sobre os bytes finais, e a prévia mostra esse arquivo. Nada muda depois.
- **Assinatura conferida antes de sair** (passo 6): um erro na montagem nunca vira um PDF "assinado" que não valida.
- **Certificado vencido ou que não serve para assinar:** o app recusa e diz o motivo.
- **Cópia falsa do site:** quem hospeda uma cópia modificada pode roubar o `.pfx` e a senha. A tela de assinatura pede para conferir se a barra de endereço mostra o endereço oficial, e o README reforça isso.
- **Código de criptografia próprio:** o 3DES e o RC2 só **decifram** o arquivo da própria pessoa, no aparelho. A operação com a chave (assinar) é do navegador. Os algoritmos próprios são testados com os vetores oficiais.
- **Coassinatura (fase 2):** no modo incremental o original não é reescrito, então os metadados e o que mais ele tiver continuam lá. O app avisa na janela de assinatura: "O PDF segue exatamente como veio, com o que ele tiver dentro (metadados, links, campos)".
- **SECURITY.md:** acrescentar "certificado ou senha saindo do aparelho, ou ficando guardados" na lista do que conta como falha.

### Testes

- [x] Certificados **de teste**, com dados fictícios (titular "PESSOA DE TESTE", CPF fictício), gerados com o OpenSSL e guardados em `test/fixtures/certificados/` com os comandos anotados (`gerar.sh`). **Nunca** usar certificado real no repositório nem nos testes
- [x] `.pfx` com AES (padrão do OpenSSL 3), com 3DES e RC2 (opção `-legacy`, como sai do Windows), com senha errada, corrompido, vencido e sem cadeia. Também em BER, sem uso para assinar, com chave de 1024 bits e com curva elíptica
- [x] 3DES e RC2 com os vetores oficiais (NIST e RFC 2268), e o KDF do PKCS#12 conferido contra o OpenSSL
- [x] `/ByteRange` cobre o arquivo todo, menos o `/Contents`; o `messageDigest` bate; e a assinatura é verificada com o `node:crypto` e com o `openssl cms -verify` (com a cadeia de teste)
- [x] Saída sem `/Name`, `/Reason`, `/Location`, `/Info` nem XMP (com PDF/A, só o XMP de identificação)
- [x] PDF sem assinatura continua idêntico byte a byte
- [x] Coassinatura: a primeira assinatura continua válida depois da segunda, inclusive quando a primeira foi feita por outro programa (PDFs assinados pelo pyHanko com o certificado de teste, em `test/fixtures/assinados/`, gerados pelo `gerar.py` de lá). Conferido com o `node:crypto`, o `openssl cms -verify` e o qpdf; à mão, com o validador do pyHanko, que também analisa o que mudou depois de cada assinatura
- [x] Carimbo: lugar certo e de pé nos quatro giros, com CropBox deslocada; texto, tamanho e corte do nome
- [x] PDF certificado: recusado sem permissão de alteração; com permissão 2, assinado sem carimbo e aceito pelo pyHanko
- [x] Fuzzing: todo PDF que abre também recebe uma assinatura acrescentada (só a estrutura) e tem que reabrir sem reparo
- [x] Certificados de teste no formato do e-CPF A1 (várias OU, dados da pessoa física no subjectAltName, política no ramo da ICP-Brasil) e um segundo titular, para a coassinatura
- [ ] Manual, com o certificado de teste: painel de assinaturas do Acrobat Reader. Ele avisa que a identidade é desconhecida (o certificado não é da ICP-Brasil), mas tem que dizer que o documento não foi alterado depois de assinado. Conferir também com `openssl cms -verify` e, se der, com o `pdfsig` (Poppler)
- [ ] Manual, com um A1 de verdade: `validar.iti.gov.br`, num documento sem nada sensível. Esse envio ao ITI é uma escolha de quem testa, fora do app. Ainda não há um A1 válido para isso (ver perguntas)
- [x] Teste real no iPhone, no site publicado: escolher o `.pfx` no app Arquivos e assinar, validado pelo dono no iPhone 16e, no site publicado, na v3.5.0 (2026-10-16)

### Decisões

- **Só A1 e só PAdES básico (B-B):** é o que dá para fazer sem rede e sem programa instalado.
- **Sem biblioteca nova:** o leitor de PKCS#12 e a montagem do CMS são próprios, e quem assina é o Web Crypto. A alternativa seria copiar o node-forge ou o PKI.js para `web/vendor/`, que são maiores e trazem muito mais do que o necessário.
- **Carimbo visível desligado por padrão:** a assinatura vale do mesmo jeito sem ele, e o nome da pessoa só aparece desenhado na página se ela escolher. Lugar padrão: embaixo, à direita, na última página.
- **Carimbo com o PDF/A** (v3.7.0, #10): a aparência do carimbo leva a Liberation Sans embutida, como as páginas do Word. Até a v3.6.0, um desligava o outro.
- **Assinar sem reescrever é automático** (decidido em 2026-10-16): quando a lista é um PDF só, inteiro, na ordem, sem giro, tarja, compressão, senha nova nem divisão. Se algo mudou, o app monta um PDF novo, como antes, e avisa que as assinaturas que o PDF tinha deixam de valer. PDF assinado e pesado não liga mais a compressão sozinho.
- **PDF com senha ou com a xref danificada:** o app monta um PDF novo para assinar (acrescentar num arquivo cifrado exigiria cifrar os objetos novos com a chave dele) e avisa que as assinaturas anteriores deixam de valer.
- **PDF certificado (com permissão de assinar):** a assinatura entra sem carimbo. O Acrobat aceita um campo visível novo depois da certificação, mas outros validadores (o pyHanko, por exemplo) dão a certificação como violada, e não se sabe de que lado fica o do ITI.
- **Sem A1 real:** a fase 2 foi feita e conferida só com os certificados de teste, e a fase 3 fica adiada (decidido em 2026-10-16). Quem tiver um A1 testa depois, no próprio aparelho, e conta o resultado.
- **Versão:** sai na v3.0.0, junto com o OCR.

### Perguntas em aberto

- O validador do ITI aceita como aprovada uma assinatura PAdES sem o identificador da política AD-RB, ou a política é obrigatória na ICP-Brasil (DOC-ICP-15)? Só um A1 válido responde, e hoje não há nenhum para teste. Até lá, a fase 1 é conferida com o certificado de teste (Acrobat, OpenSSL), e a fase 3 espera. Caminhos possíveis: alguém da comunidade com A1 testar no próprio aparelho e contar o resultado (sem mandar o arquivo nem o certificado para o projeto), ou um A1 comprado quando chegar a hora de publicar.
- Assinar vários arquivos de uma vez (dividir): é preciso um limite?

## PDF/A (arquivamento e tribunais)

**Objetivo:** uma opção para gerar o PDF no padrão **PDF/A-2b** (ISO 19005-2), o formato de arquivamento de longo prazo que alguns tribunais pedem no processo eletrônico. Na tela, o PDF continua igual. O que muda é o que vai dentro do arquivo, para ele não depender de nada de fora: fontes e perfil de cor embutidos e a identificação do padrão.

**Por que importa:** alguns sistemas de processo eletrônico pedem PDF/A. A Justiça do Trabalho, por exemplo, pede na petição inicial do PJe, segundo aviso de um TRT. Hoje o app não gera PDF/A, e quem precisa costuma recorrer a sites de conversão, que recebem o documento.

**Fora do escopo:**

- **Converter qualquer PDF em PDF/A:** as páginas copiadas de outro PDF vêm como estão, com fontes não embutidas, cores sem perfil, transparências e formulários. Consertar isso é trabalho de um conversor completo (Ghostscript, Acrobat). Se a lista tiver página de outro PDF, a opção fica indisponível e o app diz o motivo.
- **Validar o PDF/A de outros arquivos:** para isso existe o veraPDF.
- **PDF/A-1 e PDF/A-3:** o 1 é mais restritivo sem ganho aqui, e o 3 só acrescenta arquivos anexos, que o app não usa.

### Abordagem

O que falta no PDF de hoje para ele ser PDF/A-2b:

1. **Identificação do padrão (XMP):** um fluxo `/Metadata` no catálogo, sem compressão, só com `pdfaid:part` (2) e `pdfaid:conformance` (B). O padrão não exige autor, título, datas nem nome do programa, então nada disso entra e a regra de PDF limpo continua valendo.
2. **Identificador do arquivo:** `/ID` no trailer, derivado de um hash do próprio conteúdo. Não é aleatório: o mesmo documento gera o mesmo `/ID`, e ele não identifica o aparelho nem a sessão.
3. **Perfil de cor:** um `/OutputIntents` com um perfil ICC sRGB embutido. As fotos (JPEG em `DeviceRGB` e `DeviceGray`) passam a valer por ele. O perfil é montado pelo próprio código (`web/js/icc.js`: cabeçalho, ponto branco, matriz e curva do sRGB, uns 500 bytes), sem arquivo de terceiros.
4. **Fontes embutidas nas páginas de Word:** hoje o texto usa Helvetica, Times e Courier sem embutir, e o PDF/A exige a fonte dentro do arquivo.
   - As fontes vêm da família **Liberation** (SIL OFL 1.1), que tem as mesmas larguras de Arial/Helvetica, Times New Roman e Courier New. Ficam em `web/vendor/liberation/` e só carregam quando a pessoa liga o PDF/A e há página de Word.
   - Vai só o **subconjunto** das letras usadas (`web/js/ttf.js`: tabelas `glyf`, `loca`, `hmtx` e `cmap` reduzidas). Sem isso, cada fonte acrescentaria centenas de KB ao PDF.
   - A fonte entra como TrueType simples, com `WinAnsiEncoding` e `ToUnicode`, para o texto continuar selecionável e pesquisável. Caracteres fora da codificação continuam virando "?", como hoje.
   - Com o PDF/A ligado, a distribuição do texto (`layout.js`) passa a usar as larguras da fonte embutida, para o texto desenhado bater com o calculado.
5. **O que o app já cumpre:** cabeçalho com marca de arquivo binário, sem criptografia, sem JavaScript, sem LZW, sem `/Info` e sem transparência nas páginas de foto.

**Com o OCR e a assinatura (v3.0.0):**

- **OCR:** no PDF/A-2, a fonte usada só em texto invisível (`3 Tr`) não precisa ser embutida. A camada do OCR continua com a Helvetica sem embutir, o que precisa ser conferido no veraPDF.
- **Assinatura:** PAdES e PDF/A-2b combinam. O widget invisível precisa da flag de impressão (`/F 4`). Com o PDF/A ligado, o arquivo assinado leva o XMP de identificação; fora isso, valem as regras da seção da assinatura.

### Fases

#### Fase 1: fotos

- [x] `icc.js`: perfil sRGB (ICC v2, matriz e curva)
- [x] `pdf.js`: opção `pdfa` em `buildPdf`, com XMP mínimo, `/ID` e `/OutputIntents`. O `/ID` é o MD5 do conteúdo (`md5.js`, que saiu do `pdf-crypt.js` para o `pdf.js` usar sem dependência circular)
- [x] Interface:
  - [x] opção "PDF/A (tribunais e arquivamento)", desligada por padrão
  - [x] indisponível, com o motivo, quando a lista tem página de PDF ou de Word (Word entra na fase 2), e quando "Proteger o PDF com senha" está ligado (o PDF/A não permite criptografia); com o PDF/A ligado, a senha fica indisponível
  - [x] o resumo do PDF pronto mostra "PDF/A-2b"
- [x] Novos arquivos em `APP_FILES` e aumento da versão de `CACHE` no `web/sw.js`

#### Fase 2: documentos do Word

- [x] Copiar as fontes Liberation 2.1.5 (normal, negrito, itálico e negrito itálico das três famílias) para `web/vendor/liberation/`, com um `README.md` (versão, origem, SHA-256 e licença). Cada `.ttf` vira um módulo JS em base64 (`scripts/gerar-fontes-pdfa.mjs`, que confere o SHA-256), como o modelo do OCR: a página não pode usar `fetch`
- [x] `ttf.js`: ler larguras e `cmap` e gerar o subconjunto (os números das letras ficam; as não usadas ficam vazias e sem largura; as partes das letras compostas vão junto; cmap (3,1) refeito só com as letras usadas; sem GSUB, GPOS e kern; post formato 3)
- [x] ~~`layout.js` e `fonts.js`: larguras da fonte embutida quando o PDF/A está ligado~~ Não precisou: as Liberation têm as larguras das fontes padrão em toda a WinAnsi, menos ¯ ± µ · ÷ (até 0,4 ponto de diferença em letra 12). O layout continua o mesmo, e o `/Widths` vem da fonte embutida
- [x] `pdf.js`: fonte TrueType com `FontFile2` (subconjunto, FlateDecode), `WinAnsiEncoding` e `ToUnicode` (`pdfa-fonts.js` prepara, uma vez para todos os arquivos)
- [x] Medir quanto cada fonte acrescenta ao PDF: uns 10 KB por fonte (de 9,7 a 11,4 KB com umas 60 letras diferentes). Na primeira vez, o app baixa cada fonte usada (de 0,4 a 0,55 MB)
- [x] A camada do OCR das fotos divide a Helvetica com o Word: quando ela vai embutida, leva também as letras do OCR. Sem página de Word, continua sem embutir (texto invisível)
- [x] Conferido no veraPDF: Word (as 12 fontes), Word com foto e OCR, e Word assinado; e pela tela, no Chromium e no WebKit

#### Fase 3: junto com a v3.0.0

- [x] PDF/A com a camada do OCR (nas fotos): a Helvetica sem embutir passa, porque só desenha texto invisível (`3 Tr`); conferido no veraPDF
- [x] PDF/A com a assinatura (o widget já tem a flag de impressão: `/F 132` = Print + Locked), conferindo no veraPDF que o arquivo continua PDF/A depois de assinado

### Segurança e privacidade

- **Tudo no aparelho:** nenhum serviço de conversão, e a CSP continua a mesma.
- **Metadado novo, só com a opção ligada:** o XMP leva apenas a identificação do padrão. Sem autor, título, datas ou programa.
- **`/ID` sem rastreio:** sai do conteúdo, não de um número aleatório nem de dados do aparelho.
- **Arquivos de terceiros:** só as fontes, em `web/vendor/`, com SHA-256 e carregadas sob demanda. O perfil de cor é gerado pelo código.
- **A fonte é dado, não código:** o leitor de TrueType só copia tabelas e confere tamanhos e deslocamentos, para um arquivo malformado não travar o app.

### Testes

- [x] PDF sem a opção continua idêntico byte a byte
- [x] Com a opção: catálogo com `/Metadata` e `/OutputIntents`, trailer com `/ID`, e XMP só com `pdfaid` (`test/pdfa.test.js`)
- [x] `/ID` igual para o mesmo conteúdo e diferente quando o conteúdo muda
- [x] Perfil ICC: tamanho no cabeçalho, assinatura `acsp` e tags obrigatórias
- [ ] Subconjunto TrueType: as letras usadas estão lá, as larguras batem com as da fonte original, e o arquivo abre no fontTools (`ttx`)
- [x] **veraPDF** (validador de referência, código aberto, roda em Java), perfil PDF/A-2B: fotos, fotos com OCR e PDF assinado, no `npm test` quando a variável `VERAPDF` aponta o programa (`verapdf --flavour 2b --format xml arquivo.pdf`). Também conferidos os PDFs baixados do app no Chromium e no WebKit. Falta avaliar rodar no CI
- [ ] Manual: o Acrobat mostra a faixa de "arquivo em conformidade com PDF/A"
- [x] Teste real no iPhone, no site publicado: validado pelo dono no iPhone 16e, no site publicado, na v3.5.0 (2026-10-16)

### Decisões

- **PDF/A-2b:** é o nível mais aceito e o que o app consegue garantir para fotos e Word.
- **Desligado por padrão:** a maioria não precisa, e no Word as fontes aumentam o arquivo.
- **Liberation em vez de outra família livre:** é a que tem as larguras das fontes que o app já usa, então o documento quebra as linhas do mesmo jeito. As fontes entram em `web/vendor/`, o que pela regra 4 do CONTRIBUTING precisa de conversa antes; este plano é essa conversa, e o pedido veio do dono do projeto.
- **Versão:** a fase 1 (fotos), com o OCR e a assinatura, sai na v3.4.0. A fase 2 (Word) sai na próxima versão (decidido em 2026-10-16, sem esperar a confirmação dos tribunais).
- **Carimbo da assinatura com o PDF/A** (v3.7.0, #10): a aparência do carimbo leva a Liberation Sans normal e negrito embutidas, pelo mesmo caminho do Word (ver "Arrastar, lupa e carimbo com PDF/A").
- **PDF/A e senha não se combinam:** o PDF/A proíbe criptografia; com um ligado, o outro fica indisponível, com o motivo.

### Perguntas em aberto

- Quais sistemas de processo eletrônico conferem de fato o PDF/A no envio, e quais só recomendam?
- Vale mirar o PDF/A-2u (todo texto com Unicode)? O texto do Word já sai com `ToUnicode`; falta ver se a camada do OCR com `WinAnsiEncoding` passa no veraPDF.
- Aceitar páginas de PDFs que já são PDF/A (o original declara `pdfaid`)? Seria preciso conferir as fontes e as cores de cada página copiada.

## Ideias vindas do PdfCraft

O [PdfCraft](https://github.com/storytold/pdfcraft) (Rust, licença MIT ou Apache-2.0) foi analisado em outubro de 2026. O código dele **não entra no app**:

- é Rust compilado para WebAssembly, e exigiria uma etapa de build;
- tem cerca de 750 arquivos, grande demais para auditar como as bibliotecas de `web/vendor/`;
- está em fase alfa, e o próprio README diz que o fuzzing ainda encontra travamentos com arquivos maliciosos.

Três ideias dele valem a pena e estão planejadas abaixo. A licença permite estudar o código e portar trechos, com crédito. A lista de "informações ocultas" dele também revelou uma falha no app: o conteúdo de camadas ocultas aparecia no PDF juntado. A correção saiu na v2.0.1 (`web/js/pdf-layers.js`).

## Tarjar dados (de verdade)

**Objetivo:** cobrir partes do documento (CPF, endereço, número de conta, assinatura) **apagando** o que está embaixo, e não só pintando por cima. Tudo no aparelho.

**Por que importa:** a tarja feita com um retângulo preto no Word ou num editor de PDF deixa o texto embaixo, e dá para selecionar e copiar. É um vazamento comum em documentos enviados a processos e a órgãos públicos.

**Fora do escopo:**

- **Tarja que só desenha por cima:** é justamente o erro que esta função evita.
- **Busca automática em foto sem OCR:** a busca só funciona onde há texto. Em foto, a tarja é manual até o OCR da v3.0.0.

### Abordagem

A referência é o módulo de tarja do PdfCraft, que segue três princípios: apagar o conteúdo sob a área, conferir o resultado relendo a página e falhar em vez de deixar algo para trás. O app segue os mesmos princípios, com um caminho mais simples para cada tipo de página:

- **Foto:** a tarja pinta os pixels da imagem antes de ela ir para o PDF. O que estava embaixo deixa de existir.
- **Word:** o próprio app distribui o texto, então os trechos sob a tarja não entram no PDF, e a caixa é desenhada no lugar.
- **Página de outro PDF:** a página vira imagem (o PDF.js já desenha as páginas), a tarja pinta os pixels e a página entra no PDF como foto. Perde o texto selecionável dessa página, mas não sobra nada embaixo. Editar o conteúdo do PDF, como o PdfCraft faz, preserva o texto, mas é muito mais código e mais risco; fica para depois, se houver pedido.
- **Conferência:** depois de montar, o app relê o PDF novo e confere que não há texto dentro de nenhuma área tarjada. Se houver, o PDF não é entregue.

**Busca automática (opcional):** sugere tarjas para CPF e CNPJ (com dígito verificador), e-mail, telefone, CEP e número de cartão (com o dígito de Luhn). Os padrões do PdfCraft são americanos (SSN, telefone dos EUA), então os do app são próprios. A pessoa confirma cada sugestão.

### Fases

#### Fase 1: tarja manual em fotos e documentos do Word

- [x] Na tela cheia da página, "Tarjar": arrastar retângulos, ver as tarjas da página e desfazer. Pelo teclado, "Nova tarja" cria uma no meio da página, as setas movem, Shift e setas mudam o tamanho e Delete remove
- [x] Foto: pintar os pixels antes de gerar o JPEG. Com o OCR ligado, o reconhecimento roda na foto já tarjada, e o que ele achar sobre a tarja também sai
- [x] Word: tirar da distribuição do texto os trechos sob a tarja (letra por letra) e desenhar a caixa por cima de tudo. Imagem do documento sob a tarja tem os pixels pintados
- [x] A miniatura mostra as tarjas
- [x] As tarjas giram junto com a página; mudar o recorte de uma foto apaga as tarjas dela, com aviso (elas cobririam outro lugar)

#### Fase 2: páginas de PDF e conferência

- [x] Página de PDF com tarja vira imagem, na resolução da qualidade escolhida
- [x] Conferência do PDF novo: nenhum texto dentro das áreas tarjadas. O PDF.js relê o PDF montado (com um worker só para isso, encerrado no fim), antes de assinar ou proteger com senha; se não carregar, o PDF também não sai
- [x] Aviso de que a página tarjada perde o texto selecionável

#### Fase 3: busca automática

- [x] Padrões brasileiros, com dígito verificador onde existe (`web/js/find-data.js`): CPF e CNPJ, inclusive o CNPJ alfanumérico da Receita (2026), e-mail, telefone (DDD válido), CEP e cartão (Luhn)
- [x] Busca no texto do Word e no texto dos PDFs (PDF.js, `getTextContent`); nas fotos, depois do OCR (que roda na hora da busca, se ainda não rodou, e fica guardado para gerar o PDF)
- [x] Cada sugestão confirmada pela pessoa: uma janela lista os dados por página, com caixas de marcar, e só o que fica marcado vira tarja

### Segurança e privacidade

- **Apagar de verdade:** nunca só desenhar por cima.
- **Falha fechada:** se a conferência encontrar texto sob uma tarja, o PDF não sai.
- **Os dados encontrados pela busca** só existem na memória e não vão para o console.
- **Limites avisados:** a tarja não alcança cópias do documento que já existem, e PDF assinado perde a assinatura (o aviso atual já cobre isso).

### Testes

- [x] Foto: os pixels sob a tarja têm só a cor da tarja (no navegador, Chromium e WebKit)
- [x] Word: o texto sob a tarja não está no PDF, nem depois de descompactar (`test/redact.test.js`)
- [x] PDF: a página tarjada é só imagem, e nenhum texto dela fica no arquivo (no navegador)
- [x] Conferência: um PDF montado de propósito com texto sob a tarja é recusado (no Node, a regra; no navegador, com o PDF.js)
- [x] Padrões: CPF e CNPJ válidos e inválidos, com e sem pontuação, e falsos positivos comuns (número de processo, datas, valores, boleto) (`test/find-data.test.js`)
- [x] Teste real no iPhone, no site publicado: validado pelo dono no iPhone 16e, no site publicado, na v3.5.0 (2026-10-16)

### Decisões

- **Página de PDF vira imagem:** é o caminho sem chance de sobrar texto. O preço é perder o texto selecionável na página tarjada, e o app avisa.
- **Sem biblioteca nova.**
- **Só a caixa preta, sem texto** ("tarjado" ou parecido): é o padrão em documentos enviados a processos e órgãos públicos. Dá para mudar se o dono preferir.
- **Uma letra do Word sai quando a tarja cobre pelo menos 20% da altura dela**; encostar na linha de cima ou de baixo não tira nada. A conferência acusa texto com 30% ou mais da altura sob a tarja.
- **Versão:** a tarja manual e a conferência (fases 1 e 2) saem na v3.2.0; a busca automática (fase 3), na v3.3.0.
- **Posição de cada letra na busca:** no Word, exata (as larguras das fontes padrão); no PDF e na foto, estimada pela largura das letras numa fonte parecida, com uma margem a mais na tarja. A pessoa confere em tela cheia.
- **CNPJ alfanumérico só com a máscara** (XX.XXX.XXX/XXXX-DV): sem a pontuação, qualquer palavra de 14 letras e números poderia parecer um.

### Perguntas em aberto

- Vale, no futuro, tarjar editando o conteúdo do PDF, para preservar o texto da página?

## Abrir PDF com senha

**Objetivo:** abrir PDFs protegidos por senha para juntar, separar e comprimir, como os outros. É o caso de contracheques, extratos e faturas, que muitas vezes usam parte do CPF como senha. Opcional: gerar o PDF novo com senha.

**Por que importa:** hoje o app recusa esses PDFs e pede que a pessoa salve uma cópia sem senha em outro programa.

**Fora do escopo:**

- **Descobrir ou quebrar senha:** o app só abre com a senha que a pessoa digita. Também não sugere senha (nem CPF).
- **PDF cifrado com certificado digital** (em vez de senha): é outro mecanismo, raro, e fica de fora.

### Abordagem

- Implementa o mecanismo de senha padrão do PDF, revisões 2 a 6: RC4 de 40 e 128 bits, AES-128 e AES-256.
- O navegador faz o AES (Web Crypto, AES-CBC) e os hashes SHA-256, SHA-384 e SHA-512. O app traz em JS só o que o Web Crypto não tem: o MD5 e o RC4, pequenos e testados com os vetores oficiais. Os dois são fracos e só servem para ler arquivos antigos, nunca para gerar.
- A senha é normalizada com SASLprep (revisão 6), como manda a norma.
- Primeiro tenta a senha vazia: muitos PDFs têm só restrições, sem senha para abrir.
- Strings e streams são decifrados ao ler os objetos, e o PDF novo sai sem criptografia, com aviso.
- A referência para conferir o resultado é o módulo `crypt` do PdfCraft e os testes dele. Se algum trecho for portado, ele leva o crédito e a licença.

### Fases

#### Fase 1: abrir

- [x] `pdf-crypt.js`: chave a partir da senha (revisões 2 a 6), RC4, MD5 e decifragem por objeto
- [x] `pdf-reader.js`: decifrar strings e streams; parar de recusar PDF com `/Encrypt`. Todos os objetos são decifrados ao abrir, e a chave é descartada em seguida
- [x] Interface: pedir a senha quando a vazia não abre, com mensagem clara para senha errada (e "Pular este arquivo")
- [x] Aviso: "O PDF novo sai sem senha" (e, no PDF só com restrições, que elas não valem no PDF novo)
- [x] PDF que só cifra os anexos (`/EFF`) abre sem senha: o documento em si não é cifrado
- [x] As miniaturas (PDF.js) são desenhadas de uma cópia já decifrada, para a senha não precisar ficar guardada

#### Fase 2: proteger o PDF gerado

- [x] Opção "Proteger o PDF com senha" ao gerar: AES-256 (revisão 6), só com senha de abertura e sem senha de proprietário escondida (a de proprietário é a mesma, e nada é restrito)
- [x] Junto com a assinatura: o PDF é cifrado antes de ser assinado, e o `/Contents` da assinatura fica sem cifrar, como a norma manda

### Segurança e privacidade

- **A senha só existe na memória:** não fica guardada, não vai para o console nem para mensagens de erro. O campo fica fora de formulário, com `autocomplete="off"`, e é limpo depois do uso.
- **Nada sai do aparelho:** a decifragem é local, como o resto.
- **Aviso do PDF sem senha:** a pessoa pode estar contando com a proteção do original.
- **Permissões do autor:** ver as perguntas em aberto.

### Testes

- [x] PDFs de teste cifrados com o qpdf, em cada revisão, com os comandos anotados (`test/fixtures/pdf-senha/gerar.mjs`): senha de abertura, só senha de proprietário e senha com acentos
- [x] Senha errada, senha vazia e senha Unicode
- [x] MD5 (RFC 1321) e RC4 com os vetores oficiais
- [x] O conteúdo decifrado bate com o `qpdf --decrypt` do mesmo arquivo
- [x] PDF protegido pelo app: o qpdf e o PDF.js abrem com a senha e recusam a errada; o conteúdo volta igual
- [x] Varredura com os 994 PDFs de teste do PDF.js: nenhum que abria deixou de abrir, e 13 dos cifrados passaram a abrir sem senha (só restrições ou só anexos). Os que pedem senha abrem com a senha do manifesto do PDF.js
- [x] Teste real no iPhone, no site publicado: validado pelo dono no iPhone 16e, no site publicado, na v3.5.0 (2026-10-16)

### Decisões

- **AES pelo navegador e só MD5 e RC4 em JS:** menos código próprio de criptografia.
- **Versão:** sai na v3.1.0, com as duas fases (decisão do dono em 2026-10-16).
- **Permissões do autor não são respeitadas** (decisão do dono em 2026-10-16). Um PDF pode abrir sem senha e mesmo assim proibir alterações, incluindo juntar e separar páginas; o Acrobat e o PdfCraft pedem a senha de proprietário nesse caso. O app abre do mesmo jeito, porque o uso comum é justamente juntar o contracheque com outros documentos, e só avisa que o PDF novo sai sem as restrições.

## Testes com PDFs maliciosos e conferência dos PDFs gerados

**Objetivo:** garantir que nenhum PDF, quebrado ou feito para atacar, trave o app, estoure a memória ou gere um PDF inválido. O app abre arquivos de qualquer origem, então isso é segurança, não só qualidade.

### Abordagem

- **Conferência independente no CI:** os PDFs que os testes geram passam pelo `qpdf --check`, instalado pelo apt do Ubuntu, além do próprio leitor do app.
- **Varredura de arquivos reais:** um script local (`scripts/varrer-pdfs.mjs`) abre, junta, divide e comprime cada PDF de uma pasta, com tempo limite por arquivo, e anota travamentos, erros inesperados e lentidão. A base é o conjunto de testes do PDF.js (cerca de mil arquivos, muitos quebrados de propósito), como o PdfCraft faz com o motor dele.
- **Fuzzing simples:** variações dos PDFs de teste (bytes trocados, arquivo cortado, números absurdos), rodando o leitor com tempo limite.
- Cada problema encontrado vira um teste de regressão.

### Segurança

- Os arquivos da varredura são de terceiros e tratados como não confiáveis: ficam numa pasta própria, fora do repositório (também por causa do tamanho e das licenças variadas), e o script só os lê.
- Nada disso roda no navegador de quem usa o app; é só para quem desenvolve.

### Fases

- [x] `qpdf --check` nos PDFs gerados pelos testes, no CI (`test/helpers/qpdf.js`)
- [x] Script de varredura e primeira rodada no conjunto do PDF.js, com as correções
- [x] Fuzzing (`scripts/fuzz-pdf.mjs`, e uma rodada curta em todo `npm test`)

### Resultado da primeira rodada

- **Varredura** dos 989 PDFs do conjunto do PDF.js: nenhum travamento, erro inesperado ou estouro de memória; o mais lento levou 1,3 s. Achou PDFs com senha recusados como "corrompidos" (9 arquivos, com a xref em stream) e uma página com `/Resources` inválido copiada para o PDF gerado. Os 6 recusados como corrompidos não são recuperáveis nem pelo qpdf.
- **Fuzzing:** achou travamentos (contagens absurdas na xref, `/First` negativo), erros inesperados (`/Filter`, `/Annots` e `/Fields` de tipo errado) e PDFs gerados inválidos (`/Contents` com o que não é stream, números como `1e+25`, `Infinity` e `NaN`). Achou também, por tabela, o conteúdo da página sumindo quando o `/Contents` é uma lista indireta e a página tem anotação visível. Depois das correções, centenas de milhares de variações passaram sem falha.
- **O que fica como está:** dado corrompido dentro de um stream (imagem ou texto da página) é copiado byte a byte, como sempre foi; o PDF gerado mostra o que o original mostrava. O script só aponta como falha do app o problema que a entrada não tinha.

### Decisões

- **Versão:** são melhorias internas; entram na próxima versão que sair. As correções no leitor de PDF são patch.
- **O fuzzing do `npm test`** usa 20 mil variações fixas (semente 1), em uns 5 segundos. Rodadas com outras sementes ou com PDFs reais como base ficam no script.
- **Etapas novas no fuzzing (2026-10-16):** a camada do OCR (com palavras simuladas) e a assinatura acrescentada sem reescrever. No PDF com a assinatura acrescentada, o original vai byte a byte, com os defeitos dele, e o qpdf os descreve de outro jeito; ali só conta erro do qpdf que a entrada não tinha, e o trecho acrescentado é conferido à parte (número e geração de cada objeto novo, e a xref nova apontando para ele).

## Arrastar, lupa e carimbo com PDF/A (v3.7.0)

Três melhorias pequenas para o uso do dia a dia, planejadas em 2026-10-24. Nenhuma precisa de biblioteca nova nem mexe na CSP. Cada uma tem a sua issue: arrastar para reordenar (#8), lupa no recorte (#9) e carimbo com PDF/A (#10).

### Arrastar para reordenar as páginas

Hoje a página muda de lugar só pelos botões "Mover para antes" e "Mover para depois", uma posição por toque. Com 20 páginas, levar a última para o começo custa 19 toques.

- **Alça no cartão**, um ícone de arrastar junto do número da página: segurar e arrastar leva o cartão para outro lugar da lista. Só a alça arrasta (`touch-action: none` nela). No resto do cartão, o dedo continua rolando a lista, e o toque na miniatura continua abrindo a tela cheia.
- **Pointer Events**, como nos cantos do recorte e nas tarjas. A API de arrastar do HTML (drag and drop) fica de fora: no Safari do iPhone ela não responde ao dedo do mesmo jeito, e no computador se confundiria com soltar arquivos na área de adicionar.
- Enquanto arrasta, o cartão acompanha o dedo, e os outros abrem espaço onde ele vai entrar. A lista (`state.pages`) só muda ao soltar.
- Perto da borda de cima ou de baixo da tela, a página rola sozinha, para levar um cartão de uma ponta à outra de uma lista comprida.
- A grade tem de uma a várias colunas, conforme a largura da tela: o lugar de soltar sai da posição dos cartões nas duas direções, não só da altura.
- Soltar no mesmo lugar não muda nada e não descarta o PDF já gerado. Esc, ou o navegador cancelar o toque, devolve o cartão ao lugar.
- Os botões ← e → continuam: são o caminho do teclado, do leitor de tela e de quem não consegue arrastar (WCAG 2.5.7). Por isso a alça fica fora do Tab e escondida do leitor de tela: ela não faz nada que os botões não façam. Ao soltar, o leitor de tela ouve "Página 3 movida para a posição 1".
- Com o app ocupado (gerando o PDF), a alça fica desligada, como os botões.
- O lugar de soltar sai do centro do cartão arrastado, não do dedo: a alça fica embaixo de um cartão alto, e pelo dedo descer uma posição custaria uns 100 px e subir, uns 500 px. A conta acha primeiro a linha e depois a coluna (`web/js/reorder.js`).
- Numa coluna só, os outros cartões andam a altura do arrastado, porque foto e PDF têm alturas diferentes; na grade, cada um vai para o lugar do vizinho. O cartão arrastado fica preso dentro da lista: sem isso, a página cresceria a cada passo e a rolagem automática não pararia.
- A rolagem automática vale numa faixa de 80 px nas bordas e acelera até 3× em 2 s com o dedo parado. Com 12 páginas no tamanho do iPhone, de uma ponta à outra leva uns 4 a 5 s.

Fases:

- [x] Funções puras de mover um item e de achar o lugar de soltar pelos retângulos dos cartões, com testes
- [x] Alça, cartão acompanhando o dedo, espaço aberto na lista, rolagem automática e cancelamento
- [x] Anúncio para o leitor de tela e conferência no Chromium e no WebKit (mouse) e no Chromium (toque), no tamanho do iPhone 16e e em 1280 × 800. Falta o Safari do iPhone

### Lupa ao arrastar os cantos do recorte

O dedo cobre justamente o canto que a pessoa está arrastando, e acertar a borda do papel no celular vira tentativa e erro.

- Enquanto um canto é arrastado, aparece um círculo com a foto ampliada em volta dele, com uma mira no ponto exato do canto e as duas linhas do recorte que saem dele. Some ao soltar.
- É desenhada num `<canvas>`, a partir da mesma imagem do recorte, que já está na memória. Sem `background-image` com endereço e sem nada novo na CSP.
- Ampliação de 3× sobre a foto como ela aparece na tela, num círculo de uns 120 px.
- Fica acima do dedo, numa distância que o dedo não cobre. Perto da borda de cima da tela, vai para baixo ou para o lado, e nunca sai da tela.
- Aparece com qualquer ponteiro (dedo, caneta ou mouse). Pelas setas do teclado não aparece, porque nada cobre o canto.
- Fica fora da árvore de acessibilidade (`aria-hidden`) e não recebe toque (`pointer-events: none`).
- Ficou assim: 120 px, 3×, com a borda a 48 px do dedo. Perto do topo, vai para o lado com mais espaço; sem espaço, para baixo; sempre a 8 px da borda da tela. A posição é uma função pura (`loupeCenter`, em `viewer.js`), com testes.
- A mira é um anel em volta do ponto, não uma cruz, para não tampar as linhas do recorte. As linhas pegam a cor do polígono (vermelhas quando os cantos se cruzam).
- A foto do recorte tem no máximo 1280 px no lado maior, então a lupa sai um pouco suave.

Fases:

- [x] Lupa no canvas, posição em volta do dedo sem sair da tela, mira e linhas do recorte
- [x] Conferência no Chromium e no WebKit (390 × 664 e 1280 × 800), com foto em pé e deitada, por mouse e, no Chromium, por toque. Falta o Safari do iPhone

### Carimbo da assinatura com o PDF/A

Hoje um desliga o outro ("Indisponível com o PDF/A: o texto do carimbo precisaria de fonte embutida"). O carimbo usa Helvetica e Helvetica-Bold sem embutir, e o PDF/A exige fonte embutida em todo texto que aparece.

- Com o PDF/A ligado, a aparência do carimbo leva a Liberation Sans normal e negrito, embutidas e só com as letras usadas, pelo mesmo caminho das páginas do Word (`pdfa-fonts.js` e `ttf.js`). Sem o PDF/A, o carimbo continua como está, com as fontes padrão.
- Quando o documento já embute a mesma fonte para o Word, o carimbo usa o mesmo objeto, com as letras dos dois.
- O subconjunto leva as letras do nome, as do texto fixo e todos os algarismos, porque a data e a hora só são decididas na hora de assinar.
- O desenho do carimbo não muda: as Liberation têm as larguras das fontes padrão em toda a WinAnsi (menos ¯ ± µ · ÷, com até 0,4 ponto de diferença), e o `/Widths` vem da fonte embutida.
- Com o PDF/A e o carimbo, o app baixa a Liberation Sans normal e negrito na primeira vez (uns 0,5 MB cada), se o Word ainda não tiver baixado.
- Saem a recusa em `sign.js` e em `pdf.js` e o aviso na janela de assinar.
- Com o carimbo, a camada do OCR das fotos usa a mesma Helvetica embutida, mesmo sem página de Word (a regra que já valia com o Word).
- Falha fechada: se faltar a fonte embutida ou alguma letra do carimbo no subconjunto, nada é gerado.
- O carimbo com o PDF/A acrescenta uns 18 KB num PDF só de fotos e uns 3 KB quando o Word já embute a Helvetica. Sem o PDF/A, o PDF assinado sai byte a byte como antes.

Fases:

- [x] Fontes embutidas na aparência do carimbo quando o PDF/A está ligado, com testes
- [x] Conferência no veraPDF (PDF/A-2b), assinatura válida e `qpdf --check`: foto, Word, e Word com foto e OCR. Antes da mudança, o veraPDF reprovava o carimbo sem fonte embutida (regra 6.2.11.4.1)
- [x] Janela de assinar sem o aviso, com a prévia como antes, no Chromium e no WebKit

### Segurança e privacidade

- Nenhuma biblioteca nova, nenhuma requisição nova e CSP intacta. As fontes já estão em `web/vendor/liberation/`.
- A lupa só desenha a foto que já está na memória, e nada fica guardado.
- O carimbo com PDF/A mostra o mesmo que o carimbo de hoje (nome, data e hora), e só se a pessoa ligar.

### Testes

- `node:test`: mover e lugar de soltar (grade de uma e de várias colunas, lista de uma página, soltar no mesmo lugar); carimbo com PDF/A (aparência com `FontFile2` e `ToUnicode`, nenhuma fonte sem embutir); assinatura válida; `qpdf --check`.
- veraPDF (PDF/A-2b): foto com carimbo, Word com carimbo, e Word com foto, OCR e carimbo.
- Playwright, no Chromium e no WebKit, no tamanho do iPhone 16e (390 × 664):
  - arrastar a página 3 para o começo e a 1 para o fim; rolagem automática com 12 páginas; soltar no mesmo lugar; Esc; botões ← e → como antes;
  - lupa aparece, acompanha o canto, não sai da tela e some ao soltar;
  - carimbo com o PDF/A ligado, com prévia, gera um PDF que passa no veraPDF.
- Nenhuma violação da CSP no console, em nenhum dos testes.

### Decisões

- **Uma versão só, a v3.7.0:** três funcionalidades novas compatíveis sobem o minor.
- **Alça no cartão em vez de toque longo** (decisão do dono, 2026-10-24): começa a arrastar na hora e não briga com a rolagem nem com o menu do toque longo do Safari.
- **Os botões ← e → ficam**, pelo teclado e pela acessibilidade.
- **Tarefas nas issues do GitHub** (decisão do dono, 2026-10-24): cada commit cita a sua.

## Editar o PDF (v4.0.0) e preencher formulários (v4.1.0)

Pedido do dono em 2026-10-24: acrescentar coisas nas páginas (texto, rubrica, imagem e marcações), numerar, pôr cabeçalho, rodapé e marca d'água, e preencher formulários de PDF. Tudo no aparelho, igual no celular e no computador. Corrigir o texto que já existe no PDF fica de fora: o PDF guarda só as letras que o documento usou, posicionadas uma a uma, e trocar uma palavra pode pedir uma letra que a fonte não tem.

Cada fase tem a sua issue: base do editor (#11), texto e numeração (#12), marca-texto e marca d'água (#13), imagem e rubrica (#14) e formulários (#15).

### Abordagem

#### O que fica guardado na página

- Cada página ganha uma lista de edições (`page.edits`), separada das tarjas (`page.redactions`). Cada edição tem o tipo (texto, desenho, imagem, retângulo, seta, ✓, ✗, marca-texto, sublinhado, riscado) e a posição de 0 a 1 na página como ela aparece, com o giro, como as tarjas.
- Na foto, a posição vale na folha inteira, com a margem, para dar para escrever na margem. Mudar o tamanho da folha ou a margem leva as edições junto, na mesma posição relativa.
- Girar a página gira as edições junto, como as tarjas. Mudar o recorte da foto apaga as edições daquela página, com aviso, também como as tarjas.
- Nada sai da memória da aba: texto, desenho, rubrica e imagem somem ao limpar a lista ou fechar a aba.

#### Na tela

- **Modo "Editar"** na tela cheia, ao lado das tarjas e separado delas: a tarja apaga e tem conferência, a edição acrescenta. As duas usam as mesmas coordenadas.
- **Base nova** (a parte mais cara da interface):
  - tocar seleciona; arrastar move; alças de 44 px redimensionam;
  - uma barra junto da edição selecionada tem Remover e Duplicar; Desfazer guarda a pilha inteira da sessão;
  - Aplicar e Cancelar, como nas tarjas. Esc pede confirmação quando há mudança (hoje Esc perde as tarjas não aplicadas sem perguntar).
- **Ferramentas** numa linha só, que rola de lado no celular: Selecionar, Texto, Desenho, Imagem, Retângulo, Seta, ✓, ✗, Marca-texto, Sublinhar e Riscar. As propriedades (tamanho, cor, espessura) ficam num painel que abre de baixo.
- **Teclado e leitor de tela**, no nível das tarjas: "Novo" cria a edição no meio da página; setas movem 1%; Shift e setas mudam o tamanho; Delete remove. Cada edição é um grupo focável com instruções. O desenho à mão não tem caminho pelo teclado: a alternativa é texto ou imagem.
- **Texto:**
  - escrito num painel com `textarea`, letra de 16 px ou mais (abaixo disso o iPhone dá zoom), tamanho, cor e família (sem serifa, com serifa, de máquina). "Pôr na página" cria a caixa no meio; Enter na caixa reabre o painel;
  - o painel acompanha o teclado virtual (`visualViewport`), que hoje cobre a parte de baixo da tela cheia;
  - vale o que as fontes do PDF têm (WinAnsi), o que cobre todo o português. Letra fora disso (emoji, alfabetos não latinos) é avisada na hora e não entra.
- **Desenho à mão:** Pointer Events com `getCoalescedEvents`, para o traço sair liso no iPhone, e caneta reconhecida. O traço é suavizado e simplificado antes de virar caminho.
- **Imagem:** escolhida num `<input type="file">` (PNG ou JPEG), com a proporção travada ao redimensionar e o lado maior limitado, por causa da memória do celular.
- **Em todas as páginas,** no painel de opções do PDF, com prévia como a do carimbo da assinatura e a mesma grade de seis lugares:
  - numerar as páginas ("1", "1 de 7" ou "Página 1 de 7");
  - cabeçalho e rodapé (texto livre);
  - marca d'água ("CÓPIA", "CONFIDENCIAL" ou texto livre), em diagonal e transparente;
  - rubrica: desenhada uma vez num painel próprio e repetida em todas as páginas, no lugar escolhido.

#### No PDF

- **Fixo na página:** a edição vira parte do conteúdo da página (um stream a mais, com recursos de nomes novos), não anotação. Quem recebe não tira a rubrica, todo leitor e impressora mostra, e é o mesmo caminho da camada do OCR. Foto e Word entram no `assemble`; página de outro PDF, por uma opção nova do `copyPages`, como a do OCR. As posições passam por `visibleToPdf` e `uprightMatrix`, como o carimbo.
- **Texto, numeração, cabeçalho e rodapé:** fontes padrão (Helvetica, Times, Courier) sem embutir. Com o PDF/A, a Liberation embutida, pelo caminho que o carimbo usa desde a v3.7.0.
- **Seta, ✓ e ✗:** caminhos vetoriais. ✓ e ✗ não existem na WinAnsi, e a ZapfDingbats sem embutir reprova o PDF/A.
- **Transparência:** o gerador ganha `ExtGState`, com opacidade (`/ca` e `/CA`) para a marca d'água e `/BM /Multiply` para o marca-texto não esconder o texto embaixo. O PDF/A-2b aceita os dois, com o perfil sRGB que o app já grava.
- **Imagem:** PNG com transparência vira imagem Flate com máscara (`/SMask`) em cinza; PNG sem transparência vai como JPEG. A imagem é recodificada pelo canvas, então os metadados do arquivo original (EXIF, texto do PNG) não entram. Como o `assemble` é síncrono, a compressão (`CompressionStream`) é feita antes, como a das fontes.
- **Rubrica repetida:** um Form XObject gravado uma vez por PDF e chamado em cada página.
- **Ordem ao gerar:** edição, depois a tarja por cima de tudo (texto da edição sob a tarja sai do arquivo, como no Word, e a conferência continua igual), OCR (que lê só a imagem; o texto da edição já é texto), compressão, senha e, por último, a assinatura.
- **Assinar sem reescrever:** página com edição, numeração, cabeçalho, rodapé ou marca d'água conta como mudança. O app monta um PDF novo e avisa que as assinaturas que o PDF tinha deixam de valer, como já faz ao juntar ou girar.
- **PDF/A:** vale com a edição nas fotos e no Word. Página de outro PDF continua sem PDF/A, como hoje.

### Fases

#### Fase 1: base do editor (#11)

- [ ] `page.edits`: modelo, giro, recorte, tamanho e margem
- [ ] Modo "Editar" na tela cheia: selecionar, mover, redimensionar, Remover, Duplicar, Desfazer, Aplicar, Cancelar e Esc com confirmação; teclado e leitor de tela
- [ ] Retângulo, seta, ✓, ✗ e desenho à mão
- [ ] Fixo no PDF nos três tipos de página (foto, Word, página de outro PDF), com a tarja por cima
- [ ] Assinar sem reescrever desligado quando há edição, com o aviso

#### Fase 2: texto e numeração (#12)

- [ ] Texto novo: painel com `textarea`, tamanho, cor e família; letras fora da WinAnsi avisadas
- [ ] Numerar páginas, cabeçalho e rodapé, no painel de opções, com prévia
- [ ] PDF/A com a Liberation embutida para o texto novo

#### Fase 3: marca-texto e marca d'água (#13)

- [ ] `ExtGState` com opacidade e `Multiply`
- [ ] Marca-texto, sublinhar e riscar (retângulo e linha arrastados à mão)
- [ ] Marca d'água em todas as páginas, com prévia

#### Fase 4: imagem e rubrica (#14)

- [ ] Imagem PNG com transparência (`/SMask`) e JPEG, com limite de lado
- [ ] Rubrica desenhada uma vez e repetida em todas as páginas (Form XObject)

#### Fase 5: formulários, v4.1.0 (#15)

- [ ] Ler os campos do PDF (`/AcroForm`, `/Fields`, `/Kids`, `/FT`, `/Ff`, `/Opt`, `/DA`, `/Q`, `/MaxLen`) pelo leitor do app
- [ ] Lista de campos num painel, por página, com controles do próprio navegador (texto, caixa de marcar, rádio, lista) e "Mostrar na página". Campo desenhado por cima da página não serve no celular: numa A4 de 390 px, a letra fica com uns 8 px
- [ ] Valores fixos na página: aparência gerada para cada campo preenchido (fonte e tamanho do campo, tamanho automático, alinhamento, várias linhas, pente) e entregue ao achatamento que o app já faz; caixa de marcar e rádio usam o estado "marcado" que o próprio arquivo tem
- [ ] XFA: no PDF híbrido, preenche a parte AcroForm e tira o `/XFA`; XFA puro é recusado com o motivo. Campo calculado por script sai com o valor digitado, com aviso

### Segurança e privacidade

- Nenhuma biblioteca nova e nenhuma requisição nova; a CSP não muda. As fontes já estão em `web/vendor/`, a imagem chega por `blob:` e é decodificada pelo navegador.
- Nada guardado: texto, desenho, rubrica e imagem ficam só na memória da aba.
- O PDF leva só o que a pessoa vê e escolhe: a imagem vai recodificada, sem os metadados do arquivo original.
- A tarja continua por cima de tudo, e a conferência do PDF montado continua a mesma.
- Memória do iPhone: imagem com o lado limitado e desenho simplificado.

### Testes

- `node:test`: posições com `/Rotate`, CropBox e margem; seta, ✓, ✗ e suavização do traço; `ExtGState`; `/SMask`; fontes com o PDF/A; Form XObject repetido; `copyPages` com edição sem nome de recurso repetido; assinar sem reescrever desligado com edição; texto da edição sob a tarja fora do arquivo; numeração por arquivo com "um PDF por página" e por intervalos.
- `qpdf --check` e o fuzzing com edição; veraPDF (PDF/A-2b) com texto novo, marca d'água, marca-texto e imagem com transparência.
- Playwright no Chromium e no WebKit, em 390 × 664 e 1280 × 800: cada ferramenta pelo ponteiro e pelo teclado, o painel de texto com a tela encolhida pelo teclado virtual, Esc com confirmação, nenhuma violação da CSP. O que for de toque fica para o iPhone real.
- Formulários: PDFs gerados nos testes com cada tipo de campo, e PDFs públicos de formulário numa pasta fora do repositório, como a varredura.

### Decisões

- **Versões** (decisão do dono, 2026-10-24): o editor sai na v4.0.0 (pacote grande, sobe o major); os formulários, na v4.1.0, logo depois.
- **Fixo na página, não comentário editável** (decisão do dono, 2026-10-24).
- **PDF assinado por outra pessoa** (decisão do dono, 2026-10-24): editar monta um PDF novo, com o aviso de que a assinatura deixa de valer. Rubricar mantendo a assinatura dela fica para depois.
- **Formulário com valores fixos na página** (decisão do dono, 2026-10-24). Campos que continuam editáveis, sem reescrever o arquivo, ficam para depois.
- **Numeração por arquivo** (decisão do dono, 2026-10-24): com "um PDF por página" ou por intervalos, cada arquivo começa do 1.
- **Corrigir o texto que já existe no PDF fica de fora** (decisão do dono, 2026-10-24).
- **Só as letras da WinAnsi:** cobrem todo o português. Alfabetos não latinos e emoji exigiriam fonte composta (Type0), que o `ttf.js` não gera.
- **Modo "Editar" separado das tarjas,** com a tarja aplicada por cima de tudo.

### Perguntas em aberto

- Rubricar um PDF assinado mantendo a assinatura (anotação numa atualização incremental, com a permissão do autor), se houver pedido.
- Formulário que continua editável depois de preenchido, se houver pedido.
- Encaixar o sublinhado e o riscado na linha do texto (pelas caixas de texto do PDF.js ou pelas palavras do OCR)? Na v4.0.0, eles são arrastados à mão.
