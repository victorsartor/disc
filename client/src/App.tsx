import { useCallback, useEffect, useRef, useState } from 'react';
import type { Me, Message, UserProfile } from './types';
import { MAX_ASSISTINDO, useRoom } from './lib/useRoom';
import { usePresence, useStatus } from './lib/usePresence';
import { useUpdate, blocksApp } from './lib/useUpdate';
import { Login } from './components/Login';
import { Updater } from './components/Updater';
import { Sidebar } from './components/Sidebar';
import { Stage } from './components/Stage';
import { RoomAudio } from './components/RoomAudio';
import { Chat } from './components/Chat';
import { ScreenPicker } from './components/ScreenPicker';
import { Settings } from './components/Settings';
import { ObsSetup } from './components/ObsSetup';
import { Profile, UserCard } from './components/Profile';
import { IconScreen, IconBroadcast, IconEye, IconEyeOff } from './components/Icons';
import { DEFAULT_THEME, isThemeId, type ThemeId } from './lib/themes';
import { playNotify } from './lib/sounds';

export function App() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [picking, setPicking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [obsOpen, setObsOpen] = useState(false);
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
  // true só depois que a primeira leva de mensagens (o histórico) já
  // passou. Sem isto, entrar num canal com conversa parada tocaria uma
  // notificação pra cada mensagem antiga.
  const historicoCarregadoRef = useRef(false);

  const addMessage = useCallback((m: Message) => {
    if (seenRef.current.has(m.id)) return;
    seenRef.current.add(m.id);
    setMessages((prev) => [...prev, m].sort((a, b) => a.id - b.id));
    if (historicoCarregadoRef.current && m.user_id !== meRef.current?.id) playNotify();
  }, []);

  const room = useRoom(addMessage);

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
    const cores = getComputedStyle(document.documentElement);
    const fundo = cores.getPropertyValue('--level-2').trim();
    const simbolo = cores.getPropertyValue('--alabaster').trim();
    if (fundo && simbolo) void window.disc.titlebar(fundo, simbolo);
  }, [theme, settingsCarregou]);

  const { channels: presence, users } = usePresence(Boolean(loggedIn), room.channelId);

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
   * perfil. O sufixo do ingress do OBS não é gente: aponta pra mesma pessoa.
   */
  const openUser = useCallback((identity: string) => {
    const id = identity.endsWith('_obs') ? identity.slice(0, -4) : identity;
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
    window.disc.me().then(setMe).catch(() => setLoggedIn(false));
  }, [loggedIn]);

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
  }, [loggedIn, addMessage]);

  const sendChat = useCallback(async (body: string) => {
    const { message } = await window.disc.sendMessage(body);
    addMessage(message);
    await room.broadcastChat(message);
  }, [addMessage, room]);

  // Espelha o estado da sala no overlay
  const activeName = me?.channels.find((c) => c.id === room.channelId)?.name ?? null;
  useEffect(() => {
    window.disc.overlay.push({
      channelName: room.channelId ? activeName : null,
      peers: room.peers.map((p) => ({
        identity: p.identity,
        name: p.name,
        avatarUrl: p.avatarUrl,
        isSpeaking: p.isSpeaking,
        isMuted: p.isMuted,
        isSharing: p.isSharing,
      })),
      micOn: room.micOn,
      pttActive: room.pttDown,
    });
  }, [room.channelId, activeName, room.peers, room.micOn, room.pttDown]);

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
        channels={me.channels}
        activeChannel={room.channelId}
        peers={room.peers}
        presence={presence}
        users={users}
        status={status.efetivo}
        statusEscolhido={status.escolhido}
        onStatusChange={(s) => void status.escolher(s)}
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
                className="btn btn--ghost"
                onClick={() => setObsOpen(true)}
                title="Transmitir em alta qualidade pelo OBS"
                style={{ display: 'flex', alignItems: 'center', gap: 7 }}
              >
                <IconBroadcast size={15} />
                OBS
              </button>
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

        <Stage
          screens={room.screens}
          audios={room.audios}
          screenVolumes={room.screenVolumes}
          onScreenVolume={room.setScreenVolume}
          onParar={room.toggleAssistir}
          localScreen={room.localScreen}
        />
        <Chat messages={messages} onSend={sendChat} onOpenUser={openUser} />
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
          onSaved={onProfileSaved}
          onClose={() => setProfileOpen(false)}
        />
      )}

      {/* O seu perfil abre a aba de edição; o dos outros, o cartão de leitura. */}
      {cardIdentity && (
        <UserCard identity={cardIdentity} onClose={() => setCardIdentity(null)} />
      )}

      {obsOpen && room.channelId && (
        <ObsSetup
          channelId={room.channelId}
          channelName={activeName ?? room.channelId}
          onClose={() => setObsOpen(false)}
        />
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
