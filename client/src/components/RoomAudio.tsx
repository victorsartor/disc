import { useEffect, useRef } from 'react';
import type { RemoteTrack } from 'livekit-client';
import type { AudioFeed } from '../lib/useRoom';

/**
 * Onde o som realmente sai.
 *
 * O livekit-client entrega a faixa de audio e para por ai - nao existe
 * reproducao automatica. Sem um <audio> anexado, a voz chega pela rede,
 * e decodificada, e morre ali: nenhum erro, nenhum aviso, so silencio.
 *
 * Um elemento por faixa, porque cada um tem seu proprio volume e sua
 * propria saida de audio. O attach() do RemoteAudioTrack reaplica os dois
 * no elemento novo, entao anexar depois de o volume ja ter sido escolhido
 * continua certo.
 *
 * Nao desenha nada: <audio> sem controls nao ocupa espaco.
 */
export function RoomAudio({ feeds }: { feeds: AudioFeed[] }) {
  return (
    <>
      {feeds.map((f) => (
        <AudioSink key={f.sid} track={f.track} />
      ))}
    </>
  );
}

function AudioSink({ track }: { track: RemoteTrack }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return <audio ref={ref} autoPlay />;
}
