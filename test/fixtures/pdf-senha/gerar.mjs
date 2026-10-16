// PDFs de teste com senha, cifrados pelo qpdf em cada revisão do mecanismo padrão do PDF (2 a 6).
// Uso, nesta pasta: node gerar.mjs   (o programa vem da variável QPDF ou do PATH; qpdf 11 ou mais novo)
//
// O base.pdf tem duas páginas: texto com acentos no conteúdo (stream comprimido), strings em dicionários
// (catálogo e campo de formulário) e um campo com aparência própria (outro stream). Cada arquivo cifrado é o
// mesmo base.pdf; os testes conferem que o app decifra igual ao qpdf --decrypt.
// Senhas: "usuario" para abrir e "dono" de proprietário, a não ser onde o nome do arquivo diz outra coisa.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { makeRawPdf } from '../../helpers/pdf.js';

const QPDF = process.env.QPDF || 'qpdf';
const here = (name) => new URL(name, import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

const base = makeRawPdf({
  1: '<< /Type /Catalog /Pages 2 0 R /Teste << /Texto (Cora\\347\\343o e a\\347\\343o) >> >>',
  2: '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /MediaBox [0 0 595 842] >>',
  3: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  4: { data: 'BT /F1 18 Tf 72 760 Td (Contracheque de teste: sal\\341rio l\\355quido R$ 1.234,56) Tj ET', deflate: true },
  5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  6: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R /Annots [8 0 R] >>',
  7: { data: 'BT /F1 14 Tf 72 760 Td (Segunda p\\341gina) Tj ET' },
  8: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Nome) /V (Fulano de Teste) /F 4 /Rect [72 600 300 620] /AP << /N 9 0 R >> >>',
  9: { dict: '/BBox [0 0 228 20] /Resources << /Font << /F1 5 0 R >> >>', data: 'BT /F1 12 Tf 2 5 Td (Fulano de Teste) Tj ET', deflate: true },
}).bytes;
writeFileSync(here('base.pdf'), base);

const variants = {
  'r2-rc4-40.pdf': ['--allow-weak-crypto', '--encrypt', 'usuario', 'dono', '40', '--'],
  'r3-rc4-128.pdf': ['--allow-weak-crypto', '--encrypt', 'usuario', 'dono', '128', '--use-aes=n', '--'],
  'r4-aes-128.pdf': ['--encrypt', 'usuario', 'dono', '128', '--use-aes=y', '--'],
  'r4-aes-128-object-streams.pdf': ['--object-streams=generate', '--encrypt', 'usuario', 'dono', '128', '--use-aes=y', '--'],
  'r5-aes-256.pdf': ['--allow-weak-crypto', '--encrypt', 'usuario', 'dono', '256', '--force-R5', '--'],
  'r6-aes-256.pdf': ['--encrypt', 'usuario', 'dono', '256', '--'],
  'r6-aes-256-object-streams.pdf': ['--object-streams=generate', '--encrypt', 'usuario', 'dono', '256', '--'],
  // Só restrições (sem senha para abrir): o app abre sem pedir senha e avisa que o PDF novo sai sem elas.
  'r6-so-restricoes.pdf': ['--encrypt', '', 'dono', '256', '--modify=none', '--extract=n', '--print=none', '--'],
  'r3-so-restricoes.pdf': ['--allow-weak-crypto', '--encrypt', '', 'dono', '128', '--use-aes=n', '--modify=none', '--'],
  // Senhas com acento e fora do Latin-1.
  'r4-senha-acao.pdf': ['--encrypt', 'ação', 'dono', '128', '--use-aes=y', '--'],
  'r6-senha-acao.pdf': ['--encrypt', 'ação', 'dono', '256', '--'],
  'r6-senha-japones.pdf': ['--encrypt', 'パスワード', 'dono', '256', '--'],
};

for (const [name, args] of Object.entries(variants)) {
  const result = spawnSync(QPDF, [...args, here('base.pdf'), here(name)], { encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 3) throw new Error(`${name}: ${result.stderr || result.error}`);
  console.log(name);
}
