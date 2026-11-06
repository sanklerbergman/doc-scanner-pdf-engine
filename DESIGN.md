---
name: Scanner Doc
description: Foto, Word ou PDF vira PDF no próprio aparelho; cada garantia aparece como carimbo de conferido, em tinta azul caneta.
colors:
  ink-blue: "#3a63ff"
  ink-blue-text: "#2b4fe0"
  ink-blue-text-dark: "#8aa2ff"
  ink-blue-wash: "#e6ecff"
  ink-blue-wash-dark: "#1a2350"
  error-red: "#b42318"
  error-red-dark: "#ff7a70"
  cold-paper: "#f5f6f9"
  card-white: "#ffffff"
  paper-recess: "#eef0f5"
  sankler-black: "#0b0c10"
  graphite: "#565c69"
  hairline: "#dcdfe6"
  field-edge: "#858c9b"
  night-card: "#16181e"
  night-recess: "#1e2129"
  night-ink: "#eef0f5"
  night-graphite: "#a3a9b6"
  night-hairline: "#2a2e38"
  night-field-edge: "#6c7385"
typography:
  display:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "clamp(1.75rem, 1.2rem + 2.4vw, 2.5rem)"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.5
  stamp:
    fontFamily: "ui-monospace, \"SF Mono\", \"Cascadia Mono\", \"Roboto Mono\", Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.06em"
    fontFeature: "\"tnum\""
  data:
    fontFamily: "ui-monospace, \"SF Mono\", \"Cascadia Mono\", \"Roboto Mono\", Menlo, Consolas, monospace"
    fontSize: "0.8rem"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "\"tnum\""
rounded:
  stamp: "4px"
  sm: "8px"
  md: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink-blue}"
    textColor: "{colors.card-white}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "color-mix(in srgb, #3a63ff 86%, #000)"
    textColor: "{colors.card-white}"
  button-primary-lg:
    backgroundColor: "{colors.ink-blue}"
    textColor: "{colors.card-white}"
    rounded: "{rounded.md}"
    padding: "12px 22px"
    height: "52px"
  button-outline:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.sankler-black}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    height: "44px"
  button-outline-hover:
    textColor: "{colors.ink-blue-text}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-blue-text}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    height: "44px"
  button-ghost-hover:
    backgroundColor: "{colors.ink-blue-wash}"
  stamp:
    backgroundColor: "transparent"
    textColor: "{colors.ink-blue-text}"
    typography: "{typography.stamp}"
    rounded: "{rounded.stamp}"
    padding: "6px 12px 5px"
  stamp-sm:
    textColor: "{colors.ink-blue-text}"
    rounded: "3px"
    padding: "1px 6px"
  input:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.sankler-black}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
    height: "44px"
  collapsible-section:
    backgroundColor: "{colors.card-white}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
    height: "56px"
  receipt:
    backgroundColor: "{colors.card-white}"
    rounded: "{rounded.md}"
  dock-bar:
    backgroundColor: "{colors.card-white}"
    padding: "8px 16px"
  result:
    backgroundColor: "{colors.card-white}"
    rounded: "{rounded.md}"
    padding: "20px"
---

# Design System: Scanner Doc

## Overview

**Creative North Star: "Carimbo de conferência"**

O Scanner Doc é uma mesa de repartição honesta: papel frio, cartões brancos, tinta preta e uma única tinta de cor, o azul caneta da Sankler, usada para carimbar o que foi conferido e para marcar a ação. Cada garantia do app (processado no aparelho, tarjado, protegido com senha, assinado) aparece como carimbo de borda dupla, caixa alta monoespaçada, levemente girado, e não como parágrafo de promessa. A prova vem antes do enfeite.

A densidade é de ferramenta, não de vitrine: o caminho simples (adicionar, Gerar PDF) fica sempre à vista, a lista de páginas lê como recibo numerado com fios tracejados, e o avançado mora em seções recolhidas que mostram, em monoespaçada, o resumo do que está ligado. A barra do polegar fixa no pé da tela leva o resumo e o botão cheio de azul. O tema claro e o escuro seguem `prefers-color-scheme`; no escuro o papel vira o preto Sankler e a tinta continua a mesma.

Só há fontes do sistema (a CSP tem `font-src 'none'`): a sans do aparelho para o texto e a mono do aparelho para tudo que é número, código ou carimbo. A personalidade vem do carimbo, do recibo e da disciplina de uma tinta só, não de uma face tipográfica.

**Key Characteristics:**
- Uma tinta de cor, azul caneta, para carimbo, ação e foco; sem verde de sucesso.
- Carimbo de borda dupla em caixa alta mono como assinatura visual de toda garantia.
- Números, tamanhos, protocolos e resumos em mono com algarismos de mesma largura.
- Lista de páginas como recibo: itens separados por fio tracejado, total no pé, borda picotada.
- Plano, quase sem sombra; profundidade só no que flutua (barra, janela, item arrastado).
- Alvo de toque de 44px em todo controle; 52px nas ações principais.

## Colors

Papel frio e tinta preta, com uma única tinta de cor (azul caneta) e o vermelho reservado a erro e risco.

### Primary
- **Azul Caneta Sankler** (ink-blue): preenche o botão principal, desenha a borda dupla do carimbo e os fios dentro dele, contorna o resultado e a dica de compressão, e é o anel de foco (3px). Não é cor de texto no claro: sobre o papel dá 4,41:1.
- **Azul Caneta de Escrever** (ink-blue-text): o mesmo azul quando vira texto, link, ícone ou letra do carimbo no tema claro (5,89:1 no papel). É também a cor de "deu certo".
- **Azul Caneta de Escrever, noite** (ink-blue-text-dark): o papel do anterior no tema escuro (8,09:1 no papel escuro); também o foco dentro da janela e da tela cheia no escuro.
- **Lavado de Tinta** (ink-blue-wash / ink-blue-wash-dark): fundo de dica, de item de menu aberto, de cor de tarja escolhida, de hover do botão sem borda e da área de soltar arquivos durante o arraste.

### Secondary
- **Vermelho de Erro** (error-red / error-red-dark): erro, a ação Remover e a nota de risco (senha sem recuperação, endereço antes de assinar), que leva borda vermelha e fundo com 8% de vermelho sobre a superfície.

### Neutral
- **Papel Frio** (cold-paper): fundo da página no claro.
- **Cartão Branco** (card-white): superfície de cartões, recibo, barra, campos e botões de contorno no claro.
- **Papel Rebaixado** (paper-recess): segunda superfície (fundo de miniatura, `code`, hover de linha de menu, bloco do Pix).
- **Preto Sankler** (sankler-black): texto no claro e papel no escuro.
- **Grafite** (graphite / night-graphite): texto secundário, números das páginas, resumos em mono, notas de campo.
- **Fio** (hairline / night-hairline): borda decorativa de cartão e divisória; nunca borda de controle.
- **Borda de Campo** (field-edge / night-field-edge): borda de campo, de botão de contorno, da área de soltar e base dos fios tracejados do recibo (3:1 ou mais).
- **Cartão e Rebaixo da Noite** (night-card, night-recess) e **Tinta da Noite** (night-ink): superfícies e texto do tema escuro.

### Named Rules
**A Regra da Tinta Única.** Só o azul caneta tem cor de marca. Sucesso, conferido e ação usam a mesma tinta; não existe verde de sucesso nem segunda cor de destaque na interface.

**A Regra do Azul que Escreve.** O azul pinta (preenchimento, borda, contorno, foco) no valor de ink-blue; quando vira letra ou ícone, usa ink-blue-text no claro e ink-blue-text-dark no escuro, que passam de 4,5:1.

**A Regra do Vermelho Raro.** Vermelho só para erro, remoção e momento de risco; nunca como destaque decorativo.

## Typography

**Display Font:** fonte do sistema (system-ui, -apple-system, Segoe UI, Roboto, sans-serif)
**Body Font:** a mesma fonte do sistema
**Label/Mono Font:** monoespaçada do sistema (ui-monospace, SF Mono, Cascadia Mono, Roboto Mono, Menlo, Consolas)

**Character:** a sans do aparelho fala como a interface do próprio telefone; a mono do aparelho é a voz do carimbo e do recibo, onde cada algarismo ocupa a mesma largura. A CSP proíbe qualquer fonte baixada, inclusive servida pelo próprio site.

### Hierarchy
- **Display** (800, clamp de 1,75rem a 2,5rem; 1,5rem até 520px de largura; entrelinha 1,2; -0,025em): só o título da primeira tela, equilibrado em linhas (`text-wrap: balance`), uma frase por linha a partir de 600px.
- **Headline** (700, 1,25rem, 1,2; -0,01em): títulos de seção, janela e resultado (o do resultado sobe para 800).
- **Title** (600, 0,9375rem, 1,35): nome do arquivo no item do recibo, título de seção recolhida (700), marca no cabeçalho (800, 1,125rem, -0,02em).
- **Body** (400, 16px, 1,55): texto corrido; abertura em 1,0625rem cinza, até 62ch; notas até 60 a 70ch. Campos sempre a 16px (abaixo disso o iPhone amplia a tela).
- **Label** (600, 0,875rem): rótulo de campo; o controle volta ao peso normal.
- **Stamp** (mono 600, 0,8125rem, 1,3, 0,06em, caixa alta): texto de carimbo; o carimbo pequeno usa 0,75rem e 0,07em.
- **Data** (mono 400, 0,78 a 0,85rem, algarismos tabulares): meta da página, resumo das seções e da barra, total do recibo, versão, informação do resultado.

### Named Rules
**A Regra do Número em Mono.** Todo número que a pessoa confere (páginas, KB, versão, protocolo, zoom) sai na mono do sistema com `tabular-nums`.

**A Regra da Fonte da Casa.** Nenhuma fonte baixada: só a sans e a mono do sistema, por exigência da CSP.

## Layout

Coluna única centrada de até 960px com 16px de margem lateral, celular primeiro (iPhone de 390px de referência). O recibo de páginas fica em uma coluna também no computador, na largura de leitura. Os ajustes usam grade automática de colunas de no mínimo 200px com 16px de vão. O ritmo é de 4 em 4px, com 8, 12, 16 e 24px como passos mais usados; a primeira tela encolhe no celular (até 520px) para os dois botões de adicionar caberem nela, e com páginas na lista a área de soltar vira uma linha só, "Adicionar mais".

A barra do polegar é `sticky` no pé da tela, sangrando até a borda no celular; a partir de 720px ela flutua 12px acima do pé com borda inteira e cantos de 10px. Com o teclado virtual aberto num campo de texto, a barra sai da frente. A altura dela vai para `--dock-h` (um `ResizeObserver` no `#dock`), e o `scroll-padding-bottom` do `html` usa esse valor mais 12px: o foco do Tab nunca para embaixo da barra. Até 480px de altura (celular deitado, zoom de 400%) a barra deixa de ser presa e fica no lugar dela, depois dos ajustes. O item do recibo é uma grade de duas linhas no celular e uma linha só a partir de 640px. Pontos de quebra observados: 420, 520, 600, 640 e 720px de largura, 480px de altura (celular deitado), mais `pointer: coarse` e `hover: hover`, que decidem qual botão de adicionar é o cheio e se há hover.

## Elevation & Depth

O sistema é plano: cartões, recibo, seções e campos se separam por fio de 1px e pela troca de papel para cartão branco, não por sombra. No tema escuro a sombra de cartão é zero. Sombra só aparece no que se descola da página: a barra fixa, o aviso com Desfazer, a janela modal, o item sendo arrastado e as setas da tela cheia.

### Shadow Vocabulary
- **Assentado** (`box-shadow: 0 1px 2px rgb(11 12 16 / 5%), 0 4px 14px rgb(11 12 16 / 5%)`): o cartão do resultado e a página na tela cheia, só no claro.
- **Janela** (`box-shadow: 0 12px 40px rgb(11 12 16 / 22%)`; no escuro 55% de preto): janelas modais e o link de pular para o conteúdo.
- **Barra do polegar** (`--shadow-dock`, `0 -8px 24px` a 8% de preto nos dois temas): sombra para cima da barra fixa.
- **Aviso** (`--shadow-notice`, `0 6px 20px` a 14% de preto nos dois temas): o cartão do aviso com Desfazer, acima da barra.
- **Item erguido** (`box-shadow: 0 10px 30px rgb(11 12 16 / 25%)`): item do recibo enquanto é arrastado, com contorno azul de 1px.

### Named Rules
**A Regra do Plano por Padrão.** Superfície parada não tem sombra; sombra é sinal de que a peça flutua sobre a página.

## Shapes

Cantos suaves e contidos: 10px em cartões, recibo, seções recolhidas, barra no computador e botões grandes; 8px em botões e campos; 4px no carimbo, em miniaturas e no `code`; 3px no carimbo pequeno. Círculo só nos botões da câmera e nas setas da tela cheia. A troca de idioma usa os 8px dos botões. As formas de papel se repetem: o recibo termina em borda picotada (dentes da cor do cartão, 8px), os itens e linhas de menu se separam por fio tracejado, a área de soltar arquivos tem borda tracejada de 1,5px que vira contínua e azul ao arrastar, e o carimbo tem borda dupla (4px, 3px no pequeno) e fica girado (-2° no carimbo grande, 3° no pequeno; reto na variante deitada, quando quebra em várias linhas largas).

## Components

### Buttons
Firmes e diretos, com verbo de ação e ícone de traço do sprite.
- **Shape:** cantos de 8px (sm); 10px no grande; 44px de altura mínima, 52px no grande e na barra.
- **Primary:** cheio de azul caneta com texto branco (4,76:1). Um por contexto: "Tirar foto" no toque, "Escolher arquivos" sem toque, "Gerar PDF" na barra.
- **Hover / Focus:** hover só onde há ponteiro que paira; o cheio escurece 14% em preto, o de contorno troca a borda para azul e o texto para azul de escrever. Foco: contorno de 3px em azul caneta, 2px de folga. Ao pressionar, desce 1px.
- **Contorno (padrão):** cartão branco, borda de campo, texto preto. No toque, o segundo botão de adicionar ganha borda e texto azuis.
- **Sem borda (ghost):** texto azul de escrever, fundo lavado no hover ("Mudar", resumo da barra).
- **Ícone:** 44×44, transparente, ícone de 20px.

### Cards / Containers
- **Corner Style:** 10px (md).
- **Background:** cartão branco sobre papel frio (cartão e rebaixo da noite no escuro).
- **Shadow Strategy:** sem sombra, salvo o resultado (ver Elevation & Depth).
- **Border:** fio de 1px; o resultado e a dica de compressão têm borda azul caneta.
- **Internal Padding:** 16px nos ajustes, 20px no resultado e nas janelas, 10 a 14px nas seções recolhidas.

### Inputs / Fields
- **Style:** cartão branco, borda de campo de 1px (3:1 ou mais), cantos de 8px, 44px de altura, letra de 16px.
- **Focus:** o contorno de 3px em azul caneta; hover troca a borda para azul.
- **Error / Disabled:** desabilitado a 60% de opacidade; caixa de seleção de 22px com `accent-color` azul e linha de 44px.

### Navigation
Cabeçalho branco com fio embaixo, 60px: ícone de 28px e "Scanner Doc" em 800 à esquerda, troca de idioma à direita (sublinhada por contorno azul quando o navegador está em outra língua). Rodapé em cinza, 0,875rem, com versão em mono e a assinatura "por" seguida do logo reduzido da Sankler, trocado por `<picture>` entre a versão de fundo claro e a de fundo escuro, nunca recolorido.

### Carimbo de conferência (signature)
A assinatura visual do app. Borda dupla de 4px em azul caneta, cantos de 4px, letra em azul de escrever, mono 600 em caixa alta com 0,06em, girado -2° a partir da esquerda, opacidade 0,94, fundo transparente. Linhas internas separadas por fio azul de 1px; a regra (`connect-src 'none'`) é a última linha, em caixa normal. Usos: o carimbo do topo ("Processado no aparelho · 0 bytes enviados"), o carimbo pequeno "Tarjado" no item do recibo e os carimbos do resultado (o que foi conferido). Só quando aparece pela primeira vez ele "bate": 0,22s de escala 1,15 para 1 e opacidade 0 para 1, sem animação com movimento reduzido.

### Recibo de páginas (signature)
Cartão branco sem borda de baixo, terminado em borda picotada. Cada item: número em mono (01, 02...), miniatura de 48×64 (52×68 no computador) que abre a tela cheia, nome e meta em mono, Tarjar e Editar à mão, alça de arrastar e "Mais ações" (menu que abre no lugar, embaixo da linha, com Remover por último em vermelho). Itens separados por fio tracejado; no pé, a linha do total em mono. Ao arrastar, os outros deslizam em 0,18s.

### Seções recolhidas
`details` com cartão de 10px; o `summary` é o botão (56px), com o título em 700 e, embaixo, o estado ligado em mono cinza; seta desenhada em CSS que gira ao abrir; fio tracejado entre o título e o corpo aberto. Nada de cartão dentro de cartão.

### Barra do polegar
Resumo dos ajustes em mono ("A4 · Documento · sem senha") com "Mudar" ao lado, e "Gerar PDF" cheio a 52px. Acima dela, quando há texto, o aviso com Desfazer e fechar, em cartão com fio. O `#status` dentro do aviso é a única região de aviso da tela principal e nunca leva `display: none`: vazio ou com o sucesso (que o cartão do resultado já mostra), o cartão sai só da tela, no padrão `.sr-only`. O aviso informativo some no próximo toque ou na próxima tecla que age; Tab, setas, Home/End e as teclas de página não o apagam.

### Câmera (exceção intencional)
A tela da câmera fica fora dos temas: fundo preto puro, texto branco e botões em pílula (`border-radius: 999px`) de fundo night-card com borda night-field-edge, o obturador branco redondo e o amarelo `#fde68a` só para o alerta de luz e o botão ligado. É escura de propósito, nos dois temas: o que importa ali é o papel na imagem, e qualquer moldura clara compete com ele. Fora da câmera, nada usa preto puro, pílula nem amarelo.

## Do's and Don'ts

### Do:
- **Do** use o carimbo (borda dupla azul, caixa alta mono, girado) para toda garantia conferida: privacidade, tarja, senha, PDF/A, assinatura.
- **Do** escreva texto, link e ícone azuis com ink-blue-text (claro) ou ink-blue-text-dark (escuro), nunca com ink-blue.
- **Do** ponha todo número conferível na mono do sistema com `tabular-nums`.
- **Do** separe itens de lista por fio tracejado e cartões por fio de 1px, sem sombra.
- **Do** dê 44px de alvo a todo controle e 52px às ações principais.
- **Do** troque o logo da Sankler pela versão de fundo escuro no tema escuro, com `<picture>`, e mantenha a assinatura só no rodapé.
- **Do** desligue a batida do carimbo e o deslizar do recibo com `prefers-reduced-motion`.

### Don't:
- **Don't** introduza uma segunda cor de destaque nem verde de sucesso: "deu certo" é o carimbo azul.
- **Don't** use vermelho fora de erro, remoção e momento de risco.
- **Don't** carregue fonte nenhuma, nem do próprio site: a CSP tem `font-src 'none'`.
- **Don't** recolora o logo da Sankler nem ponha a assinatura dentro do PDF gerado.
- **Don't** ponha cartão dentro de cartão nas seções recolhidas.
- **Don't** dê sombra a superfície parada; sombra é só do que flutua.
