// Leitor de XML mínimo, sem dependências (o Node, onde rodam os testes, não tem DOMParser).
// Monta uma árvore simples: {name, attrs, children}, com os textos como strings dentro de children.
// Segurança: não aceita DTD (<!DOCTYPE>), então não há entidade externa nem expansão de entidades;
// só as cinco entidades do XML e as numéricas (&#233; &#xE9;) são traduzidas.
//
// Nomes com namespace: quem chama passa os prefixos que quer usar, por URI. Assim "w:p" é sempre o
// parágrafo do Word, qualquer que seja o prefixo escrito no arquivo. Namespace não listado vira "{uri}nome".

export class XmlError extends Error {}

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const MAX_DEPTH = 256;

const NAME = /[^\s/>]+/y;
const ATTRIBUTE = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const TAG_END = /\s*(\/?)>/y;
const ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (match, hex, dec, name) => {
    if (name) return NAMED[name.toLowerCase()] ?? match;
    const code = hex ? parseInt(hex, 16) : Number(dec);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

/**
 * @param {string} text
 * @param {Record<string, string | string[]>} [prefixes] prefixo desejado → URI(s) do namespace
 * @returns {{name: string, attrs: Record<string, string>, children: Array}} elemento raiz
 */
export function parseXml(text, prefixes = {}) {
  const canonical = new Map([[XML_NS, 'xml']]);
  for (const [prefix, uris] of Object.entries(prefixes)) for (const uri of [].concat(uris)) canonical.set(uri, prefix);

  const document = { name: '#document', attrs: {}, children: [] };
  // Cada nível guarda o elemento, o nome como está no arquivo (para conferir o fechamento) e os namespaces.
  const stack = [{ node: document, raw: '', scope: new Map([['xml', XML_NS]]) }];

  const fail = (message = 'XML inválido') => { throw new XmlError(message); };
  const addText = (value) => {
    if (!value) return;
    const { children } = stack[stack.length - 1].node;
    if (typeof children[children.length - 1] === 'string') children[children.length - 1] += value;
    else children.push(value);
  };
  const resolve = (qname, scope, isAttribute) => {
    const colon = qname.indexOf(':');
    const prefix = colon < 0 ? '' : qname.slice(0, colon);
    const local = qname.slice(colon + 1);
    if (!prefix && isAttribute) return local; // atributo sem prefixo não tem namespace
    const uri = scope.get(prefix);
    if (!uri) return qname;
    return canonical.has(uri) ? `${canonical.get(uri)}:${local}` : `{${uri}}${local}`;
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(decodeEntities(text.slice(i)));
      break;
    }
    addText(decodeEntities(text.slice(i, lt)));

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) fail();
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) fail();
      addText(text.slice(lt + 9, end));
      i = end + 3;
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) fail();
      i = end + 2;
    } else if (text.startsWith('<!', lt)) {
      fail('XML com DTD não é aceito');
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt + 2);
      if (end < 0) fail();
      const top = stack.pop();
      if (stack.length === 0 || text.slice(lt + 2, end).trim() !== top.raw) fail();
      i = end + 1;
    } else {
      NAME.lastIndex = lt + 1;
      const raw = NAME.exec(text)?.[0];
      if (!raw) fail();
      let pos = NAME.lastIndex;
      const pairs = [];
      for (;;) {
        ATTRIBUTE.lastIndex = pos;
        const match = ATTRIBUTE.exec(text);
        if (!match) break;
        pairs.push([match[1], decodeEntities(match[2] ?? match[3])]);
        pos = ATTRIBUTE.lastIndex;
      }
      TAG_END.lastIndex = pos;
      const close = TAG_END.exec(text);
      if (!close) fail();
      i = TAG_END.lastIndex;

      const parent = stack[stack.length - 1];
      let scope = parent.scope;
      for (const [name, value] of pairs) {
        if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
        if (scope === parent.scope) scope = new Map(scope);
        scope.set(name === 'xmlns' ? '' : name.slice(6), value);
      }
      const attrs = {};
      for (const [name, value] of pairs) {
        if (name !== 'xmlns' && !name.startsWith('xmlns:')) attrs[resolve(name, scope, true)] = value;
      }
      const node = { name: resolve(raw, scope, false), attrs, children: [] };
      parent.node.children.push(node);
      if (!close[1]) {
        if (stack.length > MAX_DEPTH) fail('XML aninhado demais');
        stack.push({ node, raw, scope });
      }
    }
  }
  if (stack.length !== 1) fail('XML incompleto');
  const root = document.children.find((child) => typeof child !== 'string');
  if (!root) fail('XML vazio');
  return root;
}

// Filhos elemento com o nome dado (ou todos, sem nome).
export function elements(node, name) {
  return node ? node.children.filter((child) => typeof child !== 'string' && (!name || child.name === name)) : [];
}

export function element(node, name) {
  return node?.children.find((child) => typeof child !== 'string' && child.name === name);
}

// Todo o texto dentro do elemento, em ordem.
export function textOf(node) {
  if (!node) return '';
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}
