import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Channel, Me, Message, NovaEnquete, Poll, TelaCanto, UserProfile,
} from './types';
import { MAX_ASSISTINDO, useRoom } from './lib/useRoom';
import { usePresence, useStatus } from './lib/usePresence';
import { useUpdate, blocksApp } from './lib/useUpdate';
import { Login } from './components/Login';
import { Updater } from './components/Updater';
import { Sidebar } from './components/Sidebar';
import { Stage } from './components/Stage';
import { Preview } from './components/Preview';
import { RoomAudio } from './components/RoomAudio';
import { Chat } from './components/Chat';
import { ScreenPicker } from './components/ScreenPicker';
import { Settings } from './components/Settings';
import { Profile, UserCard } from './components/Profile';
import { IconScreen, IconEye, IconEyeOff } from './components/Icons';
import { DEFAULT_THEME, isThemeId, type ThemeId } from './lib/themes';
import { playNotify, playMention } from './lib/sounds';

/**
 * Duas versões da MESMA mensagem dizem a mesma coisa?
 *
 * Roda 100 vezes a cada 3 segundos, então a ordem das perguntas é a ordem
 * do que é barato: os três escalares primeiro, e o JSON.stringify só nos
 * casos raros em que existe reação ou enquete pra comparar. A esmagadora
 * maioria das mensagens sai na primeira linha.
 *
 * Não compara anexo: o único jeito de a lista de anexos mudar é a mensagem
 * virar lápide, e `deleted` já pega isso.
 */
function mesmoConteudo(a: Message, b: Message): boolean {
  if (a.body !== b.body) return false;
  if ((a.edited_at ?? null) !== (b.edited_at ?? null)) return false;
  if ((a.deleted ?? false) !== (b.deleted ?? false)) return false;

  const ra = a.reactions ?? [];
  const rb = b.reactions ?? [];
  if (ra.length !== rb.length) return false;
  if (ra.length > 0 && JSON.stringify(ra) !== JSON.stringify(rb)) return false;

  if (Boolean(a.poll) !== Boolean(b.poll)) return false;
  if (a.poll && b.poll && JSON.stringify(a.poll) !== JSON.stringify(b.poll)) return false;

  return true;
}

/**
 * O que a notificação do sistema mostra no corpo.
 *
 * Mensagem de menção quase sempre tem texto — é o caso de "@fulano bora?".
 * Os outros existem porque dá pra mencionar alguém numa enquete ou numa
 * foto, e um balãozinho vazio no canto da tela não diz por que apareceu.
 */
function resumoParaAviso(m: Message): string {
  if (m.body.trim()) return m.body;
  if (m.poll) return `Enquete: ${m.poll.question}`;
  // Foto não leva o nome do arquivo nem aqui — pelo mesmo motivo do resumoDe
  // no Chat: é lixo de câmera, e num balãozinho do sistema ele ocupa a linha
  // inteira sem dizer nada.
  const anexo = m.attachments?.[0];
  if (anexo) {
    if (anexo.kind === 'image') return 'Mandou uma foto';
    if (anexo.kind === 'video') return 'Mandou um vídeo';
    return `Mandou ${anexo.name}`;
  }
  return 'Mencionou você';
}

export function App() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [picking, setPicking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // Identity de quem foi clicado. null = nenhum cartão aberto.
  const [cardIdentity, setCardIdentity] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  const update = useUpdate();

  useEffect(() => {
    void window.disc.update.version().then(setVersion);
  }, []);

  // Guarda os ids já vistos para o data channel não duplicar o que o
  // polling também trouxe (e vice-versa).
  const seenRef = useRef<Set<number>>(new Set());
  // Refs, não state: addMessage precisa do valor de agora sem entrar na
  // lista de dependências do useCallback - senão toda troca de `me` ou de
  // fase do histórico recriaria a função e, com ela, o `room` que a usa.
  const meRef = useRef<Me | null>(null);
  meRef.current = me;
  // Espelho da lista, pra quem precisa do valor de AGORA fora de um
  // atualizador de estado — é o caso da detecção de mensagem removida.
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  // true só depois que a primeira leva de mensagens (o histórico) já
  // passou. Sem isto, entrar num canal com conversa parada tocaria uma
  // notificação pra cada mensagem antiga.
  const historicoCarregadoRef = useRef(false);
  /**
   * Onde a linha de "novas mensagens" fica — travado no valor que o
   * servidor mandou na PRIMEIRA leitura do /api/me desta abertura.
   *
   * Ref, e não state: se fosse state, marcar como lida (que atualiza o
   * mesmo número no servidor) reagiria de volta pra cá e apagaria a linha
   * embaixo da própria pessoa enquanto ela ainda está lendo.
   */
  const unreadAfterIdRef = useRef<number | null>(null);

  const addMessage = useCallback((m: Message) => {
    if (seenRef.current.has(m.id)) return;
    seenRef.current.add(m.id);
    setMessages((prev) => [...prev, m].sort((a, b) => a.id - b.id));

    if (!historicoCarregadoRef.current) return;
    const eu = meRef.current?.id;
    if (!eu || m.user_id === eu) return;

    /**
     * Menção tem som próprio e chama fora do app; mensagem comum, não.
     *
     * A lista vem do SERVIDOR (m.mentions) e não de reler o texto aqui —
     * assim o que dispara a notificação é a mesma decisão que marcou o
     * balão, e não uma segunda interpretação da frase.
     *
     * A notificação é sempre pedida: quem confere se a janela está em foco
     * é o processo main. Com o app na frente ela simplesmente não sai.
     */
    if (m.mentions?.includes(eu)) {
      playMention();
      void window.disc.notificarMencao(m.author_name, resumoParaAviso(m)).catch(() => {
        /* notificacao e enfeite: nao vale um erro na tela */
      });
    } else {
      playNotify();
    }
  }, []);

  /**
   * Troca uma mensagem já na lista pela versão nova que o servidor devolveu.
   *
   * É o caminho de tudo que MUDA depois de a mensagem existir — editar,
   * apagar, reagir. Tem que ser separado do addMessage porque ele ignora id
   * já visto: é justamente esse ignorar que impede o data channel e o
   * polling de duplicarem cada mensagem nova.
   *
   * Mensagem que não está na lista é ignorada de propósito: quem acabou de
   * abrir o app pode receber o aviso de uma alteração antes do histórico
   * chegar, e inserir aqui a colocaria fora de ordem. O polling traz.
   */
  const aplicarMensagem = useCallback((m: Message) => {
    setMessages((prev) => {
      const i = prev.findIndex((x) => x.id === m.id);
      if (i === -1) return prev;
      const proximo = prev.slice();
      proximo[i] = m;
      return proximo;
    });
  }, []);

  /**
   * Tira mensagens da lista — e da memória de ids já vistos.
   *
   * Limpar o `seenRef` junto é o que torna a remoção AUTOCORRIGÍVEL: se ela
   * acontecer por engano, a próxima volta do polling encontra a mensagem no
   * servidor e o addMessage a recoloca no lugar certo (ele ordena por id).
   * Mantendo o id no `seen`, um engano seria permanente até fechar o app —
   * e o engano é justamente o que a heurística de janela lá embaixo pode
   * cometer.
   */
  const removerMensagens = useCallback((ids: number[]) => {
    if (ids.length === 0) return;
    const fora = new Set(ids);
    for (const id of fora) seenRef.current.delete(id);
    setMessages((prev) => {
      const proximo = prev.filter((m) => !fora.has(m.id));
      return proximo.length === prev.length ? prev : proximo;
    });
  }, []);

  /**
   * Reconcilia o que o polling trouxe com o que já está na tela.
   *
   * Só troca o objeto quando o conteúdo mudou de verdade. Sem essa
   * comparação, a cada 3 segundos a lista inteira viraria objetos novos e o
   * chat re-renderizaria sozinho para sempre — inclusive com ninguém
   * mexendo em nada.
   *
   * Cobre o que envelhece depois do envio: a apuração da enquete, o texto
   * editado, a lápide, as reações — e o sumiço, quando alguém remove a
   * lápide de vez. O addMessage não ajudaria em nenhum deles: ele só olha
   * ids que nunca viu.
   *
   * A REMOÇÃO precisa de cuidado. O servidor devolve só as 100 mais novas,
   * então "não veio na resposta" não significa "não existe mais" — pode ser
   * uma mensagem antiga que saiu da janela enquanto a conversa andava. Por
   * isso só some quem está DENTRO da faixa que chegou: id maior ou igual ao
   * mais antigo da resposta. Abaixo disso a resposta não tem opinião.
   */
  const sincronizarMensagens = useCallback((chegaram: Message[]) => {
    const porId = new Map(chegaram.map((m) => [m.id, m]));

    setMessages((prev) => {
      let mudou = false;
      const proximo = prev.map((atual) => {
        const nova = porId.get(atual.id);
        if (!nova || mesmoConteudo(atual, nova)) return atual;
        mudou = true;
        return nova;
      });
      return mudou ? proximo : prev;
    });

    // O sumiço é uma passada à parte, lendo o estado pelo ref em vez de por
    // dentro do atualizador: ele também mexe no seenRef, e efeito colateral
    // dentro de um atualizador roda duas vezes no StrictMode.
    //
    // `chegaram` vem do mais antigo pro mais novo (o servidor reverte).
    const inicioDaJanela = chegaram.length > 0 ? chegaram[0].id : null;
    if (inicioDaJanela === null) return;

    removerMensagens(
      messagesRef.current
        .filter((m) => m.id >= inicioDaJanela && !porId.has(m.id))
        .map((m) => m.id),
    );
  }, [removerMensagens]);

  /**
   * Aplica uma apuração avulsa, sem mexer no resto da mensagem.
   *
   * Serve o retorno do próprio voto e a reconsulta disparada pelo aviso do
   * data channel — nos dois casos só a enquete mudou.
   */
  const aplicarPoll = useCallback((poll: Poll) => {
    setMessages((prev) =>
      prev.map((m) => (m.poll?.id === poll.id ? { ...m, poll } : m)),
    );
  }, []);

  const recontarPoll = useCallback((pollId: number) => {
    window.disc.polls
      .of(pollId)
      .then(({ poll }) => aplicarPoll(poll))
      .catch(() => {
        /* enquete apagada ou rede caindo: o polling de 3s corrige */
      });
  }, [aplicarPoll]);

  const removerUma = useCallback((id: number) => removerMensagens([id]), [removerMensagens]);

  const room = useRoom(addMessage, recontarPoll, aplicarMensagem, removerUma);

  /**
   * Editar, apagar e reagir seguem o mesmo desenho, e é de propósito.
   *
   * Os três mandam pro servidor, recebem a MENSAGEM INTEIRA remontada de
   * volta, aplicam na lista e retransmitem esse mesmo objeto pela sala.
   * Ninguém calcula localmente como a mensagem ficou — nem o autor, nem
   * quem recebe. Foi a lição da enquete: quem soma no cliente acaba com
   * dois apps discordando e nada que os reconcilie.
   */
  const editarMensagem = useCallback(async (id: number, body: string) => {
    const { message } = await window.disc.editMessage(id, body);
    aplicarMensagem(message);
    await room.broadcastMessageChanged(message);
  }, [aplicarMensagem, room]);

  const apagarMensagem = useCallback(async (id: number) => {
    const { message } = await window.disc.deleteMessage(id);
    aplicarMensagem(message);
    await room.broadcastMessageChanged(message);
  }, [aplicarMensagem, room]);

  const reagir = useCallback(async (id: number, emoji: string) => {
    const { message } = await window.disc.reactMessage(id, emoji);
    aplicarMensagem(message);
    await room.broadcastMessageChanged(message);
  }, [aplicarMensagem, room]);

  /**
   * Segundo estágio: a lápide sai da conversa.
   *
   * Só o id viaja de volta — não existe mais mensagem pra mandar. Quem está
   * na sala tira na hora; quem está fora descobre no polling, que deixa de
   * trazer a mensagem (ver a detecção de janela no sincronizarMensagens).
   */
  const removerDeVez = useCallback(async (id: number) => {
    await window.disc.purgeMessage(id);
    removerMensagens([id]);
    await room.broadcastMessageRemoved(id);
  }, [removerMensagens, room]);

  // O tema mora nas configurações da máquina e vale pro documento inteiro:
  // quem pinta é o CSS, a partir deste atributo no <html>.
  const temaSalvo = room.settings?.theme;
  const theme: ThemeId = isThemeId(temaSalvo) ? temaSalvo : DEFAULT_THEME;

  const settingsCarregou = room.settings !== null;

  useEffect(() => {
    // Antes de as configurações chegarem, o valor aqui é só o padrão
    // provisório. Aplicá-lo desfaria o que o main.tsx já pintou a partir da
    // cópia do localStorage — o clarão que aquela cópia existe pra evitar.
    if (!settingsCarregou) return;

    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('tema', theme);
    } catch {
      /* sem armazenamento: só perde o atalho contra o clarão */
    }

    // A barra de título é desenhada pelo Windows e não lê CSS: sem este
    // aviso, trocar pro Ártico deixaria três símbolos brancos sobre fundo
    // branco. Lemos o computado em vez de manter uma tabela de cores aqui,
    // pra que o themes.css continue sendo a única fonte da verdade.
    //
    // O --level-1 vai junto pelo mesmo motivo, mas pra outra hora: é o fundo
    // que a JANELA usa, e ela nasce antes do CSS. O main guarda e usa na
    // próxima abertura — sem isso, todo tema que não é o Abissal pisca azul
    // ao abrir, e no Total Black o azul aparece sobre um app preto.
    const cores = getComputedStyle(document.documentElement);
    const barra = cores.getPropertyValue('--level-2').trim();
    const simbolo = cores.getPropertyValue('--alabaster').trim();
    const janela = cores.getPropertyValue('--level-1').trim();
    if (barra && simbolo) void window.disc.titlebar(barra, simbolo, janela || undefined);
  }, [theme, settingsCarregou]);

  // A largura da barra lateral segue o mesmo desenho do tema logo acima:
  // mora no settings.json (que sobrevive à atualização do app), quem desenha
  // é o CSS a partir de uma variável no <html>, e uma cópia no localStorage
  // evita o pulo na abertura.
  const larguraSidebar = room.settings?.sidebarWidth ?? 240;

  useEffect(() => {
    // Mesmo motivo do efeito do tema: antes de as configurações chegarem
    // este valor é só o padrão provisório, e aplicá-lo desfaria o que o
    // main.tsx já pintou a partir do localStorage.
    if (!settingsCarregou) return;

    // Este efeito é o ÚNICO caminho da largura vinda do disco. O arrasto
    // escreve na mesma variável por fora do React (SidebarResizer), e as
    // duas coisas não brigam porque as dependências aqui só mudam quando o
    // settings.json muda — nunca no meio de um gesto.
    document.documentElement.style.setProperty('--sidebar-w', `${larguraSidebar}px`);
    try {
      localStorage.setItem('larguraSidebar', String(larguraSidebar));
    } catch {
      /* sem armazenamento: só perde o atalho contra o pulo */
    }
  }, [larguraSidebar, settingsCarregou]);

  const salvarLargura = useCallback((px: number) => {
    void room.updateSettings({ sidebarWidth: px });
  }, [room]);

  // O canto e o tamanho da transmissão flutuante seguem exatamente o mesmo
  // desenho da largura acima: valor no settings.json, o CSS desenhando a
  // partir de uma variável no <html>, e o gesto escrevendo nela por fora do
  // React (ver Stage.tsx). A dependência só muda quando o settings.json
  // muda, nunca no meio de um arrasto — é isso que evita o salto ao soltar.
  const telaCanto = room.settings?.telaCanto ?? 'baixo-dir';
  const telaLargura = room.settings?.telaLargura ?? 360;

  useEffect(() => {
    if (!settingsCarregou) return;
    document.documentElement.style.setProperty('--tela-w', `${telaLargura}px`);
  }, [telaLargura, settingsCarregou]);

  const salvarCanto = useCallback((c: TelaCanto) => {
    void room.updateSettings({ telaCanto: c });
  }, [room]);

  const salvarTelaLargura = useCallback((px: number) => {
    void room.updateSettings({ telaLargura: px });
  }, [room]);

  const { channels: presence, users, canais } = usePresence(Boolean(loggedIn), room.channelId);

  /**
   * A lista de canais que a coluna mostra.
   *
   * A presença (polling de 3s) é a fonte enquanto responde — é ela que faz
   * um canal criado por um admin aparecer nas outras telas. Nos primeiros 3s,
   * antes da primeira volta, cai no que veio no `me`. O servidor nunca deixa
   * a lista vazia (recusa apagar o último canal), então `canais.length` só é
   * 0 antes do primeiro retorno.
   */
  const channels: Channel[] = canais.length > 0 ? canais : (me?.channels ?? []);

  /**
   * O canal em que você está sumiu da lista — um admin apagou enquanto você
   * estava dentro. O LiveKit ainda te segura na sala fantasma; sair aqui é o
   * que fecha o ciclo. Só age depois que a presença já respondeu ao menos uma
   * vez (`canais.length > 0`), senão derrubaria você no carregamento.
   */
  useEffect(() => {
    if (!room.channelId || canais.length === 0) return;
    if (!canais.some((c) => c.id === room.channelId)) void room.disconnect();
  }, [canais, room]);

  const criarCanal = useCallback(
    (nome: string) => window.disc.canais.criar(nome).then(() => undefined),
    [],
  );
  const renomearCanal = useCallback(
    (id: string, nome: string) => window.disc.canais.renomear(id, nome).then(() => undefined),
    [],
  );
  const removerCanal = useCallback(async (id: string) => {
    await window.disc.canais.remover(id);
    // Não espera o efeito de cima: se era o canal ativo, sai já.
    if (room.channelId === id) void room.disconnect();
  }, [room]);

  // Microfone aberto num canal é o que segura o status em "disponível".
  //
  // É micWanted, e não micOn: em apertar-para-falar o micOn pisca junto com
  // a tecla, e ficar dez minutos sem apertar não é estar mudo — é estar
  // ouvindo. O que conta é ter desligado o microfone de propósito.
  const ativo = Boolean(room.channelId) && room.micWanted;
  const status = useStatus(Boolean(loggedIn), ativo);

  /**
   * Clicar numa pessoa. Clicar em VOCÊ abre a aba de edição — é o mesmo
   * gesto, e não faria sentido cair num cartão só de leitura do próprio
   * perfil.
   */
  const openUser = useCallback((id: string) => {
    if (id === me?.id) {
      setCardIdentity(null);
      setProfileOpen(true);
    } else {
      setCardIdentity(id);
    }
  }, [me?.id]);

  /** Perfil salvo: o nome e a foto novos precisam valer já na sidebar. */
  const onProfileSaved = useCallback((user: UserProfile) => {
    setMe((prev) =>
      prev ? { ...prev, name: user.name, avatarUrl: user.avatarUrl } : prev,
    );
  }, []);

  useEffect(() => {
    void window.disc.auth.status().then(setLoggedIn);
    return window.disc.auth.onChanged((v) => {
      setLoggedIn(v);
      if (!v) setMe(null);
    });
  }, []);

  useEffect(() => {
    if (!loggedIn) return;
    window.disc.me().then((m) => {
      setMe(m);
      if (unreadAfterIdRef.current === null) unreadAfterIdRef.current = m.lastReadMessageId;
    }).catch(() => setLoggedIn(false));
  }, [loggedIn]);

  /** Avança o ponteiro de leitura no servidor. Ver o efeito em Chat.tsx que chama isto. */
  const marcarLido = useCallback((id: number) => {
    void window.disc.markRead(id).catch(() => {
      /* rede caindo: a proxima tentativa (nova mensagem, ou o foco) corrige */
    });
  }, []);

  // Backend é a fonte da verdade. O data channel só adianta a entrega
  // para quem está na mesma sala de voz — quem está fora recebe aqui.
  useEffect(() => {
    if (!loggedIn) return;
    let alive = true;
    // Zera a cada login: quem sai e entra de novo vê o histórico de novo
    // sem barulho, do mesmo jeito que na primeira vez.
    historicoCarregadoRef.current = false;

    const load = async () => {
      try {
        const { messages } = await window.disc.messages();
        if (!alive) return;
        for (const m of messages) addMessage(m);
        // Segunda passada, porque o addMessage ignora mensagem já vista: é
        // justamente numa mensagem ANTIGA que a apuração muda, o texto é
        // editado, a lápide aparece e a reação entra. Este é o caminho de
        // quem não está na mesma sala de voz — o data channel só alcança
        // quem está.
        sincronizarMensagens(messages);
      } catch {
        /* offline momentâneo: a próxima volta pega */
      } finally {
        historicoCarregadoRef.current = true;
      }
    };

    void load();
    // 3s. Dentro do canal de voz o data channel entrega na hora e isto nem
    // aparece; fora dele este intervalo É a latência do chat.
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [loggedIn, addMessage, sincronizarMensagens]);

  const sendChat = useCallback(async (
    body: string,
    attachmentId?: string,
    poll?: NovaEnquete,
    replyToId?: number,
  ) => {
    const { message } = await window.disc.sendMessage(body, attachmentId, poll, replyToId);
    addMessage(message);
    await room.broadcastChat(message);
  }, [addMessage, room]);

  /**
   * O nome de quem votou. 'Você' pra si mesmo — na lista de uma opção,
   * ler o próprio nome em terceira pessoa é estranho.
   *
   * Sai da presença, que já traz todo mundo do servidor (não só quem está
   * em call). Quem não estiver lá é gente que saiu da allowlist: o voto
   * continua contando, só perde o nome.
   */
  const nomeDe = useCallback((id: string) => {
    if (id === me?.id) return 'Você';
    return users.find((u) => u.identity === id)?.name ?? 'alguém';
  }, [users, me?.id]);

  /**
   * Quem dá pra mencionar, no formato que o tokenizer espera.
   *
   * Memoizado porque a presença se refaz a cada volta do polling, e sem isto
   * a lista viraria um array novo a cada 3 segundos — re-renderizando o chat
   * inteiro sozinho, que é exatamente o que o sincronizarMensagens evita do
   * outro lado.
   */
  const gente = useMemo(
    () => users.map((u) => ({ id: u.identity, name: u.name })),
    [users],
  );

  // Nome do canal ativo, pro topo. Sai da lista viva, não do me: um canal
  // renomeado troca de nome no topo sem reiniciar o app.
  const activeName = channels.find((c) => c.id === room.channelId)?.name ?? null;

  // No Linux o seletor e do sistema (ver initDisplayMedia no main): abrir o
  // nosso modal por cima so poria uma escolha em cima da outra — e a escolha
  // feita nele nem sobrevive a viagem ate a captura.
  const seletorProprio = window.disc.platform !== 'linux';

  const onShareClick = useCallback(() => {
    if (room.sharing) void room.stopShare();
    else if (seletorProprio) setPicking(true);
    else void room.startShare(null);
  }, [room, seletorProprio]);

  // Atualizar vem antes de tudo, inclusive do login: nao adianta entrar numa
  // sala com uma versao que o resto do grupo ja deixou pra tras.
  if (blocksApp(update)) return <Updater state={update} from={version} />;

  if (loggedIn === null) return <div className="login" />;
  if (!loggedIn || !me) return <Login />;

  return (
    <div className="app">
      <RoomAudio feeds={room.audios} />

      <Sidebar
        me={me}
        channels={channels}
        activeChannel={room.channelId}
        onCriarCanal={criarCanal}
        onRenomearCanal={renomearCanal}
        onRemoverCanal={removerCanal}
        peers={room.peers}
        presence={presence}
        users={users}
        status={status.efetivo}
        connecting={room.connecting}
        micOn={room.micOn}
        deafened={room.deafened}
        pttMode={room.settings?.voiceMode === 'ptt'}
        pttDown={room.pttDown}
        onJoin={(id) => void room.connect(id)}
        onLeave={() => void room.disconnect()}
        onToggleMic={room.toggleMic}
        onToggleDeafen={room.toggleDeafen}
        onVolumeChange={room.setPeerVolume}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenProfile={() => setProfileOpen(true)}
        onOpenUser={openUser}
        largura={larguraSidebar}
        onLarguraChange={salvarLargura}
      />

      <div className="main">
        <div className="topbar">
          <span className="topbar__title">{activeName ?? 'Nenhum canal'}</span>

          <Lives
            transmitindo={room.peers
              .filter((p) => p.isSharing && !p.isLocal)
              .map((p) => ({ identity: p.identity, name: p.name }))}
            assistindo={room.assistindo}
            onToggle={room.toggleAssistir}
          />

          {room.error && (
            <span style={{ color: 'var(--danger)', fontSize: 12.5 }}>{room.error}</span>
          )}
          <span className="topbar__spacer" />
          {room.channelId && <Ping ms={room.ping} />}
          {room.channelId && (
            <>
              <button
                className={`btn ${room.sharing ? 'btn--danger' : 'btn--ghost'}`}
                onClick={onShareClick}
                style={{ display: 'flex', alignItems: 'center', gap: 7 }}
              >
                <IconScreen size={15} />
                {room.sharing ? 'Parar de compartilhar' : 'Compartilhar tela'}
              </button>
            </>
          )}
        </div>

        {/* O palco, com as telas que você escolheu assistir. Fora da conversa
            de propósito: ele divide altura com o chat, então quando não há
            nenhuma live aberta ele nem renderiza e o chat fica com tudo. */}
        <Stage
          screens={room.screens}
          audios={room.audios}
          screenVolumes={room.screenVolumes}
          onScreenVolume={room.setScreenVolume}
          onParar={room.toggleAssistir}
        />

        {/* A sua própria tela flutua por cima da CONVERSA, e não do app
            inteiro: ancorada aqui, ela nunca cobre o palco de quem você está
            assistindo — que é justamente o que se veio ver. */}
        <div className="main__conversa">
          {room.localScreen && (
            <Preview
              track={room.localScreen}
              canto={telaCanto}
              largura={telaLargura}
              onCanto={salvarCanto}
              onLargura={salvarTelaLargura}
            />
          )}
          <Chat
            messages={messages}
            onSend={sendChat}
            onOpenUser={openUser}
            chatVolume={room.settings?.chatVolume ?? 100}
            meId={me.id}
            // Padrões defensivos: um servidor anterior a esta versão não manda
            // nenhum dos dois, e um reactionEmojis undefined quebraria o .map
            // da tirinha em vez de só não desenhar nada.
            isAdmin={me.isAdmin ?? false}
            reactionEmojis={me.reactionEmojis ?? []}
            // Da presença: todo mundo do servidor, não só quem está em call.
            // Dá pra mencionar quem está offline — ele lê quando voltar.
            gente={gente}
            nomeDe={nomeDe}
            onApurarPoll={aplicarPoll}
            onVotou={room.broadcastVote}
            onEditar={editarMensagem}
            onApagar={apagarMensagem}
            onReagir={reagir}
            onRemoverDeVez={removerDeVez}
            unreadAfterId={unreadAfterIdRef.current}
            onLerMensagens={marcarLido}
          />
        </div>
      </div>

      {picking && (
        <ScreenPicker
          onClose={() => setPicking(false)}
          onPick={(sourceId) => {
            setPicking(false);
            void room.startShare(sourceId);
          }}
        />
      )}

      {settingsOpen && room.settings && (
        <Settings
          settings={room.settings}
          onPatch={room.updateSettings}
          micLevel={room.micLevel}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {profileOpen && (
        <Profile
          me={me}
          theme={theme}
          onThemeChange={(t) => void room.updateSettings({ theme: t })}
          statusEscolhido={status.escolhido}
          onStatusChange={(s) => void status.escolher(s)}
          onSaved={onProfileSaved}
          onClose={() => setProfileOpen(false)}
        />
      )}

      {/* O seu perfil abre a aba de edição; o dos outros, o cartão de leitura. */}
      {cardIdentity && (
        <UserCard identity={cardIdentity} onClose={() => setCardIdentity(null)} />
      )}

    </div>
  );
}

/**
 * O seu ping até o servidor de voz.
 *
 * Cada pessoa vê o PRÓPRIO número: o valor sai da conexão desta máquina com
 * o SFU, e não existe jeito de medir daqui o caminho de outra pessoa. Se o
 * seu amigo quiser saber o dele, ele lê o dele na tela dele.
 *
 * É meio caminho, não o total entre vocês dois: a voz ainda sobe até o
 * servidor e desce do outro lado. Dois amigos com 30 ms cada estão a uns
 * 60 ms um do outro.
 *
 * As faixas são as da conversa por voz, não as de jogo: até 60 ms ninguém
 * percebe atraso na fala, até 120 dá pra conversar sem atropelo, e acima
 * disso as pessoas começam a se cortar.
 */
function Ping({ ms }: { ms: number | null }) {
  if (ms === null) return null;

  const cor = ms <= 60 ? 'var(--ok)' : ms <= 120 ? 'var(--live)' : 'var(--danger)';
  const nota = ms <= 60 ? 'ótimo' : ms <= 120 ? 'bom' : 'alto';

  return (
    <span className="ping" title={`Seu ping até o servidor de voz — ${nota}`}>
      <span className="ping__bolinha" style={{ background: cor }} />
      <span className="ping__valor">{ms}</span>
      <span className="ping__ms">ms</span>
    </span>
  );
}

/**
 * Quem está transmitindo, na barra de cima e não no palco.
 *
 * Mora aqui, ao lado do nome da sala, porque é informação sobre a SALA — e
 * porque no palco ela roubava uma linha inteira da grade, deixando as
 * transmissões com metade da altura que tinham direito.
 *
 * É também o caminho de volta: fechar uma live a tira do palco, e sem esta
 * lista não haveria de onde reabri-la.
 */
function Lives({
  transmitindo, assistindo, onToggle,
}: {
  transmitindo: { identity: string; name: string }[];
  assistindo: string[];
  onToggle: (identity: string) => void;
}) {
  if (transmitindo.length === 0) return null;
  const cheio = assistindo.length >= MAX_ASSISTINDO;

  return (
    <div className="lives">
      {transmitindo.map((t) => {
        const vendo = assistindo.includes(t.identity);
        return (
          <button
            key={t.identity}
            className={`lives__item${vendo ? ' lives__item--vendo' : ''}`}
            onClick={() => onToggle(t.identity)}
            title={
              vendo
                ? `Parar de assistir ${t.name}`
                : cheio
                  ? `Assistir ${t.name} — a live aberta há mais tempo fecha pra abrir vaga`
                  : `Assistir ${t.name}`
            }
          >
            {vendo ? <IconEye size={13} /> : <IconEyeOff size={13} />}
            <span className="lives__nome">{t.name}</span>
          </button>
        );
      })}
    </div>
  );
}
