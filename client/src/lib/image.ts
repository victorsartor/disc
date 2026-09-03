/**
 * Escolher uma imagem e devolvê-la pronta pra subir.
 *
 * O redimensionamento acontece AQUI, não no servidor: uma foto de celular
 * tem 5 MB e 4000px de largura, e nada nesta tela mostra mais que 640. Subir
 * o arquivo cru gastaria a banda de todo mundo pra guardar pixel que
 * ninguém vai ver.
 */

/** Abre o seletor do sistema. Resolve null se a pessoa cancelar. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';

    // O change não dispara no cancelar em navegador nenhum, e o input fica
    // pendurado pra sempre. O foco voltando à janela é o sinal de que o
    // diálogo fechou; se nada chegou até lá, foi cancelamento.
    let done = false;
    const finish = (file: File | null) => {
      if (done) return;
      done = true;
      window.removeEventListener('focus', onFocus);
      resolve(file);
    };
    const onFocus = () => window.setTimeout(() => finish(null), 500);

    input.onchange = () => finish(input.files?.[0] ?? null);
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

function loadBitmap(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('não consegui abrir essa imagem'));
    };
    img.src = url;
  });
}

/**
 * Teto de imagem animada.
 *
 * Bem maior que o das outras porque esta é a única que sobe do jeito que
 * saiu do disco: o canvas não pode encolher um GIF sem matar a animação
 * junto, então não há como reduzir antes.
 *
 * O servidor barra no mesmo número (MAX_ANIMATED_BYTES em
 * server/src/profile.ts) — os dois têm que andar juntos, e lá ainda existe
 * um terceiro teto, sobre o corpo já em base64. Subir só este daqui deixa a
 * pessoa escolher um arquivo que o servidor vai recusar.
 */
export const MAX_ANIMADA_BYTES = 10 * 1024 * 1024;

/**
 * A imagem carrega animação?
 *
 * GIF sempre pode. WebP só na variante estendida com o bit de animação
 * ligado — e por isso ele é conferido byte a byte, e não pelo mime: um WebP
 * comum indo pelo caminho cru subiria em tamanho original à toa, perdendo o
 * redimensionamento que ele podia muito bem ter recebido.
 */
export async function ehImagemAnimada(file: File): Promise<boolean> {
  if (file.type === 'image/gif') return true;
  if (file.type === 'image/webp') return ehWebpAnimado(file);
  return false;
}

/**
 * O cabeçalho de um WebP animado, byte a byte.
 *
 * "RIFF" nos 4 primeiros, "WEBP" no 8, e o fourcc do primeiro chunk no 12.
 * Só o VP8X (a forma estendida) aceita animação; o byte 20 é o de flags, e
 * o bit 0x02 dele é o ANIMATION. Nada disso precisa do arquivo inteiro —
 * daí o slice de 21 bytes.
 */
async function ehWebpAnimado(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 21).arrayBuffer());
    if (head.length < 21) return false;

    const marca = (i: number) => String.fromCharCode(...head.subarray(i, i + 4));
    if (marca(0) !== 'RIFF' || marca(8) !== 'WEBP' || marca(12) !== 'VP8X') {
      return false;
    }
    return (head[20] & 0x02) !== 0;
  } catch {
    // Arquivo que não deu pra ler não é animado — é problema, e o caminho
    // normal vai reclamar dele com uma mensagem melhor que a daqui.
    return false;
  }
}

/**
 * Os bytes originais, sem passar por canvas nenhum.
 *
 * O FileReader monta o data URL no formato exato que o servidor espera
 * (`data:<mime>;base64,<...>`), e faz o base64 nativamente — a alternativa
 * seria fatiar o arquivo à mão pra não estourar o limite de argumentos do
 * String.fromCharCode.
 */
function dataUrlCru(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('não consegui ler essa imagem'));
    r.readAsDataURL(file);
  });
}

/** "8 MB", "1,4 MB" — só pra caber numa mensagem de erro. */
function mb(bytes: number): string {
  const v = bytes / 1024 / 1024;
  return `${v.toFixed(v < 10 ? 1 : 0).replace('.', ',')} MB`;
}

/**
 * Corta no centro para a proporção pedida e reduz até caber em `maxW`.
 * Devolve um data URL JPEG — o mesmo recorte que a tela mostra depois,
 * então o que a pessoa escolheu é o que ela vai ver.
 *
 * Imagem animada é a exceção: ela sai daqui crua. Ver o desvio logo abaixo.
 */
export async function prepareImage(
  file: File,
  { maxW, ratio, quality = 0.85 }: { maxW: number; ratio: number; quality?: number },
): Promise<string> {
  // Animação não sobrevive ao canvas — ele desenha UM quadro, e o que
  // chegaria no servidor seria o primeiro frame achatado. Então ela pula o
  // redimensionamento inteiro e vai como está.
  //
  // O recorte centralizado some junto, mas ninguém perde nada: quem corta
  // na tela já é o CSS. O .avatar tem object-fit: cover e a capa tem
  // background-size: cover, então o enquadramento continua o mesmo.
  if (await ehImagemAnimada(file)) {
    if (file.size > MAX_ANIMADA_BYTES) {
      throw new Error(
        `Essa imagem animada tem ${mb(file.size)}. O limite é ${mb(MAX_ANIMADA_BYTES)}.`,
      );
    }
    return dataUrlCru(file);
  }

  const img = await loadBitmap(file);

  // Recorte centralizado na proporção de destino
  const srcRatio = img.naturalWidth / img.naturalHeight;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  if (srcRatio > ratio) sw = sh * ratio;
  else sh = sw / ratio;
  const sx = (img.naturalWidth - sw) / 2;
  const sy = (img.naturalHeight - sh) / 2;

  const w = Math.round(Math.min(maxW, sw));
  const h = Math.round(w / ratio);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('não consegui preparar a imagem');
  ctx.imageSmoothingQuality = 'high';
  // JPEG não tem transparência: sem este fundo, PNG transparente sai preto.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);

  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * Imagem pro chat: reduz mas NÃO corta.
 *
 * O prepareImage acima recorta pra uma proporção, que é o certo pra foto de
 * perfil e errado aqui: um print de tela cortado no centro perde justamente
 * a parte que a pessoa queria mostrar. Aqui só encolhe se passar de
 * MAX_LADO, e mantém a forma original.
 *
 * PNG continua PNG. Reencodar print de tela em JPEG borra texto e linha
 * fina — é o formato errado pra imagem com aresta dura, e print é quase só
 * aresta dura. O custo é arquivo maior, e num anexo isso não importa.
 *
 * Imagem ANIMADA não chega aqui: o Chat manda ela pelo caminho do arquivo,
 * que sobe por stream (ver o `escolher` em components/Chat.tsx). Se chegasse,
 * sairia daqui com um quadro só — o canvas não sabe fazer diferente.
 */
export async function prepareChatImage(
  file: File,
): Promise<{ bytes: Uint8Array; mime: string; nome: string }> {
  const img = await loadBitmap(file);
  const manterPng = file.type === 'image/png';

  const maior = Math.max(img.naturalWidth, img.naturalHeight);
  const escala = maior > MAX_LADO ? MAX_LADO / maior : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * escala));
  const h = Math.max(1, Math.round(img.naturalHeight * escala));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('não consegui preparar a imagem');
  ctx.imageSmoothingQuality = 'high';
  // Só o JPEG precisa de fundo — ele não tem transparência, e sem isto um
  // PNG transparente sairia preto. No caminho PNG a transparência fica.
  if (!manterPng) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(img, 0, 0, w, h);

  const mime = manterPng ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((pronto) =>
    canvas.toBlob(pronto, mime, 0.9),
  );
  if (!blob) throw new Error('não consegui preparar a imagem');

  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mime,
    nome: trocarExtensao(file.name, manterPng ? 'png' : 'jpg'),
  };
}

/** O nome que a pessoa vê e baixa tem que combinar com o que foi gravado. */
function trocarExtensao(nome: string, ext: string): string {
  const semExt = nome.replace(/\.[^.]+$/, '');
  return `${semExt || 'imagem'}.${ext}`;
}

/**
 * Teto do lado maior. "Desde que não seja 4k": 1920 cobre tela cheia em
 * qualquer monitor comum e ainda dá pra ampliar sem ver pixel.
 */
const MAX_LADO = 1920;

/** Foto de perfil: quadrada, e nunca aparece maior que 112px na tela. */
export const AVATAR_SPEC = { maxW: 512, ratio: 1 };

/** Capa: a faixa larga do topo do perfil. */
export const BANNER_SPEC = { maxW: 1280, ratio: 1280 / 400 };
