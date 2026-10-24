// A tarja apaga também as edições: no PDF/A, as letras tiradas pela tarja não ficam no subconjunto da fonte embutida
// (nem no programa, nem no /Widths, nem no ToUnicode). Texto, cabeçalho e rodapé, e marca d'água.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textEdit, allPagesText } from '../web/js/edit-text.js';
import { watermarkEdit } from '../web/js/edit-marks.js';
import { textWidth } from '../web/js/fonts.js';
import { layoutPage, buildPdf as buildRaw, redactedEdits } from '../web/js/pdf.js';
import { embedFonts } from '../web/js/pdfa-fonts.js';
import { buildPdf } from './helpers/qpdf.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const A4 = { width: 595.28, height: 841.89 };

const photoPage = (extra = {}) => ({ jpeg: fixture('rgb-40x30.jpg'), ...layoutPage(30, 40, 'a4', 36), ...extra });

// ---------- PDF/A: as letras tarjadas não ficam na fonte embutida ----------

const TARJADAS = ['J', 'ã', 'S', 'v'];
const hexCode = (char) => `<${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`;

async function assertLeftOut(pages, font) {
  const fonts = await embedFonts(pages);
  const embedded = fonts.get(font);
  assert.ok(embedded, `fonte ${font} embutida`);
  for (const char of TARJADAS) assert.ok(!embedded.chars.includes(char), `${char} no subconjunto: ${embedded.chars}`);
  assert.ok(embedded.chars.includes('N') && embedded.chars.includes(':'), 'o que fica continua');
  const text = latin1(buildPdf(pages, { pdfa: true, fonts }));
  for (const char of TARJADAS) assert.ok(!text.includes(hexCode(char)), `${char} no ToUnicode`);
}

test('PDF/A: texto "Nome: João da Silva" com tarja sobre "João da Silva" não leva J, ã, S nem v na fonte embutida', async () => {
  const edit = textEdit({ text: 'Nome: João da Silva', size: 20 }, [0.5, 0.3], A4);
  const left = edit.x0 * A4.width + 0.2 * 20 + textWidth('Nome: ', 'Helvetica', 20);
  const item = { type: 'redaction', x: left - 1, y: edit.y0 * A4.height - 2, w: edit.x1 * A4.width - left + 4, h: (edit.y1 - edit.y0) * A4.height + 4 };
  const page = { width: A4.width, height: A4.height, items: [item], edits: [edit] };
  // Saem as letras de "João da Silva" (e o espaço antes, que a tarja também pega); "Nome:" fica.
  const hidden = redactedEdits(page)[0].hidden.map(([, k]) => k);
  assert.deepEqual(hidden.filter((k) => k > 5), [...'João da Silva'].map((_, k) => k + 6));
  assert.ok(hidden.every((k) => k >= 5));
  await assertLeftOut([page], 'Helvetica');
});

test('PDF/A: cabeçalho e rodapé com tarja: as letras tiradas não ficam na fonte embutida', async () => {
  const edits = allPagesText({ header: { text: 'Nome: João da Silva', spot: 'top-left' }, footer: { text: 'Nome: João da Silva', spot: 'bottom-left' } },
    { position: 1, total: 1, size: A4 });
  const photo = photoPage({ edits });
  const { x, y, w, h } = photo.box;
  const top = photo.height - y - h;
  // Tarja da metade direita da linha de cada texto, na folha → na imagem (a margem é coberta só onde há imagem).
  const covers = edits.map((edit) => {
    const at = edit.x0 * photo.width + (textWidth('Nome: ', 'Helvetica', 10) + 2) * (edit.y1 - edit.y0) * photo.height / (10 * 1.65);
    return { x0: (at - x) / w, x1: 1, y0: (edit.y0 * photo.height - 2 - top) / h, y1: (edit.y1 * photo.height + 2 - top) / h };
  });
  // O cabeçalho e o rodapé ficam na margem, fora da imagem: as tarjas da imagem não chegam lá. Na página de PDF
  // tarjada (que vira imagem da página inteira), chegam.
  const pdfPage = { jpeg: fixture('rgb-40x30.jpg'), width: A4.width, height: A4.height, box: { x: 0, y: 0, w: A4.width, h: A4.height }, edits };
  pdfPage.redactions = edits.map((edit) => {
    const at = edit.x0 + (0.2 * 10 + textWidth('Nome: ', 'Helvetica', 10)) / A4.width;
    return { x0: at - 0.001, x1: 1, y0: edit.y0 - 0.005, y1: edit.y1 + 0.005 };
  });
  assert.ok(covers.length === 2);
  await assertLeftOut([pdfPage], 'Helvetica');
});

test('PDF/A: marca d\'água com tarja: as letras tiradas não ficam na fonte embutida', async () => {
  const edit = watermarkEdit('ABCDEFGHIJ');
  const page = { width: A4.width, height: A4.height, items: [], edits: [edit] };
  // A diagonal sobe da esquerda para a direita: a tarja no alto, à direita, pega as últimas letras.
  page.items.push({ type: 'redaction', x: A4.width * 0.55, y: 0, w: A4.width * 0.45, h: A4.height * 0.45 });
  const [cut] = redactedEdits(page);
  const hidden = cut.hide.map((i) => 'ABCDEFGHIJ'[i]);
  assert.ok(hidden.length > 0 && hidden.length < 10, hidden.join(''));
  const fonts = await embedFonts([page]);
  const chars = fonts.get('Helvetica-Bold').chars;
  for (const char of hidden) assert.ok(!chars.includes(char), `${char} no subconjunto: ${chars}`);
  const text = latin1(buildPdf([page], { pdfa: true, fonts }));
  for (const char of hidden) assert.ok(!text.includes(hexCode(char)), `${char} no ToUnicode`);
});

test('PDF/A sem tarja: as letras continuam todas (nada some sem tarja)', async () => {
  const edit = textEdit({ text: 'Nome: João da Silva', size: 20 }, [0.5, 0.3], A4);
  const fonts = await embedFonts([{ width: A4.width, height: A4.height, items: [], edits: [edit] }]);
  for (const char of TARJADAS) assert.ok(fonts.get('Helvetica').chars.includes(char));
  assert.ok(latin1(buildRaw([{ width: A4.width, height: A4.height, items: [], edits: [edit] }], { pdfa: true, fonts })).includes(hexCode('J')));
});
