/**
 * Como o texto de uma mensagem é lido: código e menções.
 *
 * ⚠️ ESTE ARQUIVO É COMPARTILHADO COM O CLIENTE. Ele é importado por
 * `client/src/lib/texto.ts`, que só reexporta. Mora aqui porque o Dockerfile
 * do servidor só copia `server/`, então um diretório `shared/` na raiz não
 * chegaria no container.
 *
 * POR QUE COMPARTILHADO, e não uma cópia de cada lado: as duas metades TÊM
 * que concordar sobre onde começa e termina um bloco de código. O servidor
 * usa isso pra decidir quem foi mencionado (e portanto quem é notificado);
 * o cliente usa pra decidir o que vira chip na tela. Se discordarem, um
 * `@caio` dentro de um bloco de código notifica o Caio sem aparecer marcado
 * pra ninguém — o tipo de divergência que só se descobre meses depois.
 *
 * Foi exatamente assim que o vídeo quebrou na 0.29: a mesma regra em dois
 * arquivos, testada de um lado só.
 *
 * MANTENHA ESTE ARQUIVO SEM IMPORTS. Ele é typecheckado pelo tsconfig do
 * cliente também, onde nada de Node existe.
 */

export type Segmento =
  | { tipo: 'texto'; texto: string }
  /** Trecho entre crases simples, no meio de uma frase. */
  | { tipo: 'codigo'; texto: string }
  /** Bloco entre crases triplas, em linha própria. */
  | { tipo: 'bloco'; lingua: string; texto: string };

/**
 * Quebra o texto cru em pedaços de texto e pedaços de código.
 *
 * É um subconjunto MÍNIMO de markdown, de propósito: só crase simples e
 * crase tripla. Nada de link, imagem, negrito ou HTML. Cada coisa a mais
 * seria uma superfície a mais, e a renderização de mensagem de usuário é o
 * único lugar do app onde XSS vira execução. Aqui não há o que escapar
 * porque nada disto vira HTML — o cliente monta elementos React, e o React
 * escapa texto sozinho.
 */
export function tokenizar(entrada: string): Segmento[] {
  const saida: Segmento[] = [];
  let buffer = '';
  let i = 0;

  const despejar = () => {
    if (buffer) {
      saida.push({ tipo: 'texto', texto: buffer });
      buffer = '';
    }
  };

  while (i < entrada.length) {
    if (entrada.startsWith('```', i)) {
      const fim = entrada.indexOf('```', i + 3);
      // Sem fechamento não é bloco: três crases soltas no fim de uma frase
      // não podem engolir o resto da mensagem.
      if (fim !== -1) {
        despejar();
        const miolo = entrada.slice(i + 3, fim);
        const quebra = miolo.indexOf('\n');

        // A primeira linha vira o nome da linguagem SÓ se for uma palavra
        // só. "```js\ncodigo" tem linguagem; "```bora ver\nisso" não tem —
        // ali a primeira linha é conteúdo.
        let lingua = '';
        let corpo = miolo;
        if (quebra !== -1) {
          const cabeca = miolo.slice(0, quebra).trim();
          const ehLingua = cabeca !== '' && !/\s/.test(cabeca) && cabeca.length <= 20;
          if (ehLingua) lingua = cabeca;

          // A primeira linha some em DOIS casos: quando ela era a
          // linguagem, e quando estava vazia — aí ela é só o ``` ocupando
          // uma linha própria, que é como quase todo mundo escreve.
          //
          // Sem o segundo caso, todo bloco sem linguagem nascia com uma
          // linha em branco na frente. Só aparece na tela, nunca no dado.
          if (ehLingua || cabeca === '') corpo = miolo.slice(quebra + 1);
        }

        saida.push({ tipo: 'bloco', lingua, texto: corpo.replace(/\n$/, '') });
        i = fim + 3;
        continue;
      }
    }

    if (entrada[i] === '`') {
      const fim = entrada.indexOf('`', i + 1);
      // Precisa fechar, não pode estar vazio, e não pode atravessar linha:
      // uma crase perdida numa frase não pode transformar os dois parágrafos
      // seguintes em código.
      if (fim !== -1 && fim > i + 1 && !entrada.slice(i + 1, fim).includes('\n')) {
        despejar();
        saida.push({ tipo: 'codigo', texto: entrada.slice(i + 1, fim) });
        i = fim + 1;
        continue;
      }
    }

    buffer += entrada[i];
    i++;
  }

  despejar();
  return saida;
}

/** Quem dá pra mencionar. O servidor passa todo mundo; o cliente, a presença. */
export interface Mencionavel {
  id: string;
  name: string;
}

/** A palavra que chama o grupo inteiro. `@todos`. */
export const MENCAO_TODOS = 'todos';

export interface Mencao {
  /** Índice do `@` dentro do trecho. */
  inicio: number;
  /** Índice logo depois do último caractere do nome. */
  fim: number;
  /** null = é o `@todos`. */
  id: string | null;
  /** O nome como ele deve aparecer no chip, não como foi digitado. */
  rotulo: string;
}

/**
 * Acha as menções DENTRO DE UM TRECHO DE TEXTO.
 *
 * Recebe um pedaço já tokenizado, nunca a mensagem inteira: é o que garante
 * que `@fulano` dentro de um bloco de código não vira menção. Quem separa é
 * o tokenizar.
 */
export function acharMencoes(texto: string, gente: Mencionavel[]): Mencao[] {
  // Os mais longos primeiro. Com "Ana" e "Ana Paula" na sala, "@Ana Paula"
  // tem que casar com a segunda — parando na primeira, sobraria um " Paula"
  // solto e a menção seria pra pessoa errada.
  const alvos = [
    { chave: MENCAO_TODOS, id: null as string | null, rotulo: MENCAO_TODOS },
    ...gente.map((g) => ({ chave: g.name, id: g.id, rotulo: g.name })),
  ]
    .filter((a) => a.chave.length > 0)
    .sort((a, b) => b.chave.length - a.chave.length);

  const achados: Mencao[] = [];
  const minusculo = texto.toLowerCase();

  for (let i = 0; i < texto.length; i++) {
    if (texto[i] !== '@') continue;

    // O @ tem que começar palavra. Sem isto, "sartor@gmail.com" mencionaria
    // alguém chamado Gmail, e todo e-mail escrito no chat viraria menção.
    const antes = i > 0 ? texto[i - 1] : ' ';
    if (/[\p{L}\p{N}_@]/u.test(antes)) continue;

    for (const alvo of alvos) {
      const chave = alvo.chave.toLowerCase();
      if (!minusculo.startsWith(chave, i + 1)) continue;

      // E tem que TERMINAR palavra: "@ana" não pode casar dentro de
      // "@anabela", senão mencionaria a Ana toda vez que a Anabela falasse.
      const fim = i + 1 + chave.length;
      const depois = texto[fim] ?? ' ';
      if (/[\p{L}\p{N}_]/u.test(depois)) continue;

      achados.push({ inicio: i, fim, id: alvo.id, rotulo: alvo.rotulo });
      i = fim - 1;
      break;
    }
  }

  return achados;
}

/**
 * Quem foi mencionado numa mensagem inteira. É o que o servidor grava.
 *
 * O autor sai do resultado: mencionar a si mesmo não notifica ninguém, e
 * `@todos` que notificasse quem escreveu seria só barulho de volta.
 */
export function mencionadosEm(
  corpo: string,
  gente: Mencionavel[],
  autorId: string,
): string[] {
  const ids = new Set<string>();

  for (const seg of tokenizar(corpo)) {
    if (seg.tipo !== 'texto') continue;
    for (const m of acharMencoes(seg.texto, gente)) {
      // @todos vira uma linha por pessoa, em vez de um sinalizador na
      // mensagem. Assim o cliente pergunta sempre a mesma coisa — "meu id
      // está na lista?" — sem um segundo caminho pra tratar.
      if (m.id === null) for (const g of gente) ids.add(g.id);
      else ids.add(m.id);
    }
  }

  ids.delete(autorId);
  return [...ids];
}
