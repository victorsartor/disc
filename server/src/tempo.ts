/**
 * Quanto tempo cada pessoa passou em call.
 *
 * POR QUE NO SERVIDOR. O cliente sabe muito bem quando entrou e quando
 * saiu, e mesmo assim não pode ser a fonte: um POST dizendo "somei 200
 * horas" seria aceito sem nada pra contestar. "Autorização sempre no
 * servidor" vale pro número também. E o servidor já sabe a resposta — o
 * presence() pergunta ao LiveKit quem está em cada sala pra desenhar a
 * sidebar, e essa mesma lista serve aqui.
 *
 * POR QUE UM TICKER, E NÃO EVENTO DE ENTRADA E SAÍDA. Marcar o instante em
 * que a pessoa entra e fechar a conta quando ela sai parece mais exato, e é
 * pior: quem cai a conexão, fecha o notebook ou perde energia nunca manda o
 * evento de saída, e a sessão fica aberta pra sempre — somando a noite
 * inteira na próxima vez que alguém olhasse. Somando de tick em tick, o pior
 * caso é perder um tick. Nada fica pendurado.
 *
 * É AUTO-CORRETIVO. Se o servidor reiniciar no meio, perde no máximo os 30s
 * do tick em curso. Não há estado em memória pra reconstruir, e ninguém
 * precisa avisar que saiu.
 */

import { presence, type Presence } from './presence.js';
import { addVoiceTime } from './db.js';

/**
 * De quanto em quanto tempo somar.
 *
 * 30s é a granularidade do erro: alguém que entra e sai dentro de uma
 * janela pode não ser contado, e alguém que sai logo depois de um tick
 * ganha até 30s a mais. Num número que se apresenta em HORAS, isso é ruído.
 * Descer pra 5s multiplicaria por 6 as chamadas ao LiveKit pra ganhar uma
 * precisão que nenhuma tela mostra.
 */
const TICK_MS = 30_000;

let timer: NodeJS.Timeout | null = null;

/**
 * Quem está em call agora, uma vez cada.
 *
 * O Set é o que faz o trabalho: a mesma pessoa aparecendo em duas salas
 * conta uma hora só. Hoje isso quase não acontece — a presença já devolve
 * cada pessoa num canal só (ver o `maisRecente` em presence.ts) — mas a soma
 * das HORAS de alguém não deveria depender de outra função estar certa.
 *
 * Função à parte e exportada pra que a dedupe possa ser provada sem
 * precisar de gente numa chamada de verdade.
 *
 * Até 03/09/2026 ela também desfazia o sufixo `_obs` do ingress, que fazia
 * quem transmitisse pelo OBS contar o dobro. O OBS saiu do app nessa data e
 * o sufixo não é mais emitido por ninguém.
 */
export function pessoasEmCall(canais: Presence): string[] {
  const presentes = new Set<string>();
  for (const membros of Object.values(canais)) {
    for (const m of membros) presentes.add(m.identity);
  }
  return [...presentes];
}

/** Uma volta: quem está em call agora ganha mais um tick. */
async function tick(): Promise<void> {
  const presentes = pessoasEmCall(await presence());
  if (presentes.length > 0) addVoiceTime(presentes, TICK_MS);
}

export function iniciarContagemDeTempo(): void {
  if (timer) return;

  timer = setInterval(() => {
    // O catch é o que mantém o ticker vivo. LiveKit fora do ar por um
    // minuto derrubaria o intervalo inteiro se o erro subisse, e aí a
    // contagem pararia até o próximo restart do servidor — em silêncio.
    void tick().catch((err) => {
      console.error('nao consegui somar o tempo de call', err);
    });
  }, TICK_MS);

  // unref: este intervalo não é motivo pro processo continuar vivo. Sem
  // isso, um `docker stop` esperaria o timeout inteiro antes de matar.
  timer.unref();
}
