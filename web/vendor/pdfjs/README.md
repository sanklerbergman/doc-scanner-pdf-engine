# PDF.js 6.3.289

Renderizador de PDF da Mozilla. Desenha as páginas dos PDFs abertos no app (miniaturas e tela cheia), para dar para conferir o que vai entrar no PDF novo. Não participa da geração: a cópia das páginas é feita pelo `js/pdf-reader.js`.

- Origem: pacote npm `pdfjs-dist@6.3.289` (SHA-256 do `.tgz`: `06f25e887adc6489f04c9fcb14198c77e4e5623a59a0bba5c4cea5838a4f1241`), arquivos `build/pdf.min.mjs` e `build/pdf.worker.min.mjs`, copiados sem alterações (só renomeados para `.js`, para qualquer servidor entregar com o tipo certo)
- SHA-256 de `pdf.min.js`: `f80490490320511e5df18c580b9edd6b5db8058dceebaf6f161992e0a964b9e2`
- SHA-256 de `pdf.worker.min.js`: `8ab0e5e30031b4a06ecfddd5ae9562f0227f830ee7ec9ed1a968b134243d2386`
- Licença: Apache-2.0 (ver `LICENSE`)
- Carregado sob demanda por `js/pdf-render.js`, só quando um PDF é adicionado
- O worker nasce de um blob que importa o arquivo daqui, então herda a política de segurança da página (`connect-src 'none'`). O WebAssembly (JPEG 2000, JBIG2) fica desligado e não é copiado; as fontes padrão vêm do sistema. Nada é baixado de outro lugar, e os scripts que um PDF possa ter não rodam (o `pdf.sandbox` não é copiado)

Para atualizar: `npm pack pdfjs-dist@<versão>`, copie os dois arquivos de `build/` renomeando para `.js`, e atualize versão e SHA-256 aqui.
