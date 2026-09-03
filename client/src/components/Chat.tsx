import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Attachment, Message, NovaEnquete, Poll } from '../types';
import { Avatar } from './Profile';
import { Anexo, Lightbox, tamanhoLegivel } from './Anexo';
import { Enquete, NovaEnqueteForm } from './Enquete';
import {
  IconClipe, IconClose, IconDescer, IconEnquete,
  IconReagir, IconResponder, IconLapis, IconLixeira, IconCopiar,
} from './Icons';
import { ehImagemAnimada, prepareChatImage } from '../lib/image';
import { mensagemDeErro } from '../lib/erros';
import { tokenizar, acharMencoes, MENCAO_TODOS, type Mencionavel } from '../lib/texto';

const timeFmt = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
});

const dataHoraFmt = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Duas mensagens seguidas da mesma pessoa no mesmo dia viram um bloco só:
 * a foto e o nome aparecem na primeira, as outras entram como texto puro.
 * O dia é o limite porque, virando a data, repetir o cabeçalho é o que
 * separa uma conversa da outra.
 */
function mesmoDia(a: number, b: number) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** Teto por arquivo — o mesmo do servidor, avisado antes de subir. */
const MAX_BYTES = 200 * 1024 * 1024;

/**
 * Como o anexo preso ao composer se apresenta antes de virar mensagem.
 *
 * Foto e vídeo não mostram o nome do arquivo — é gerado pela câmera ou pelo
 * gravador e não diz nada ("MedalTVLeagueofLegends20260520002422858-trim-
 * 1779250752194.mp4"). Nos outros o nome fica: é o que deixa perceber que
 * você anexou o .pdf errado antes de mandar.
 */
function rotuloPendente(a: Attachment): string {
  if (a.kind === 'image') return 'Foto';
  if (a.kind === 'video') return 'Vídeo';
  return a.name;
}

interface Props {
  messages: Message[];
  onSend: (
    body: string,
    attachmentId?: string,
    poll?: NovaEnquete,
    replyToId?: number,
  ) => Promise<void>;
  /** Clicar na foto ou no nome de quem escreveu abre o perfil da pessoa. */
  onOpenUser: (identity: string) => void;
  /** Volume dos áudios do chat, 0 a 100. Vem das configurações. */
  chatVolume: number;
  /** Pra saber em que opção da enquete VOCÊ votou. */
  meId: string;
  /** Pode apagar mensagem dos outros. Vem do /api/me. */
  isAdmin: boolean;
  /** A tirinha de emojis, na ordem em que o servidor a define. */
  reactionEmojis: string[];
  /**
   * Todo mundo do servidor, pro autocomplete do @ e pra desenhar os chips.
   *
   * Vem da presença, que traz o servidor inteiro e não só quem está em call:
   * dá pra mencionar quem está offline, e a pessoa lê quando voltar.
   */
  gente: Mencionavel[];
  /** Como mostrar quem votou. 'Você' pra si mesmo. */
  nomeDe: (id: string) => string;
  /** Guarda a apuração nova que o servidor devolveu depois de um voto. */
  onApurarPoll: (poll: Poll) => void;
  /** Avisa a sala que o voto mudou, pra quem está nela reconsultar. */
  onVotou: (pollId: number) => void;
  /** Os três devolvem a mensagem remontada, que o App aplica na lista. */
  onEditar: (id: number, body: string) => Promise<void>;
  onApagar: (id: number) => Promise<void>;
  onReagir: (id: number, emoji: string) => Promise<void>;
  /** Segundo estágio: tira a lápide da conversa. Só em mensagem já apagada. */
  onRemoverDeVez: (id: number) => Promise<void>;
  /**
   * Onde a linha de "novas mensagens" fica. Vem do servidor, lido uma vez
   * no carregamento (`me.lastReadMessageId`) — não se move sozinho depois,
   * é por isso que fica fora do estado deste componente.
   */
  unreadAfterId: number | null;
  /** Avisa o servidor até onde você já leu. Ver o efeito de marcar lido abaixo. */
  onLerMensagens: (id: number) => void;
}

export function Chat({
  messages, onSend, onOpenUser, chatVolume, meId, isAdmin, reactionEmojis, gente,
  nomeDe, onApurarPoll, onVotou, onEditar, onApagar, onReagir, onRemoverDeVez,
  unreadAfterId, onLerMensagens,
}: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const listaRef = useRef<HTMLDivElement>(null);
  /** Medido pra que a transmissão flutuante não cubra a caixa de escrever. */
  const composerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Preso no fim. Só um gesto da PESSOA solta — ver conferirPino. */
  const pinnedRef = useRef(true);
  /** Instante do último gesto de rolagem feito pela pessoa. */
  const gestoRef = useRef(0);
  /** Espelho do pino pra tela: é ele que mostra o botão de descer. */
  const [noFim, setNoFim] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  /** Aberto = o formulário de enquete no lugar da caixa de texto. */
  const [enquetando, setEnquetando] = useState(false);

  /** A mensagem que o composer está respondendo. null = mensagem solta. */
  const [respondendo, setRespondendo] = useState<Message | null>(null);
  /**
   * O balão de cada mensagem, pra citação conseguir rolar até a original.
   *
   * Mapa em ref, e não estado: ele muda a cada montagem de linha e nada na
   * tela depende do conteúdo dele pra desenhar — só o clique na citação
   * consulta, e só no momento do clique.
   */
  const balaoRefs = useRef(new Map<number, HTMLDivElement>());
  /** Qual mensagem está piscando depois de um pulo de citação. */
  const [destacada, setDestacada] = useState<number | null>(null);
  const destaqueTimer = useRef<number | null>(null);

  /** Já subiu e está esperando a mensagem que vai carregá-lo. */
  const [pendente, setPendente] = useState<Attachment | null>(null);
  const [subindo, setSubindo] = useState(false);
  /** 0 a 100. null = sem número ainda (começou agora, ou é o caminho da imagem, que não reporta). */
  const [progresso, setProgresso] = useState<number | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  /** A imagem aberta em tela cheia. */
  const [ampliada, setAmpliada] = useState<Attachment | null>(null);

  /**
   * O autocomplete do @: onde começa a menção sendo digitada, e qual opção
   * está sob o cursor. null = fechado.
   */
  const [mencionando, setMencionando] = useState<{ inicio: number; busca: string } | null>(null);
  const [escolhido, setEscolhido] = useState(0);

  /**
   * Quem casa com o que está sendo digitado depois do @.
   *
   * `todos` entra na lista como se fosse gente, e no topo: é a menção mais
   * usada num grupo desse tamanho, e mantê-la fora obrigaria a lembrar que
   * ela existe.
   */
  const candidatos = (() => {
    if (!mencionando) return [];
    const busca = mencionando.busca.toLowerCase();
    return [
      { id: null as string | null, name: MENCAO_TODOS },
      ...gente,
    ]
      .filter((g) => g.name.toLowerCase().startsWith(busca))
      .slice(0, 6);
  })();

  /**
   * Descobre se o cursor está no meio de uma menção sendo digitada.
   *
   * Olha pra trás a partir do cursor até achar um @ que comece palavra. Para
   * na quebra de linha e depois de 24 caracteres: sem esses limites,
   * qualquer @ escrito lá em cima da mensagem manteria o menu aberto pelo
   * resto do texto.
   */
  const conferirMencao = (texto: string, cursor: number) => {
    for (let i = cursor - 1; i >= 0 && cursor - i <= 24; i--) {
      const c = texto[i];
      if (c === '\n') break;
      if (c !== '@') continue;

      const antes = i > 0 ? texto[i - 1] : ' ';
      if (/[\p{L}\p{N}_@]/u.test(antes)) break;

      setMencionando({ inicio: i, busca: texto.slice(i + 1, cursor) });
      setEscolhido(0);
      return;
    }
    setMencionando(null);
  };

  /** Troca o "@bus" pelo nome inteiro e devolve o cursor pro fim dele. */
  const escolherMencao = (nome: string) => {
    if (!mencionando) return;
    const antes = draft.slice(0, mencionando.inicio);
    const depois = draft.slice(mencionando.inicio + 1 + mencionando.busca.length);
    const novo = `${antes}@${nome} ${depois}`;
    setDraft(novo);
    setMencionando(null);

    // O cursor tem que ir pro fim do nome, não pro fim do texto: quem
    // menciona no meio de uma frase continua escrevendo dali.
    const posicao = antes.length + nome.length + 2;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(posicao, posicao);
    });
  };

  /**
   * Sobe o arquivo NA HORA da escolha, antes de a mensagem existir.
   *
   * Podia esperar o Enter, mas aí um vídeo de 200 MB viraria um Enter que
   * não responde por um minuto. Subindo agora, a espera acontece enquanto a
   * pessoa escreve a legenda — e o servidor recolhe sozinho o que subiu e
   * nunca virou mensagem.
   */
  useEffect(() => window.disc.arquivos.onProgress(setProgresso), []);

  const escolher = async (file: File) => {
    setErro(null);

    if (file.size > MAX_BYTES) {
      setErro(`Esse arquivo tem ${tamanhoLegivel(file.size)}. O limite é 200 MB.`);
      return;
    }

    setSubindo(true);
    // Zera o número de uma tentativa anterior — sem isto, um upload de
    // imagem (que não reporta progresso) herdaria o "87%" do último arquivo.
    setProgresso(null);
    // O foco volta pro campo de texto na hora, e não depois que o arquivo
    // termina de subir: quem escolheu o arquivo pelo botão do clipe está
    // com o foco NELE, e o Enter não chegava no textarea — era preciso
    // clicar na legenda antes pra conseguir mandar.
    inputRef.current?.focus();
    try {
      let r: { attachment: Attachment };

      // A divisão é entre imagem que a gente REPROCESSA e imagem que vai
      // crua. GIF (e WebP animado) não pode passar pelo canvas — sairia com
      // um quadro só — então não há nada pra reduzir, e mandar os bytes pelo
      // IPC seria copiar um arquivo inteiro na memória dos dois lados sem
      // ganho nenhum. Ela desce pelo caminho do arquivo, como todo mundo que
      // sobe cru; o servidor continua classificando image/gif como 'image',
      // então na conversa ela aparece igual.
      const reprocessavel =
        file.type.startsWith('image/') && !(await ehImagemAnimada(file));

      if (reprocessavel) {
        // Imagem passa pelo canvas primeiro: reduz e vai como bytes.
        const img = await prepareChatImage(file);
        r = await window.disc.arquivos.enviarImagem(img.bytes, img.nome, img.mime);
      } else {
        // O resto vai pelo CAMINHO, e o processo main faz stream do disco —
        // é o que impede 200 MB de atravessarem o IPC.
        r = await window.disc.arquivos.enviar(window.disc.arquivos.caminhoDe(file));
      }
      setPendente(r.attachment);
    } catch (err) {
      console.error(err);
      setErro('Não consegui enviar esse arquivo.');
    } finally {
      setSubindo(false);
      setProgresso(null);
    }
  };

  const irAoFim = () => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setNoFim(true);
  };

  /**
   * Rola até a mensagem citada e a faz piscar.
   *
   * Some sem alarde quando a original não está carregada: o chat só tem as
   * últimas cem mensagens e não existe paginação, então citar algo mais
   * antigo que isso é um pulo que não tem pra onde ir. Um aviso explica; um
   * scroll que não acontece deixaria a pessoa clicando de novo.
   */
  const pularPara = (id: number) => {
    const alvo = balaoRefs.current.get(id);
    if (!alvo) {
      setErro('Essa mensagem é antiga demais e não está mais carregada aqui.');
      return;
    }
    alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setDestacada(id);
    if (destaqueTimer.current) window.clearTimeout(destaqueTimer.current);
    destaqueTimer.current = window.setTimeout(() => setDestacada(null), 1600);
  };

  /**
   * Recalcula o pino — e SÓ a partir de um gesto da pessoa.
   *
   * Aqui estava o bug de abrir o app numa mensagem antiga, e ele é mais
   * sutil do que parece. O pino morava no onScroll: "se o scroll não está
   * no fim, a pessoa subiu". Só que o scroll se mexe sozinho o tempo todo
   * durante a abertura — uma foto que carrega, um vídeo que descobre a
   * própria altura, a fonte que troca, o ancoramento de rolagem do
   * Chromium. Qualquer um desses eventos soltava o pino sem ninguém ter
   * tocado em nada, e a partir dali nada mais trazia a conversa pro fim.
   *
   * Exigir um gesto separa as duas coisas na origem, em vez de tentar
   * adivinhar pela geometria: roda do mouse, arrastar a barra, tecla,
   * toque. Conteúdo crescendo não é gesto.
   */
  const conferirPino = () => {
    const el = logRef.current;
    if (!el) return;
    const preso = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    pinnedRef.current = preso;
    setNoFim((antes) => (antes === preso ? antes : preso));
  };

  const marcarGesto = () => {
    gestoRef.current = Date.now();
  };

  /**
   * Avança o ponteiro de leitura NO SERVIDOR — só quando faz sentido dizer
   * que a pessoa realmente leu: presa no fim (pinnedRef) E com a janela em
   * foco. Sem o foco, uma mensagem que chega com o app aberto em segundo
   * plano marcaria como lida sem ninguém ter olhado pra ela.
   *
   * `lidoRef` guarda o maior id já avisado NESTA sessão, pra não repetir o
   * mesmo PUT a cada volta do polling de 3s quando nada mudou.
   */
  const lidoRef = useRef(0);
  useEffect(() => {
    const tentar = () => {
      if (!pinnedRef.current || !document.hasFocus()) return;
      const maior = messages.length > 0 ? messages[messages.length - 1].id : 0;
      if (maior > lidoRef.current) {
        lidoRef.current = maior;
        onLerMensagens(maior);
      }
    };
    tentar();
    // Cobre quem estava pinado mas SEM foco quando a mensagem chegou —
    // ao voltar pro app, o retorno do foco é o gatilho que faltava.
    window.addEventListener('focus', tentar);
    return () => window.removeEventListener('focus', tentar);
  }, [messages, onLerMensagens]);

  /**
   * Manter a conversa no fim — observando o TAMANHO da lista, não a
   * chegada de mensagem.
   *
   * Observar `messages.length` não bastava: quando o efeito rodava, as
   * fotos ainda não tinham carregado. Uma <img> sem bytes ocupa altura
   * zero, então rolávamos até o fim de uma lista que ainda ia crescer.
   *
   * O ResizeObserver pega qualquer coisa que mude a altura — foto, vídeo,
   * fonte, janela mudando de largura, mensagem nova — e já dispara uma vez
   * ao começar a observar, o que cobre a primeira pintura.
   */
  useLayoutEffect(() => {
    const el = logRef.current;
    const lista = listaRef.current;
    if (!el || !lista) return;

    const observador = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    observador.observe(lista);
    return () => observador.disconnect();
  }, []);

  // Cinto e suspensório do anterior: se por algum motivo a lista crescer
  // sem o observador ver, mensagem nova ainda traz pro fim.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  /**
   * Publica a altura do composer como --composer-h.
   *
   * Quem lê são as transmissões flutuantes (.flutuantes no theme.css), que
   * param onde ele começa: a janelinha pode cobrir a conversa — dá pra rolar
   * — mas nunca a caixa de escrever, que é o único lugar da tela onde se
   * está prestes a digitar.
   *
   * Medido, e não um número fixo, porque o composer cresce sozinho: o
   * textarea sobe com as linhas, e a barra de "respondendo a" e o anexo
   * pendente entram e saem por cima dele.
   */
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;

    const observador = new ResizeObserver(() => {
      document.documentElement.style.setProperty(
        '--composer-h',
        `${Math.round(el.getBoundingClientRect().height)}px`,
      );
    });
    observador.observe(el);
    return () => {
      observador.disconnect();
      // Sem isto a última altura medida sobrevive ao Chat desmontado, e a
      // próxima tela que usar a variável herda um valor sem dono.
      document.documentElement.style.removeProperty('--composer-h');
    };
  }, []);

  /**
   * Cria a enquete como uma mensagem sem corpo.
   *
   * A pergunta É o texto do balão — repeti-la no corpo só daria a mesma
   * frase duas vezes, uma acima da outra.
   */
  const criarEnquete = async (enquete: NovaEnquete) => {
    if (sending) return;
    setSending(true);
    setErro(null);
    try {
      await onSend('', undefined, enquete);
      setEnquetando(false);
      pinnedRef.current = true;
      setNoFim(true);
    } catch (err) {
      console.error(err);
      setErro(mensagemDeErro(err, 'Não consegui criar a enquete.'));
    } finally {
      setSending(false);
    }
  };

  const responder = (m: Message) => {
    setRespondendo(m);
    setEnquetando(false);
    inputRef.current?.focus();
  };

  /**
   * Reagir e apagar passam por aqui só pra ter onde a falha aparecer.
   *
   * Sem isto o clique virava `void promessa` e uma recusa do servidor — um
   * 403, a rede caindo, o servidor ainda na versão anterior — não deixava
   * rastro nenhum na tela: o balão simplesmente não mudava, e não havia como
   * distinguir isso de um clique que não pegou.
   */
  const reagir = async (id: number, emoji: string) => {
    setErro(null);
    try {
      await onReagir(id, emoji);
    } catch (err) {
      console.error(err);
      setErro(mensagemDeErro(err, 'Não consegui registrar essa reação.'));
    }
  };

  const apagar = async (id: number) => {
    setErro(null);
    try {
      await onApagar(id);
    } catch (err) {
      console.error(err);
      setErro(mensagemDeErro(err, 'Não consegui apagar essa mensagem.'));
    }
  };

  const removerDeVez = async (id: number) => {
    setErro(null);
    try {
      await onRemoverDeVez(id);
    } catch (err) {
      console.error(err);
      setErro(mensagemDeErro(err, 'Não consegui tirar essa mensagem da conversa.'));
    }
  };

  /**
   * Enter apertado ANTES de o anexo terminar de subir.
   *
   * Ref, e não estado: nada na tela depende dele, e ele precisa ser lido
   * pelo efeito logo abaixo sem entrar numa lista de dependências.
   */
  const enviarAoTerminarRef = useRef(false);

  /**
   * Manda sozinho quando o arquivo chega, se o Enter já tiver sido apertado.
   *
   * Só quando o anexo REALMENTE chegou: upload que falhou não vira mensagem
   * — o erro já está na tela, e mandar um balão vazio por cima dele seria a
   * segunda coisa errada.
   *
   * O `send` fica fora das dependências de propósito: ele se recria a cada
   * tecla digitada (fecha sobre o `draft`), e entrar aqui faria este efeito
   * rodar a cada letra. Quem manda o efeito rodar é o anexo chegar.
   */
  useEffect(() => {
    if (!enviarAoTerminarRef.current || subindo) return;
    enviarAoTerminarRef.current = false;
    if (pendente) void send();
  }, [pendente, subindo]);

  const send = async () => {
    const text = draft.trim();
    // Anexo ainda subindo: guarda a intenção em vez de engolir o Enter. Um
    // vídeo de 200 MB leva segundos, e nesse meio-tempo o Enter não fazia
    // nada nem dizia por quê.
    if (subindo) {
      enviarAoTerminarRef.current = true;
      return;
    }
    // Foto sem legenda é normal; balão totalmente vazio não.
    if ((!text && !pendente) || sending) return;
    setSending(true);
    setErro(null);
    try {
      await onSend(text, pendente?.id, undefined, respondendo?.id);
      setDraft('');
      setPendente(null);
      setRespondendo(null);
      pinnedRef.current = true;
      setNoFim(true);
    } catch (err) {
      console.error(err);
      setErro(mensagemDeErro(err, 'Não consegui mandar a mensagem.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat">
      <div
        className="chat__log"
        ref={logRef}
        // Os quatro jeitos de rolar de propósito. Marcam o instante; quem
        // decide o pino é o onScroll logo abaixo, mas só dentro da janela
        // que estes gestos abrem.
        onWheel={marcarGesto}
        onPointerDown={marcarGesto}
        onTouchStart={marcarGesto}
        onKeyDown={marcarGesto}
        onScroll={() => {
          // 1,5s cobre a inércia da roda e o arrastar da barra, que
          // continuam gerando scroll depois do gesto ter acabado. Fora
          // dessa janela, quem mexeu no scroll foi o conteúdo — e conteúdo
          // não decide se a pessoa quer ou não estar lendo o histórico.
          if (Date.now() - gestoRef.current > 1500) return;
          conferirPino();
        }}
      >
        {/* A lista é um elemento à parte do container que rola porque é o
            TAMANHO DELA que o ResizeObserver precisa ver. Observar o
            .chat__log só mostraria a altura da janela, que não muda quando
            uma foto termina de carregar — justamente o momento em que o fim
            da conversa se desloca. */}
        <div className="chat__lista" ref={listaRef}>
        {messages.length === 0 ? (
          <div className="empty">Ninguém falou nada ainda.</div>
        ) : (
          messages.map((m, i) => {
            const anterior = messages[i - 1];
            // Uma lápide nunca se agrupa com a de cima, e nunca deixa a de
            // baixo se agrupar nela: sem o cabeçalho, "mensagem removida"
            // apareceria pendurada num nome que é de outra mensagem.
            const seguida =
              anterior !== undefined &&
              anterior.user_id === m.user_id &&
              !anterior.deleted &&
              !m.deleted &&
              mesmoDia(anterior.created_at, m.created_at);

            // A linha entra ANTES da primeira mensagem que ficou depois do
            // ponto onde a pessoa parou de ler — daí exigir que a anterior
            // ainda esteja dentro do lido.
            const primeiraNaoLida =
              unreadAfterId !== null &&
              m.id > unreadAfterId &&
              (anterior === undefined || anterior.id <= unreadAfterId);

            return (
              <Fragment key={m.id}>
                {primeiraNaoLida && (
                  <div className="chat__novas">
                    <span>Novas mensagens</span>
                  </div>
                )}
                <Balao
                  m={m}
                  seguida={seguida}
                  meId={meId}
                  isAdmin={isAdmin}
                  reactionEmojis={reactionEmojis}
                  gente={gente}
                  chatVolume={chatVolume}
                  destacada={destacada === m.id}
                  registrarRef={(el) => {
                    if (el) balaoRefs.current.set(m.id, el);
                    else balaoRefs.current.delete(m.id);
                  }}
                  nomeDe={nomeDe}
                  onOpenUser={onOpenUser}
                  onAmpliar={setAmpliada}
                  onApurarPoll={onApurarPoll}
                  onVotou={onVotou}
                  onResponder={responder}
                  onPularPara={pularPara}
                  onEditar={onEditar}
                  onApagar={apagar}
                  onReagir={reagir}
                  onRemoverDeVez={removerDeVez}
                />
              </Fragment>
            );
          })
        )}
        </div>
      </div>

      {/* Aparece só quando a conversa NÃO está no fim. Além de ser o
          atalho óbvio pra voltar, ele torna o estado visível: se o botão
          está na tela, o pino está solto — que era exatamente o que não
          dava pra ver quando o chat abria fora do fim. */}
      {!noFim && (
        <button className="chat__descer" onClick={irAoFim} title="Ir pro fim da conversa">
          <IconDescer size={16} />
        </button>
      )}

      {ampliada && <Lightbox anexo={ampliada} onFechar={() => setAmpliada(null)} />}

      <div className="chat__composer" ref={composerRef}>
        {erro && <div className="chat__erro">{erro}</div>}

        {/* Fica ACIMA do anexo pendente: a ordem na tela é a ordem em que
            as duas coisas entram na mensagem — primeiro a quem ela
            responde, depois o que ela carrega. */}
        {respondendo && (
          <div className="chat__respondendo">
            <IconResponder size={14} />
            <span className="chat__respondendo-quem">{respondendo.author_name}</span>
            <span className="chat__respondendo-texto">
              {resumoDe(respondendo)}
            </span>
            <button
              className="chat__pendente-x"
              onClick={() => setRespondendo(null)}
              title="Não responder mais"
            >
              <IconClose size={14} />
            </button>
          </div>
        )}

        {(pendente || subindo) && (
          <div className="chat__pendente">
            {subindo ? (
              <div className="chat__progresso-wrap">
                <span className="chat__pendente-nome">
                  {progresso !== null ? `Enviando... ${progresso}%` : 'Enviando...'}
                </span>
                {/* Sem barra quando progresso é null: o caminho da imagem
                    não reporta, e uma barra travada em 0% mentiria mais
                    que não ter barra nenhuma. */}
                {progresso !== null && (
                  <div className="chat__progresso">
                    <div className="chat__progresso-barra" style={{ width: `${progresso}%` }} />
                  </div>
                )}
              </div>
            ) : (
              <>
                <span className="chat__pendente-nome" title={rotuloPendente(pendente!)}>
                  {rotuloPendente(pendente!)}
                </span>
                <span className="chat__pendente-tam">{tamanhoLegivel(pendente!.size)}</span>
                {/* Só tira daqui. Os bytes já subiram, e quem os recolhe é a
                    faxina de órfãos do servidor — não vale um round-trip
                    pra apagar algo que some sozinho. */}
                <button
                  className="chat__pendente-x"
                  onClick={() => setPendente(null)}
                  title="Tirar o anexo"
                >
                  <IconClose size={14} />
                </button>
              </>
            )}
          </div>
        )}

        {/* O formulário TOMA O LUGAR da caixa de texto em vez de aparecer
            junto: com os dois na tela existiriam dois botões de mandar, e
            nenhuma pista de qual deles vale. */}
        {enquetando ? (
          <NovaEnqueteForm
            ocupado={sending}
            onCriar={(e) => void criarEnquete(e)}
            onCancelar={() => setEnquetando(false)}
          />
        ) : (
          <div className="chat__linha">
            {/* O menu do @ flutua ACIMA do campo, ancorado nele. No fluxo ele
                empurraria a caixa de texto pra baixo a cada tecla. */}
            {mencionando && candidatos.length > 0 && (
              <div className="mencao-menu">
                {candidatos.map((c, i) => (
                  <button
                    key={c.id ?? MENCAO_TODOS}
                    className={`mencao-menu__item${i === escolhido ? ' mencao-menu__item--sel' : ''}`}
                    // onMouseDown, e não onClick: o clique tira o foco do
                    // textarea antes do onClick disparar, e aí o menu já
                    // fechou pelo onBlur e o clique cai no vazio.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      escolherMencao(c.name);
                    }}
                    onMouseEnter={() => setEscolhido(i)}
                  >
                    <span className="mencao-menu__nome">{c.name}</span>
                    {c.id === null && (
                      <span className="mencao-menu__dica">avisa todo mundo</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {/* O input fica escondido: quem aparece é o botão do clipe, que
                casa com o resto da interface. */}
            <input
              ref={fileRef}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Zera pra que escolher o MESMO arquivo de novo dispare o
                // change outra vez — sem isso, tirar e repor não funciona.
                e.target.value = '';
                if (f) void escolher(f);
              }}
            />
            <button
              className="chat__clipe"
              onClick={() => fileRef.current?.click()}
              disabled={subindo || Boolean(pendente)}
              title={pendente ? 'Já tem um anexo nesta mensagem' : 'Anexar arquivo'}
            >
              <IconClipe size={18} />
            </button>

            <button
              className="chat__clipe"
              onClick={() => setEnquetando(true)}
              disabled={subindo || Boolean(pendente)}
              title={pendente ? 'Tire o anexo primeiro' : 'Criar enquete'}
            >
              <IconEnquete size={18} />
            </button>

            <textarea
              ref={inputRef}
              className="chat__input"
              rows={1}
              placeholder={
                respondendo
                  ? `Respondendo ${respondendo.author_name}...`
                  : pendente
                    ? 'Legenda (opcional)...'
                    : 'Escreve aqui...'
              }
              value={draft}
              maxLength={2000}
              onChange={(e) => {
                setDraft(e.target.value);
                conferirMencao(e.target.value, e.target.selectionStart);
              }}
              // O cursor pode andar sem o texto mudar (setas, clique), e o
              // menu tem que acompanhar: sair de dentro de um @ fecha.
              onSelect={(e) => {
                const el = e.target as HTMLTextAreaElement;
                conferirMencao(el.value, el.selectionStart);
              }}
              onBlur={() => setMencionando(null)}
              onPaste={(e) => {
                // Print colado com Ctrl+V sobe pelo MESMO caminho do botão
                // do clipe (a `escolher` abaixo). Só intercepta quando o
                // clipboard tem imagem — colar texto segue pro textarea
                // normalmente, sem passar por aqui.
                if (subindo || pendente) return;
                const item = Array.from(e.clipboardData.items).find((it) =>
                  it.type.startsWith('image/'),
                );
                if (!item) return;
                const file = item.getAsFile();
                if (!file) return;
                e.preventDefault();
                void escolher(file);
              }}
              onKeyDown={(e) => {
                // Com o menu aberto, o teclado é DELE. Enter aqui escolhe a
                // pessoa em vez de mandar a mensagem — mandar no meio de uma
                // menção pela metade é o erro que essa captura evita.
                const menuAberto = mencionando && candidatos.length > 0;
                if (menuAberto) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setEscolhido((i) => (i + 1) % candidatos.length);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setEscolhido((i) => (i - 1 + candidatos.length) % candidatos.length);
                    return;
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    escolherMencao(candidatos[escolhido].name);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setMencionando(null);
                    return;
                  }
                }

                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
                // Esc solta a resposta antes de limpar qualquer outra coisa:
                // é o jeito de desistir sem tirar a mão do teclado.
                if (e.key === 'Escape' && respondendo) {
                  e.preventDefault();
                  setRespondendo(null);
                }
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * O corpo da mensagem: texto, código e menções.
 *
 * Tudo vira ELEMENTO REACT, nunca HTML. Não há `dangerouslySetInnerHTML`
 * em lugar nenhum deste caminho, e é por isso que não existe sanitização
 * aqui: o React escapa todo texto que passa como filho, então um
 * `<img onerror=...>` digitado por alguém aparece como esses caracteres
 * mesmo, dentro ou fora de um bloco de código.
 *
 * Quem separa código de texto é o tokenizar — o MESMO que o servidor usa
 * pra decidir quem foi mencionado. Ver o comentário em lib/texto.ts.
 */
function Corpo({
  texto, gente, meId, onOpenUser,
}: {
  texto: string;
  gente: Mencionavel[];
  meId: string;
  onOpenUser: (identity: string) => void;
}) {
  return (
    <>
      {tokenizar(texto).map((seg, i) => {
        if (seg.tipo === 'bloco') return <Bloco key={i} texto={seg.texto} lingua={seg.lingua} />;
        if (seg.tipo === 'codigo') return <code key={i} className="msg__codigo">{seg.texto}</code>;
        return (
          <TextoComMencoes
            key={i}
            texto={seg.texto}
            gente={gente}
            meId={meId}
            onOpenUser={onOpenUser}
          />
        );
      })}
    </>
  );
}

/** Um trecho de texto puro, com os @nomes virando chip clicável. */
function TextoComMencoes({
  texto, gente, meId, onOpenUser,
}: {
  texto: string;
  gente: Mencionavel[];
  meId: string;
  onOpenUser: (identity: string) => void;
}) {
  const mencoes = acharMencoes(texto, gente);
  if (mencoes.length === 0) return <>{texto}</>;

  const pedacos: React.ReactNode[] = [];
  let cursor = 0;

  mencoes.forEach((m, i) => {
    if (m.inicio > cursor) pedacos.push(texto.slice(cursor, m.inicio));

    // Ser VOCÊ o mencionado muda a cor: numa conversa cheia de menções, o
    // que interessa é achar as suas de relance.
    const euMesmo = m.id === meId || m.id === null;
    pedacos.push(
      <button
        key={`m${i}`}
        className={`mencao${euMesmo ? ' mencao--eu' : ''}`}
        // @todos não é pessoa e não abre perfil nenhum.
        onClick={m.id ? () => onOpenUser(m.id!) : undefined}
        disabled={!m.id}
        title={m.id ? `Ver o perfil de ${m.rotulo}` : 'Menção a todo mundo'}
      >
        @{m.rotulo}
      </button>,
    );
    cursor = m.fim;
  });

  if (cursor < texto.length) pedacos.push(texto.slice(cursor));
  return <>{pedacos}</>;
}

/** Bloco de código com botão de copiar. */
function Bloco({ texto, lingua }: { texto: string; lingua: string }) {
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    if (!copiado) return;
    const t = window.setTimeout(() => setCopiado(false), 1500);
    return () => window.clearTimeout(t);
  }, [copiado]);

  return (
    <div className="msg__bloco-wrap">
      <div className="msg__bloco-topo">
        {lingua && <span className="msg__bloco-lingua">{lingua}</span>}
        <button
          className="msg__copiar"
          onClick={() => {
            // window.disc.copy, e não navigator.clipboard: em contexto
            // file:// a API do navegador não é confiável, e o app roda
            // exatamente assim depois de instalado.
            void window.disc.copy(texto);
            setCopiado(true);
          }}
          title="Copiar o bloco"
        >
          {copiado ? 'copiado' : <IconCopiar size={13} />}
        </button>
      </div>
      {/* overflow-x no <pre> (ver theme.css): linha comprida rola DENTRO da
          caixa em vez de alargar a conversa inteira. */}
      <pre className="msg__bloco"><code>{texto}</code></pre>
    </div>
  );
}

/**
 * Como uma mensagem se resume numa linha só.
 *
 * Usado pela barra do composer. O card de citação do balão NÃO passa por
 * aqui: o dele vem pronto do servidor (Message.reply_to.snippet), que é
 * quem consegue resolver a original mesmo quando ela não está carregada
 * nesta tela.
 */
function resumoDe(m: Message): string {
  if (m.deleted) return 'mensagem removida';
  if (m.body.trim()) return m.body;
  if (m.poll) return m.poll.question;
  // Foto vira "foto", e não o nome do arquivo: responder a uma imagem
  // mostrava "IMG-20260830-WA0007.jpg" na barra do composer, que é o mesmo
  // lixo que a conversa deixou de mostrar. Nos outros o nome ainda ajuda —
  // é como se distingue um .pdf de outro.
  const anexo = m.attachments?.[0];
  if (anexo) {
    if (anexo.kind === 'image') return 'foto';
    if (anexo.kind === 'video') return 'vídeo';
    return anexo.name;
  }
  return 'mensagem';
}

interface BalaoProps {
  m: Message;
  seguida: boolean;
  meId: string;
  isAdmin: boolean;
  reactionEmojis: string[];
  gente: Mencionavel[];
  chatVolume: number;
  destacada: boolean;
  registrarRef: (el: HTMLDivElement | null) => void;
  nomeDe: (id: string) => string;
  onOpenUser: (identity: string) => void;
  onAmpliar: (a: Attachment) => void;
  onApurarPoll: (poll: Poll) => void;
  onVotou: (pollId: number) => void;
  onResponder: (m: Message) => void;
  onPularPara: (id: number) => void;
  onEditar: (id: number, body: string) => Promise<void>;
  onApagar: (id: number) => Promise<void>;
  onReagir: (id: number, emoji: string) => Promise<void>;
  onRemoverDeVez: (id: number) => Promise<void>;
}

function Balao({
  m, seguida, meId, isAdmin, reactionEmojis, gente, chatVolume, destacada,
  registrarRef, nomeDe, onOpenUser, onAmpliar, onApurarPoll, onVotou,
  onResponder, onPularPara, onEditar, onApagar, onReagir, onRemoverDeVez,
}: BalaoProps) {
  /** Aberta = a tirinha de emojis no lugar dos botões. */
  const [reagindo, setReagindo] = useState(false);
  /** Não-nulo = o corpo virou campo de edição, com este texto dentro. */
  const [rascunho, setRascunho] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  /** Falha ao salvar. Fica DENTRO da caixa: é ali que a pessoa está olhando. */
  const [erroEdicao, setErroEdicao] = useState<string | null>(null);
  /**
   * O botão de remover de vez já foi clicado uma vez e espera confirmação.
   *
   * A confirmação mora no próprio botão em vez de numa janela por cima: é
   * uma ação irreversível, mas pequena e repetitiva (limpar várias lápides
   * seguidas), e um modal a cada uma seria pior que o risco. Volta sozinho
   * em 3s pra não ficar armado esperando um clique distraído.
   */
  const [confirmando, setConfirmando] = useState(false);
  useEffect(() => {
    if (!confirmando) return;
    const t = window.setTimeout(() => setConfirmando(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmando]);

  const hora = timeFmt.format(m.created_at);
  const meu = m.user_id === meId;
  const podeApagar = meu || isAdmin;

  // Mencionaram VOCÊ: o balão ganha um fio na lateral. É o que faz a menção
  // ser achável de relance ao voltar pro app depois de um tempo fora — o som
  // já passou, e rolar a conversa procurando o próprio nome não é achar.
  const mencionado = m.mentions?.includes(meId) ?? false;

  const classes = [
    'msg',
    seguida ? 'msg--seguida' : '',
    destacada ? 'msg--destacada' : '',
    m.deleted ? 'msg--removida' : '',
    mencionado ? 'msg--mencionado' : '',
  ].filter(Boolean).join(' ');

  const salvarEdicao = async () => {
    if (rascunho === null || salvando) return;
    const texto = rascunho.trim();
    // Nada mudou: fecha sem gastar um round-trip nem um "(editado)".
    if (texto === m.body.trim()) {
      setRascunho(null);
      return;
    }
    setSalvando(true);
    setErroEdicao(null);
    try {
      await onEditar(m.id, texto);
      setRascunho(null);
    } catch (err) {
      console.error(err);
      // A caixa fica ABERTA de propósito: o texto que a pessoa escreveu
      // continua ali pra ela tentar de novo. Fechar perderia a edição junto
      // com o erro.
      setErroEdicao(mensagemDeErro(err, 'Não consegui salvar. Tente de novo.'));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div
      className={classes}
      ref={registrarRef}
      // Tirar o mouse fecha a tirinha de emojis. Sem isto ela ficaria aberta
      // atrás de outra mensagem, já que a barra inteira some no hover.
      onMouseLeave={() => setReagindo(false)}
    >
      {seguida ? (
        // Segura a coluna da esquerda no lugar da foto e guarda o
        // horário, que só aparece quando o mouse passa por cima.
        <div className="msg__vinco">
          <span
            className="msg__time msg__time--vinco"
            title={`${m.author_name} às ${hora}`}
          >
            {hora}
          </span>
        </div>
      ) : (
        <button
          className="msg__avatar-btn"
          onClick={() => onOpenUser(m.user_id)}
          title={`Ver o perfil de ${m.author_name}`}
        >
          <Avatar
            url={m.author_avatar}
            name={m.author_name}
            size={36}
            className="msg__avatar"
          />
        </button>
      )}

      <div className="msg__body">
        {/* A citação vem ANTES do cabeçalho, como um fio que sobe até a
            original — é a leitura natural: primeiro a quem se responde,
            depois quem está falando. */}
        {m.reply_to && (
          <button
            className="msg__citacao"
            onClick={() => onPularPara(m.reply_to!.id)}
            title="Ir até a mensagem respondida"
          >
            <span className="msg__citacao-quem">{m.reply_to.author_name}</span>
            <span className="msg__citacao-texto">{m.reply_to.snippet}</span>
          </button>
        )}

        {!seguida && (
          <div className="msg__head">
            <button
              className="msg__author msg__author--botao"
              onClick={() => onOpenUser(m.user_id)}
            >
              {m.author_name}
            </button>
            <span className="msg__time">{hora}</span>
          </div>
        )}

        {m.deleted ? (
          <div className="msg__texto-removido">mensagem removida</div>
        ) : rascunho !== null ? (
          <div className="msg__edicao">
            <textarea
              className="chat__input"
              rows={1}
              autoFocus
              value={rascunho}
              maxLength={2000}
              disabled={salvando}
              onChange={(e) => setRascunho(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void salvarEdicao();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setRascunho(null);
                  setErroEdicao(null);
                }
              }}
            />
            <div className={erroEdicao ? 'msg__edicao-erro' : 'msg__edicao-dica'}>
              {erroEdicao ?? 'Enter salva · Esc cancela'}
            </div>
          </div>
        ) : (
          <>
            {/* Tudo via children do React — escapado automaticamente.
                Nada de dangerouslySetInnerHTML aqui. */}
            {m.body && (
              <div className="msg__text">
                <Corpo texto={m.body} gente={gente} meId={meId} onOpenUser={onOpenUser} />
                {m.edited_at != null && (
                  <span
                    className="msg__editado"
                    title={`Editada em ${dataHoraFmt.format(m.edited_at)}`}
                  >
                    (editado)
                  </span>
                )}
              </div>
            )}
            {m.attachments?.map((a) => (
              <Anexo
                key={a.id}
                anexo={a}
                chatVolume={chatVolume}
                onAmpliar={onAmpliar}
              />
            ))}
            {m.poll && (
              <Enquete
                poll={m.poll}
                meId={meId}
                nomeDe={nomeDe}
                onApurar={onApurarPoll}
                onVotou={onVotou}
              />
            )}
          </>
        )}

        {m.reactions && m.reactions.length > 0 && (
          <div className="msg__reacoes">
            {m.reactions.map((r) => {
              const minha = r.users.includes(meId);
              return (
                <button
                  key={r.emoji}
                  className={`reacao${minha ? ' reacao--minha' : ''}`}
                  onClick={() => void onReagir(m.id, r.emoji)}
                  title={r.users.map(nomeDe).join(', ')}
                >
                  <span className="reacao__emoji">{r.emoji}</span>
                  <span className="reacao__conta">{r.users.length}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Na lápide a barra tem uma coisa só: tirar o "mensagem removida" da
          conversa. É o segundo estágio — o conteúdo já foi embora, e isto
          apaga o registro. */}
      {m.deleted && podeApagar && (
        <div className="msg__acoes">
          <button
            className={`msg__remover${confirmando ? ' msg__remover--confirma' : ''}`}
            onClick={() => {
              if (!confirmando) { setConfirmando(true); return; }
              setConfirmando(false);
              void onRemoverDeVez(m.id);
            }}
            title={
              confirmando
                ? 'Some da conversa pra todo mundo, sem volta'
                : 'Tirar da conversa de vez'
            }
          >
            {confirmando ? 'confirmar?' : <IconLixeira size={14} />}
          </button>
        </div>
      )}

      {/* Durante a edição a barra some: os botões competiriam com o Enter
          que salva. */}
      {!m.deleted && rascunho === null && (
        <div className="msg__acoes">
          {reagindo ? (
            <div className="msg__emojis">
              {reactionEmojis.map((e) => (
                <button
                  key={e}
                  className="msg__emoji"
                  onClick={() => {
                    setReagindo(false);
                    void onReagir(m.id, e);
                  }}
                  title={`Reagir com ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
          ) : (
            <>
              {/* Sem lista de emojis não há o que abrir. Acontece quando o
                  app já atualizou e o servidor ainda não: o /api/me antigo
                  não manda reactionEmojis, e um botão que abre uma tirinha
                  vazia é pior que botão nenhum. */}
              {reactionEmojis.length > 0 && (
                <button
                  className="msg__acao"
                  onClick={() => setReagindo(true)}
                  title="Reagir"
                >
                  <IconReagir size={15} />
                </button>
              )}
              <button
                className="msg__acao"
                onClick={() => onResponder(m)}
                title="Responder"
              >
                <IconResponder size={15} />
              </button>
              {meu && (
                <button
                  className="msg__acao"
                  onClick={() => setRascunho(m.body)}
                  title="Editar"
                >
                  <IconLapis size={15} />
                </button>
              )}
              {podeApagar && (
                <button
                  className="msg__acao msg__acao--perigo"
                  onClick={() => void onApagar(m.id)}
                  title={meu ? 'Apagar' : 'Apagar (admin)'}
                >
                  <IconLixeira size={15} />
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
