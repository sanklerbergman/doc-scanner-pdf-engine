// Conferência independente dos PDFs que o app gera: o buildPdf daqui é o do app, mas cada PDF montado passa
// pelo qpdf --check (estrutura, tabela xref, streams que dá para descompactar e conteúdo das páginas).
// O próprio leitor do app aceitaria erros que ele mesmo comete; o qpdf não.
//
// No CI o qpdf é obrigatório (instalado pelo apt). Na máquina de quem desenvolve, sem ele a conferência é
// pulada com um aviso. O caminho do programa pode vir na variável QPDF.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * @param {string} [password] senha, para PDF protegido
 */
export function qpdfCheck(bytes, password) {
  if (!hasQpdf()) return;
  const dir = mkdtempSync(join(tmpdir(), 'qpdf-'));
  let result;
  try {
    writeFileSync(join(dir, 'gerado.pdf'), bytes);
    const args = password === undefined ? [] : [`--password=${password}`];
    result = spawnSync(QPDF, ['--check', ...args, join(dir, 'gerado.pdf')], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 0: sem problemas; 2: erros; 3: só avisos. Para um PDF que o app gerou, aviso também é falha.
  if (result.status !== 0) {
    throw new Error(`qpdf --check recusou o PDF gerado (saída ${result.status}):\n${result.stdout}${result.stderr}`);
  }
}

/**
 * Roda o qpdf com um PDF de entrada e devolve o PDF de saída (ex.: --decrypt), ou null sem o qpdf (fora do CI).
 * @param {string[]} args opções do qpdf, antes dos arquivos
 * @param {Uint8Array} bytes
 * @returns {{output: Uint8Array, stdout: string} | null}
 */
export function qpdfRun(args, bytes) {
  if (!hasQpdf()) return null;
  const dir = mkdtempSync(join(tmpdir(), 'qpdf-'));
  try {
    writeFileSync(join(dir, 'entrada.pdf'), bytes);
    const result = spawnSync(QPDF, [...args, join(dir, 'entrada.pdf'), join(dir, 'saida.pdf')], { encoding: 'utf8' });
    if (result.status !== 0 && result.status !== 3) throw new Error(`qpdf ${args.join(' ')} falhou (${result.status}):\n${result.stdout}${result.stderr}`);
    return { output: new Uint8Array(readFileSync(join(dir, 'saida.pdf'))), stdout: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Saída de um comando do qpdf que não gera arquivo (ex.: --show-encryption), ou null sem o qpdf. */
export function qpdfShow(args, bytes) {
  if (!hasQpdf()) return null;
  const dir = mkdtempSync(join(tmpdir(), 'qpdf-'));
  try {
    writeFileSync(join(dir, 'entrada.pdf'), bytes);
    const result = spawnSync(QPDF, [...args, join(dir, 'entrada.pdf')], { encoding: 'utf8' });
    return `${result.stdout}${result.stderr}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** O buildPdf do app, com o PDF conferido pelo qpdf. */
export function buildPdf(pages) {
  const out = build(pages);
  qpdfCheck(out);
  return out;
}
