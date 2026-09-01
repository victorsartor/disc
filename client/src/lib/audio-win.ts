/**
 * O som do sistema sem a Disneia dentro, virando faixa de midia — Windows.
 *
 * O addon nativo (electron/../native/audio-win) entrega quadros PCM crus,
 * porque quem sabe falar com o WASAPI nao tem por que saber o que e
 * LiveKit. Aqui esses quadros viram um MediaStreamTrack de verdade, do
 * mesmo tipo que o microfone produz — e a partir dai o resto do app trata
 * igual a qualquer outra faixa.
 *
 * POR QUE UM AudioWorklet E NAO AudioBufferSourceNode AGENDADO. O relogio
 * do WASAPI e o do AudioContext nao sao o mesmo relogio: eles andam quase
 * juntos, e "quase" vira segundos de diferenca depois de algumas horas de
 * jogo. Agendar buffers acumularia essa deriva ate estourar. O worklet le
 * no ritmo do AudioContext e o anel absorve a diferenca — quando falta,
 * sai silencio; quando sobra, o mais velho e descartado. Nenhum dos dois
 * acontece com frequencia, e os dois se corrigem sozinhos.
 */

/**
 * O worklet mora numa string, e nao num arquivo .js separado.
 *
 * addModule() precisa de uma URL, e um arquivo a parte teria que sobreviver
 * ao empacotamento do electron-builder no caminho certo. Como Blob, ele
 * viaja junto com o bundle e nao ha caminho pra errar.
 */
const CODIGO_WORKLET = `
class AnelDeAudio extends AudioWorkletProcessor {
  constructor(opcoes) {
    super();
    const canais = opcoes.processorOptions.canais;
    const quadros = opcoes.processorOptions.quadros;
    this.canais = canais;
    this.anel = new Float32Array(quadros * canais);
    this.tamanho = this.anel.length;
    this.escrita = 0;
    this.leitura = 0;
    this.disponivel = 0;
    this.port.onmessage = (e) => this.escrever(e.data);
  }

  escrever(bloco) {
    const n = bloco.length;
    // Sobra: o consumidor ficou pra tras (aba escondida, maquina travando).
    // Joga fora o mais VELHO em vez do mais novo - audio atrasado nao
    // interessa a ninguem, e assim a latencia nao cresce pra sempre.
    if (this.disponivel + n > this.tamanho) {
      const excesso = this.disponivel + n - this.tamanho;
      this.leitura = (this.leitura + excesso) % this.tamanho;
      this.disponivel -= excesso;
    }
    for (let i = 0; i < n; i++) {
      this.anel[this.escrita] = bloco[i];
      this.escrita = (this.escrita + 1) % this.tamanho;
    }
    this.disponivel += n;
  }

  process(_entradas, saidas) {
    const saida = saidas[0];
    const quadros = saida[0].length;
    const precisa = quadros * this.canais;

    if (this.disponivel < precisa) {
      // Falta: silencio. Melhor um vazio curto que um estouro de ritmo.
      for (let c = 0; c < saida.length; c++) saida[c].fill(0);
      return true;
    }

    for (let q = 0; q < quadros; q++) {
      for (let c = 0; c < this.canais; c++) {
        const amostra = this.anel[this.leitura];
        this.leitura = (this.leitura + 1) % this.tamanho;
        if (c < saida.length) saida[c][q] = amostra;
      }
    }
    this.disponivel -= precisa;
    return true;
  }
}
registerProcessor('anel-de-audio', AnelDeAudio);
`;

const CANAIS = 2;
/** Um segundo de folga no anel. Sobra pra engasgo, longe de virar atraso. */
const SEGUNDOS_DE_ANEL = 1;

export interface CapturaIsolada {
  faixa: MediaStreamTrack;
  parar: () => Promise<void>;
}

/**
 * Liga a captura isolada e devolve a faixa pronta pra publicar.
 *
 * Devolve null quando nao da (outro sistema, addon ausente, Windows sem a
 * API). Null nao e erro: o chamador cai no caminho de antes, que transmite
 * com a voz da chamada junto. Pior, mas nao impede transmitir.
 */
export async function abrirAudioIsolado(): Promise<CapturaIsolada | null> {
  if (!(await window.disc.audio.disponivel())) return null;

  let ctx: AudioContext | null = null;
  let no: AudioWorkletNode | null = null;
  let destino: MediaStreamAudioDestinationNode | null = null;
  let desinscrever: (() => void) | null = null;
  let url: string | null = null;

  try {
    ctx = new AudioContext();
    url = URL.createObjectURL(new Blob([CODIGO_WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);

    no = new AudioWorkletNode(ctx, 'anel-de-audio', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [CANAIS],
      processorOptions: {
        canais: CANAIS,
        quadros: Math.round(ctx.sampleRate * SEGUNDOS_DE_ANEL),
      },
    });

    destino = ctx.createMediaStreamDestination();
    no.connect(destino);

    // Os quadros chegam do processo main e vao direto pro worklet. O
    // `transfer` evita copiar: o ArrayBuffer muda de dono em vez de ser
    // duplicado, e a esta altura ninguem mais precisa dele deste lado.
    const alvo = no.port;
    desinscrever = window.disc.audio.onQuadros((amostras) => {
      alvo.postMessage(amostras, [amostras.buffer]);
    });

    // A taxa e a do AudioContext, e nao um numero escolhido aqui: pedir
    // qualquer outra obrigaria alguem a reamostrar, e o loopback do Windows
    // ja converte de graca na hora de capturar.
    const erro = await window.disc.audio.iniciar(Math.round(ctx.sampleRate), CANAIS);
    if (erro) throw new Error(erro);

    const faixa = destino.stream.getAudioTracks()[0];
    if (!faixa) throw new Error('o destino nao produziu faixa');

    const parar = async () => {
      desinscrever?.();
      await window.disc.audio.parar().catch(() => {});
      no?.disconnect();
      destino?.disconnect();
      await ctx?.close().catch(() => {});
      if (url) URL.revokeObjectURL(url);
    };

    return { faixa, parar };
  } catch (err) {
    console.error('[audio-win] nao consegui isolar o som', err);
    // Desmonta o que subiu: um AudioContext pendurado segura o amplificador
    // do fone ligado, e a captura nativa continuaria rodando a toa.
    desinscrever?.();
    await window.disc.audio.parar().catch(() => {});
    no?.disconnect();
    destino?.disconnect();
    await ctx?.close().catch(() => {});
    if (url) URL.revokeObjectURL(url);
    return null;
  }
}
