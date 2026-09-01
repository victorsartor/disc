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

import urlDoWorklet from './anel-de-audio.worklet.js?url';

const CANAIS = 2;
/** Um segundo de folga no anel. Sobra pra engasgo, longe de virar atraso. */
const SEGUNDOS_DE_ANEL = 1;

export interface CapturaIsolada {
  faixa: MediaStreamTrack;
  parar: () => Promise<void>;
}

/**
 * Deu certo, ou nao deu e AQUI ESTA O MOTIVO.
 *
 * Nao e um `| null` de proposito. Enquanto era null, quem chamava caia no
 * caminho de reserva sem ter como saber que caiu — foi assim que a 0.30.0
 * foi pra producao transmitindo o sistema inteiro com o toggle marcado.
 * Com o motivo na mao, dar de ombros vira uma decisao escrita.
 */
export type ResultadoIsolamento =
  | { ok: true; captura: CapturaIsolada }
  | { ok: false; motivo: string };

/**
 * Liga a captura isolada e devolve a faixa pronta pra publicar.
 *
 * Quando nao da (outro sistema, addon ausente, Windows sem a API), devolve
 * o motivo. Nao e fatal: o chamador pode cair no caminho de antes, que
 * transmite com a voz da chamada junto — mas agora tem como avisar.
 */
export async function abrirAudioIsolado(): Promise<ResultadoIsolamento> {
  if (!(await window.disc.audio.disponivel())) {
    return { ok: false, motivo: 'o componente de audio nao esta disponivel nesta instalacao' };
  }

  let ctx: AudioContext | null = null;
  let no: AudioWorkletNode | null = null;
  let destino: MediaStreamAudioDestinationNode | null = null;
  let desinscrever: (() => void) | null = null;

  try {
    ctx = new AudioContext();

    // urlDoWorklet e um asset de mesma origem que o documento. Ja foi um
    // Blob, e o Blob passava em dev e era RECUSADO em producao pela CSP
    // (`script-src 'self'`) — ver o cabecalho do anel-de-audio.worklet.js.
    await ctx.audioWorklet.addModule(urlDoWorklet);

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
    };

    return { ok: true, captura: { faixa, parar } };
  } catch (err) {
    console.error('[audio-win] nao consegui isolar o som', err);
    // Desmonta o que subiu: um AudioContext pendurado segura o amplificador
    // do fone ligado, e a captura nativa continuaria rodando a toa.
    desinscrever?.();
    await window.disc.audio.parar().catch(() => {});
    no?.disconnect();
    destino?.disconnect();
    await ctx?.close().catch(() => {});
    return { ok: false, motivo: (err as Error)?.message || 'falhou por um motivo desconhecido' };
  }
}
