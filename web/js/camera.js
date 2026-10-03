// Câmera dentro da página. Existe para dar o que a câmera do sistema (input capture) não dá:
// acender a luz do celular e tirar várias fotos em sequência.
// A imagem da câmera só é desenhada num <canvas> local; nada é transmitido.

const $ = (selector) => document.querySelector(selector);

// Brilho médio da imagem (0 a 255) abaixo do qual a câmera precisa de exposição longa e a foto borra.
// Dois níveis para o aviso não ficar piscando quando o brilho está no limite.
const DARK_BELOW = 60;
const BRIGHT_ABOVE = 80;

/**
 * @param {{onPhoto: (file: File) => void, useNative: () => void}} handlers
 *   onPhoto recebe cada foto tirada; useNative abre a câmera do sistema.
 * @returns {{open: () => void} | null} null quando o navegador não tem getUserMedia ou <dialog>.
 */
export function setupCamera({ onPhoto, useNative }) {
  const dialog = $('#camera');
  if (!navigator.mediaDevices?.getUserMedia || typeof dialog.showModal !== 'function') return null;

  const video = $('#camera-video');
  const message = $('#camera-message');
  const torch = $('#camera-torch');
  const shutter = $('#camera-shutter');
  const count = $('#camera-count');
  const warning = $('#camera-warning');
  const probe = document.createElement('canvas');
  probe.width = probe.height = 32;
  let lightTimer = 0;
  let stream = null;
  let track = null;
  let photos = 0;

  const say = (text) => { message.textContent = text; };

  async function open() {
    photos = 0;
    count.textContent = '';
    torch.hidden = true;
    shutter.disabled = true;
    say('Abrindo a câmera…');
    dialog.showModal();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
    } catch (err) {
      say(err.name === 'NotAllowedError'
        ? 'A câmera está bloqueada para este site. Libere nas configurações do navegador ou use a câmera do sistema.'
        : 'Não consegui abrir a câmera aqui. Use a câmera do sistema.');
      return;
    }
    if (!dialog.open) return stop(); // fecharam enquanto a permissão era pedida

    [track] = stream.getVideoTracks();
    track.addEventListener('ended', () => { if (dialog.open) say('A câmera foi interrompida. Feche e abra de novo.'); });
    video.srcObject = stream;
    await video.play().catch(() => {});
    shutter.disabled = false;
    say('A imagem da câmera fica só no seu aparelho.');

    // Nem todo aparelho/navegador deixa controlar a luz; o botão só aparece quando dá.
    if (track.getCapabilities?.().torch) {
      torch.hidden = false;
      setTorchState(false);
    }
    lightTimer = setInterval(checkLight, 800);
  }

  // Mede a claridade do miolo da imagem e avisa quando está escuro demais para uma foto nítida.
  function checkLight() {
    if (!video.videoWidth) return;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    const w = video.videoWidth, h = video.videoHeight;
    ctx.drawImage(video, w * 0.2, h * 0.2, w * 0.6, h * 0.6, 0, 0, 32, 32);
    const { data } = ctx.getImageData(0, 0, 32, 32);
    let sum = 0;
    for (let p = 0; p < data.length; p += 4) sum += (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    const brightness = sum / (32 * 32);

    const torchOn = torch.getAttribute('aria-pressed') === 'true';
    const dark = warning.hidden ? brightness < DARK_BELOW : brightness < BRIGHT_ABOVE;
    const warn = dark && !torchOn;
    if (warn === !warning.hidden) return;
    warning.hidden = !warn;
    torch.classList.toggle('attention', warn);
    warning.textContent = torch.hidden
      ? 'Ambiente escuro: a foto pode sair borrada. Chegue perto de uma luz ou use a câmera do sistema com flash.'
      : 'Ambiente escuro: a foto pode sair borrada. Toque em Luz.';
  }

  function setTorchState(on) {
    torch.setAttribute('aria-pressed', String(on)); // o estado aparece na cor do botão
  }

  async function toggleTorch() {
    const on = torch.getAttribute('aria-pressed') !== 'true';
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] });
      setTorchState(on);
      checkLight();
    } catch {
      torch.hidden = true;
      say('Este aparelho não deixou ligar a luz por aqui.');
    }
  }

  function takePhoto() {
    if (!video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return say('Não consegui capturar a foto. Tente de novo.');
      photos++;
      count.textContent = `(${photos})`;
      say(photos === 1 ? '1 foto tirada. Pode tirar a próxima página.' : `${photos} fotos tiradas.`);
      onPhoto(new File([blob], `foto-${photos}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.95);

    // Piscada rápida para confirmar o clique.
    video.classList.remove('shot');
    void video.offsetWidth;
    video.classList.add('shot');
  }

  // Parar a trilha também apaga a luz.
  function stop() {
    clearInterval(lightTimer);
    warning.hidden = true;
    torch.classList.remove('attention');
    stream?.getTracks().forEach((t) => t.stop());
    stream = track = null;
    video.srcObject = null;
  }

  torch.addEventListener('click', toggleTorch);
  shutter.addEventListener('click', takePhoto);
  $('#camera-close').addEventListener('click', () => dialog.close());
  $('#camera-native').addEventListener('click', () => {
    dialog.close();
    useNative(); // chamado direto do clique: o iOS só abre o seletor com gesto do usuário
  });
  dialog.addEventListener('close', stop); // cobre o botão, o Esc e o gesto de voltar
  document.addEventListener('visibilitychange', () => { if (document.hidden && dialog.open) dialog.close(); });

  return { open };
}
