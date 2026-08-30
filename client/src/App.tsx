import { useCallback, useEffect, useRef, useState } from 'react';
import type { Me, Message } from './types';
import { useRoom } from './lib/useRoom';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { Stage } from './components/Stage';
import { Chat } from './components/Chat';
import { ScreenPicker } from './components/ScreenPicker';
import { Settings } from './components/Settings';
import { ObsSetup } from './components/ObsSetup';
import { IconScreen, IconBroadcast } from './components/Icons';

export function App() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [picking, setPicking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [obsOpen, setObsOpen] = useState(false);

  // Guarda os ids já vistos para o data channel não duplicar o que o
  // polling também trouxe (e vice-versa).
  const seenRef = useRef<Set<number>>(new Set());

  const addMessage = useCallback((m: Message) => {
    if (seenRef.current.has(m.id)) return;
    seenRef.current.add(m.id);
    setMessages((prev) => [...prev, m].sort((a, b) => a.id - b.id));
  }, []);

  const room = useRoom(addMessage);

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
    const id = setInterval(load, 6000);
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

  if (loggedIn === null) return <div className="login" />;
  if (!loggedIn || !me) return <Login />;

  return (
    <div className="app">
      <Sidebar
        me={me}
        channels={me.channels}
        activeChannel={room.channelId}
        peers={room.peers}
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

        <Stage screens={room.screens} />
        <Chat messages={messages} onSend={sendChat} />
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
