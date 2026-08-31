/**
 * Sons de evento do app: entrar/sair de canal, compartilhar tela, chat.
 *
 * Tocados no Web Audio, decodificados uma vez e reaproveitados - nao um
 * <audio> por som, que reabriria o arquivo do disco a cada toque.
 *
 * O contexto e SUSPENSO assim que o ultimo som em voo termina, e nao so
 * deixado de lado.
 *
 * Isso importa por causa do hardware: enquanto existe um AudioContext
 * rodando, o Chromium mantem aberto um fluxo de saida no dispositivo, e o
 * amplificador do fone fica ligado o tempo todo. Em fone sensivel isso se
 * ouve como um chiado baixinho e constante. Como o primeiro som que toca e
 * justamente o de conectar, o chiado comecava ao entrar na call e ficava ate
 * fechar o app - inclusive depois de sair do canal.
 *
 * Suspender devolve o dispositivo ao sistema entre um som e outro. Retomar
 * custa alguns milissegundos, e por isso o resume e esperado antes de
 * agendar: com o contexto suspenso o relogio nao anda, e agendar em cima de
 * um currentTime parado sai torto.
 */

import entrarUrl from '../assets/sons/entrar-call.mp3';
import sairUrl from '../assets/sons/sair-call.mp3';
import iniciarTelaUrl from '../assets/sons/iniciar-tela.wav';
import fecharTelaUrl from '../assets/sons/fechar-tela.wav';
import notificacaoUrl from '../assets/sons/notificacao.mp3';

let ctx: AudioContext | null = null;

/** Quantos sons ainda estao no ar. Suspende so quando zera. */
let tocando = 0;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Envolve qualquer som (sintetizado ou de arquivo) com o resume antes e o
 * suspend depois - a mesma contagem de `tocando` cobre os dois tipos, entao
 * um bip e um arquivo tocando juntos nao desligam o contexto um por baixo
 * do outro.
 */
async function comContextoAberto(tarefa: (ac: AudioContext) => Promise<void>): Promise<void> {
  const ac = audio();
  if (!ac) return;

  tocando++;
  try {
    // Suspenso pelo nosso proprio fim de som, ou pelo navegador antes da
    // primeira interacao do usuario. Os dois casos se resolvem igual.
    if (ac.state !== 'running') await ac.resume();
    await tarefa(ac);
  } catch {
    /* dispositivo sumiu no meio, arquivo nao decodificou: nao derruba nada por causa de um som */
  } finally {
    tocando--;
    if (tocando === 0 && ctx?.state === 'running') void ctx.suspend();
  }
}

/** Um buffer decodificado por URL, guardado pra nao rebaixar e redecodificar a cada toque. */
const buffers = new Map<string, Promise<AudioBuffer>>();

function carregar(ac: AudioContext, url: string): Promise<AudioBuffer> {
  let p = buffers.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((bytes) => ac.decodeAudioData(bytes));
    buffers.set(url, p);
  }
  return p;
}

/**
 * Volume dos sons de evento, de 0 a 1. Mora aqui em vez de ser passado a
 * cada toque porque quem chama playJoin() e um handler de evento da sala,
 * que nao tem as configuracoes na mao.
 */
let ganhoEfeitos = 1;

/** Recebe a escala do slider (0 a 100). Chamado ao carregar e ao mexer. */
export function setEffectsVolume(percentual: number): void {
  const n = Number(percentual);
  ganhoEfeitos = Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 1;
}

async function tocarArquivo(ac: AudioContext, url: string, ganho: number): Promise<void> {
  const buffer = await carregar(ac, url);
  const src = ac.createBufferSource();
  src.buffer = buffer;

  // Ganho no meio do caminho em vez de mexer no destination: o destination e
  // compartilhado com a voz das pessoas, e abaixar ali abaixaria a call
  // junto.
  const vol = ac.createGain();
  vol.gain.value = ganho;
  src.connect(vol).connect(ac.destination);

  src.start();
  await new Promise<void>((pronto) => {
    src.onended = () => pronto();
  });
}

/**
 * Um som de evento, no volume escolhido.
 *
 * No zero nao toca nem abre o contexto. Nao e so economia: e o mesmo motivo
 * do comentario la em cima - contexto aberto mantem o amplificador do fone
 * ligado e chiando. Quem zerou os efeitos zerou justamente pra nao ouvir
 * nada, e seria estranho ganhar um chiado em troca do silencio.
 */
function efeito(url: string): void {
  if (ganhoEfeitos === 0) return;
  void comContextoAberto((ac) => tocarArquivo(ac, url, ganhoEfeitos));
}

/**
 * Voce entrou na call. Mesmo arquivo de playJoin de proposito: e o mesmo
 * evento social, "alguem entrou", so que o alguem e voce.
 */
export const playConnect = () => efeito(entrarUrl);

/** Voce saiu da call - por escolha, troca de canal, ou queda de conexao. */
export const playDisconnect = () => efeito(sairUrl);

/**
 * Alguem entrou na call que voce esta.
 *
 * So dispara enquanto existe uma sala conectada: o listener que chama isto
 * vive dentro do Room, que so existe depois que voce entrou em um canal.
 * Fora de uma call ninguem ouve ninguem chegar em outra.
 */
export const playJoin = () => efeito(entrarUrl);

/** Alguem saiu da call que voce esta. Mesma regra do playJoin. */
export const playLeave = () => efeito(sairUrl);

/** Uma tela comecou a ser compartilhada na call - a sua ou a de alguem. */
export const playShareStart = () => efeito(iniciarTelaUrl);

/** Uma tela parou de ser compartilhada na call - a sua ou a de alguem. */
export const playShareStop = () => efeito(fecharTelaUrl);

/** Mensagem nova no chat, de outra pessoa. */
export const playNotify = () => efeito(notificacaoUrl);
