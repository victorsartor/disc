import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  // Classe, nao tipo: o instanceof la embaixo precisa dela em tempo de
  // execucao pra separar audio de video sem cast.
  RemoteAudioTrack,
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
  track: RemoteAudioTrack;
  /**
   * Volume escolhido pra esta faixa (0 a 2), ja vindo do settings.json.
   *
   * Viaja junto com a faixa porque quem anexa o <audio> e quem precisa
   * reaplicar o ganho, e ele so descobre o valor certo por aqui. Ver o
   * segundo efeito do AudioSink, em components/RoomAudio.tsx.
   */
  volume: number;
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

/**
 * Quantas transmissoes da pra assistir ao mesmo tempo.
 *
 * O limite e de banda, nao de tela: cada uma pode chegar a 20 Mbps, e a
 * terceira e a que estoura a internet de quem esta assistindo - inclusive
 * derrubando a voz junto, que e o que menos pode cair.
 */
export const MAX_ASSISTINDO = 2;

/**
 * Som do sistema no Linux, por um monitor do PipeWire.
 *
 * O Chromium so captura som de sistema no Windows: no Linux nao existe
 * loopback nenhum atras do getDisplayMedia. O que existe e o "monitor" que o
 * PipeWire publica de cada saida de audio - ele aparece na lista de
 * ENTRADAS, como se fosse um microfone, e gravar dele e gravar o que esta
 * saindo pela caixa.
 *
 * Os tres tratamentos saem desligados de proposito. Eles existem pra voz
 * humana: supressao de ruido come trilha de jogo, cancelamento de eco
 * subtrai o que ja esta tocando (que aqui e justamente o sinal que
 * queremos), e ganho automatico faz a musica respirar junto com os tiros.
 */
async function somDoSistema(deviceId: string | null): Promise<MediaStreamTrack | null> {
  if (!deviceId) return null;
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    return s.getAudioTracks()[0] ?? null;
  } catch (err) {
    // Monitor que sumiu (fone desconectado, saida trocada). Melhor
    // compartilhar sem som do que nao compartilhar.
    console.warn('nao consegui abrir o som do sistema', err);
    return null;
  }
}

/**
 * Devolve os volumes escolhidos pra uma pessoa.
 *
 * O setVolume do LiveKit guarda o valor num mapa mesmo quando a faixa ainda
 * nao existe, e o aplica sozinho na hora em que ela chega. E por isso que dá
 * pra chamar isto no momento em que a pessoa entra, muito antes de ela
 * comecar a compartilhar tela.
 *
 * Volume 1 nao entra no mapa de proposito: e o padrao, e deixar o mapa vazio
 * e o mesmo resultado com menos estado.
 */
function aplicarVolumesSalvos(p: RemoteParticipant, cfg: Settings | null): void {
  const vol = cfg?.volumes[p.identity];
  if (vol !== undefined && vol !== 1) p.setVolume(vol, Track.Source.Microphone);

  const svol = cfg?.screenVolumes[p.identity];
  if (svol !== undefined && svol !== 1) {
    p.setVolume(svol, Track.Source.ScreenShareAudio);
  }
}

/**
 * Volume salvo pra uma pessoa, no mapa da trilha certa.
 *
 * 1 e o padrao de quem nunca foi mexido - e tambem o que sai pra quem mexeu
 * e voltou pro cheio, ja que aplicarVolumesSalvos nao guarda o 1.
 */
function volumeSalvo(
  cfg: Settings | null,
  identity: string,
  kind: 'voice' | 'screen',
): number {
  const mapa = kind === 'screen' ? cfg?.screenVolumes : cfg?.volumes;
  return mapa?.[identity] ?? 1;
}

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
  /** A sua propria tela, so pra você conferir o que esta mandando. */
  const [localScreen, setLocalScreen] = useState<MediaStreamTrack | null>(null);
  /**
   * Quais transmissoes voce escolheu assistir, no maximo MAX_ASSISTINDO.
   *
   * Nao e so enfeite de tela: quem nao esta nesta lista tem a assinatura
   * cortada no SFU, entao os quadros nem descem pela rede. Assistir tres
   * telas em 20 Mbps cada e o que derruba a call de quem tem internet
   * comum.
   */
  const [assistindo, setAssistindo] = useState<string[]>([]);
  const assistindoRef = useRef<string[]>([]);
  assistindoRef.current = assistindo;
  const [error, setError] = useState<string | null>(null);
  /** Ida e volta ate o SFU, em ms. null = sem call ou ICE ainda assentando. */
  const [ping, setPing] = useState<number | null>(null);

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
          // Sem isto o setVolume do LiveKit escreve em element.volume, que a
          // especificacao trava em 0..1 - passar de 1 lanca IndexSizeError e
          // o volume nem se move. Ligando a mixagem por Web Audio o ganho
          // passa por um GainNode, que amplifica acima de 100% de verdade.
          // E o que sustenta os 200% da voz e do som da tela.
          webAudioMix: true,
        });

        room
          .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
            aplicarVolumesSalvos(p, settingsRef.current);
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
              if (track instanceof RemoteAudioTrack) {
                const kind =
                  pub.source === Track.Source.ScreenShareAudio ? 'screen' : 'voice';
                setAudios((prev) => [
                  ...prev.filter((a) => a.sid !== pub.trackSid),
                  {
                    sid: pub.trackSid,
                    identity: participant.identity,
                    kind,
                    track,
                    volume: volumeSalvo(settingsRef.current, participant.identity, kind),
                  },
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

        // Volumes salvos de quem JA ESTAVA na sala.
        //
        // O ParticipantConnected so dispara pra quem chega depois de voce, e
        // esses aqui ja estavam. Sem este laco, o LiveKit nunca ouvia falar
        // do volume escolhido pra eles: a barrinha marcava 0 e o som saia
        // inteiro na hora em que a pessoa comecava a compartilhar.
        room.remoteParticipants.forEach((p) => aplicarVolumesSalvos(p, settingsRef.current));

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

        // Entra sempre fechado, e o efeito de microfone logo abaixo abre se
        // for o caso. Ele conhece as tres coisas que decidem isso (mudo,
        // ensurdecido, tecla do PTT) e roda assim que o canal muda; abrir
        // aqui seria um palpite que poderia deixar o microfone no ar por um
        // instante contra a vontade de quem entrou mudo.
        await room.localParticipant.setMicrophoneEnabled(false);

        roomRef.current = room;
        setChannelId(target);
        // O mudo NAO se desfaz ao trocar de canal: quem saiu calado entra
        // calado. Só fechar o app zera, porque o estado só vive em memória.
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
  //
  // Ensurdecido corta antes de tudo, e nao so quando se aperta o botao:
  // falar com quem nao se ouve nao e uma combinacao que faz sentido, e como
  // invariante ela nao pode depender da ORDEM em que os botoes foram
  // clicados nem sobreviver a uma troca de canal.
  const micLive = deafened
    ? false
    : settings?.voiceMode === 'ptt'
      ? micWanted && pttDown
      : micWanted;

  useEffect(() => {
    const room = roomRef.current;
    if (!room || !channelId) return;
    void room.localParticipant.setMicrophoneEnabled(micLive).then(syncPeers);
  }, [micLive, channelId, syncPeers]);

  /**
   * Botao do microfone.
   *
   * Abrir o microfone estando ensurdecido desfaz o ensurdecer junto. O botao
   * precisa fazer o que promete: sem isso ele ficaria aceso sem que ninguem
   * te ouvisse, porque a invariante acima manda calar.
   */
  const toggleMic = useCallback(() => {
    if (deafenedRef.current) {
      deafenedRef.current = false;
      setDeafened(false);
      roomRef.current?.remoteParticipants.forEach((p) =>
        p.audioTrackPublications.forEach((pub) => {
          if (pub.source === Track.Source.Microphone) pub.setEnabled(true);
        }),
      );
      setMicWanted(true);
      announceState();
      return;
    }
    setMicWanted((v) => !v);
  }, [announceState]);

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
    // Nao mexe no micWanted: quem cala e o micLive, que ja trata ensurdecido
    // como microfone fechado. Assim o botao do microfone guarda sozinho o que
    // a pessoa queria antes, e desensurdecer devolve exatamente aquilo — sem
    // um segundo lugar guardando a mesma coisa e podendo discordar.
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
    // A faixa tambem: e dela que o <audio> tira o ganho ao reanexar.
    setAudios((prev) =>
      prev.map((a) => (a.identity === identity && a.kind === 'voice' ? { ...a, volume } : a)),
    );
  }, []);

  /** Volume do SOM DA TELA de uma pessoa (0 a 2), independente da voz dela. */
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
    setAudios((prev) =>
      prev.map((a) => (a.identity === identity && a.kind === 'screen' ? { ...a, volume } : a)),
    );
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
    setLocalScreen(null);
    syncPeers();
  }, [syncPeers]);

  /**
   * Abre a captura de tela.
   *
   * `sourceId` null = deixa o sistema escolher. E o caminho do Wayland: la o
   * id de uma fonte so vale enquanto a sessao do portal que o criou estiver
   * viva, e ela nao sobrevive ao ida-e-volta pelo nosso modal - o PipeWire
   * responde "target not found" na hora de abrir. Com getDisplayMedia quem
   * lista e quem entrega e a mesma requisicao (ver initDisplayMedia no main),
   * entao a sessao continua de pe.
   */
  const abrirCaptura = async (sourceId: string | null): Promise<MediaStream> => {
    if (sourceId === null) {
      // O audio NAO vem daqui. O Chromium so faz captura de som de sistema no
      // Windows; no Linux, pedir audio aqui derruba o video junto. O som vem
      // separado, de um monitor do PipeWire (ver somDoSistema).
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 60 },
        audio: false,
      });

      const som = await somDoSistema(settingsRef.current?.screenAudioDeviceId ?? null);
      if (som) stream.addTrack(som);
      return stream;
    }

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

    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints,
        video,
      });
    } catch {
      return navigator.mediaDevices.getUserMedia({ audio: false, video });
    }
  };

  const startShare = useCallback(async (sourceId: string | null) => {
    const room = roomRef.current;
    if (!room) return;

    let stream: MediaStream;
    try {
      stream = await abrirCaptura(sourceId);
    } catch (err) {
      // Fechar o seletor do sistema no X e desistir, nao falhar: no Wayland
      // esse dialogo e o caminho normal, entao cancelar nao pode acender
      // mensagem de erro. Qualquer outra coisa a pessoa precisa ver.
      const nome = (err as Error)?.name;
      if (nome === 'NotAllowedError' || nome === 'AbortError') return;
      console.error('captura de tela falhou', err);
      setError('nao consegui compartilhar a tela');
      return;
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
    videoTrack.addEventListener("ended", () => void stopShare());
    // A mesma faixa que esta indo pro ar alimenta o seu preview: assim o
    // que voce confere e literalmente o que os outros recebem, e nao uma
    // segunda captura que poderia divergir.
    setLocalScreen(videoTrack);
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

  // --- Quais telas assistir ----------------------------------------------
  /**
   * Liga e desliga a assinatura de cada tela conforme a escolha.
   *
   * Roda tanto ao mexer na escolha quanto quando alguem comeca ou para de
   * compartilhar: os dois mudam quem deveria estar assinado. O audio da tela
   * acompanha o video de proposito - quem nao esta vendo o jogo tambem nao
   * quer ouvi-lo.
   */
  const sincronizarAssinaturas = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    room.remoteParticipants.forEach((p) => {
      const quer = assistindoRef.current.includes(p.identity);
      for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
        const pub = p.getTrackPublication(source);
        if (pub && pub.isSubscribed !== quer) pub.setSubscribed(quer);
      }
    });
  }, []);

  useEffect(() => {
    sincronizarAssinaturas();
  }, [assistindo, peers, sincronizarAssinaturas]);

  /**
   * Entra ou sai de uma transmissao.
   *
   * Cheio, a mais antiga sai pra abrir vaga. Recusar o clique seria mais
   * simples, mas obrigaria a fechar uma antes de abrir outra - e quem clica
   * numa live quer ver aquela live.
   */
  const toggleAssistir = useCallback((identity: string) => {
    setAssistindo((atual) => {
      if (atual.includes(identity)) return atual.filter((i) => i !== identity);
      return [...atual, identity].slice(-MAX_ASSISTINDO);
    });
  }, []);

  /**
   * Quem ja passou por aqui uma vez, tendo sido aberto sozinho ou nao.
   *
   * E o que separa "transmissao nova" de "transmissao que voce fechou".
   * Sem esta memoria, o efeito abaixo reabria no ciclo seguinte tudo que
   * tivesse vaga - fechar no olho durava um piscar e voltava sozinho.
   */
  const jaVistas = useRef(new Set<string>());

  // Transmissao NOVA entra sozinha enquanto houver vaga: exigir um clique pra
  // ver a unica live da sala seria cerimonia à toa. Uma que voce fechou fica
  // fechada ate voce mandar abrir.
  useEffect(() => {
    const noAr = peers.filter((p) => p.isSharing && !p.isLocal).map((p) => p.identity);

    // Quem parou de transmitir e esquecido: se voltar ao ar depois, e uma
    // transmissao nova de novo, e merece abrir sozinha.
    for (const id of [...jaVistas.current]) {
      if (!noAr.includes(id)) jaVistas.current.delete(id);
    }

    const novas = noAr.filter((i) => !jaVistas.current.has(i));
    novas.forEach((i) => jaVistas.current.add(i));

    setAssistindo((atual) => {
      const vivos = atual.filter((i) => noAr.includes(i));
      const vagas = MAX_ASSISTINDO - vivos.length;
      const entram = vagas > 0 ? novas.filter((i) => !vivos.includes(i)).slice(0, vagas) : [];
      // Devolver o mesmo array quando nada muda evita um ciclo de renderizacao
      // a cada sincronia de participantes.
      if (entram.length === 0 && vivos.length === atual.length) return atual;
      return [...vivos, ...entram];
    });
  }, [peers]);

  // --- Ping --------------------------------------------------------------
  /**
   * Mede o tempo de ida e volta ate o servidor de voz, a cada 2 segundos.
   *
   * Cada pessoa so consegue medir o PROPRIO caminho: o RTT sai do par de
   * candidatos ICE da conexao desta maquina com o SFU. Nao existe medida do
   * caminho de outra pessoa daqui — o que o outro ve, so ele mede.
   *
   * O que aparece na tela e metade do caminho de voz, nao o total: o audio
   * ainda passa pelo servidor e desce pro outro lado. Dois amigos com 30ms
   * cada estao a uns 60ms um do outro.
   */
  useEffect(() => {
    if (!channelId) {
      setPing(null);
      return;
    }
    let vivo = true;

    const medir = async () => {
      const pcm = roomRef.current?.engine?.pcManager;
      // O publisher so existe depois de publicar algo; o subscriber, depois
      // de receber. Sozinho na sala, um dos dois pode nao ter subido ainda.
      for (const t of [pcm?.publisher, pcm?.subscriber]) {
        let report: RTCStatsReport | undefined;
        try {
          report = await t?.getStats();
        } catch {
          continue;
        }
        if (!report) continue;

        let rtt: number | null = null;
        report.forEach((s) => {
          const st = s as RTCStats & {
            nominated?: boolean;
            state?: string;
            currentRoundTripTime?: number;
          };
          if (
            st.type === 'candidate-pair' &&
            st.state === 'succeeded' &&
            st.nominated &&
            typeof st.currentRoundTripTime === 'number'
          ) {
            rtt = st.currentRoundTripTime;
          }
        });

        if (rtt !== null && vivo) {
          setPing(Math.round(rtt * 1000));
          return;
        }
      }
      // Nenhum par nominado ainda: melhor manter o ultimo valor do que
      // piscar um trace vazio a cada volta enquanto o ICE nao assenta.
    };

    void medir();
    const id = setInterval(() => void medir(), 2000);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, [channelId]);

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
    micOn: micLive, micWanted, pttDown, deafened, sharing, error, micLevel, ping,
    localScreen, assistindo, toggleAssistir,
    connect, disconnect, toggleMic, toggleDeafen, setPeerVolume, setScreenVolume,
    startShare, stopShare, broadcastChat, updateSettings,
  };
}
