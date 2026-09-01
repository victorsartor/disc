/**
 * Tirar a Disneia do som que vai pra transmissao — no Linux.
 *
 * O PROBLEMA. No Linux o Chromium nao captura som de sistema, entao o app
 * grava de um "monitor" do PipeWire: uma escuta do que sai pela caixa. So
 * que a voz das outras pessoas TAMBEM sai pela caixa, entao ela entra na
 * gravacao — e quem esta te assistindo se ouve de volta. Ate aqui a saida
 * era a mao: mandar a Disneia pra outra saida de audio nas configuracoes do
 * sistema. Isto automatiza, e sem addon nativo nenhum.
 *
 * A IDEIA. O que se OUVE e o que se TRANSMITE deixam de ser a mesma mistura:
 *
 *   jogo, navegador, tudo ─┐
 *                          ├─> disneia_captura (sink virtual) ─┬─> monitor -> transmissao
 *                          │                                   └─> loopback -> saida real -> voce ouve
 *   Disneia ───────────────────────────────────────────────────────────────> saida real -> voce ouve
 *
 * A Disneia toca DIRETO na saida real e nunca passa pelo sink virtual.
 * Todo o resto passa, e volta pra saida real por um loopback — por isso
 * continua audivel. O monitor do sink virtual e a transmissao: tem o jogo,
 * nao tem a chamada.
 *
 * POR QUE null-sink + loopback, E NAO module-combine-sink. O combine faria
 * o mesmo com menos latencia, mas e um modulo que nem toda versao do
 * pipewire-pulse implementa. Estes dois sao o piso: existem no PulseAudio
 * de verdade e na camada de compatibilidade do PipeWire desde sempre. Num
 * recurso que quebra o audio da pessoa quando falha, o piso vale mais que
 * os milissegundos.
 *
 * TUDO PELO pactl, de proposito. Ele fala com o PulseAudio de verdade e com
 * o pipewire-pulse pela mesma interface, entao uma implementacao cobre os
 * dois servidores de som. Sem biblioteca nativa, sem compilar nada — o
 * oposto da metade Windows desta versao.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Os nomes carregam o prefixo porque e por ele que a limpeza de sobra
 * encontra o que ficou pra tras depois de um fechamento sujo. Mudar isto
 * deixa orfao o que a versao anterior criou.
 */
const PREFIXO = 'disneia_';
const SINK_CAPTURA = `${PREFIXO}captura`;

/**
 * Como o sink aparece na lista de dispositivos.
 *
 * E por este texto que o renderer acha o monitor certo depois: o Chromium
 * so entrega `label`, nunca o nome interno do PulseAudio. Mudar aqui exige
 * mudar o lado de la junto.
 */
export const DESCRICAO_CAPTURA = 'Disneia (transmissao)';

/** Latencia do loopback que devolve o som pra saida real, em ms. */
const LATENCIA_MS = 40;

/**
 * A descricao no formato que o load-module aceita.
 *
 * MEDIDO, nao deduzido: o parser de argumentos do PulseAudio quebra no
 * ESPACO antes de olhar as aspas, entao `device.description="Disneia
 * (transmissao)"` faz o modulo inteiro falhar com "Module initialization
 * failed" — sem dizer qual parte. As aspas continuam necessarias, e cada
 * espaco precisa vir escapado com barra ALEM delas. Sem aspas, com aspas
 * simples, ou com barra sem aspas: os tres falham. Conferido contra o
 * PulseAudio 16.1.
 *
 * A descricao tambem e ASCII de proposito: ela atravessa o parser do
 * PulseAudio, o D-Bus e o Chromium antes de virar `label` na lista de
 * dispositivos, e acento e a primeira coisa que se perde nesse caminho.
 */
const propriedadeDescricao = (texto: string) =>
  `device.description="${texto.replace(/ /g, '\\ ')}"`;

interface Estado {
  /** Saida real de antes — pra onde tudo volta no fim. */
  sinkOriginal: string;
  /** Indices dos modulos que carregamos, na ordem de descarregar. */
  modulos: number[];
  /** Streams que movemos, pra devolver cada um pro lugar de onde saiu. */
  movidos: { indice: string; sinkAnterior: string }[];
  /** O `pactl subscribe` que avisa de stream novo. Morre no liberar. */
  vigia: ChildProcess | null;
}

let estado: Estado | null = null;

/** Roda o pactl. Sem shell: os argumentos vao como lista, nunca concatenados. */
async function pactl(...args: string[]): Promise<string> {
  const { stdout } = await run('pactl', args, { timeout: 5000 });
  return stdout.trim();
}

/** O pactl existe e responde? E a checagem de "da pra fazer isso aqui". */
export async function temPactl(): Promise<boolean> {
  try {
    await pactl('info');
    return true;
  } catch {
    return false;
  }
}

/** Um stream tocando agora, com o que precisamos pra decidir sobre ele. */
interface Stream {
  indice: string;
  /** NOME do sink, ja resolvido — o pactl entrega indice aqui. */
  sink: string;
  appName: string;
  pid: number | null;
}

/**
 * Le os streams que estao tocando.
 *
 * LANG=C no ambiente porque o pactl traduz os rotulos da saida longa. Sem
 * isso, "application.name" continua igual (e propriedade, nao rotulo), mas
 * a leitura fica refem de um formato que muda com o idioma da maquina.
 */
async function listarStreams(): Promise<Stream[]> {
  const { stdout: curto } = await run('pactl', ['list', 'short', 'sink-inputs'], {
    timeout: 5000,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  const { stdout: longo } = await run('pactl', ['list', 'sink-inputs'], {
    timeout: 5000,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });

  // O `list short sink-inputs` diz em qual sink cada stream esta, mas pelo
  // INDICE dele — e indice muda a cada modulo carregado ou descarregado.
  // Guardar nome desde aqui e o que deixa o resto do arquivo comparavel.
  const { stdout: sinks } = await run('pactl', ['list', 'short', 'sinks'], {
    timeout: 5000,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  const nomeDoSink = new Map<string, string>();
  for (const linha of sinks.split('\n')) {
    const campos = linha.split('\t');
    if (campos.length >= 2 && campos[0]) nomeDoSink.set(campos[0].trim(), campos[1].trim());
  }

  const sinkPorIndice = new Map<string, string>();
  for (const linha of curto.split('\n')) {
    const campos = linha.split('\t');
    if (campos.length >= 2 && campos[0]) {
      sinkPorIndice.set(campos[0].trim(), nomeDoSink.get(campos[1].trim()) ?? '');
    }
  }

  const streams: Stream[] = [];
  // Cada bloco comeca em "Sink Input #N" e vai ate o proximo.
  for (const bloco of longo.split(/^Sink Input #/m).slice(1)) {
    const indice = bloco.split('\n')[0].trim();
    if (!indice) continue;
    const nome = /application\.name = "([^"]*)"/.exec(bloco)?.[1] ?? '';
    const pidCru = /application\.process\.id = "(\d+)"/.exec(bloco)?.[1];
    streams.push({
      indice,
      sink: sinkPorIndice.get(indice) ?? '',
      appName: nome,
      pid: pidCru ? Number(pidCru) : null,
    });
  }
  return streams;
}

/**
 * Este stream e nosso?
 *
 * Duas provas, porque uma so nao basta. O nome vem do PULSE_PROP que o
 * main.ts planta antes do Chromium subir, e e o caminho normal; mas se o
 * libpulse ignorar a variavel (versao antiga, sandbox), a arvore de
 * processos ainda responde. Errar aqui e caro dos dois lados: um stream
 * nosso deixado de fora volta o eco, e um stream do JOGO tratado como
 * nosso some da transmissao.
 */
async function ehNosso(s: Stream): Promise<boolean> {
  return ehStreamNosso(s.appName, s.pid);
}

/**
 * A decisao, separada do formato do pactl — e exportada pra poder ser
 * provada sozinha, como o pessoasEmCall do servidor.
 *
 * E o ponto onde um erro custa caro dos dois lados e nao aparece em
 * nenhuma tela: marcar um stream do JOGO como nosso o tira da transmissao
 * em silencio, e deixar um nosso de fora traz o eco de volta.
 */
export async function ehStreamNosso(appName: string, pid: number | null): Promise<boolean> {
  if (appName === 'Disneia') return true;
  if (pid === null) return false;
  return descendeDeNos(pid);
}

/**
 * Sobe a arvore de processos ate achar a gente ou chegar no init.
 *
 * O servico de audio do Chromium e um processo FILHO, com pid proprio — e
 * e o pid dele que aparece no pactl, nunca o nosso. Comparar direto com
 * process.pid nao acharia nada.
 */
async function descendeDeNos(pid: number): Promise<boolean> {
  let atual = pid;
  // Teto de saltos: /proc pode mentir, e um ciclo aqui travaria a abertura
  // da transmissao. A arvore real do Chromium tem 2 ou 3 niveis.
  for (let i = 0; i < 10; i++) {
    if (atual === process.pid) return true;
    if (atual <= 1) return false;
    try {
      const stat = await readFile(`/proc/${atual}/stat`, 'utf8');
      // O nome do processo vem entre parenteses e pode ter espaco dentro,
      // entao a divisao e depois do ULTIMO ')': o ppid e o campo 2 dali.
      const depois = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const ppid = Number(depois[1]);
      if (!Number.isInteger(ppid)) return false;
      atual = ppid;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Descarrega o que sobrou de uma sessao anterior.
 *
 * Existe porque o pior caso deste recurso nao e falhar: e o app morrer no
 * meio (queda, kill, falta de energia) e deixar a saida padrao apontando
 * pra um sink virtual que ninguem mais alimenta — a pessoa reabre e nao tem
 * som nenhum, sem nenhuma pista do porque. Roda na abertura do app, antes
 * de qualquer transmissao.
 */
export async function limparSobras(): Promise<number> {
  let removidos = 0;
  try {
    const saida = await pactl('list', 'short', 'modules');
    // Os indices sao coletados antes de descarregar: cada unload reindexa
    // o resto, e uma lista lida no meio disso ficaria errada.
    const alvos: string[] = [];
    for (const linha of saida.split('\n')) {
      if (linha.includes(PREFIXO)) {
        const indice = linha.split('\t')[0]?.trim();
        if (indice) alvos.push(indice);
      }
    }
    // De tras pra frente pelo mesmo motivo: descarregar o maior primeiro
    // nao mexe no indice dos menores.
    for (const indice of alvos.reverse()) {
      try {
        await pactl('unload-module', indice);
        removidos++;
      } catch {
        /* ja saiu sozinho */
      }
    }
  } catch {
    /* sem pactl: nao ha sobra que possa ser nossa */
  }
  return removidos;
}

/**
 * Monta o desvio e devolve a descricao do monitor a capturar.
 *
 * Devolve null quando nao deu — e nao lanca. Falhar aqui nao pode impedir
 * a transmissao: sem isolamento ela sai com eco, o que ainda e melhor que
 * nao sair.
 */
export async function isolar(): Promise<string | null> {
  if (estado) return DESCRICAO_CAPTURA;
  if (!(await temPactl())) return null;

  // Sobra de uma sessao anterior atrapalharia: o load-module abaixo criaria
  // um segundo sink com o mesmo nome, e o renderer acharia o errado.
  await limparSobras();

  const novo: Estado = { sinkOriginal: '', modulos: [], movidos: [], vigia: null };

  try {
    novo.sinkOriginal = await pactl('get-default-sink');
    if (!novo.sinkOriginal) return null;

    // 1. O sink virtual. E o monitor DELE que vira a transmissao.
    const idNull = await pactl(
      'load-module', 'module-null-sink',
      `sink_name=${SINK_CAPTURA}`,
      `sink_properties=${propriedadeDescricao(DESCRICAO_CAPTURA)}`,
    );
    novo.modulos.push(Number(idNull));

    // 2. O caminho de volta: o que entra no sink virtual sai na caixa. Sem
    //    isto o jogo ficaria mudo pra propria pessoa enquanto transmite.
    const idLoop = await pactl(
      'load-module', 'module-loopback',
      `source=${SINK_CAPTURA}.monitor`,
      `sink=${novo.sinkOriginal}`,
      `latency_msec=${LATENCIA_MS}`,
      'sink_input_properties=application.name=Disneia',
    );
    novo.modulos.push(Number(idLoop));

    // 3. A FOTOGRAFIA vem ANTES de mexer no destino padrao. E dela que sai
    //    pra onde cada stream volta no fim — e ela precisa ser tirada
    //    enquanto o mundo ainda esta no lugar.
    const antes = await listarStreams();

    // 4. Quem nascer daqui pra frente ja nasce no sink virtual.
    //
    //    E ATENCAO: o set-default-sink NAO so muda o padrao. Ele ARRASTA
    //    junto todo stream que estava tocando na saida antiga — inclusive
    //    os nossos. Sem o passo 5, a voz do pessoal seria levada pra dentro
    //    da captura por esta linha, e a versao inteira nao faria nada.
    await pactl('set-default-sink', SINK_CAPTURA);

    // 5. Cada stream e recolocado EXPLICITAMENTE, e nao so os que "ainda
    //    nao estao la": depois do arrasto acima, "onde ele esta agora" nao
    //    diz mais nada sobre onde ele deveria estar.
    for (const s of antes) {
      const nosso = await ehNosso(s);
      try {
        if (nosso) {
          // De volta pra onde estava. Sem isto ele fica na captura, que e
          // exatamente o problema que esta versao existe pra resolver.
          if (s.sink && s.sink !== SINK_CAPTURA) {
            await pactl('move-sink-input', s.indice, s.sink);
          }
        } else {
          await pactl('move-sink-input', s.indice, SINK_CAPTURA);
          novo.movidos.push({ indice: s.indice, sinkAnterior: s.sink });
        }
      } catch {
        // Stream que morreu entre listar e mover. Nao e erro: um a menos
        // na transmissao e melhor que desmontar tudo por causa dele.
      }
    }

    estado = novo;

    // 6. E o que nascer DEPOIS? Nasce no padrao, que agora e a captura —
    //    entao um som de notificacao, ou a voz de quem acabou de entrar na
    //    sala, cairia direto na transmissao. O vigia tira os nossos de la
    //    conforme aparecem.
    iniciarVigia(novo);

    return DESCRICAO_CAPTURA;
  } catch (err) {
    console.error('[audio-linux] nao consegui isolar', err);
    // Desmonta o que ja tinha subido: meio desvio e pior que nenhum — a
    // saida padrao podia ter mudado sem o caminho de volta existir.
    estado = novo;
    await liberar();
    return null;
  }
}

/**
 * Tira da captura os nossos sons que nascerem durante a transmissao.
 *
 * Enquanto o desvio esta montado, o destino padrao E o sink de captura —
 * entao TODO stream novo nasce la dentro, os nossos junto. Um som de
 * notificacao, ou a faixa de voz de quem acabou de entrar na sala, iria
 * direto pra transmissao sem passar por lugar nenhum que a gente checasse.
 *
 * O `pactl subscribe` avisa na hora, em vez de a gente ficar perguntando de
 * segundo em segundo: um segundo de voz vazada ja e a falha que a versao
 * existe pra impedir.
 *
 * Falhar aqui nao derruba a transmissao — no pior caso volta o eco, que e
 * o comportamento de antes desta versao.
 */
function iniciarVigia(atual: Estado): void {
  let vigia: ChildProcess;
  try {
    vigia = spawn('pactl', ['subscribe'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
  } catch (err) {
    console.error('[audio-linux] sem vigia de streams novos', err);
    return;
  }

  atual.vigia = vigia;
  let pendente = false;

  vigia.stdout?.setEncoding('utf8');
  vigia.stdout?.on('data', (bloco: string) => {
    // So evento de sink-input novo interessa. O subscribe fala de tudo —
    // sink, source, card, client — e varias vezes por segundo.
    if (!/on sink-input/.test(bloco)) return;
    // Uma varredura de cada vez: os eventos vem em rajada (um stream novo
    // gera 'new' e varios 'change'), e sem isto seriam dezenas de pactl
    // simultaneos pra fazer o mesmo trabalho.
    if (pendente) return;
    pendente = true;
    void resgatarNossos(atual)
      .catch(() => {
        /* o proximo evento tenta de novo */
      })
      .finally(() => {
        pendente = false;
      });
  });

  vigia.on('error', (err) => {
    console.error('[audio-linux] o vigia caiu', err);
  });
}

/** Move pra saida real qualquer stream nosso que esteja dentro da captura. */
async function resgatarNossos(atual: Estado): Promise<void> {
  for (const s of await listarStreams()) {
    if (s.sink !== SINK_CAPTURA) continue;
    if (!(await ehNosso(s))) continue;
    try {
      await pactl('move-sink-input', s.indice, atual.sinkOriginal);
    } catch {
      /* morreu no meio do caminho */
    }
  }
}

/** Desfaz tudo, na ordem inversa. Seguro de chamar mesmo sem isolar antes. */
export async function liberar(): Promise<void> {
  const atual = estado;
  estado = null;
  if (!atual) return;

  // O vigia sai antes de tudo: com o desvio sendo desmontado, cada evento
  // que ele gerasse mandaria um move pra um sink que esta indo embora.
  atual.vigia?.kill();
  atual.vigia = null;

  // A saida padrao volta PRIMEIRO: se algo abaixo falhar, o pior caso e um
  // modulo pendurado, e nao a pessoa sem som nenhum.
  if (atual.sinkOriginal) {
    try {
      await pactl('set-default-sink', atual.sinkOriginal);
    } catch {
      /* a saida sumiu (fone desconectado): o sistema ja escolheu outra */
    }
  }

  for (const m of atual.movidos) {
    try {
      await pactl('move-sink-input', m.indice, m.sinkAnterior || atual.sinkOriginal);
    } catch {
      /* stream que acabou no meio da transmissao */
    }
  }

  for (const indice of [...atual.modulos].reverse()) {
    try {
      await pactl('unload-module', String(indice));
    } catch {
      /* ja saiu */
    }
  }
}

/** Verdadeiro enquanto o desvio esta montado. */
export function isolando(): boolean {
  return estado !== null;
}
