# Tesseract.js 7.0.0 (OCR)

Reconhecimento de texto das fotos ("Texto pesquisável (OCR)"). É o Tesseract compilado para WebAssembly, com o modelo de português. O app desenha a camada de texto invisível no PDF (`js/pdf.js`); daqui só vem o reconhecimento.

| Arquivo | Origem | SHA-256 |
| --- | --- | --- |
| `worker.min.js` | `tesseract.js@7.0.0`, `dist/worker.min.js` | `576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d` |
| `worker.min.js.LICENSE.txt` | `tesseract.js@7.0.0`, `dist/` | `45f54171aeaa1d10c0c1a66f374b7bba1f02472b1487fbe892eec04f840002ac` |
| `tesseract-core-lstm.wasm.js` | `tesseract.js-core@7.0.0` | `eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680` |
| `tesseract-core-simd-lstm.wasm.js` | `tesseract.js-core@7.0.0` | `c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38` |
| `tesseract-core-relaxedsimd-lstm.wasm.js` | `tesseract.js-core@7.0.0` | `861a536cf9ef8e63cb644d57bab39c388f37f7d6b6f60024b741c5f6b39a59b3` |
| `por.traineddata.js` | gerado de `@tesseract.js-data/por@1.0.0`, `4.0.0_best_int/por.traineddata.gz` (SHA-256 do `.gz`: `dacebc1386ddaaf8389f81094236cca0d690897cde693d48cbdaa881c86e2b4c`) | `a8e517d407de272a057674fa1e1378d7f367d51f42feef85f2cccdef8e567134` |

SHA-256 dos pacotes npm:

- `tesseract.js-7.0.0.tgz`: `9a93bf51c3387f945d10a24bf8b3a4bf2e45c7c7161b8242aafbaf9d3c4b606a`
- `tesseract.js-core-7.0.0.tgz`: `ba584355515eaff877552022853c0e71f2cb70466e759d1d6940484929718ee0`
- `tesseract.js-data-por-1.0.0.tgz`: `e9d54a379afab14fbd18530fc6a6e6cc8f7c0be2799c74be854eda920aabddac`

Os arquivos do Tesseract.js entram sem nenhuma alteração. Só o modelo muda de forma: o `.gz` vira um módulo JS em base64, pelo `scripts/gerar-modelo-ocr.mjs` (que confere o SHA-256 do `.gz`).

## Licenças

- Tesseract.js e tesseract.js-core: Apache-2.0 (ver `LICENSE`). As bibliotecas que vão dentro do `worker.min.js` estão em `worker.min.js.LICENSE.txt`.
- Modelo de português: vem do [tessdata_best](https://github.com/tesseract-ocr/tessdata_best) do Tesseract (Apache-2.0), convertido para inteiros (`best_int`). O pacote `@tesseract.js-data/por` é publicado como MIT.

## Como o app usa

- Carregado sob demanda por `js/ocr.js`, só quando a pessoa liga o OCR e gera o PDF. Quem não usa não baixa nada daqui. Quem usa baixa uns 5,5 MB na primeira vez (o worker, uma das três variantes do núcleo e o modelo); depois, os arquivos ficam no cache do service worker.
- O núcleo tem três variantes. O worker escolhe a que o aparelho suporta (com ou sem SIMD), e só essa é baixada. As variantes sem `-lstm` (motor antigo do Tesseract) não são copiadas.
- **Sem rede:** o worker nasce de um blob que importa o `worker.min.js`, então herda a política da página (`connect-src 'none'`). O WebAssembly vai embutido nos `.wasm.js` (permitido pelo `'wasm-unsafe-eval'`). O modelo chega ao worker em bytes, vindo do `por.traineddata.js`: o Tesseract nunca usa `fetch`.
- **Nada guardado:** `cacheMethod: 'none'`, então o Tesseract.js não grava o modelo no IndexedDB. Sem logs.
- **Sem a biblioteca da página:** o app conversa direto com o worker, pelo protocolo dele (`load`, `loadLanguage`, `initialize`, `recognize`), e não copia o `tesseract.esm.min.js`. Na versão 7.0.0, a biblioteca da página manda os bytes do modelo no lugar do nome do idioma ao inicializar (`initialize` usa `lang.data` em vez de `lang.code`), e o Tesseract não inicia. Ao atualizar, confira se o protocolo do worker mudou.

## Para atualizar

1. `npm pack tesseract.js@<versão> tesseract.js-core@<versão> @tesseract.js-data/por@<versão>` numa pasta fora do repositório, e extraia cada `.tgz` numa pasta própria.
2. Copie `dist/worker.min.js` e `dist/worker.min.js.LICENSE.txt` do tesseract.js e os três `tesseract-core-*lstm.wasm.js` do núcleo.
3. Atualize o SHA-256 em `scripts/gerar-modelo-ocr.mjs` e rode `node scripts/gerar-modelo-ocr.mjs <pasta>/4.0.0_best_int/por.traineddata.gz`.
4. Atualize versões e SHA-256 aqui e aumente o `CACHE` do `sw.js`.
5. Teste no navegador (Chromium e WebKit): nenhuma requisição fora do site e nada no IndexedDB durante o OCR.
