// Gera os web/vendor/liberation/*.ttf.js: as fontes Liberation dentro de módulos JS, para o PDF/A dos documentos do
// Word (js/pdfa-fonts.js). Motivo: a página não abre conexão nenhuma (connect-src 'none'), então não dá para baixar
// a fonte com fetch; um módulo JS do próprio site é carregado como script ('self'), sem afrouxar a política.
// Cada .ttf entra inteiro, sem alteração, em base64; o subconjunto com as letras usadas é feito no aparelho (js/ttf.js).
//
// Uso: node scripts/gerar-fontes-pdfa.mjs <pasta com os .ttf>
//   Os .ttf vêm da versão 2.1.5 das Liberation (github.com/liberationfonts/liberation-fonts, release 2.1.5,
//   arquivo liberation-fonts-ttf-2.1.5.tar.gz):
//   tar -xzf liberation-fonts-ttf-2.1.5.tar.gz
//   node scripts/gerar-fontes-pdfa.mjs liberation-fonts-ttf-2.1.5
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// SHA-256 de cada arquivo da versão 2.1.5 (também anotados no README do vendor).
const FILES = {
  'LiberationSans-Regular.ttf': '76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8',
  'LiberationSans-Bold.ttf': '788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173',
  'LiberationSans-Italic.ttf': 'e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0',
  'LiberationSans-BoldItalic.ttf': '698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee',
  'LiberationSerif-Regular.ttf': '058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74',
  'LiberationSerif-Bold.ttf': 'd754ba427cfe0bca54ae052384baa8f842da5bd6550ad4da024ac441e7a7d5ce',
  'LiberationSerif-Italic.ttf': '0e3dea9f8d613e006ccfa62201f33e265d19167bd0907725c3e145368b04fc2e',
  'LiberationSerif-BoldItalic.ttf': 'f17db8af71e24d2066b587546021d4f0b296be389512b658dec3c09affeb11a7',
  'LiberationMono-Regular.ttf': 'f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1',
  'LiberationMono-Bold.ttf': 'bd62a0672d0b9b6710b01df434c80ad54fa5f0835207eb7b17b7a761463067bb',
  'LiberationMono-Italic.ttf': '605c01c711b44480a7508d349dfbf3264e81fa43d69e61cfa7d10b86e764c4d1',
  'LiberationMono-BoldItalic.ttf': '79451f3c09fe25116098853b7a2ca6e2436220ccc11af022979adbcf195be130',
  LICENSE: '93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b',
};

const [folder] = process.argv.slice(2);
if (!folder) {
  console.error('Uso: node scripts/gerar-fontes-pdfa.mjs <pasta com os .ttf>');
  process.exit(1);
}
const output = new URL('../web/vendor/liberation/', import.meta.url);
mkdirSync(output, { recursive: true });
for (const [name, expected] of Object.entries(FILES)) {
  const bytes = readFileSync(join(folder, name));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== expected) {
    console.error(`${name}: SHA-256 diferente do esperado.\n  esperado: ${expected}\n  arquivo:  ${hash}`);
    process.exit(1);
  }
  if (name === 'LICENSE') {
    copyFileSync(join(folder, name), new URL('LICENSE', output));
    continue;
  }
  writeFileSync(new URL(`${name}.js`, output), `// ${name} (Liberation Fonts 2.1.5, SIL Open Font License 1.1: ver LICENSE), em base64, sem alteração.\n`
    + `// Gerado por scripts/gerar-fontes-pdfa.mjs. SHA-256 do .ttf: ${expected}\n`
    + `export default '${bytes.toString('base64')}';\n`);
  console.log(`${name}.js (${bytes.length} bytes do .ttf)`);
}
