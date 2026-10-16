import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { decryptTripleDesCbc, decryptRc2Cbc, desDecryptRaw, rc2DecryptRaw, CipherError } from '../web/js/legacy-ciphers.js';

const hex = (text) => Uint8Array.from(Buffer.from(text.replace(/\s/g, ''), 'hex'));
const toHex = (bytes) => Buffer.from(bytes).toString('hex');

test('DES: vetor clássico (chave 133457799BBCDFF1)', () => {
  assert.equal(toHex(desDecryptRaw(hex('133457799BBCDFF1'), hex('85E813540F0AB405'))), '0123456789abcdef');
});

test('3DES: vetor do NIST SP 800-67 (três chaves, ECB)', () => {
  // Apêndice B do SP 800-67: "The qufck brown fox jump" com as chaves 0123456789ABCDEF, 23456789ABCDEF01 e
  // 456789ABCDEF0123. Em CBC com o vetor inicial zerado, o primeiro bloco é o mesmo do ECB.
  const key = hex('0123456789ABCDEF 23456789ABCDEF01 456789ABCDEF0123');
  const cipher = hex('A826FD8CE53B855F');
  // Segundo bloco: o preenchimento PKCS#7, encadeado no primeiro (CBC).
  const pad = Buffer.alloc(8, 8).map((b, i) => b ^ cipher[i]);
  const padded = createCipheriv('des-ede3-ecb', key, null).setAutoPadding(false).update(pad);
  const plain = decryptTripleDesCbc(key, new Uint8Array(8), new Uint8Array([...cipher, ...padded]));
  assert.equal(Buffer.from(plain).toString('latin1'), 'The qufc');
});

test('3DES em CBC bate com o OpenSSL do Node (três e duas chaves, vários tamanhos)', () => {
  for (const size of [0, 1, 7, 8, 9, 100, 1234]) {
    const key = randomBytes(24);
    const iv = randomBytes(8);
    const data = randomBytes(size);
    const cipher = createCipheriv('des-ede3-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    assert.deepEqual(Buffer.from(decryptTripleDesCbc(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(encrypted))), data);
  }
  const two = randomBytes(16);
  const iv = randomBytes(8);
  const cipher = createCipheriv('des-ede3-cbc', Buffer.concat([two, two.subarray(0, 8)]), iv);
  const encrypted = Buffer.concat([cipher.update('duas chaves'), cipher.final()]);
  assert.equal(Buffer.from(decryptTripleDesCbc(new Uint8Array(two), new Uint8Array(iv), new Uint8Array(encrypted))).toString(), 'duas chaves');
});

test('RC2: vetores da RFC 2268', () => {
  const vectors = [
    ['0000000000000000', 63, '0000000000000000', 'ebb773f993278eff'],
    ['ffffffffffffffff', 64, 'ffffffffffffffff', '278b27e42e2f0d49'],
    ['3000000000000000', 64, '1000000000000001', '30649edf9be7d2c2'],
    ['88', 64, '0000000000000000', '61a8a244adacccf0'],
    ['88bca90e90875a', 64, '0000000000000000', '6ccf4308974c267f'],
    ['88bca90e90875a7f0f79c384627bafb2', 64, '0000000000000000', '1a807d272bbe5db1'],
    ['88bca90e90875a7f0f79c384627bafb2', 128, '0000000000000000', '2269552ab0f85ca6'],
    ['88bca90e90875a7f0f79c384627bafb216f80a6f85920584c42fceb0be255daf1e', 129, '0000000000000000', '5b78d3a43dfff1f1'],
  ];
  for (const [key, bits, plain, cipher] of vectors) {
    assert.equal(toHex(rc2DecryptRaw(hex(key), bits, hex(cipher))), plain, `chave ${key}, ${bits} bits`);
  }
});

test('RC2 em CBC: preenchimento conferido; chave ou dados errados são recusados', () => {
  assert.throws(() => decryptRc2Cbc(hex('0102030405'), 40, new Uint8Array(8), new Uint8Array(16)), CipherError);
  assert.throws(() => decryptRc2Cbc(hex('0102030405'), 40, new Uint8Array(8), new Uint8Array(12)), /tamanho/);
  assert.throws(() => decryptTripleDesCbc(new Uint8Array(10), new Uint8Array(8), new Uint8Array(8)), /Chave 3DES/);
});
