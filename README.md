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
- **PDF/A** (PDF/A-2b, formato de arquivamento que alguns tribunais pedem no processo eletrônico): para fotos e documentos do Word, com ou sem o texto pesquisável e a assinatura. Nas páginas do Word, as fontes vão embutidas no PDF (as Liberation, com as mesmas medidas de Helvetica, Times e Courier, só com as letras usadas). Não vale para páginas de outro PDF e não combina com senha, porque o PDF/A não permite criptografia
- **Tarja de verdade**: na tela cheia da página, marque o que esconder (CPF, endereço, conta, assinatura). O que fica sob a tarja é apagado do PDF, não só coberto: nas fotos, os pixels são pintados; no Word, o texto embaixo sai da página; a página de outro PDF tarjada vira imagem. Antes de entregar, o app relê o PDF novo e confere que não sobrou texto sob nenhuma tarja. O botão "Procurar dados para tarjar" acha CPF, CNPJ, e-mail, telefone, CEP e número de cartão no texto das páginas (nas fotos e nos PDFs escaneados, com o OCR) e sugere as tarjas, que a pessoa confirma uma a uma
- Abre **PDFs com senha** (contracheques, extratos, faturas): o app pede a senha, que só é usada no aparelho e não fica guardada. PDF que só tem restrições do autor abre direto. O PDF novo sai sem senha, a não ser que você ligue "Proteger o PDF com senha"
- **Protege o PDF gerado com senha** (AES-256): quem receber precisa da senha para abrir. O app não guarda a senha nem tem como recuperá-la
- **Junta, separa e comprime PDFs**: abra um ou mais PDFs, reordene, remova ou misture as páginas com fotos e documentos, e gere um PDF só, um por página ou um por intervalo (ex.: 1-3, 4-10). Dá para ver cada página antes e conferir, numa prévia, os arquivos que vão sair. As páginas vão como estão no original, com o texto selecionável; links, formulários, scripts, metadados e o conteúdo de camadas ocultas ficam de fora. Para diminuir PDFs escaneados ou de fotos, as imagens podem ser recomprimidas, com o "antes → depois" do tamanho. Avisa quando o PDF tem assinatura digital, que deixa de valer no arquivo novo (para mantê-la, assine o PDF sem mudar nada nele)
- **Texto pesquisável (OCR)** nas fotos e nos PDFs escaneados: o texto impresso é reconhecido no próprio aparelho e vai para o PDF como uma camada invisível por cima da imagem, que dá para buscar, selecionar e copiar. Página de PDF que já tem texto fica como está. Opcional e desligado por padrão: na primeira vez, o app baixa uns 5 MB do próprio site
- **Assina o PDF com certificado digital A1** (e-CPF ou e-CNPJ, arquivo .pfx ou .p12), no padrão PAdES, que o Acrobat reconhece. O certificado, a senha e o documento não saem do aparelho e não ficam guardados. Um carimbo visível ("Assinado digitalmente por", nome, data e hora) é opcional, na página e no lugar escolhidos, com prévia. Um PDF que já existe, aberto e assinado sem mudar nada, recebe a assinatura no fim do arquivo, sem ser reescrito: as assinaturas que ele já tinha continuam valendo, e duas pessoas podem assinar o mesmo contrato, uma depois da outra. PDF certificado pelo autor sem permitir alterações é recusado. Token, cartão (A3) e certificado em nuvem não funcionam, porque exigem programa instalado ou servidor da certificadora
- Abre fotos **HEIC** do iPhone em qualquer navegador (decodificador embutido, carregado só quando precisa)
- Funciona offline depois do primeiro acesso

## Privacidade (o ponto principal)

| Garantia | Como |
| --- | --- |
| Nenhum arquivo sai do aparelho | Todo o processamento é feito no navegador (`<canvas>` e um Web Worker). Não há backend. |
| Nem dá para enviar | CSP com `connect-src 'none'`: o navegador bloqueia fetch/XHR/WebSocket/beacon na página e nos Workers, que são os únicos lugares por onde os arquivos passam. O service worker (cache offline) tem política própria: só busca arquivos do próprio site. |
| Zero terceiros | Sem analytics, cookies, scripts de CDN ou fontes externas. As quatro bibliotecas (libheif, para HEIC, o PDF.js, para mostrar as páginas dos PDFs, o Tesseract, para o OCR, e um gerador de QR Code) são servidas pelo próprio site e só carregam quando precisam, como as fontes do PDF/A (Liberation). A assinatura digital não usa biblioteca: quem assina é o próprio navegador (Web Crypto). |
| Nada guardado | Sem `localStorage`/IndexedDB. O service worker só faz cache dos arquivos do app. O certificado e as senhas (do certificado, de um PDF protegido e a escolhida para proteger o PDF novo) só existem na memória enquanto são usados; a chave do certificado entra no navegador sem como ser lida de volta. |
| PDF limpo | A foto é redesenhada, o que descarta o EXIF (GPS, modelo do celular, data). Do .docx, os metadados (autor, empresa, datas) nem são lidos. O PDF não tem `/Info`, datas nem "Producer". De PDFs juntados, o que estava em camadas ocultas não vem junto. O PDF assinado leva o certificado (com nome e CPF ou CNPJ, que é como quem recebe confere quem assinou) e a hora da assinatura; o app avisa antes. A exceção é assinar um PDF que já existe sem mudar nada: ele segue exatamente como veio, com o que tiver dentro, para as assinaturas anteriores continuarem valendo; o app também avisa antes. |

Dá para conferir: F12 → aba **Rede** enquanto gera um PDF. As únicas requisições são os arquivos do próprio app e URLs `blob:` (memória local).

### Limites dessa garantia

- A política chega de dois jeitos. O `<meta>` do `index.html` vale para a página e para os Workers. Os cabeçalhos que o Cloudflare envia com cada arquivo (regras em [`web/_headers`](web/_headers)) repetem essa política e cobrem o que o `<meta>` não alcança: o service worker, que só consegue buscar arquivos do próprio site, e o bloqueio do site dentro de outro (iframe).
- O Cloudflare, que hospeda o site, vê que alguém abriu a página, como em qualquer site, mas nunca vê os arquivos. Depois de cada publicação, o workflow confere que cada arquivo no ar é idêntico ao do repositório, sem nada injetado no caminho.
- Nenhuma política de navegador impede o próprio site de ser alterado por quem controla o repositório ou a conta do Cloudflare. A proteção contra isso é o código ser aberto, com o histórico de mudanças público, e a publicação sair só da branch `main`, depois dos testes.
- Extensões instaladas no navegador ficam fora de qualquer política da página: uma extensão com permissão para ler sites vê o que aparece na tela. Para documentos sensíveis, use um navegador sem extensões ou uma janela anônima, onde elas costumam vir desligadas.
- Quem hospeda uma cópia modificada pode trocar qualquer coisa, inclusive a chave Pix, e pode não enviar os cabeçalhos. Numa cópia falsa, o certificado digital e a senha poderiam ser roubados: só assine em https://scanner.sankler.com.br/, o endereço oficial.
- O texto do OCR fica escondido no PDF, mas continua lá: uma tarja feita depois, em outro programa, cobre a imagem e não apaga o texto que está embaixo. Para tarjar, use a tarja do próprio app (o OCR roda na foto já tarjada) ou gere o PDF sem o OCR.
- A tarja apaga o que está no PDF novo, mas não alcança cópias do documento que já existem (o arquivo original, um e-mail enviado antes).
- A assinatura sai no nível básico (PAdES B-B), com a hora do relógio do aparelho: carimbo do tempo e dados de revogação exigem rede.

Achou uma falha de segurança? Veja [SECURITY.md](SECURITY.md).

## Contribuindo

Veja [CONTRIBUTING.md](CONTRIBUTING.md). Regra de ouro: **nada de requisições externas nem rastreamento.**

## Licença

[MIT](LICENSE). As quatro bibliotecas em `web/vendor/` são distribuídas sem alterações e têm licença própria: o decodificador de HEIC [libheif-js](https://github.com/catdad-experiments/libheif-js) (LGPL-3.0), o renderizador de PDF [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0), o OCR [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0, com o modelo de português do Tesseract) e o gerador de QR Code [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT). As fontes do PDF/A, as [Liberation](https://github.com/liberationfonts/liberation-fonts), estão sob a SIL Open Font License 1.1.

---

<p>por <a href="https://sankler.com.br"><picture><source srcset="web/sankler-logo-reduzido-fundo-escuro.svg" media="(prefers-color-scheme: dark)"><img src="web/sankler-logo-reduzido-fundo-claro.svg" alt="Sankler" height="18"></picture></a></p>
