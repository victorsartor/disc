/**
 * O tokenizer de mensagem — reexportado do SERVIDOR, de propósito.
 *
 * A implementação mora em `server/src/texto.ts` e é a mesma dos dois lados.
 * Não é organização preguiçosa: o servidor decide QUEM foi mencionado (e
 * portanto quem recebe notificação) e o cliente decide O QUE vira chip na
 * tela. As duas decisões dependem de concordar sobre onde começa e termina
 * um bloco de código.
 *
 * Duas cópias divergiriam na primeira vez que alguém ajustasse uma delas, e
 * o sintoma seria mudo: um `@caio` dentro de um bloco de código notificando
 * o Caio sem aparecer marcado pra ninguém. Foi assim que o vídeo quebrou na
 * 0.29 — a mesma regra em dois arquivos, testada de um lado só.
 *
 * Mora do lado do servidor porque o Dockerfile dele só copia `server/`; um
 * diretório compartilhado na raiz não chegaria no container. O build do
 * cliente roda com o repositório inteiro na mão, então alcança sem
 * problema (ver `server.fs.allow` no vite.config.ts).
 */
export {
  tokenizar,
  acharMencoes,
  mencionadosEm,
  MENCAO_TODOS,
  type Segmento,
  type Mencao,
  type Mencionavel,
} from '../../../server/src/texto.js';
