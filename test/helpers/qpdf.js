// Conferência independente dos PDFs que o app gera: o buildPdf daqui é o do app, mas cada PDF montado passa
// pelo qpdf --check (estrutura, tabela xref, streams que dá para descompactar e conteúdo das páginas).
// O próprio leitor do app aceitaria erros que ele mesmo comete; o qpdf não.
//
// No CI o qpdf é obrigatório (instalado pelo apt). Na máquina de quem desenvolve, sem ele a conferência é
// pulada com um aviso. O caminho do programa pode vir na variável QPDF.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPdf as build } from '../../web/js/pdf.js';

const QPDF = process.env.QPDF || 'qpdf';

let available;

function hasQpdf() {
  if (available !== undefined) return available;
  available = !spawnSync(QPDF, ['--version']).error;
  if (!available && process.env.CI) throw new Error(`qpdf não encontrado (${QPDF}): no CI ele é obrigatório.`);
  if (!available) console.warn(`qpdf não encontrado (${QPDF}): os PDFs gerados não passam pela conferência independente.`);
  return available;
}

/**
 * Passa um PDF pelo qpdf --check. Erro ou aviso do qpdf derruba o teste.
 * @param {Uint8Array} bytes
 */
export function qpdfCheck(bytes) {
  if (!hasQpdf()) return;
  const dir = mkdtempSync(join(tmpdir(), 'qpdf-'));
  let result;
  try {
    writeFileSync(join(dir, 'gerado.pdf'), bytes);
    result = spawnSync(QPDF, ['--check', join(dir, 'gerado.pdf')], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 0: sem problemas; 2: erros; 3: só avisos. Para um PDF que o app gerou, aviso também é falha.
  if (result.status !== 0) {
    throw new Error(`qpdf --check recusou o PDF gerado (saída ${result.status}):\n${result.stdout}${result.stderr}`);
  }
}

/** O buildPdf do app, com o PDF conferido pelo qpdf. */
export function buildPdf(pages) {
  const out = build(pages);
  qpdfCheck(out);
  return out;
}
