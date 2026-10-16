// Perfil de cor sRGB (ICC v2, matriz e curva), montado pelo próprio código, sem arquivo de terceiros: é o perfil
// do /OutputIntents do PDF/A, que diz como as cores das fotos (RGB e tons de cinza) devem ser interpretadas.
// Os valores são os do sRGB IEC 61966-2.1 adaptados ao D50 (o espaço de conexão do ICC), como nos perfis sRGB v2
// comuns. Nenhuma data do aparelho entra: a data do perfil é fixa.

const encoder = new TextEncoder();
const DESCRIPTION = 'sRGB IEC61966-2.1';
const COPYRIGHT = 'No copyright, use freely';
const CURVE_POINTS = 256;

// Número s15Fixed16 (16 bits de inteiro com sinal, 16 de fração).
const s15f16 = (value) => Math.round(value * 65536) | 0;

// Corpos das tags (cada um começa pela assinatura do tipo).
function xyz(x, y, z) {
  const out = new DataView(new ArrayBuffer(20));
  out.setUint32(0, 0x58595a20); // 'XYZ '
  out.setInt32(8, s15f16(x));
  out.setInt32(12, s15f16(y));
  out.setInt32(16, s15f16(z));
  return new Uint8Array(out.buffer);
}

function text(value) {
  const ascii = encoder.encode(`${value}\0`);
  const out = new Uint8Array(8 + ascii.length);
  out.set(encoder.encode('text'));
  out.set(ascii, 8);
  return out;
}

// textDescriptionType do ICC v2: ASCII, Unicode (vazio) e ScriptCode (vazio, com os 67 bytes fixos).
function description(value) {
  const ascii = encoder.encode(`${value}\0`);
  const out = new Uint8Array(12 + ascii.length + 4 + 4 + 2 + 1 + 67);
  const view = new DataView(out.buffer);
  out.set(encoder.encode('desc'));
  view.setUint32(8, ascii.length);
  out.set(ascii, 12);
  return out;
}

// A curva do sRGB (linear abaixo de 0,04045 e potência 2,4 acima), em 256 pontos de 16 bits.
function curve() {
  const out = new Uint8Array(12 + CURVE_POINTS * 2);
  const view = new DataView(out.buffer);
  out.set(encoder.encode('curv'));
  view.setUint32(8, CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const v = i / (CURVE_POINTS - 1);
    const linear = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    view.setUint16(12 + i * 2, Math.round(linear * 65535));
  }
  return out;
}

let profile; // montado uma vez só

/** Perfil sRGB em bytes (ICC v2.1, classe "monitor", RGB → XYZ). */
export function srgbProfile() {
  if (profile) return profile;
  const trc = curve();
  // Tags na ordem da tabela; as três curvas apontam para os mesmos bytes (o ICC permite).
  const tags = [
    ['desc', description(DESCRIPTION)],
    ['cprt', text(COPYRIGHT)],
    ['wtpt', xyz(0.9504559, 1, 1.0890578)],
    ['rXYZ', xyz(0.4360747, 0.2225045, 0.0139322)],
    ['gXYZ', xyz(0.3850649, 0.7168786, 0.0971045)],
    ['bXYZ', xyz(0.1430804, 0.0606169, 0.7141733)],
    ['rTRC', trc],
    ['gTRC', trc],
    ['bTRC', trc],
  ];
  const align = (n) => (n + 3) & ~3;
  const tableSize = 4 + tags.length * 12;
  let offset = align(128 + tableSize);
  const placed = new Map(); // bytes → deslocamento (a curva vai uma vez só)
  const entries = tags.map(([signature, data]) => {
    if (!placed.has(data)) {
      placed.set(data, offset);
      offset = align(offset + data.length);
    }
    return { signature, at: placed.get(data), size: data.length };
  });
  const size = offset;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);

  // Cabeçalho (128 bytes).
  view.setUint32(0, size);
  view.setUint32(8, 0x02100000); // versão 2.1
  out.set(encoder.encode('mntr'), 12);
  out.set(encoder.encode('RGB '), 16);
  out.set(encoder.encode('XYZ '), 20);
  // Data fixa (2026-01-01 00:00:00): do perfil, não de quem gerou o PDF.
  [2026, 1, 1, 0, 0, 0].forEach((v, i) => view.setUint16(24 + i * 2, v));
  out.set(encoder.encode('acsp'), 36);
  // Iluminante do espaço de conexão: D50.
  view.setInt32(68, s15f16(0.9642));
  view.setInt32(72, s15f16(1));
  view.setInt32(76, s15f16(0.8249));

  // Tabela de tags e os dados.
  view.setUint32(128, tags.length);
  entries.forEach(({ signature, at, size: length }, i) => {
    out.set(encoder.encode(signature), 132 + i * 12);
    view.setUint32(136 + i * 12, at);
    view.setUint32(140 + i * 12, length);
  });
  for (const [data, at] of placed) out.set(data, at);
  profile = out;
  return out;
}
