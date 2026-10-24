// Assinar um PDF que já existe sem reescrever o arquivo (atualização incremental, ISO 32000-1, 7.5.6).
// Os bytes do original ficam intactos. No fim entram só o campo de assinatura (com o carimbo, se a pessoa quiser),
// os objetos que precisam apontar para ele (a página e o formulário, regravados com o mesmo número) e uma tabela
// xref nova. As assinaturas que o PDF já tinha continuam valendo: cada uma cobre os bytes dela, que não mudam.
// É o que permite que duas pessoas assinem o mesmo contrato, uma depois da outra.
// O PDF segue exatamente como veio, com tudo o que ele tiver (metadados, links, campos): o app avisa antes.
import { PdfDict, PdfRef, PdfName, PdfString, PdfStream, Keyword, isName, formatName, formatNumber, formatString } from './pdf-reader.js';
import { BYTE_RANGE_SPACE, finishSignature, pdfDate } from './pdf.js';
import { buildStamp, stampPageIndex } from './stamp.js';

const encoder = new TextEncoder();

/**
 * O PDF da lista, quando dá para assiná-lo sem reescrever: a lista é um PDF só, inteiro e na ordem, e nada do que foi
 * escolhido muda o arquivo (giro, tarja, edição, valor preenchido no formulário, compressão, OCR, senha, dividir, "em
 * todas as páginas"). Aí a assinatura entra no fim do arquivo, e as que ele já tinha continuam valendo.
 * @param {object[]} pages a lista de páginas do app
 * @param {{changes: boolean, groups: number[][] | null}} options changes: alguma opção do PDF muda o arquivo
 *   (compressão, senha, OCR, "em todas as páginas"); groups: os arquivos que vão sair (null: intervalos inválidos)
 * @returns {object | null} o documento do pdf-reader, ou null
 */
export function unchangedSource(pages, { changes, groups }) {
  const doc = pages[0]?.doc;
  if (!doc || changes || pages.length !== doc.pages.length || doc.form?.hasValues()) return null;
  const same = pages.every((page, i) => page.kind === 'pdf' && page.doc === doc && page.index === i && !page.rotation
    && !page.redactions?.length && !page.edits?.length);
  if (!same || groups?.length !== 1) return null;
  return groups[0].length === doc.pages.length && groups[0].every((n, i) => n === i) ? doc : null;
}

/**
 * Permissão de alteração de um PDF certificado (/DocMDP, ISO 32000-1, 12.8.2.2): 1 = nenhuma alteração;
 * 2 = preencher formulários e assinar; 3 = também comentar. Vale a mais restritiva, inclusive a que uma
 * assinatura de campo trava para o documento todo (/FieldMDP com /P, do PDF 2.0).
 * @returns {1 | 2 | 3 | null} null: o PDF não é certificado
 */
export function changePermission(doc) {
  const levels = [];
  const fromSignature = (signature) => {
    const references = signature instanceof PdfDict ? doc.resolve(signature.get('Reference')) : null;
    if (!Array.isArray(references)) return;
    for (const item of references.slice(0, 100)) {
      const reference = doc.resolve(item);
      if (!(reference instanceof PdfDict)) continue;
      const method = doc.resolve(reference.get('TransformMethod'));
      const params = doc.resolve(reference.get('TransformParams'));
      const p = params instanceof PdfDict ? doc.resolve(params.get('P')) : undefined;
      if (isName(method, 'DocMDP')) levels.push(p === 1 || p === 3 ? p : 2); // 2 é o padrão
      else if (isName(method, 'FieldMDP') && [1, 2, 3].includes(p)) levels.push(p);
    }
  };
  const perms = doc.resolve(doc.catalog().get('Perms'));
  if (perms instanceof PdfDict) fromSignature(doc.resolve(perms.get('DocMDP')));
  for (const { type, value } of doc.formFields()) if (type === 'Sig') fromSignature(value);
  return levels.length ? Math.min(...levels) : null;
}

// Limites dos leitores de PDF (ISO 32000-1, anexo C): número de objeto e de geração.
const MAX_OBJECT = 8388607;
const validGeneration = (gen) => Number.isInteger(gen) && gen >= 0 && gen <= 65535;

// Geração de um objeto, pelo cabeçalho dele ("12 0 obj"); o de dentro de object stream é sempre 0.
function generationOf(doc, num) {
  const entry = doc.entries.get(num);
  if (entry?.type === 2) return 0;
  return entry?.type === 1 ? doc.parseObjectAt(entry.offset)?.gen : undefined;
}

// A atualização aponta para a estrutura do original (/Prev, números e gerações dos objetos regravados). Ela só é
// acrescentada quando essa estrutura está limpa: /Size coerente, a tabela xref mais nova com geração válida, cada
// objeto que pode ser regravado com a mesma geração na referência e no cabeçalho, e toda página com MediaBox. Um PDF
// danificado que o leitor ainda abre fica para o caminho de sempre (o PDF novo), que conserta essas coisas.
function sound(doc) {
  // O arquivo termina na tabela que o leitor usou: depois do "startxref N" só vem o %%EOF (e espaço). Se vier mais
  // coisa, como uma atualização cortada no meio, acrescentar no fim esconderia essa parte.
  const end = new TextDecoder('latin1').decode(doc.bytes.subarray(doc.startxrefAt ?? doc.bytes.length));
  if (!/^startxref\s+\d+\s*%%EOF[\s\x00]*$/.test(end)) return false;
  const size = doc.trailer.get('Size');
  let max = 0;
  for (const num of doc.entries.keys()) if (num > max) max = num;
  if (!Number.isInteger(size) || size <= max || size > MAX_OBJECT) return false;
  if (isName(doc.trailer.get('Type'), 'XRef') && !validGeneration(doc.parseObjectAt(doc.startxref)?.gen)) return false;
  if (doc.pages.some((page) => page.guessed)) return false;
  const catalog = doc.catalog();
  const form = catalog.get('AcroForm');
  const refs = [doc.trailer.get('Root'), form, doc.resolve(form)?.get?.('Fields')];
  for (const page of doc.pages) refs.push(page.ref, page.node.get('Annots'));
  return refs.every((ref) => !(ref instanceof PdfRef) || (validGeneration(ref.gen) && generationOf(doc, ref.num) === ref.gen));
}

/**
 * O que impede acrescentar a assinatura no fim do PDF. null: dá para acrescentar.
 * - locked: o autor certificou o PDF sem permitir alterações (/DocMDP 1). Uma assinatura nova desfaria a
 *   certificação, então o app recusa;
 * - rewrite: o app não acrescenta com segurança (PDF com senha, tabela xref quebrada, estrutura fora do comum) e
 *   monta um PDF novo, como ao juntar ou dividir: aí as assinaturas que o PDF tinha deixam de valer.
 * @returns {{kind: 'locked' | 'rewrite', message: string} | null}
 */
export function appendBlocker(doc) {
  if (doc.security) {
    return { kind: 'rewrite', message: 'Este PDF tinha senha ou restrições: o app monta um PDF novo para assinar, e as assinaturas que ele já tinha deixam de valer.' };
  }
  if (doc.repaired || typeof doc.startxref !== 'number' || !(doc.trailer.get('Root') instanceof PdfRef) || doc.pages.some((page) => !page.ref) || !sound(doc)) {
    return { kind: 'rewrite', message: 'A estrutura deste PDF está danificada: o app monta um PDF novo para assinar, e as assinaturas que ele já tinha deixam de valer.' };
  }
  if (changePermission(doc) === 1) {
    return { kind: 'locked', message: 'O autor certificou este PDF sem permitir nenhuma alteração. Uma assinatura nova faria a certificação deixar de valer, por isso o app não assina este arquivo.' };
  }
  return null;
}

// Valor do PDF original → texto, com as referências apontando para os mesmos objetos de antes.
function write(value) {
  if (value instanceof PdfRef) return `${value.num} ${value.gen} R`;
  if (value instanceof PdfName) return formatName(value.value);
  if (value instanceof PdfString) return formatString(value.bytes);
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null || value === undefined || value instanceof Keyword) return 'null';
  if (Array.isArray(value)) return `[${value.map(write).join(' ')}]`;
  if (value instanceof PdfDict) return `<<${[...value].map(([key, item]) => ` ${formatName(key)} ${write(item)}`).join('')} >>`;
  if (value instanceof PdfStream) throw new Error('Stream não é regravado na atualização');
  return 'null';
}

/**
 * Acrescenta ao PDF o espaço da assinatura, como buildPdfToSign (pdf.js) faz no PDF que o app monta.
 * @param {object} doc documento do pdf-reader, sem appendBlocker
 * @param {{reserve: number, time: Date, stamp?: {name: string, position: string, page: 'first' | 'last' | number}}} signature
 * @returns {{bytes: Uint8Array, byteRange: number[], contents: {at: number, length: number}}}
 */
export function buildAppendToSign(doc, { reserve, time, stamp }) {
  if (!(reserve > 0) || !(time instanceof Date)) throw new Error('Assinatura sem espaço ou sem hora');
  const blocker = appendBlocker(doc);
  if (blocker) throw new Error(blocker.message);

  const original = doc.bytes;
  const catalogRef = doc.trailer.get('Root');
  const catalog = doc.catalog();
  // Objetos novos depois do maior número em uso (o /Size do trailer é o maior número + 1).
  const declared = doc.resolve(doc.trailer.get('Size'));
  let next = Number.isInteger(declared) && declared > 0 ? declared : 1;
  for (const num of doc.entries.keys()) if (num >= next) next = num + 1;
  const widgetNum = next++;
  const sigNum = next++;
  const appearanceNum = stamp ? next++ : 0;
  const widget = new PdfRef(widgetNum, 0);
  const changed = new Map(); // num → {gen, value}: objetos do original regravados com o mesmo número

  // Página: o campo entra na lista /Annots. Lista à parte (referência) é regravada; senão, a página.
  const pageIndex = stamp ? stampPageIndex(stamp.page, doc.pages.length) : 0;
  const page = doc.pages[pageIndex];
  const annotsValue = page.node.get('Annots');
  const annots = doc.resolve(annotsValue);
  if (annotsValue instanceof PdfRef && Array.isArray(annots)) {
    changed.set(annotsValue.num, { gen: annotsValue.gen, value: [...annots, widget] });
  } else {
    const updated = new PdfDict(page.node);
    updated.set('Annots', [...(Array.isArray(annots) ? annots : []), widget]);
    changed.set(page.ref.num, { gen: page.ref.gen, value: updated });
  }

  // Formulário: o campo entra em /Fields, e /SigFlags fica com 1 (tem assinatura) e 2 (só acrescentar no fim).
  const formValue = catalog.get('AcroForm');
  const form = doc.resolve(formValue);
  const fieldsValue = form instanceof PdfDict ? form.get('Fields') : undefined;
  const fields = doc.resolve(fieldsValue);
  const flags = form instanceof PdfDict ? doc.resolve(form.get('SigFlags')) : 0;
  const updatedForm = new PdfDict(form instanceof PdfDict ? form : []);
  let formChanged = !(form instanceof PdfDict) || !Number.isInteger(flags) || (flags & 3) !== 3;
  updatedForm.set('SigFlags', (Number.isInteger(flags) ? flags : 0) | 3);
  if (fieldsValue instanceof PdfRef && Array.isArray(fields)) {
    changed.set(fieldsValue.num, { gen: fieldsValue.gen, value: [...fields, widget] });
  } else {
    updatedForm.set('Fields', [...(Array.isArray(fields) ? fields : []), widget]);
    formChanged = true;
  }
  if (formChanged) {
    if (formValue instanceof PdfRef && form instanceof PdfDict) {
      changed.set(formValue.num, { gen: formValue.gen, value: updatedForm });
    } else {
      const updatedCatalog = new PdfDict(catalog);
      updatedCatalog.set('AcroForm', updatedForm);
      changed.set(catalogRef.num, { gen: catalogRef.gen, value: updatedCatalog });
    }
  }

  // Nome do campo: "Assinatura", "Assinatura 2"… sem repetir o de um campo que já existe.
  const taken = new Set(doc.formFields().filter(({ top }) => top).map(({ partial }) => partial));
  let name = 'Assinatura';
  for (let n = 2; taken.has(name); n++) name = `Assinatura ${n}`;

  const visible = stamp
    ? buildStamp({ ...stamp, time }, { box: page.crop ?? page.media, rotate: page.rotate })
    : null;

  // Bytes novos, depois do original.
  const chunks = [];
  let length = original.length;
  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const offsets = new Map(); // num → {offset, gen}
  const object = (num, gen, text) => {
    offsets.set(num, { offset: length, gen });
    push(`${num} ${gen} obj\n${text}\nendobj\n`);
  };
  const last = original[original.length - 1];
  if (last !== 0x0a && last !== 0x0d) push('\n');

  for (const [num, { gen, value }] of [...changed].sort(([a], [b]) => a - b)) object(num, gen, write(value));
  const rect = visible ? visible.rect.map(formatNumber).join(' ') : '0 0 0 0';
  const appearance = visible ? ` /AP << /N ${appearanceNum} 0 R >>` : '';
  object(widgetNum, 0, `<< /Type /Annot /Subtype /Widget /FT /Sig /T ${formatString(encoder.encode(name))} /F 132 /Rect [${rect}]`
    + ` /P ${page.ref.num} ${page.ref.gen} R /V ${sigNum} 0 R${appearance} >>`);
  if (visible) object(appearanceNum, 0, visible.appearance);
  offsets.set(sigNum, { offset: length, gen: 0 });
  push(`${sigNum} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /M (${pdfDate(time)}) /ByteRange `);
  const byteRangeAt = length;
  push(BYTE_RANGE_SPACE);
  push(' /Contents ');
  const contentsAt = length;
  push(`<${'0'.repeat(reserve * 2)}>`);
  push(' >>\nendobj\n');

  // Tabela xref do mesmo tipo da última do original (clássica ou em stream), apontando para ela (/Prev).
  const size = next;
  const extra = ['Root', 'Info', 'ID']
    .filter((key) => doc.trailer.has(key))
    .map((key) => ` /${key} ${write(doc.trailer.get(key))}`).join('');
  const xrefAt = length;
  if (isName(doc.trailer.get('Type'), 'XRef')) {
    const xrefNum = next;
    offsets.set(xrefNum, { offset: xrefAt, gen: 0 });
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const data = new Uint8Array(nums.length * 7);
    nums.forEach((num, i) => {
      const { offset, gen } = offsets.get(num);
      data.set([1, (offset >>> 24) & 0xff, (offset >>> 16) & 0xff, (offset >>> 8) & 0xff, offset & 0xff, gen >> 8, gen & 0xff], i * 7);
    });
    push(`${xrefNum} 0 obj\n<< /Type /XRef /Size ${xrefNum + 1} /Index [${sections(nums).map(([start, count]) => `${start} ${count}`).join(' ')}]`
      + ` /W [1 4 2] /Prev ${doc.startxref}${extra} /Length ${data.length} >>\nstream\n`);
    push(data);
    push('\nendstream\nendobj\n');
  } else {
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    let xref = 'xref\n';
    let i = 0;
    for (const [start, count] of sections(nums)) {
      xref += `${start} ${count}\n`;
      for (const num of nums.slice(i, i + count)) {
        const { offset, gen } = offsets.get(num);
        xref += `${String(offset).padStart(10, '0')} ${String(gen).padStart(5, '0')} n \n`;
      }
      i += count;
    }
    push(`${xref}trailer\n<< /Size ${size} /Prev ${doc.startxref}${extra} >>\n`);
  }
  push(`startxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  out.set(original, 0);
  let pos = original.length;
  for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
  return { bytes: out, ...finishSignature(out, { byteRangeAt, contentsAt, reserve }) };
}

// Números em ordem → subseções da xref: [[primeiro, quantidade], …] de números seguidos.
function sections(nums) {
  const out = [];
  for (const num of nums) {
    const last = out[out.length - 1];
    if (last && last[0] + last[1] === num) last[1]++;
    else out.push([num, 1]);
  }
  return out;
}
