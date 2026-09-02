/**
 * O microfone, com portão de ruído.
 *
 * O app publicava a faixa crua do getUserMedia: tudo que o microfone
 * captava ia pro ar, inclusive ventilador, teclado e a televisão da sala.
 * Aqui a faixa passa por um grafo de Web Audio antes de ser publicada:
 *
 *     getUserMedia ──▶ [limpador] ──┬── analisador (só mede, não corta)
 *                                   └── ganho ──▶ destino ──▶ é ISTO que sobe
 *
 * O portão mexe no GANHO, não no mute da faixa. A diferença importa: mute
 * viaja pela sala e acenderia o ícone de microfone desligado de todo mundo
 * a cada pausa entre frases. Ganho zero é silêncio que só existe aqui —
 * ninguém do outro lado percebe, exatamente como no Discord.
 *
 * Mute de verdade (a pessoa clicando no botão) continua sendo mute da
 * faixa, porque aí o resto do grupo PRECISA ver.
 *
 * O [limpador] é o RNNoise, e só existe quando a pessoa liga a supressão
 * avançada — sem ele o grafo é o mesmo de antes, com a fonte no lugar dele.
 * Ele vem ANTES do analisador de propósito: o analisador é quem alimenta o
 * portão, e medir o sinal já limpo é o que faz o portão fechar de verdade
 * nas pausas. Medindo o sinal cru, um ventilador constante segura o portão
 * aberto o tempo todo por mais bem ajustado que esteja o corte.
 */

import { criarRnnoise, TAXA_RNNOISE } from './rnnoise';
import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';

export interface MicOptions {
  deviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** Supressão de ruído por RNNoise. Ver lib/rnnoise.ts. */
  rnnoise: boolean;
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
  /** O RNNoise, quando subiu. null = o grafo está sem ele. */
  private readonly limpador: RnnoiseWorkletNode | null;
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
    limpador: RnnoiseWorkletNode | null,
  ) {
    this.bruto = bruto;
    this.ctx = ctx;
    this.analisador = analisador;
    this.ganho = ganho;
    this.track = track;
    this.limpador = limpador;
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

    // A taxa é fixada em 48 kHz quando a supressão está ligada porque o
    // RNNoise só funciona nela — o porquê está em lib/rnnoise.ts. Sem a
    // supressão o contexto segue com o padrão da placa de som, como sempre
    // foi: forçar a reamostragem de quem não vai usar o filtro seria custo
    // sem contrapartida.
    const ctx = new AudioContext(opts.rnnoise ? { sampleRate: TAXA_RNNOISE } : undefined);
    const fonte = ctx.createMediaStreamSource(bruto);

    // Quem alimenta o analisador e o ganho: a fonte crua, ou o RNNoise
    // quando ele sobe. Uma variável só, para o grafo abaixo ser escrito uma
    // vez em vez de duas.
    let cabeca: AudioNode = fonte;
    let limpador: RnnoiseWorkletNode | null = null;

    if (opts.rnnoise) {
      const r = await criarRnnoise(ctx);
      if (r.ok) {
        fonte.connect(r.no);
        cabeca = r.no;
        limpador = r.no;
      } else {
        // Sem voz é pior que sem filtro: segue no grafo de sempre. O motivo
        // vai pro console porque "liguei e não mudou nada" precisa ter onde
        // ser investigado — foi a lição da 0.30.0.
        console.warn('[mic] supressão avançada indisponível:', r.motivo);
      }
    }

    const analisador = ctx.createAnalyser();
    analisador.fftSize = 1024;
    // Sem suavização o medidor treme; com muita ele atrasa a abertura do
    // portão e engole a primeira sílaba.
    analisador.smoothingTimeConstant = 0.3;

    const ganho = ctx.createGain();
    ganho.gain.value = 0;
    const destino = ctx.createMediaStreamDestination();

    cabeca.connect(analisador);
    cabeca.connect(ganho);
    ganho.connect(destino);

    const track = destino.stream.getAudioTracks()[0];
    if (!track) throw new Error('nao consegui montar o microfone');

    const mic = new Mic(bruto, ctx, analisador, ganho, track, limpador);
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
    // destroy() antes de disconnect(): ele avisa o worklet pra liberar o
    // heap do wasm, e um nó já desconectado ainda entrega a mensagem. Sem
    // isso cada troca de microfone deixaria um modelo pendurado na memória
    // da thread de áudio.
    this.limpador?.destroy();
    this.limpador?.disconnect();
    this.bruto.getTracks().forEach((t) => t.stop());
    this.track.stop();
    void this.ctx.close().catch(() => {
      /* já fechado */
    });
  }
}
