/**
 * O microfone, com portão de ruído.
 *
 * O app publicava a faixa crua do getUserMedia: tudo que o microfone
 * captava ia pro ar, inclusive ventilador, teclado e a televisão da sala.
 * Aqui a faixa passa por um grafo de Web Audio antes de ser publicada:
 *
 *     getUserMedia ──┬── analisador (só mede, não corta)
 *                    └── ganho ──▶ destino ──▶ é ISTO que é publicado
 *
 * O portão mexe no GANHO, não no mute da faixa. A diferença importa: mute
 * viaja pela sala e acenderia o ícone de microfone desligado de todo mundo
 * a cada pausa entre frases. Ganho zero é silêncio que só existe aqui —
 * ninguém do outro lado percebe, exatamente como no Discord.
 *
 * Mute de verdade (a pessoa clicando no botão) continua sendo mute da
 * faixa, porque aí o resto do grupo PRECISA ver.
 */

export interface MicOptions {
  deviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/** Quanto tempo o portão fica aberto depois que o som cai abaixo do corte.
 *  Sem isso ele fecharia no meio de cada respiração e picotaria a fala. */
const HOLD_MS = 400;

/** Subida e descida do ganho. Corte seco estala; isto tira o clique. */
const RAMPA_S = 0.02;

export class Mic {
  readonly track: MediaStreamTrack;

  private readonly bruto: MediaStream;
  private readonly ctx: AudioContext;
  private readonly analisador: AnalyserNode;
  private readonly ganho: GainNode;
  // O buffer e criado sobre um ArrayBuffer explicito: o
  // getFloatTimeDomainData nao aceita um Float32Array que possa estar
  // apoiado num SharedArrayBuffer.
  private readonly amostras: Float32Array<ArrayBuffer>;
  private timer: number | null = null;

  /** 0 a 100. O que o medidor das configurações desenha. */
  nivel = 0;
  /** Corte do portão, na mesma escala. 0 desliga o portão. */
  corte = 0;
  /** Intenção do usuário: falar ou não (botão de mudo, tecla do PTT). */
  querFalar = true;
  /** Em apertar-para-falar o portão não opina: a tecla decide sozinha. */
  portaoLigado = true;

  private abertoAte = 0;

  private constructor(
    bruto: MediaStream,
    ctx: AudioContext,
    analisador: AnalyserNode,
    ganho: GainNode,
    track: MediaStreamTrack,
  ) {
    this.bruto = bruto;
    this.ctx = ctx;
    this.analisador = analisador;
    this.ganho = ganho;
    this.track = track;
    this.amostras = new Float32Array(new ArrayBuffer(analisador.fftSize * 4));
  }

  static async abrir(opts: MicOptions): Promise<Mic> {
    const bruto = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: opts.deviceId ?? undefined,
        echoCancellation: opts.echoCancellation,
        noiseSuppression: opts.noiseSuppression,
        autoGainControl: opts.autoGainControl,
      },
    });

    const ctx = new AudioContext();
    const fonte = ctx.createMediaStreamSource(bruto);
    const analisador = ctx.createAnalyser();
    analisador.fftSize = 1024;
    // Sem suavização o medidor treme; com muita ele atrasa a abertura do
    // portão e engole a primeira sílaba.
    analisador.smoothingTimeConstant = 0.3;

    const ganho = ctx.createGain();
    ganho.gain.value = 0;
    const destino = ctx.createMediaStreamDestination();

    fonte.connect(analisador);
    fonte.connect(ganho);
    ganho.connect(destino);

    const track = destino.stream.getAudioTracks()[0];
    if (!track) throw new Error('nao consegui montar o microfone');

    const mic = new Mic(bruto, ctx, analisador, ganho, track);
    mic.iniciarMedicao();
    return mic;
  }

  private iniciarMedicao(): void {
    // 50ms: rápido o suficiente pra abrir sem cortar a primeira sílaba,
    // devagar o suficiente pra não pesar durante um jogo.
    this.timer = window.setInterval(() => this.medir(), 50);
  }

  private medir(): void {
    this.analisador.getFloatTimeDomainData(this.amostras);

    let soma = 0;
    for (let i = 0; i < this.amostras.length; i++) {
      soma += this.amostras[i] * this.amostras[i];
    }
    const rms = Math.sqrt(soma / this.amostras.length);

    // Escala em decibéis, não linear: voz normal fica em torno de -30 dBFS,
    // e numa régua linear isso seria 3% do curso — impossível de ajustar.
    const db = 20 * Math.log10(rms || 1e-8);
    this.nivel = Math.max(0, Math.min(100, ((db + 70) / 70) * 100));

    const agora = performance.now();
    if (this.nivel >= this.corte) this.abertoAte = agora + HOLD_MS;

    const portaoAberto = !this.portaoLigado || this.corte === 0 || agora < this.abertoAte;
    this.aplicar(this.querFalar && portaoAberto);
  }

  private aplicar(passar: boolean): void {
    const alvo = passar ? 1 : 0;
    if (Math.abs(this.ganho.gain.value - alvo) < 0.001) return;
    const t = this.ctx.currentTime;
    this.ganho.gain.cancelScheduledValues(t);
    this.ganho.gain.setValueAtTime(this.ganho.gain.value, t);
    this.ganho.gain.linearRampToValueAtTime(alvo, t + RAMPA_S);
  }

  /** True enquanto o som está passando — é o que acende o anel de "falando". */
  get passando(): boolean {
    return this.ganho.gain.value > 0.5;
  }

  fechar(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.bruto.getTracks().forEach((t) => t.stop());
    this.track.stop();
    void this.ctx.close().catch(() => {
      /* já fechado */
    });
  }
}
