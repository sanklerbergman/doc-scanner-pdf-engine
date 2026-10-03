# libheif-js 1.23.2

Decodificador de HEIC/HEIF (fotos de iPhone) para navegadores que não abrem o formato sozinhos (Chrome, Firefox, Edge).

- Origem: pacote npm `libheif-js@1.23.2`, arquivo `libheif-wasm/libheif-bundle.mjs`, copiado sem alterações (só renomeado para `.js`, para qualquer servidor entregar com o tipo certo)
- Licença: LGPL-3.0 (ver `LICENSE` e `LICENSE-libheif`)
- Carregado sob demanda por `js/imaging.js`, só quando uma imagem HEIC é adicionada
- O WebAssembly vai embutido no próprio arquivo: nada é baixado de outro lugar

Para atualizar: `npm pack libheif-js` e substitua o arquivo pelo `.mjs` da nova versão.
