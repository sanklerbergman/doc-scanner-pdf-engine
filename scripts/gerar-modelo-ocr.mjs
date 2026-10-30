// Gera o web/vendor/tesseract/<idioma>.traineddata.js: o modelo do OCR dentro de um módulo JS (por, português; eng,
// inglês, para a página /en/, #22).
// Motivo: o Tesseract.js baixaria o modelo com fetch, e a página não abre conexão nenhuma (connect-src 'none').
// Um módulo JS do próprio site é carregado como script ('self'), sem afrouxar a política.
// O arquivo .gz entra inteiro, em base64; quem descompacta é o worker do Tesseract.
//
// Uso: node scripts/gerar-modelo-ocr.mjs <idioma> <caminho do .traineddata.gz>
//   O .gz vem do pacote npm @tesseract.js-data/<idioma>@1.0.0, pasta 4.0.0_best_int:
//   npm pack @tesseract.js-data/por@1.0.0 && tar -xzf tesseract.js-data-por-1.0.0.tgz
//   node scripts/gerar-modelo-ocr.mjs por package/4.0.0_best_int/por.traineddata.gz
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// SHA-256 do <idioma>.traineddata.gz do @tesseract.js-data/<idioma>@1.0.0 (também anotado no README do vendor).
const MODELS = {
  por: { name: 'português', sha256: 'dacebc1386ddaaf8389f81094236cca0d690897cde693d48cbdaa881c86e2b4c' },
  eng: { name: 'inglês', sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91' },
};

const [lang, input] = process.argv.slice(2);
const model = MODELS[lang];
if (!model || !input) {
  console.error(`Uso: node scripts/gerar-modelo-ocr.mjs <${Object.keys(MODELS).join(' | ')}> <caminho do .traineddata.gz>`);
  process.exit(1);
}
const gz = readFileSync(input);
const hash = createHash('sha256').update(gz).digest('hex');
if (hash !== model.sha256) {
  console.error(`SHA-256 diferente do esperado.\n  esperado: ${model.sha256}\n  arquivo:  ${hash}`);
  process.exit(1);
}

const output = new URL(`../web/vendor/tesseract/${lang}.traineddata.js`, import.meta.url);
writeFileSync(output, `// Modelo de ${model.name} do Tesseract (@tesseract.js-data/${lang}@1.0.0, 4.0.0_best_int/${lang}.traineddata.gz), em base64.\n`
  + `// Gerado por scripts/gerar-modelo-ocr.mjs. SHA-256 do .gz: ${model.sha256}\n`
  + `export default '${gz.toString('base64')}';\n`);
console.log(`Gerado ${output.pathname} (${gz.length} bytes do .gz).`);
