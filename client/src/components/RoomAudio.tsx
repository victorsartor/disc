import { useEffect, useRef } from 'react';
import type { RemoteAudioTrack } from 'livekit-client';
import type { AudioFeed } from '../lib/useRoom';

/**
 * Onde o som realmente sai.
 *
 * O livekit-client entrega a faixa de audio e para por ai - nao existe
 * reproducao automatica. Sem um <audio> anexado, a voz chega pela rede,
 * e decodificada, e morre ali: nenhum erro, nenhum aviso, so silencio.
 *
 * Um elemento por faixa, porque cada um tem seu proprio volume e sua
 * propria saida de audio.
 *
 * Nao desenha nada: <audio> sem controls nao ocupa espaco.
 */
export function RoomAudio({ feeds }: { feeds: AudioFeed[] }) {
  return (
    <>
      {feeds.map((f) => (
        <AudioSink key={f.sid} track={f.track} volume={f.volume} />
      ))}
    </>
  );
}

function AudioSink({ track, volume }: { track: RemoteAudioTrack; volume: number }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  /**
   * Reaplica o volume DEPOIS de anexar. Nao e redundancia: e o conserto do
   * "abaixei pra zero e o som voltou inteiro quando a live reabriu".
   *
   * Com webAudioMix ligado, o attach() do livekit monta um GainNode novo pra
   * cada faixa que chega, e ele nasce em 1. Quem devia baixar de volta pro
   * valor escolhido sao dois `if (this.elementVolume)` la dentro - e ZERO e
   * falsy. Entao justamente o volume 0, o unico que a pessoa mexeu de
   * proposito pra nao ouvir nada, era o unico que o livekit pulava: a
   * barrinha marcava 0, o ganho ficava em 1, e o som saia inteiro toda vez
   * que a pessoa parava e recomecava de compartilhar (faixa nova, elemento
   * novo, GainNode novo).
   *
   * Este efeito roda depois do de cima - na mesma ordem em que estao
   * escritos - entao o elemento ja esta anexado e o ganho vai pro lugar
   * certo, inclusive quando o valor e 0.
   *
   * Depender de `volume` tambem cobre o ajuste ao vivo: mexer na barrinha
   * chega aqui mesmo que a pessoa nao esteja mais na lista de participantes
   * que o setPeerVolume consulta.
   */
  useEffect(() => {
    track.setVolume(volume);
  }, [track, volume]);

  return <audio ref={ref} autoPlay />;
}
