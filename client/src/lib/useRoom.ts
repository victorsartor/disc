import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type Participant,
} from 'livekit-client';
import type { Message, Settings } from '../types';
import { playJoin, playLeave, playConnect } from './sounds';

export interface Peer {
  identity: string;
  name: string;
  avatarUrl: string | null;
  isSpeaking: boolean;
  isMuted: boolean;
  isSharing: boolean;
  isLocal: boolean;
  volume: number;
}

export interface ScreenFeed {
  identity: string;
  name: string;
  track: RemoteTrack;
}

/**
 * Qualidade de tela. Estes tres ajustes sao o que separa
 * "tela boa" de "tela do Discord":
 *   - VP9 rende muito mais que VP8 no mesmo bitrate para conteudo de tela
 *   - maintain-framerate: ao apertar a banda, derruba resolucao e nao FPS
 *   - simulcast off: manda uma camada so, na qualidade cheia
 */
// 20 Mbps e TETO, nao piso: o controle de congestionamento do WebRTC baixa
// sozinho quando a rede de alguem nao aguenta. Subir o teto so libera quem
// tem banda - nao prejudica quem nao tem.
const SCREEN_PRESET = {
  maxBitrate: 20_000_000,
  maxFramerate: 60,
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readAvatar(p: Participant): string | null {
  try {
    return p.metadata ? (JSON.parse(p.metadata).avatarUrl ?? null) : null;
  } catch {
    return null;
  }
}

export function useRoom(onChatMessage: (m: Message) => void) {
  const roomRef = useRef<Room | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  const chatCbRef = useRef(onChatMessage);
  chatCbRef.current = onChatMessage;
  // Refs porque os handlers de evento da sala capturam o valor do momento
  // em que a sala foi criada e ficariam com estado velho.
  const deafenedRef = useRef(false);
  const micBeforeDeafenRef = useRef(true);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [screens, setScreens] = useState<ScreenFeed[]>([]);
  const [micWanted, setMicWanted] = useState(true);
  const [pttDown, setPttDown] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Configuracoes -----------------------------------------------------
  useEffect(() => {
    void window.disc.settings.get().then((s) => {
      settingsRef.current = s;
      setSettings(s);
      setMicWanted(s.voiceMode === 'vad');
    });
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = await window.disc.settings.patch(patch);
    settingsRef.current = next;
    setSettings(next);

    const room = roomRef.current;
    if (room) {
      if (patch.micDeviceId) await room.switchActiveDevice('audioinput', patch.micDeviceId);
      if (patch.speakerDeviceId) await room.switchActiveDevice('audiooutput', patch.speakerDeviceId);
    }
    // Ao voltar pro modo VAD, o mic deve reabrir sozinho.
    if (patch.voiceMode === 'vad') {
      setMicWanted(true);
      setPttDown(false);
    } else if (patch.voiceMode === 'ptt') {
      setMicWanted(true);
    }
    return next;
  }, []);

  const toPeer = useCallback((p: Participant, isLocal: boolean): Peer => ({
    identity: p.identity,
    name: p.name || p.identity,
    avatarUrl: readAvatar(p),
    isSpeaking: p.isSpeaking,
    isMuted: !p.isMicrophoneEnabled,
    isSharing: p.isScreenShareEnabled,
    isLocal,
    volume: settingsRef.current?.volumes[p.identity] ?? 1,
  }), []);

  const syncPeers = useCallback(() => {
    const room = roomRef.current;
    if (!room) return setPeers([]);
    setPeers([
      toPeer(room.localParticipant, true),
      ...Array.from(room.remoteParticipants.values()).map((p) => toPeer(p, false)),
    ]);
  }, [toPeer]);

  const disconnect = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) await room.disconnect();
    setChannelId(null);
    setPeers([]);
    setScreens([]);
    setSharing(false);
  }, []);

  const connect = useCallback(
    async (target: string) => {
      if (channelId === target) return disconnect();

      setConnecting(true);
      setError(null);
      try {
        if (roomRef.current) await disconnect();

        const { token, url } = await window.disc.roomToken(target);
        const s = settingsRef.current;

        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          publishDefaults: {
            videoCodec: 'vp9',
            screenShareEncoding: SCREEN_PRESET,
            simulcast: false,
            degradationPreference: 'maintain-framerate',
          },
          audioCaptureDefaults: {
            deviceId: s?.micDeviceId ?? undefined,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          audioOutput: s?.speakerDeviceId ? { deviceId: s.speakerDeviceId } : undefined,
        });

        room
          .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
            // Volume salvo daquela pessoa volta a valer assim que ela entra
            const vol = settingsRef.current?.volumes[p.identity];
            if (vol !== undefined && vol !== 1) p.setVolume(vol);
            // Quem entra durante o ensurdecido tambem precisa vir mudo,
            // senao a proxima pessoa a chegar fura o silencio.
            if (deafenedRef.current) {
              p.audioTrackPublications.forEach((pub) => pub.setEnabled(false));
            }
            playJoin();
            syncPeers();
          })
          .on(RoomEvent.ParticipantDisconnected, () => {
            playLeave();
            syncPeers();
          })
          .on(RoomEvent.ActiveSpeakersChanged, syncPeers)
          .on(RoomEvent.TrackMuted, syncPeers)
          .on(RoomEvent.TrackUnmuted, syncPeers)
          .on(RoomEvent.LocalTrackPublished, syncPeers)
          .on(RoomEvent.LocalTrackUnpublished, syncPeers)
          .on(RoomEvent.Disconnected, () => {
            roomRef.current = null;
            setChannelId(null);
            setPeers([]);
            setScreens([]);
            setSharing(false);
          })
          .on(RoomEvent.DataReceived, (payload: Uint8Array) => {
            try {
              const msg = JSON.parse(decoder.decode(payload));
              if (msg?.kind === 'chat' && msg.message) chatCbRef.current(msg.message);
            } catch {
              /* payload de outra versao do app: ignora */
            }
          })
          .on(
            RoomEvent.TrackSubscribed,
            (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
              // Cobre quem ja estava na sala quando voce entrou ensurdecido,
              // e quem liga o mic depois. O ParticipantConnected sozinho nao
              // pega esses dois casos.
              if (deafenedRef.current && track.kind === 'audio') pub.setEnabled(false);

              if (track.source === Track.Source.ScreenShare) {
                setScreens((prev) => [
                  ...prev.filter((s) => s.identity !== participant.identity),
                  { identity: participant.identity, name: participant.name || participant.identity, track },
                ]);
              }
              syncPeers();
            },
          )
          .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
            if (track.source === Track.Source.ScreenShare) {
              setScreens((prev) => prev.filter((s) => s.track !== track));
            }
            syncPeers();
          });

        await room.connect(url, token);

        // Em PTT o microfone comeca fechado e so abre com a tecla presa.
        const startMuted = settingsRef.current?.voiceMode === 'ptt';
        await room.localParticipant.setMicrophoneEnabled(!startMuted);

        roomRef.current = room;
        setChannelId(target);
        setMicWanted(true);
        setPttDown(false);
        playConnect();
        syncPeers();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'falha ao conectar');
        await disconnect();
      } finally {
        setConnecting(false);
      }
    },
    [channelId, disconnect, syncPeers],
  );

  // --- Microfone ---------------------------------------------------------
  // Em PTT o mic so abre com a tecla presa. Em VAD segue o toggle manual.
  const micLive = settings?.voiceMode === 'ptt' ? micWanted && pttDown : micWanted;

  useEffect(() => {
    const room = roomRef.current;
    if (!room || !channelId) return;
    void room.localParticipant.setMicrophoneEnabled(micLive).then(syncPeers);
  }, [micLive, channelId, syncPeers]);

  const toggleMic = useCallback(() => setMicWanted((v) => !v), []);

  const toggleDeafen = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const next = !deafened;
    room.remoteParticipants.forEach((p) =>
      p.audioTrackPublications.forEach((pub) => pub.setEnabled(!next)),
    );
    // Ensurdecer implica calar: caso classico de nao querer falar sozinho.
    // Ao desensurdecer, o microfone volta como estava antes.
    if (next) {
      micBeforeDeafenRef.current = micWanted;
      setMicWanted(false);
    } else {
      setMicWanted(micBeforeDeafenRef.current);
    }
    deafenedRef.current = next;
    setDeafened(next);
    syncPeers();
  }, [deafened, micWanted, syncPeers]);

  /** Volume individual por pessoa (0 a 2), persistido entre sessoes. */
  const setPeerVolume = useCallback((identity: string, volume: number) => {
    roomRef.current?.remoteParticipants.get(identity)?.setVolume(volume);
    void window.disc.settings.setVolume(identity, volume);
    if (settingsRef.current) {
      settingsRef.current.volumes = { ...settingsRef.current.volumes, [identity]: volume };
    }
    setPeers((prev) => prev.map((p) => (p.identity === identity ? { ...p, volume } : p)));
  }, []);

  // --- Compartilhamento de tela ------------------------------------------
  const stopShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    for (const pub of room.localParticipant.videoTrackPublications.values()) {
      if (pub.source === Track.Source.ScreenShare && pub.track) {
        await room.localParticipant.unpublishTrack(pub.track, true);
      }
    }
    for (const pub of room.localParticipant.audioTrackPublications.values()) {
      if (pub.source === Track.Source.ScreenShareAudio && pub.track) {
        await room.localParticipant.unpublishTrack(pub.track, true);
      }
    }
    setSharing(false);
    syncPeers();
  }, [syncPeers]);

  const startShare = useCallback(async (sourceId: string) => {
    const room = roomRef.current;
    if (!room) return;

    // Constraints do Electron. O audio de sistema so funciona no Windows;
    // no Linux ele falha, entao tentamos sem audio como fallback.
    const video = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 2560,
        maxHeight: 1440,
        maxFrameRate: 60,
      },
    } as unknown as MediaTrackConstraints;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints,
        video,
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    }

    const [videoTrack] = stream.getVideoTracks();
    // 'motion' prioriza framerate (jogo). Use 'detail' para codigo/planilha.
    videoTrack.contentHint = 'motion';

    await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.ScreenShare,
      videoEncoding: SCREEN_PRESET,
      videoCodec: 'vp9',
      simulcast: false,
      degradationPreference: 'maintain-framerate',
    });

    const [audioTrack] = stream.getAudioTracks();
    if (audioTrack) {
      await room.localParticipant.publishTrack(audioTrack, {
        source: Track.Source.ScreenShareAudio,
      });
    }

    // Cobre o "parar de compartilhar" nativo do SO
    videoTrack.addEventListener('ended', () => void stopShare());
    setSharing(true);
    syncPeers();
  }, [syncPeers, stopShare]);

  // --- Chat --------------------------------------------------------------
  /**
   * Persiste no backend e retransmite pelo data channel.
   *
   * O data channel e so o caminho rapido: ele alcanca apenas quem esta na
   * MESMA sala de voz. Quem esta na outra sala ou fora de call recebe pelo
   * polling do backend. Por isso os dois caminhos convivem.
   */
  const broadcastChat = useCallback(async (message: Message) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.publishData(
        encoder.encode(JSON.stringify({ kind: 'chat', message })),
        { reliable: true },
      );
    } catch {
      /* sem sala ou sem permissao: o polling cobre */
    }
  }, []);

  // --- Push-to-talk ------------------------------------------------------
  useEffect(() => window.disc.onPushToTalk(setPttDown), []);

  // Desconecta limpo ao fechar o app
  useEffect(() => () => void roomRef.current?.disconnect(), []);

  return {
    settings, channelId, connecting, peers, screens,
    micOn: micLive, micWanted, pttDown, deafened, sharing, error,
    connect, disconnect, toggleMic, toggleDeafen, setPeerVolume,
    startShare, stopShare, broadcastChat, updateSettings,
  };
}
