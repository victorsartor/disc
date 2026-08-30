import { useCallback, useEffect, useRef, useState } from 'react';
import type { Me, Message, UserProfile } from './types';
import { useRoom } from './lib/useRoom';
import { usePresence } from './lib/usePresence';
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
import { IconScreen, IconBroadcast } from './components/Icons';
import { DEFAULT_THEME, isThemeId, type ThemeId } from './lib/themes';

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

  const addMessage = useCallback((m: Message) => {
    if (seenRef.current.has(m.id)) return;
    seenRef.current.add(m.id);
    setMessages((prev) => [...prev, m].sort((a, b) => a.id - b.id));
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
  }, [theme, settingsCarregou]);

  const presence = usePresence(Boolean(loggedIn), room.channelId);

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

    const load = async () => {
      try {
        const { messages } = await window.disc.messages();
        if (!alive) return;
        for (const m of messages) addMessage(m);
      } catch {
        /* offline momentâneo: a próxima volta pega */
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

  const onShareClick = useCallback(() => {
    if (room.sharing) void room.stopShare();
    else setPicking(true);
  }, [room]);

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
          {room.error && (
            <span style={{ color: 'var(--danger)', fontSize: 12.5 }}>{room.error}</span>
          )}
          <span className="topbar__spacer" />
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
