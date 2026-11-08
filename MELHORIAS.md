# Melhorias

O que está em aberto: testes que só dão para fazer à mão, o que foi adiado, perguntas sem resposta e ideias. O trabalho em andamento fica nas [issues do GitHub](https://github.com/sanklerbergman/doc-scanner-pdf-engine/issues); cada uma é o plano e o contrato da entrega, e o commit cita o número dela (`#N`).

Os planos das funcionalidades já entregues (Word, juntar/dividir/comprimir, OCR, assinatura, PDF/A, tarjas, PDF com senha, editor, formulários, inglês, zoom), com as decisões e os testes de cada uma, saíram daqui em 2026-11-08 e continuam no git: `git show 5c100f1:MELHORIAS.md`.

## O que vale para toda melhoria

Toda funcionalidade nova precisa cumprir estes pontos antes de qualquer outra coisa. São as [regras do CONTRIBUTING](CONTRIBUTING.md#regras-que-não-negociamos) aplicadas ao planejamento:

- **Nenhum dado da pessoa chega ao projeto.** Isso vale para arquivos, texto, certificado, senha, estatística de uso e relatório de erro. Não existe servidor para receber nada disso.
- **Tudo roda no aparelho**, com a CSP como está (`connect-src 'none'`). Se uma ideia só funciona com rede, ela fica fora do escopo, e o plano diz isso.
- **Nada fica guardado.** Não se usa `localStorage`, IndexedDB nem opção de "lembrar". Segredos (senha e chave) ficam na memória só durante a operação e são descartados depois.
- **O PDF leva só o que a pessoa vê e escolhe**, sem metadados escondidos. Quando algo pessoal precisa entrar no arquivo (o certificado, numa assinatura), o app avisa antes.
- **Biblioteca nova** entra só em `web/vendor/`, com versão, origem e SHA-256, e carrega só quando precisa. O Worker dela nasce de um blob para herdar a CSP.
- **Funções pesadas são opcionais** e vêm desligadas: quem não usa não baixa nada a mais.

## Testes à mão pendentes

O que os testes automáticos não alcançam. Ao conferir, tire o item daqui e diga no commit ou na issue o que foi visto, em que aparelho e em que versão.

### No iPhone (16e), no site publicado

- Tarjar com o painel "Ajustar tarja", a tarja repetida em todas as páginas e o título curto da tela cheia ("Tarjar · 2/10") (v5.7.0 e v5.8.0)
- Zoom no Editar e no Tarjar: pinça com dois dedos, sem criar tarja nem edição no meio
- "Copiar texto" (o `ClipboardItem` com promessa depois de vários segundos de OCR)
- Limite da confiança baixa do OCR com fotos reais de câmera (as 56 imagens da calibragem são sintéticas)
- Tempo por página e pico de memória do OCR com 10 e 30 páginas (no computador, de 1 a 1,5 s por página)
- Formulários reais do INSS, da Receita e do TJMG

### No Acrobat Reader

- Seleção do texto do OCR, inclusive em página torta (o PDF.js do Firefox e o `pdftotext` quebram mais as linhas do texto inclinado ao copiar; cada palavra sai certa). Também no leitor do Chrome
- Painel de assinaturas, com o certificado de teste: ele avisa que a identidade é desconhecida (não é da ICP-Brasil), mas tem que dizer que o documento não foi alterado depois de assinado. Conferir também com `openssl cms -verify` e, se der, com o `pdfsig` (Poppler)
- A faixa de "arquivo em conformidade com PDF/A"

### Com um certificado A1 de verdade

- Assinar e conferir em `validar.iti.gov.br`, num documento sem nada sensível. Esse envio ao ITI é uma escolha de quem testa, fora do app. Ainda não há um A1 válido para isso

### Ferramentas

- Subconjunto TrueType do PDF/A: as letras usadas estão lá, as larguras batem com as da fonte original, e o arquivo abre no fontTools (`ttx`)
- Rodar o veraPDF no CI (hoje roda no `npm test` só quando a variável `VERAPDF` aponta o programa)

## Adiado

**Assinatura, fase 3: política da ICP-Brasil e cadeia.** Decisão do dono em 2026-10-16: só começa depois que alguém com um A1 real testar a assinatura no validador do ITI. Sem esse teste, não dá para saber se a política AD-RB é exigida, e a fase seria conferida só com certificado de teste.

- Identificador da política de assinatura da ICP-Brasil (AD-RB), se o validador do ITI exigir
- Certificados raiz da ICP-Brasil embutidos (são públicos), para avisar quando o certificado não é da ICP-Brasil ou a cadeia está incompleta. A revogação continua sem consulta
- ECDSA, se aparecer certificado A1 com curva elíptica

## Perguntas em aberto

- **Assinatura:** o validador do ITI aceita como aprovada uma assinatura PAdES sem o identificador da política AD-RB, ou a política é obrigatória na ICP-Brasil (DOC-ICP-15)? Só um A1 válido responde.
- **Vários arquivos de uma vez** (dividir, assinar cada um): é preciso um limite, por causa da memória no celular?
- **PDF/A:** quais sistemas de processo eletrônico conferem de fato o PDF/A no envio, e quais só recomendam? Vale mirar o PDF/A-2u (todo texto com Unicode)? O texto do Word já sai com `ToUnicode`; falta ver se a camada do OCR com `WinAnsiEncoding` passa no veraPDF. Aceitar páginas de PDFs que já são PDF/A (o original declara `pdfaid`)? Seria preciso conferir as fontes e as cores de cada página copiada.
- **Tarjas:** vale tarjar editando o conteúdo do PDF, para preservar o texto da página? Hoje a página de PDF tarjada sai como imagem.
- **Editor:** encaixar o sublinhado e o riscado na linha do texto (pelas caixas de texto do PDF.js ou pelas palavras do OCR)? Hoje eles são arrastados à mão.

## Ideias

Cada uma vira issue quando houver pedido ou decisão do dono.

- Detectar o papel também com sombra forte ou fundo claro
- OCR em inglês como segundo idioma (mais um modelo para baixar)
- Outros idiomas na interface, além do português e do inglês
- Rubricar um PDF assinado mantendo a assinatura (anotação numa atualização incremental, com a permissão do autor)
- Formulário que continua editável depois de preenchido; preencher mantendo a assinatura de outra pessoa (`DocMDP` 2, atualização incremental)
- Carimbo da assinatura no lugar do campo de assinatura vazio do formulário
