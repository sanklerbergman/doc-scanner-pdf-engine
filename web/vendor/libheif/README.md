# libheif-js 1.23.2

Decodificador de HEIC/HEIF (fotos de iPhone) para navegadores que não abrem o formato sozinhos (Chrome, Firefox, Edge).

- Origem: pacote npm `libheif-js@1.23.2`, arquivo `libheif-wasm/libheif-bundle.mjs`, copiado sem alterações (só renomeado para `.js`, para qualquer servidor entregar com o tipo certo)
- SHA-256 do arquivo: `d05292271af008d300cc75be374feb8fd35b418a71420a556c3fb817f662b502` (confira com `sha256sum` depois de qualquer atualização)
- Licença: LGPL-3.0 (ver `LICENSE` e `LICENSE-libheif`)
- Carregado sob demanda por `js/imaging.js`, só quando uma imagem HEIC é adicionada
- O WebAssembly vai embutido no próprio arquivo: nada é baixado de outro lugar

Para atualizar: `npm pack libheif-js` e substitua o arquivo pelo `.mjs` da nova versão.
