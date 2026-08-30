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
import { Mic } from './mic';

export interface Peer {
  identity: string;
  name: string;
  avatarUrl: string | null;
  isSpeaking: boolean;
  isMuted: boolean;
  /** Sem ouvir ninguem. Nao vem da sala: e anunciado (ver announceState). */
  isDeafened: boolean;
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
 * Faixa de audio que chega de outra pessoa - microfone ou audio da tela.
 *
 * O livekit-client NAO toca audio sozinho: ele entrega a faixa e para por
 * ai. Quem nao anexa a um <audio> nunca ouve nada. Por isso as faixas viram
 * estado aqui e o RoomAudio as anexa, do mesmo jeito que o Stage faz com o
 * video da tela.
 */
export interface AudioFeed {
  /** sid da publicacao: unico por faixa, e uma pessoa pode ter duas. */
  sid: string;
  identity: string;
  /**
   * Duas trilhas separadas, de proposito.
   *
   * 'voice' e o microfone da pessoa; 'screen' e o som do que ela esta
   * compartilhando. Ensurdecer derruba so a primeira, e cada uma tem seu
   * proprio volume - senao abaixar a voz de alguem abaixaria junto o jogo
   * que ele esta transmitindo.
   */
  kind: 'voice' | 'screen';
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
  /** O microfone com portao de ruido. null = caiu no caminho antigo. */
  const micRef = useRef<Mic | null>(null);
  /** identity -> ensurdecido, do que cada um anunciou. */
  const remoteDeafRef = useRef(new Map<string, boolean>());

  const [settings, setSettings] = useState<Settings | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [screens, setScreens] = useState<ScreenFeed[]>([]);
  const [audios, setAudios] = useState<AudioFeed[]>([]);
  /** identity -> volume do som da tela daquela pessoa. */
  const [screenVolumes, setScreenVolumes] = useState<Record<string, number>>({});
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
      setScreenVolumes(s.screenVolumes ?? {});
      setMicWanted(s.voiceMode === 'vad');
    });
  }, []);

  /**
   * Troca o microfone publicado por um novo.
   *
   * Necessario quando muda o dispositivo ou qualquer filtro do Chromium
   * (supressao, eco, ganho automatico): essas opcoes entram no
   * getUserMedia e nao dao pra mudar numa faixa que ja existe.
   *
   * A nova e aberta ANTES de a antiga sair. Se a captura falhar - alguem
   * escolheu um microfone que foi desconectado - o que estava no ar
   * continua no ar.
   */
  const rebuildMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const cfg = settingsRef.current;
    const antiga = micRef.current;

    try {
      const mic = await Mic.abrir({
        deviceId: cfg?.micDeviceId ?? null,
        echoCancellation: cfg?.echoCancellation ?? true,
        noiseSuppression: cfg?.noiseSuppression ?? true,
        autoGainControl: cfg?.autoGainControl ?? true,
      });
      mic.corte = cfg?.micSensitivity ?? 0;
      mic.portaoLigado = cfg?.voiceMode !== 'ptt';

      const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (pub?.track) await room.localParticipant.unpublishTrack(pub.track, true);

      micRef.current = mic;
      await room.localParticipant.publishTrack(mic.track, {
        source: Track.Source.Microphone,
      });
      antiga?.fechar();
      // Nao chama syncPeers aqui: o LocalTrackPublished ja dispara.
    } catch (err) {
      console.warn('nao consegui trocar o microfone', err);
      setError('nao consegui abrir esse microfone');
    }
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = await window.disc.settings.patch(patch);
    settingsRef.current = next;
    setSettings(next);

    // Corte e modo de voz o portao aceita a quente, sem recapturar nada.
    const mic = micRef.current;
    if (mic) {
      if (patch.micSensitivity !== undefined) mic.corte = next.micSensitivity;
      if (patch.voiceMode !== undefined) mic.portaoLigado = next.voiceMode !== 'ptt';
    }

    const room = roomRef.current;
    if (room) {
      if (patch.speakerDeviceId) await room.switchActiveDevice('audiooutput', patch.speakerDeviceId);
      // Estes so existem no momento da captura: exigem microfone novo.
      const recaptura =
        patch.micDeviceId !== undefined ||
        patch.noiseSuppression !== undefined ||
        patch.echoCancellation !== undefined ||
        patch.autoGainControl !== undefined;
      if (recaptura) await rebuildMic();
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
    isDeafened: isLocal
      ? deafenedRef.current
      : (remoteDeafRef.current.get(p.identity) ?? false),
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

  /**
   * Anuncia o proprio estado de ensurdecido pro resto da sala.
   *
   * Ensurdecer e uma decisao 100% local: a gente so desliga as faixas que
   * chegam, ninguem para de mandar audio. Entao nada disso aparece na sala
   * sozinho - por isso o anuncio pelo data channel.
   *
   * Cada um anuncia o seu ao mudar de estado, ao entrar, e de novo toda vez
   * que alguem entra (que e como quem chega depois descobre quem ja estava
   * ensurdecido). Se um anuncio se perder, o unico prejuizo e um icone
   * desatualizado - o audio de ninguem depende disso.
   */
  const announceState = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    room.localParticipant
      .publishData(
        encoder.encode(JSON.stringify({ kind: 'state', deafened: deafenedRef.current })),
        { reliable: true },
      )
      .catch(() => {
        /* sem sala ou sem permissao: o proximo anuncio corrige */
      });
  }, []);

  const disconnect = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) await room.disconnect();
    // Solta o microfone de verdade: sem isto a luzinha do mic fica acesa
    // depois de sair do canal.
    micRef.current?.fechar();
    micRef.current = null;
    remoteDeafRef.current.clear();
    setChannelId(null);
    setPeers([]);
    setScreens([]);
    setAudios([]);
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
            // Volumes salvos daquela pessoa voltam a valer assim que ela entra.
            // Sao dois, um por trilha: a voz dela e o som da tela dela.
            const vol = settingsRef.current?.volumes[p.identity];
            if (vol !== undefined && vol !== 1) {
              p.setVolume(vol, Track.Source.Microphone);
            }
            const svol = settingsRef.current?.screenVolumes[p.identity];
            if (svol !== undefined && svol !== 1) {
              p.setVolume(svol, Track.Source.ScreenShareAudio);
            }
            // Quem entra durante o ensurdecido tambem precisa vir mudo,
            // senao a proxima pessoa a chegar fura o silencio. So o microfone:
            // o som da tela nao e afetado por ensurdecer.
            if (deafenedRef.current) {
              p.audioTrackPublications.forEach((pub) => {
                if (pub.source === Track.Source.Microphone) pub.setEnabled(false);
              });
            }
            playJoin();
            // Quem chegou nao tem como saber que voce esta ensurdecido:
            // isso nao viaja pela sala. Reanuncia pra ele.
            announceState();
            syncPeers();
          })
          .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
            remoteDeafRef.current.delete(p.identity);
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
            micRef.current?.fechar();
            micRef.current = null;
            remoteDeafRef.current.clear();
            setChannelId(null);
            setPeers([]);
            setScreens([]);
            setAudios([]);
            setSharing(false);
          })
          .on(RoomEvent.DataReceived, (payload: Uint8Array, from?: RemoteParticipant) => {
            try {
              const msg = JSON.parse(decoder.decode(payload));
              if (msg?.kind === 'chat' && msg.message) {
                chatCbRef.current(msg.message);
              } else if (msg?.kind === 'state' && from) {
                remoteDeafRef.current.set(from.identity, Boolean(msg.deafened));
                syncPeers();
              }
            } catch {
              /* payload de outra versao do app: ignora */
            }
          })
          .on(
            RoomEvent.TrackSubscribed,
            (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
              // Cobre quem ja estava na sala quando voce entrou ensurdecido,
              // e quem liga o mic depois. O ParticipantConnected sozinho nao
              // pega esses dois casos. So microfone: som de tela passa.
              if (deafenedRef.current && pub.source === Track.Source.Microphone) {
                pub.setEnabled(false);
              }

              // Microfone E audio de tela caem aqui: os dois sao kind 'audio'
              // e os dois precisam ser anexados pra sair som. O kind separa
              // quem responde a ensurdecer e a qual controle de volume.
              if (track.kind === 'audio') {
                const kind =
                  pub.source === Track.Source.ScreenShareAudio ? 'screen' : 'voice';
                setAudios((prev) => [
                  ...prev.filter((a) => a.sid !== pub.trackSid),
                  { sid: pub.trackSid, identity: participant.identity, kind, track },
                ]);
              }

              if (track.source === Track.Source.ScreenShare) {
                setScreens((prev) => [
                  ...prev.filter((s) => s.identity !== participant.identity),
                  { identity: participant.identity, name: participant.name || participant.identity, track },
                ]);
              }
              syncPeers();
            },
          )
          .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
            if (track.kind === 'audio') {
              setAudios((prev) => prev.filter((a) => a.sid !== pub.trackSid));
            }
            if (track.source === Track.Source.ScreenShare) {
              setScreens((prev) => prev.filter((s) => s.track !== track));
            }
            syncPeers();
          })
          // O Chromium pode recusar o autoplay do audio. Aqui sempre existe um
          // clique antes (entrar no canal), entao o normal e nunca disparar -
          // mas se disparar, sem isto a sala fica muda em silencio.
          .on(RoomEvent.AudioPlaybackStatusChanged, () => {
            if (!room.canPlaybackAudio) {
              void room.startAudio().catch(() => {
                setError('o navegador bloqueou o audio - clique em qualquer lugar');
              });
            }
          });

        await room.connect(url, token);

        // Entrar no canal e um clique, entao o gesto do usuario ainda vale
        // aqui - que e a condicao pro Chromium liberar o autoplay do audio.
        await room.startAudio().catch(() => {
          /* o AudioPlaybackStatusChanged cobre se ainda assim bloquear */
        });

        // Publica a faixa JA filtrada pelo portao de ruido (lib/mic.ts) no
        // lugar da crua do getUserMedia. Como ela vai com source Microphone,
        // todo o resto continua funcionando igual - o setMicrophoneEnabled
        // reaproveita a publicacao que ja existe em vez de criar outra.
        try {
          const cfg = settingsRef.current;
          const mic = await Mic.abrir({
            deviceId: cfg?.micDeviceId ?? null,
            echoCancellation: cfg?.echoCancellation ?? true,
            noiseSuppression: cfg?.noiseSuppression ?? true,
            autoGainControl: cfg?.autoGainControl ?? true,
          });
          mic.corte = cfg?.micSensitivity ?? 0;
          mic.portaoLigado = cfg?.voiceMode !== 'ptt';
          micRef.current = mic;
          await room.localParticipant.publishTrack(mic.track, {
            source: Track.Source.Microphone,
          });
        } catch (err) {
          // Ficar sem voz seria pior que ficar sem portao: cai no caminho
          // antigo, que e o que rodava antes desta funcionalidade existir.
          console.warn('portao de ruido indisponivel, publicando o mic cru', err);
          micRef.current = null;
          await room.localParticipant.setMicrophoneEnabled(true);
        }

        // Em PTT o microfone comeca fechado e so abre com a tecla presa.
        const startMuted = settingsRef.current?.voiceMode === 'ptt';
        await room.localParticipant.setMicrophoneEnabled(!startMuted);

        roomRef.current = room;
        setChannelId(target);
        setMicWanted(true);
        setPttDown(false);
        playConnect();
        // Quem ja estava na sala so fica sabendo do seu estado por aqui.
        announceState();
        syncPeers();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'falha ao conectar');
        await disconnect();
      } finally {
        setConnecting(false);
      }
    },
    [channelId, disconnect, syncPeers, announceState],
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
    // SO o microfone. Antes isto derrubava todas as faixas de audio da pessoa,
    // e o som da tela dela ia junto: ensurdecer pra nao ouvir o amigo calava
    // tambem o jogo que ele estava transmitindo.
    room.remoteParticipants.forEach((p) =>
      p.audioTrackPublications.forEach((pub) => {
        if (pub.source === Track.Source.Microphone) pub.setEnabled(!next);
      }),
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
    announceState();
    syncPeers();
  }, [deafened, micWanted, syncPeers, announceState]);

  /**
   * Volume da VOZ de uma pessoa (0 a 2), persistido entre sessoes.
   *
   * O source explicito nao e decoracao: o setVolume do LiveKit tem
   * Microphone como padrao, e deixar implicito escondia que existe uma
   * segunda trilha logo abaixo mexendo na mesma pessoa.
   */
  const setPeerVolume = useCallback((identity: string, volume: number) => {
    roomRef.current
      ?.remoteParticipants.get(identity)
      ?.setVolume(volume, Track.Source.Microphone);
    void window.disc.settings.setVolume(identity, volume);
    if (settingsRef.current) {
      settingsRef.current.volumes = { ...settingsRef.current.volumes, [identity]: volume };
    }
    setPeers((prev) => prev.map((p) => (p.identity === identity ? { ...p, volume } : p)));
  }, []);

  /** Volume do SOM DA TELA de uma pessoa (0 a 1), independente da voz dela. */
  const setScreenVolume = useCallback((identity: string, volume: number) => {
    roomRef.current
      ?.remoteParticipants.get(identity)
      ?.setVolume(volume, Track.Source.ScreenShareAudio);
    void window.disc.settings.setScreenVolume(identity, volume);
    if (settingsRef.current) {
      settingsRef.current.screenVolumes = {
        ...settingsRef.current.screenVolumes,
        [identity]: volume,
      };
    }
    setScreenVolumes((prev) => ({ ...prev, [identity]: volume }));
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

  /**
   * Nivel do microfone, 0 a 100, pro medidor das configuracoes.
   *
   * E funcao, e nao estado, de proposito: isto muda 20 vezes por segundo, e
   * como estado obrigaria o app inteiro a re-renderizar nesse ritmo. Quem
   * quiser o medidor faz seu proprio intervalo enquanto a tela esta aberta.
   */
  const micLevel = useCallback(() => micRef.current?.nivel ?? null, []);

  return {
    settings, channelId, connecting, peers, screens, audios, screenVolumes,
    micOn: micLive, micWanted, pttDown, deafened, sharing, error, micLevel,
    connect, disconnect, toggleMic, toggleDeafen, setPeerVolume, setScreenVolume,
    startShare, stopShare, broadcastChat, updateSettings,
  };
}
