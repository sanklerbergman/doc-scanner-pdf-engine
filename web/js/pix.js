// Monta o código "Pix copia e cola" (BR Code estático) a partir de uma chave.
// Formato EMV: cada campo é ID (2 dígitos) + tamanho (2 dígitos) + valor.

const field = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

// CRC16-CCITT (polinômio 0x1021, valor inicial 0xFFFF), como exige o padrão do Banco Central.
export function crc16(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * @param {string} key chave Pix
 * @param {{name: string, city: string}} merchant textos informativos (ASCII; até 25 e 15 caracteres).
 *   O banco de quem paga mostra o titular real da chave, não este nome.
 */
export function pixPayload(key, { name, city }) {
  const payload =
    field('00', '01') +
    field('26', field('00', 'BR.GOV.BCB.PIX') + field('01', key)) +
    field('52', '0000') + // categoria: não informada
    field('53', '986') + // moeda: real
    field('58', 'BR') +
    field('59', name.slice(0, 25)) +
    field('60', city.slice(0, 15)) +
    field('62', field('05', '***')) + // sem identificador de transação
    '6304';
  return payload + crc16(payload);
}
