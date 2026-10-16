// Gera o web/vendor/tesseract/por.traineddata.js: o modelo de português do OCR dentro de um módulo JS.
// Motivo: o Tesseract.js baixaria o modelo com fetch, e a página não abre conexão nenhuma (connect-src 'none').
// Um módulo JS do próprio site é carregado como script ('self'), sem afrouxar a política.
// O arquivo .gz entra inteiro, em base64; quem descompacta é o worker do Tesseract.
//
// Uso: node scripts/gerar-modelo-ocr.mjs <caminho do por.traineddata.gz>
//   O .gz vem do pacote npm @tesseract.js-data/por@1.0.0, pasta 4.0.0_best_int:
//   npm pack @tesseract.js-data/por@1.0.0 && tar -xzf tesseract.js-data-por-1.0.0.tgz
//   node scripts/gerar-modelo-ocr.mjs package/4.0.0_best_int/por.traineddata.gz
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// SHA-256 do por.traineddata.gz do @tesseract.js-data/por@1.0.0 (também anotado no README do vendor).
const SHA256 = 'dacebc1386ddaaf8389f81094236cca0d690897cde693d48cbdaa881c86e2b4c';

const [input] = process.argv.slice(2);
if (!input) {
  console.error('Uso: node scripts/gerar-modelo-ocr.mjs <caminho do por.traineddata.gz>');
  process.exit(1);
}
const gz = readFileSync(input);
const hash = createHash('sha256').update(gz).digest('hex');
if (hash !== SHA256) {
  console.error(`SHA-256 diferente do esperado.\n  esperado: ${SHA256}\n  arquivo:  ${hash}`);
  process.exit(1);
}

const output = new URL('../web/vendor/tesseract/por.traineddata.js', import.meta.url);
writeFileSync(output, '// Modelo de português do Tesseract (@tesseract.js-data/por@1.0.0, 4.0.0_best_int/por.traineddata.gz), em base64.\n'
  + `// Gerado por scripts/gerar-modelo-ocr.mjs. SHA-256 do .gz: ${SHA256}\n`
  + `export default '${gz.toString('base64')}';\n`);
console.log(`Gerado ${output.pathname} (${gz.length} bytes do .gz).`);
