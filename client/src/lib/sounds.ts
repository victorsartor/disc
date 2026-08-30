/**
 * Sons de entrada/saida gerados no Web Audio.
 * Sem arquivo de asset: dois tons curtos, um subindo e outro descendo.
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    // Navegador suspende o contexto ate a primeira interacao do usuario.
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function chirp(from: number, to: number, duration = 0.16, peak = 0.07): void {
  const ac = audio();
  if (!ac) return;

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
}

/** Alguem entrou: sobe. */
export const playJoin = () => chirp(523.25, 783.99);

/** Alguem saiu: desce. */
export const playLeave = () => chirp(659.25, 392.0);

/** Voce conectou na sala. */
export const playConnect = () => chirp(392.0, 587.33, 0.2);
