# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Duas audiências, com o mesmo peso:

- **Pessoa comum, no celular**, que precisa mandar um documento (RG, comprovante, contracheque, contrato) para uma empresa, um órgão público ou um advogado e quer só "foto → PDF" sem saber o que é PDF/A, OCR ou certificado A1. O iPhone é o aparelho de referência.
- **Profissional** (advocacia, escritório, quem lida com processo eletrônico) que usa PDF/A, tarja de dados, preenchimento de formulário, junção e separação de PDFs e assinatura com certificado A1, muitas vezes no computador.

O caminho simples tem que servir a primeira sem que as ferramentas avançadas atrapalhem; as avançadas têm que estar à mão para a segunda sem esconder o caminho simples.

## Product Purpose

Foto, Word ou PDF: tudo vira PDF, 100% no navegador. O app escaneia (câmera com recorte automático do papel), converte .docx, junta, separa e comprime PDFs, reconhece texto (OCR), edita e anota páginas, tarja dados de verdade, preenche formulários, protege com senha, gera PDF/A e assina com certificado A1 (PAdES). Sucesso: a pessoa sai com o PDF certo, sem cadastro, e confiando que nada saiu do aparelho dela.

## Positioning

- **Privacidade verificável, não prometida:** nada sai do aparelho, bloqueado por regra (CSP `connect-src 'none'`), sem backend, sem cadastro, sem rastreio, sem armazenamento persistente. Dá para conferir na aba Rede.
- **Código aberto (MIT), gratuito, sem anúncios, feito pela comunidade** e mantido por doação via Pix.
- Consequências que os concorrentes não oferecem do mesmo jeito: tarja que apaga o conteúdo e é conferida no PDF novo, assinatura A1 sem programa instalado, PDF limpo de metadados.

## Operating Context

- Uso principal no celular, muitas vezes com pressa, com documentos sensíveis (dados pessoais, financeiros, jurídicos); uso profissional também no computador.
- Momentos de risco: tarjar antes de enviar, assinar (alerta de site falso: só assinar em https://scanner.sankler.com.br/), proteger com senha (não há recuperação).
- Interface em português (`/`) e em inglês (`/en/`, gerada por `scripts/gerar-en.mjs` a partir do dicionário `web/js/i18n-en.js`).
- Funciona offline depois do primeiro acesso (service worker).

## Capabilities and Constraints

- JavaScript puro, ES modules, sem build e sem dependência nova sem conversa (CONTRIBUTING.md). Bibliotecas só em `web/vendor/`, carregadas sob demanda.
- Nada de terceiros em runtime: sem CDN, fontes externas ou scripts de outros domínios. Toda fonte de interface precisa ser servida pelo próprio site. A CSP e `web/_headers` não podem ser afrouxados.
- Sem `localStorage`/IndexedDB; segredos só na memória durante a operação.
- Funções pesadas (OCR, HEIC, PDF.js, fontes do PDF/A) são opcionais e só carregam quando usadas.
- Todo texto de tela entra em `t()` e no dicionário em inglês; o `test/i18n.test.js` confere.
- Fora do escopo: o que exige rede (carimbo do tempo, certificado A3/token/nuvem, XFA).

## Brand Commitments

- Nome **Scanner Doc** (obrigatório manter).
- **Voz** (obrigatório manter): português coloquial e exato, honesto sobre os limites ("Detalhe honesto", "o A3 não funciona"), verbos de ação nos controles ("Achar o papel", "Tarjar", "Pular este arquivo").
- Ícone, cores e tipografia atuais **não** são obrigatórios: o redesenho pode propor nova identidade visual para o produto.
- Assinatura **"por Sankler"** no rodapé, na tela "Sobre" e no README, nunca dentro do PDF gerado (padrão Sankler).

## Evidence on Hand

- Código aberto no GitHub (sanklerbergman/doc-scanner-pdf-engine), histórico público, deploy só da `main` com conferência de integridade dos arquivos no ar (README).
- Tabela de garantias de privacidade e seus limites no README.
- Não há depoimentos, números de uso nem imprensa: não inventar (o app não coleta estatística).

## Product Principles

1. **Privacidade é prova, não slogan:** o que o app garante deve ser verificável e visível no uso, nunca exagerado.
2. **O caminho simples primeiro:** foto → PDF em poucos toques; o avançado aparece quando a pessoa precisa, sem esconder que existe.
3. **Honestidade nos limites:** dizer o que não funciona e por quê, no lugar certo.
4. **Segurança nos momentos de risco:** tarja, senha e assinatura pedem confirmação e mostram o que foi conferido.
5. **Nada fica:** o app não lembra nada entre visitas; a interface não pode depender disso.

## Accessibility & Inclusion

- Meta: WCAG 2.2 AA, incluindo quem usa só ponteiro (alternativa a arrastar, SC 2.5.7), teclado e leitor de tela, zoom de 400% e celular deitado.
- Toque com alvo de 44px; `prefers-reduced-motion` respeitado; tema claro e escuro (`prefers-color-scheme`).
