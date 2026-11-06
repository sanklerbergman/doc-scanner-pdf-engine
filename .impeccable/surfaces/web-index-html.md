---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: ["web/en/index.html"]
---

# Superfície: app (web/index.html e web/en/index.html)

Modo: Operate. Celular primeiro (iPhone de referência), computador também.
Tarefa: foto, Word ou PDF → PDF, com tarja, edição, preenchimento, OCR, senha, PDF/A e assinatura A1. O caminho simples (adicionar → Gerar PDF) fica sempre à vista; o avançado fica recolhido com resumo do que está ligado.
Escolha do dono (2026-11-06): direção "Carimbo de conferência" com tinta azul caneta Sankler #3a63ff (não roxo), para o app ficar da família Sankler sem usar o logo.
Restrição: CSP com font-src 'none' (não afrouxar): só fontes do sistema, sans e monoespaçada.
Referência do esboço escolhido: .impeccable/mocks/decision/model-pick.html (roxo trocado pelo azul caneta).

## Direction contract

THESIS: Toda garantia do app aparece como carimbo de conferido, em tinta azul caneta: "Processado no aparelho · 0 bytes enviados" no topo, "Tarjado", "Conferido: nada sob as tarjas", "Protegido com senha", "Assinado" nas páginas e no resultado. Recusa o padrão da categoria (grade cinza, azul genérico, privacidade num card de texto abaixo da dobra).

OWN-WORLD: papel frio #f5f6f9, cartões brancos, tinta preta Sankler #0b0c10; uma tinta só, azul caneta #3a63ff, para carimbos e ação (texto azul em #2b4fe0 no claro, #8aa2ff no escuro); vermelho só para erro. Carimbo: borda dupla, caixa alta monoespaçada, levemente girado, opacidade de tinta. Números (páginas, KB, protocolo) em monoespaçada do sistema. Lista de páginas lida como recibo numerado (01, 02, 03), bordas tracejadas entre itens. Tema escuro: papel #0b0c10, mesma tinta.

STORY: a pessoa entende em um olhar que nada sai do aparelho (o carimbo do topo), adiciona foto ou arquivo, vê cada página como item do recibo com Tarjar/Editar à mão, ajusta só se quiser e toca Gerar PDF na barra do polegar; no fim, o resultado traz os carimbos do que foi conferido.

FIRST VIEWPORT: celular 390×844: marca "Scanner Doc" + linha do produto e "English" no topo; logo abaixo, o carimbo "Processado no aparelho · 0 bytes enviados · connect-src 'none'"; dois botões grandes lado a lado, "Tirar foto" (cheio, azul) e "Adicionar arquivos" (contorno); com páginas, o recibo numerado; barra fixa no rodapé com resumo ("A4 · Documento · sem senha", Mudar) e "Gerar PDF" em azul caneta. Sem páginas, a área de soltar arquivos ocupa o lugar do recibo.

FORM: Carimbo de conferência, candidato 1 da lista ordenada (escolha do Impeccable, escolhida pelo dono); seed:717de71b3a161b87

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
