import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, element, elements, textOf, XmlError } from '../web/js/xml.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

test('entidades do XML e numéricas', () => {
  const root = parseXml('<a t="&quot;x&quot; &amp; y">&amp; &lt; &gt; &apos; &#233; &#xE9; &#xe7;&#227;o</a>');
  assert.equal(root.attrs.t, '"x" & y');
  assert.equal(textOf(root), "& < > ' é é ção");
});

test('entidade desconhecida fica como está e código inválido vira �', () => {
  assert.equal(textOf(parseXml('<a>&nbsp; &#0; &#xD800;</a>')), '&nbsp; � �');
});

test('CDATA, comentários e instruções de processamento', () => {
  const root = parseXml('<?xml version="1.0"?><!-- c --><a><?pi x?><![CDATA[<b>&amp;</b>]]><!-- dentro -->fim</a>');
  assert.equal(textOf(root), '<b>&amp;</b>fim');
  assert.equal(elements(root).length, 0);
});

test('namespaces: qualquer prefixo vira o prefixo pedido', () => {
  const prefixes = { w: W };
  const prefixed = parseXml(`<x:document xmlns:x="${W}"><x:p x:val="1" outro="2"/></x:document>`, prefixes);
  assert.equal(prefixed.name, 'w:document');
  const paragraph = element(prefixed, 'w:p');
  assert.deepEqual(paragraph.attrs, { 'w:val': '1', outro: '2' });

  const byDefault = parseXml(`<document xmlns="${W}"><p/></document>`, prefixes);
  assert.equal(byDefault.name, 'w:document');
  assert.ok(element(byDefault, 'w:p'));

  const unknown = parseXml('<w:a xmlns:w="urn:outro"><w:b/></w:a>', prefixes);
  assert.equal(unknown.name, '{urn:outro}a', 'prefixo "w" de outro namespace não pode virar w:');

  const scoped = parseXml(`<a xmlns:w="${W}"><w:b/><c xmlns:w="urn:outro"><w:d/></c></a>`, prefixes);
  assert.ok(element(scoped, 'w:b'));
  assert.ok(element(element(scoped, 'c'), '{urn:outro}d'));
  assert.equal(parseXml('<a xml:space="preserve"/>').attrs['xml:space'], 'preserve');
});

test('atributo com > e aspas simples, e espaço preservado no texto', () => {
  const root = parseXml("<a v='x > y' w = \"2\" ><t> dois  espaços </t></a>");
  assert.deepEqual(root.attrs, { v: 'x > y', w: '2' });
  assert.equal(textOf(element(root, 't')), ' dois  espaços ');
});

test('recusa DTD (sem entidades externas nem "billion laughs")', () => {
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'), /DTD/);
  assert.throws(() => parseXml('<!DOCTYPE a><a/>'), XmlError);
});

test('recusa XML malformado', () => {
  for (const bad of ['<a><b></a></b>', '<a>', '<a></b>', '</a>', '<a', '<a b="1></a>', '', 'só texto', '<a><!-- </a>']) {
    assert.throws(() => parseXml(bad), XmlError, bad);
  }
});

test('limite de profundidade', () => {
  assert.throws(() => parseXml('<a>'.repeat(300) + '</a>'.repeat(300)), /aninhado/);
  assert.doesNotThrow(() => parseXml('<a>'.repeat(100) + '</a>'.repeat(100)));
});
