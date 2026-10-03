// Decodificação, rotação e filtros de imagem. Tudo em <canvas>, tudo local.
// Redesenhar a foto num canvas também descarta os metadados EXIF (GPS, modelo do celular etc.).

export const FILTERS = {
  document: 'Documento',
  enhance: 'Cor realçada',
  bw: 'Preto e branco',
  original: 'Original',
};

// Retorna algo desenhável num canvas. Respeita a orientação EXIF da foto.
export async function decodeFile(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // navegadores antigos ou formatos que só o <img> entende: tenta abaixo
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => {} };
  } catch (err) {
    // Só o Safari abre HEIC sozinho; nos outros, usa o decodificador embutido.
    if (await isHeif(file)) return decodeHeif(file);
    throw err;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Arquivos HEIC/HEIF começam com uma caixa "ftyp" (bytes 4 a 7).
async function isHeif(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  return String.fromCharCode(...head.subarray(4, 8)) === 'ftyp';
}

let libheif; // carregado só quando aparece o primeiro HEIC (o arquivo tem ~2 MB)

async function decodeHeif(file) {
  libheif ??= import('../vendor/libheif/libheif-bundle.js').then((module) => module.default());
  const { HeifDecoder } = await libheif;
  const images = new HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()));
  if (!images.length) throw new Error('Arquivo HEIC sem imagem');
  try {
    const [image] = images;
    const width = image.get_width();
    const height = image.get_height();
    const pixels = new ImageData(width, height);
    await new Promise((resolve, reject) => {
      image.display(pixels, (result) => (result ? resolve() : reject(new Error('Falha ao decodificar o HEIC'))));
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(pixels, 0, 0);
    return { source: canvas, width, height, release: () => { canvas.width = canvas.height = 0; } };
  } finally {
    for (const image of images) image.free();
  }
}

// Desenha a imagem reduzida (maxSide), girada (0/90/180/270) e filtrada num canvas novo.
export function renderPage(source, width, height, { rotation = 0, filter = 'original', maxSide = Infinity } = {}) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const sideways = rotation % 180 !== 0;

  const canvas = document.createElement('canvas');
  canvas.width = sideways ? h : w;
  canvas.height = sideways ? w : h;
  const ctx = canvas.getContext('2d', { willReadFrequently: filter !== 'original' });
  ctx.fillStyle = '#fff'; // PNG transparente viraria preto no JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  if (filter !== 'original') {
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyFilter(pixels, filter);
    ctx.putImageData(pixels, 0, 0);
  }
  return canvas;
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Falha ao codificar a imagem'))), type, quality);
  });
}

export function applyFilter({ data, width, height }, filter) {
  const n = width * height;
  const gray = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;

  if (filter === 'bw') {
    const ink = adaptiveThreshold(gray, width, height);
    for (let i = 0, p = 0; i < n; i++, p += 4) data[p] = data[p + 1] = data[p + 2] = ink[i];
    return;
  }

  // Remove sombra: divide cada pixel pelo brilho médio da vizinhança (o "papel" em volta dele).
  const background = localMean(gray, width, height, Math.max(8, Math.round(Math.max(width, height) / 12)));
  const gain = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    gain[i] = 255 / Math.max(background[i], 1);
    gray[i] = gray[i] * gain[i];
  }

  const lut = levelsTable(gray);
  if (filter === 'document') {
    for (let i = 0, p = 0; i < n; i++, p += 4) data[p] = data[p + 1] = data[p + 2] = lut[gray[i]];
  } else if (filter === 'enhance') {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      data[p] = lut[Math.min(255, data[p] * gain[i])];
      data[p + 1] = lut[Math.min(255, data[p + 1] * gain[i])];
      data[p + 2] = lut[Math.min(255, data[p + 2] * gain[i])];
    }
  }
}

// Tabela de somas acumuladas: soma de qualquer retângulo em O(1).
function integralImage(gray, width, height) {
  const stride = width + 1;
  // Uint32 aguenta: 255 × 4096² < 2³²; as imagens são limitadas por maxSide antes de chegar aqui.
  const integral = new Uint32Array(stride * (height + 1));
  for (let y = 1; y <= height; y++) {
    let row = 0;
    for (let x = 1; x <= width; x++) {
      row += gray[(y - 1) * width + x - 1];
      integral[y * stride + x] = integral[(y - 1) * stride + x] + row;
    }
  }
  return integral;
}

// Média de cada pixel numa janela quadrada de raio `radius`.
function localMean(gray, width, height, radius) {
  const stride = width + 1;
  const integral = integralImage(gray, width, height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const sum = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
      out[y * width + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

// "Níveis automáticos": o papel (tons claros mais comuns) vira branco e a tinta escurece.
function levelsTable(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const percentile = (fraction) => {
    const target = gray.length * fraction;
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= target) return v;
    return 255;
  };
  let lo = percentile(0.01);
  let hi = percentile(0.92);
  if (hi - lo < 32) { lo = 0; hi = 255; } // imagem quase lisa: não estoura o contraste

  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    lut[v] = Math.round(255 * t ** 1.15);
  }
  return lut;
}

// Limiarização adaptativa (Bradley–Roth): compara cada pixel com a média da vizinhança,
// o que aguenta bem sombra e iluminação desigual de foto de celular.
function adaptiveThreshold(gray, width, height) {
  const mean = localMean(gray, width, height, Math.max(4, Math.round(Math.max(width, height) / 32)));
  const sensitivity = 0.85; // pixel 15% mais escuro que a vizinhança = tinta
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < out.length; i++) out[i] = gray[i] < mean[i] * sensitivity ? 0 : 255;
  return out;
}
