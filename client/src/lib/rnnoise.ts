/**
 * Supressao de ruido de verdade, como um no do grafo de audio.
 *
 * O QUE ISTO RESOLVE QUE O PORTAO NAO RESOLVE. O portao do mic.ts corta o
 * som quando voce NAO esta falando - ele e uma chave liga/desliga no ganho.
 * Enquanto voce fala a chave esta aberta, e tudo passa junto: o teclado
 * mecanico, o ventilador, o cachorro. O RNNoise trabalha DENTRO da fala: e
 * uma rede neural pequena que separa voz de ruido quadro a quadro, entao o
 * teclado some sem levar a sua voz junto.
 *
 * Os dois se somam, e nessa ordem: com o ruido de fundo ja removido, o nivel
 * medido nas pausas cai de verdade, e o portao passa a fechar quando deve.
 * Ver o grafo montado em mic.ts.
 *
 * POR QUE NAO USAR O loadRnnoise DO PACOTE. Ele faz `fetch(url)`, e em
 * producao esta janela e carregada por file:// (ver o loadFile no main.ts).
 * O Chromium recusa a Fetch API em file:, entao o loadRnnoise funcionaria no
 * `npm run dev` (que serve por http) e falharia no app instalado - a mesma
 * divergencia dev/producao que ja mordeu este projeto duas vezes, no blob:
 * do worklet e no data: do asset. Aqui o binario nao e buscado: ele CHEGA
 * embutido no bundle como data: URI e e decodificado na memoria, sem rede
 * nenhuma. O que funciona no dev e literalmente o mesmo que roda instalado.
 *
 * O worklet, ao contrario, continua sendo um arquivo em ./assets - o
 * addModule sabe carregar de file:, e a CSP aceita porque e mesma origem.
 * As duas metades chegam por caminhos diferentes de proposito.
 */

import { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import urlDoWorklet from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import urlDoWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

/**
 * O RNNoise foi treinado em 48 kHz e NAO reamostra: entregar 44,1 kHz a ele
 * nao da erro, da um resultado ruim e silencioso - a rede passa a ver
 * frequencias deslocadas e limpa a coisa errada. Por isso o AudioContext do
 * microfone e criado travado nesta taxa quando a supressao esta ligada, em
 * vez de aceitar o padrao da placa de som. Ver Mic.abrir.
 */
export const TAXA_RNNOISE = 48000;

/**
 * Deu certo, ou nao deu e AQUI ESTA O MOTIVO.
 *
 * Mesma forma do ResultadoIsolamento do audio-win.ts, e pela mesma razao:
 * enquanto isto era um `| null`, cair no caminho de reserva era
 * indistinguivel de nunca ter tentado. Com o motivo na mao, quem chama pode
 * escrever no console o que faltou em vez de dar de ombros.
 */
export type ResultadoRnnoise =
  | { ok: true; no: RnnoiseWorkletNode }
  | { ok: false; motivo: string };

/**
 * O modulo compilado tem instrucoes SIMD, e so vem essa variante.
 *
 * O pacote traz as duas (com e sem SIMD) e escolhe em runtime; aqui a
 * escolha ja esta feita, porque quem fixa a versao do Chromium somos nos e
 * nao o usuario: o Electron 33 e Chromium 130, e SIMD e ligado por padrao
 * desde o 91. Carregar so uma variante tira ~150 kB do bundle e uma
 * ramificacao do codigo.
 *
 * A checagem continua existindo mesmo assim - se um dia essa premissa
 * mudar, a supressao desliga com um motivo escrito em vez de instanciar um
 * modulo que a maquina nao sabe rodar.
 */
const SONDA_SIMD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
  3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

/**
 * Os bytes do wasm a partir do data: URI que o bundler embutiu.
 *
 * Devolve null quando a URL NAO e data: - o que significa que o
 * assetsInlineLimit do vite.config.ts deixou de embutir este arquivo. Isso
 * nao e um detalhe cosmetico: um caminho de arquivo aqui so seria
 * carregavel por fetch, e fetch e exatamente o que nao existe em file://.
 * Melhor desligar a supressao com o motivo escrito do que servir um caminho
 * que morre so no app instalado.
 */
function bytesDoDataUrl(url: string): ArrayBuffer | null {
  const virgula = url.indexOf(',');
  if (!url.startsWith('data:') || !url.slice(0, virgula).includes(';base64')) {
    return null;
  }

  const texto = atob(url.slice(virgula + 1));
  const bytes = new Uint8Array(texto.length);
  for (let i = 0; i < texto.length; i++) bytes[i] = texto.charCodeAt(i);
  return bytes.buffer;
}

/**
 * O binario decodificado, uma vez por execucao do app.
 *
 * Decodificar sao ~150 kB de base64 e acontece a cada Mic.abrir - que roda
 * ao entrar num canal E a cada troca de microfone ou de filtro. Guardar o
 * resultado evita repetir isso no meio de uma chamada.
 *
 * Reaproveitar o mesmo ArrayBuffer e seguro: ele vai pro worklet por
 * processorOptions, que faz clonagem estruturada - o buffer e COPIADO, nao
 * transferido, entao ele continua valido aqui para a proxima vez.
 */
let binario: ArrayBuffer | null = null;

/**
 * Monta o no de supressao para um AudioContext.
 *
 * O contexto precisa ja estar em TAXA_RNNOISE - quem cria o contexto e o
 * mic.ts, e e la que a taxa e fixada. Conferir aqui em vez de confiar
 * transforma um erro de fiacao futuro num motivo legivel.
 */
export async function criarRnnoise(ctx: AudioContext): Promise<ResultadoRnnoise> {
  if (ctx.sampleRate !== TAXA_RNNOISE) {
    return {
      ok: false,
      motivo: `o contexto esta em ${ctx.sampleRate} Hz e o RNNoise exige ${TAXA_RNNOISE}`,
    };
  }

  if (!WebAssembly.validate(SONDA_SIMD)) {
    return { ok: false, motivo: 'esta maquina nao roda WebAssembly com SIMD' };
  }

  try {
    if (!binario) {
      const bytes = bytesDoDataUrl(urlDoWasm);
      if (!bytes) {
        return {
          ok: false,
          motivo: 'o wasm nao foi embutido no bundle (ver assetsInlineLimit no vite.config.ts)',
        };
      }
      binario = bytes;
    }

    // Um asset de mesma origem que o documento, igual ao worklet do
    // audio-win.ts - e passa no `script-src 'self'` pelo mesmo motivo.
    // Instanciar o wasm la dentro, esse sim, precisa do 'wasm-unsafe-eval'
    // que foi adicionado a CSP do index.html.
    await ctx.audioWorklet.addModule(urlDoWorklet);

    // maxChannels 2 e folga, nao intencao: o microfone quase sempre entrega
    // mono, mas uma interface de audio pode entregar estereo, e ai um teto
    // de 1 descartaria metade do sinal.
    const no = new RnnoiseWorkletNode(ctx, { maxChannels: 2, wasmBinary: binario });
    return { ok: true, no };
  } catch (err) {
    return {
      ok: false,
      motivo: (err as Error)?.message || 'falhou por um motivo desconhecido',
    };
  }
}
