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
| `tesseract.esm.min.js` e `worker.min.js` | `tesseract.js@7.0.0` | ~0,17 MB |
| `tesseract-core-*-lstm.wasm.js` (três variantes: o aparelho baixa só a que ele suporta, com ou sem SIMD) | `tesseract.js-core@7.0.0` | ~3,9 MB cada |
| Modelo de português (`4.0.0_best_int/por.traineddata.gz`) | `@tesseract.js-data/por@1.0.0` | ~1,4 MB |

Quem usa o OCR baixa uns 5,5 MB uma vez. Depois os arquivos ficam no cache do service worker, como acontece com o PDF.js.

**Como funciona sem rede (e sem afrouxar a CSP):**

- O Worker do Tesseract nasce de um blob, então herda o `connect-src 'none'`, como os Workers dos filtros e do PDF.js.
- O núcleo vem nos arquivos `.wasm.js`, que têm o WebAssembly embutido e são carregados por `importScripts`. Isso já é coberto pelo `script-src 'self' 'wasm-unsafe-eval'` atual.
- O Tesseract.js baixa o modelo com `fetch`, e a CSP bloqueia isso. Em vez de abrir uma exceção, o modelo vira um módulo JS (`por.traineddata.js`, com o `.gz` em base64, ~1,9 MB), gerado por um script em `scripts/`. Os bytes são passados direto: `createWorker([{ code: 'por', data }])`.
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

- [ ] Copiar o Tesseract.js, o núcleo e o modelo para `web/vendor/tesseract/`, com um `README.md` (versão, origem, SHA-256 do `.tgz` e de cada arquivo, licenças)
- [ ] Script em `scripts/` que gera o `por.traineddata.js` a partir do `.gz` e confere o SHA-256
- [ ] `web/js/ocr.js`:
  - [ ] carregar só quando o OCR for ligado
  - [ ] Worker de blob, com `cacheMethod: 'none'` e sem `logger`
  - [ ] um Worker por vez, encerrado (`terminate`) no fim, para liberar a memória
- [ ] Reduzir a imagem antes do OCR (lado maior entre 2000 e 3500 px, a medir no iPhone)
- [ ] `pdf.js`: páginas de imagem aceitam uma camada de texto invisível
- [ ] Interface:
  - [ ] opção "Texto pesquisável (OCR)", desligada por padrão
  - [ ] progresso por página ("Reconhecendo o texto: página 2 de 5") e botão de cancelar
- [ ] Resultado guardado na memória, por página, e descartado se a pessoa mudar o recorte, o filtro ou a rotação
- [ ] Novos arquivos em `APP_FILES` e aumento da versão de `CACHE` no `web/sw.js`. O vendor fica fora do `APP_FILES` e entra no cache quando é usado, como o PDF.js

#### Fase 2: PDFs escaneados

- [ ] Desenhar a página com o PDF.js na resolução do OCR
- [ ] Pular páginas que já têm texto
- [ ] Acrescentar o content stream e a fonte à página copiada, sem mexer no que já existe. Recursos compartilhados entre páginas são copiados antes de mudar
- [ ] Respeitar `/Rotate`, `MediaBox` e `CropBox`

#### Fase 3: acabamento

- [ ] "Copiar texto" na tela cheia da página (área de transferência, local)
- [ ] Aviso quando a confiança for baixa (o Tesseract dá uma nota para cada palavra): "parte do texto pode ter saído errada"
- [ ] Inglês como segundo idioma, se houver pedido (mais um modelo para baixar)

### Segurança e privacidade

- **A imagem e o texto não saem do aparelho.** O Worker não tem rede (herda a CSP) e nada é enviado. Se algum caminho do Tesseract tentar baixar alguma coisa, a CSP bloqueia e o OCR falha com uma mensagem, em vez de vazar.
- **Nada guardado:** sem IndexedDB (`cacheMethod: 'none'`). O texto reconhecido só existe na memória e some ao limpar a lista ou fechar a aba. Nada vai para o console.
- **Texto escondido continua sendo texto.** O PDF com OCR leva, invisível, tudo o que estava escrito (CPF, endereço, valores), e o app avisa isso na própria opção. Também avisa sobre tarjas: uma tarja desenhada depois por cima da imagem, em outro programa, não apaga o texto invisível que está embaixo. Quem precisa tarjar deve fazer isso antes do OCR, ou não usar o OCR nesse documento.
- **O texto reconhecido é dado, nunca código:** no PDF ele entra como string hexadecimal, e na tela só por `textContent`.
- **Limites:** número de páginas por vez, tamanho da imagem e tempo por página. Acima disso, o app avisa.
- **PDF assinado:** acrescentar texto altera a página, e a assinatura deixa de valer. O aviso que já aparece ao abrir cobre esse caso.

### Testes

- [ ] Camada de texto montada a partir de um resultado de OCR simulado (palavras e caixas fixas): texto com `3 Tr`, posições dentro da página e rotação
- [ ] `(`, `)`, `\` e acentos não quebram o content stream
- [ ] PDF sem OCR continua idêntico byte a byte
- [ ] PDF escaneado: a página com texto é pulada, a página sem texto ganha a camada e a xref continua válida
- [ ] No navegador: nenhuma requisição na aba Rede e nada no IndexedDB durante o OCR
- [ ] Teste real no iPhone, no site publicado: tempo por página, memória e seleção do texto no visualizador do iPhone, no Chrome e no Acrobat

### Decisões

- **Dependência nova:** o Tesseract.js é a quarta biblioteca em `web/vendor/`. Pela regra 4 do CONTRIBUTING, isso precisa de conversa antes; este plano é essa conversa, e o pedido veio do dono do projeto.
- **Desligado por padrão:** pesa ~5,5 MB e leva alguns segundos por página no celular.
- **Modelo `best_int`:** é o que o Tesseract.js usa com o motor LSTM e o menor (~1,4 MB). O modelo maior (~6,8 MB) só acrescenta o motor antigo, que não será usado.
- **Versão:** sai na v3.0.0, junto com a assinatura digital.

### Perguntas em aberto

- Quanto tempo e memória o iPhone 16e gasta com 10 páginas ou mais? Vale limitar as páginas por vez?

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

- [ ] `asn1.js`: leitor e escritor DER (inteiros, OIDs, sequências, sets ordenados e datas)
- [ ] `pkcs12.js`: MAC, PBES2, 3DES e RC2-40, com mensagem clara para senha errada e arquivo corrompido
- [ ] `cms.js`: `SignedData` destacado com os atributos do PAdES
- [ ] `pdf.js`: campo de assinatura, espaço reservado, `/ByteRange` e preenchimento
- [ ] Autoconferência da assinatura antes de entregar
- [ ] Interface:
  - [ ] "Assinar com certificado digital (A1)", junto de "Gerar PDF"
  - [ ] escolher o `.pfx`, digitar a senha, ver titular e validade e confirmar
  - [ ] aviso de que o certificado vai junto no PDF (ver Segurança)
- [ ] Vários arquivos de saída (dividir): a senha é pedida uma vez para todos, e a chave é descartada no fim
- [ ] Novos arquivos em `APP_FILES` e aumento da versão de `CACHE` no `web/sw.js`

#### Fase 2: carimbo visível e coassinatura

- [ ] Carimbo visível opcional, desligado por padrão ("Assinado digitalmente por NOME em dd/mm/aaaa hh:mm"), na página e na posição escolhidas, com prévia. Mostra só o nome: no e-CPF, o CPF vem depois do ":" no nome do certificado e fica de fora do carimbo
- [ ] **Assinar um PDF que já existe sem reescrever o arquivo** (atualização incremental): o original fica intacto, e a assinatura nova vai no fim. É o que permite que duas pessoas assinem o mesmo contrato, uma depois da outra, sem invalidar a primeira assinatura
- [ ] Respeitar o `/DocMDP`: se o PDF foi certificado sem permitir alterações, recusar e explicar o motivo

#### Fase 3: política da ICP-Brasil e cadeia

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
- **Coassinatura (fase 2):** no modo incremental o original não é reescrito, então os metadados e o que mais ele tiver continuam lá. O app avisa: "o PDF segue como veio; só a assinatura nova é acrescentada".
- **SECURITY.md:** acrescentar "certificado ou senha saindo do aparelho, ou ficando guardados" na lista do que conta como falha.

### Testes

- [ ] Certificados **de teste**, com dados fictícios (titular "PESSOA DE TESTE", CPF fictício), gerados com o OpenSSL e guardados em `test/fixtures/` com os comandos anotados. **Nunca** usar certificado real no repositório nem nos testes
- [ ] `.pfx` com AES (padrão do OpenSSL 3), com 3DES e RC2 (opção `-legacy`, como sai do Windows), com senha errada, corrompido, vencido e sem cadeia
- [ ] 3DES e RC2 com os vetores oficiais (NIST e RFC 2268), e o KDF do PKCS#12 conferido contra o OpenSSL
- [ ] `/ByteRange` cobre o arquivo todo, menos o `/Contents`; o `messageDigest` bate; e a assinatura é verificada com o `node:crypto`
- [ ] Saída sem `/Name`, `/Reason`, `/Location`, `/Info` nem XMP (com PDF/A, só o XMP de identificação)
- [ ] PDF sem assinatura continua idêntico byte a byte
- [ ] Coassinatura: a primeira assinatura continua válida depois da segunda
- [ ] Manual, com o certificado de teste: painel de assinaturas do Acrobat Reader. Ele avisa que a identidade é desconhecida (o certificado não é da ICP-Brasil), mas tem que dizer que o documento não foi alterado depois de assinado. Conferir também com `openssl cms -verify` e, se der, com o `pdfsig` (Poppler)
- [ ] Manual, com um A1 de verdade: `validar.iti.gov.br`, num documento sem nada sensível. Esse envio ao ITI é uma escolha de quem testa, fora do app. Ainda não há um A1 válido para isso (ver perguntas)
- [ ] Teste real no iPhone, no site publicado: escolher o `.pfx` no app Arquivos e assinar

### Decisões

- **Só A1 e só PAdES básico (B-B):** é o que dá para fazer sem rede e sem programa instalado.
- **Sem biblioteca nova:** o leitor de PKCS#12 e a montagem do CMS são próprios, e quem assina é o Web Crypto. A alternativa seria copiar o node-forge ou o PKI.js para `web/vendor/`, que são maiores e trazem muito mais do que o necessário.
- **Carimbo visível desligado por padrão:** a assinatura vale do mesmo jeito sem ele, e o nome da pessoa só aparece desenhado na página se ela escolher.
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

- [ ] `icc.js`: perfil sRGB (ICC v2, matriz e curva)
- [ ] `pdf.js`: opção `pdfa` em `buildPdf`, com XMP mínimo, `/ID` e `/OutputIntents`
- [ ] Interface:
  - [ ] opção "PDF/A (tribunais e arquivamento)", desligada por padrão
  - [ ] indisponível, com o motivo, quando a lista tem página de PDF ou de Word (Word entra na fase 2)
  - [ ] o resumo do PDF pronto mostra "PDF/A-2b"
- [ ] Novos arquivos em `APP_FILES` e aumento da versão de `CACHE` no `web/sw.js`

#### Fase 2: documentos do Word

- [ ] Copiar as fontes Liberation (normal, negrito, itálico e negrito itálico das três famílias) para `web/vendor/liberation/`, com um `README.md` (versão, origem, SHA-256 e licença)
- [ ] `ttf.js`: ler larguras e `cmap` e gerar o subconjunto
- [ ] `layout.js` e `fonts.js`: larguras da fonte embutida quando o PDF/A está ligado
- [ ] `pdf.js`: fonte TrueType com `FontFile2` (subconjunto), `WinAnsiEncoding` e `ToUnicode`
- [ ] Medir quanto cada fonte acrescenta ao PDF

#### Fase 3: junto com a v3.0.0

- [ ] PDF/A com a camada do OCR
- [ ] PDF/A com a assinatura (widget com `/F 4`), conferindo que o arquivo continua PDF/A depois de assinado

### Segurança e privacidade

- **Tudo no aparelho:** nenhum serviço de conversão, e a CSP continua a mesma.
- **Metadado novo, só com a opção ligada:** o XMP leva apenas a identificação do padrão. Sem autor, título, datas ou programa.
- **`/ID` sem rastreio:** sai do conteúdo, não de um número aleatório nem de dados do aparelho.
- **Arquivos de terceiros:** só as fontes, em `web/vendor/`, com SHA-256 e carregadas sob demanda. O perfil de cor é gerado pelo código.
- **A fonte é dado, não código:** o leitor de TrueType só copia tabelas e confere tamanhos e deslocamentos, para um arquivo malformado não travar o app.

### Testes

- [ ] PDF sem a opção continua idêntico byte a byte
- [ ] Com a opção: catálogo com `/Metadata` e `/OutputIntents`, trailer com `/ID`, e XMP só com `pdfaid`
- [ ] `/ID` igual para o mesmo conteúdo e diferente quando o conteúdo muda
- [ ] Perfil ICC: tamanho no cabeçalho, assinatura `acsp` e tags obrigatórias
- [ ] Subconjunto TrueType: as letras usadas estão lá, as larguras batem com as da fonte original, e o arquivo abre no fontTools (`ttx`)
- [ ] **veraPDF** (validador de referência, código aberto, roda em Java), perfil PDF/A-2B, em todos os PDFs de teste. Para começar, manual, com o comando anotado; depois avaliar rodar no CI
- [ ] Manual: o Acrobat mostra a faixa de "arquivo em conformidade com PDF/A"
- [ ] Teste real no iPhone, no site publicado: gerar com a opção ligada e abrir no visualizador do iPhone, no Chrome e no Acrobat

### Decisões

- **PDF/A-2b:** é o nível mais aceito e o que o app consegue garantir para fotos e Word.
- **Desligado por padrão:** a maioria não precisa, e no Word as fontes aumentam o arquivo.
- **Liberation em vez de outra família livre:** é a que tem as larguras das fontes que o app já usa, então o documento quebra as linhas do mesmo jeito. As fontes entram em `web/vendor/`, o que pela regra 4 do CONTRIBUTING precisa de conversa antes; este plano é essa conversa, e o pedido veio do dono do projeto.
- **Versão:** a decidir.

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

- [ ] Na tela cheia da página, "Tarjar": arrastar retângulos, ver a lista de tarjas da página e desfazer
- [ ] Foto: pintar os pixels antes de gerar o JPEG
- [ ] Word: tirar da distribuição do texto os trechos sob a tarja e desenhar a caixa
- [ ] A miniatura mostra as tarjas

#### Fase 2: páginas de PDF e conferência

- [ ] Página de PDF com tarja vira imagem, na resolução da qualidade escolhida
- [ ] Conferência do PDF novo: nenhum texto dentro das áreas tarjadas
- [ ] Aviso de que a página tarjada perde o texto selecionável

#### Fase 3: busca automática

- [ ] Padrões brasileiros, com dígito verificador onde existe
- [ ] Busca no texto do Word e no texto dos PDFs (PDF.js, `getTextContent`); nas fotos, depois do OCR
- [ ] Cada sugestão confirmada pela pessoa

### Segurança e privacidade

- **Apagar de verdade:** nunca só desenhar por cima.
- **Falha fechada:** se a conferência encontrar texto sob uma tarja, o PDF não sai.
- **Os dados encontrados pela busca** só existem na memória e não vão para o console.
- **Limites avisados:** a tarja não alcança cópias do documento que já existem, e PDF assinado perde a assinatura (o aviso atual já cobre isso).

### Testes

- [ ] Foto: os pixels sob a tarja têm só a cor da tarja
- [ ] Word: o texto sob a tarja não está no PDF, nem depois de descompactar
- [ ] PDF: a página tarjada é só imagem, e nenhum texto dela fica no arquivo
- [ ] Conferência: um PDF montado de propósito com texto sob a tarja é recusado
- [ ] Padrões: CPF e CNPJ válidos e inválidos, com e sem pontuação, e falsos positivos comuns (número de processo, datas)
- [ ] Teste real no iPhone, no site publicado

### Decisões

- **Página de PDF vira imagem:** é o caminho sem chance de sobrar texto. O preço é perder o texto selecionável na página tarjada, e o app avisa.
- **Sem biblioteca nova.**
- **Versão:** a decidir.

### Perguntas em aberto

- A tarja leva algum texto, como "tarjado", ou fica só a caixa?
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

- [ ] `pdf-crypt.js`: chave a partir da senha (revisões 2 a 6), RC4, MD5 e decifragem por objeto
- [ ] `pdf-reader.js`: decifrar strings e streams; parar de recusar PDF com `/Encrypt`
- [ ] Interface: pedir a senha quando a vazia não abre, com mensagem clara para senha errada
- [ ] Aviso: "O PDF novo sai sem senha"

#### Fase 2: proteger o PDF gerado

- [ ] Opção "Proteger com senha" ao gerar: AES-256 (revisão 6), só com senha de abertura e sem senha de proprietário escondida

### Segurança e privacidade

- **A senha só existe na memória:** não fica guardada, não vai para o console nem para mensagens de erro. O campo fica fora de formulário, com `autocomplete="off"`, e é limpo depois do uso.
- **Nada sai do aparelho:** a decifragem é local, como o resto.
- **Aviso do PDF sem senha:** a pessoa pode estar contando com a proteção do original.
- **Permissões do autor:** ver as perguntas em aberto.

### Testes

- [ ] PDFs de teste cifrados com o qpdf, em cada revisão, com os comandos anotados: senha de abertura, só senha de proprietário e senha com acentos
- [ ] Senha errada, senha vazia e senha Unicode
- [ ] MD5 (RFC 1321) e RC4 com os vetores oficiais
- [ ] O conteúdo decifrado bate com o `qpdf --decrypt` do mesmo arquivo
- [ ] Teste real no iPhone, no site publicado

### Decisões

- **AES pelo navegador e só MD5 e RC4 em JS:** menos código próprio de criptografia.
- **Versão:** a decidir.

### Perguntas em aberto

- **Respeitar as permissões do autor?** Um PDF pode abrir sem senha e mesmo assim proibir alterações, incluindo juntar e separar páginas. O Acrobat e o PdfCraft respeitam isso e pedem a senha de proprietário. Respeitar é o correto com o autor do documento, mas pode impedir justamente o uso comum (juntar o contracheque com outros documentos). A recomendação é respeitar e explicar o motivo na mensagem.

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

- [ ] `qpdf --check` nos PDFs gerados pelos testes, no CI
- [ ] Script de varredura e primeira rodada no conjunto do PDF.js, com as correções
- [ ] Fuzzing

### Decisões

- **Versão:** são melhorias internas; entram na próxima versão que sair.
