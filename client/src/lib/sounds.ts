/**
 * Sons de entrada/saida gerados no Web Audio.
 * Sem arquivo de asset: dois tons curtos, um subindo e outro descendo.
 *
 * O contexto e SUSPENSO assim que o som acaba, e nao so deixado de lado.
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

async function chirp(from: number, to: number, duration = 0.16, peak = 0.07): Promise<void> {
  const ac = audio();
  if (!ac) return;

  tocando++;
  try {
    // Suspenso pelo nosso proprio fim de som, ou pelo navegador antes da
    // primeira interacao do usuario. Os dois casos se resolvem igual.
    if (ac.state !== 'running') await ac.resume();

    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const t = ac.currentTime;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + duration);

    // Envelope curto pra nao estalar no inicio e no fim
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);

    await new Promise<void>((pronto) => {
      osc.onended = () => pronto();
    });
  } catch {
    /* dispositivo sumiu no meio: nao vale derrubar nada por causa de um bip */
  } finally {
    tocando--;
    // Dois sons juntos (duas pessoas entrando de uma vez) nao podem deixar o
    // primeiro a acabar desligar o contexto por baixo do segundo.
    if (tocando === 0 && ctx?.state === 'running') void ctx.suspend();
  }
}

/** Alguem entrou: sobe. */
export const playJoin = () => void chirp(523.25, 783.99);

/** Alguem saiu: desce. */
export const playLeave = () => void chirp(659.25, 392.0);

/** Voce conectou na sala. */
export const playConnect = () => void chirp(392.0, 587.33, 0.2);
