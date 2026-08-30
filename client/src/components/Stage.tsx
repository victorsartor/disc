import { useEffect, useRef, useState } from 'react';
import type { RemoteTrack } from 'livekit-client';
import type { AudioFeed, ScreenFeed } from '../lib/useRoom';
import { IconBroadcast, IconHeadphones, IconHeadphonesOff } from './Icons';

interface Props {
  screens: ScreenFeed[];
  /** Usado só para saber quem está mandando som junto com a tela. */
  audios: AudioFeed[];
  screenVolumes: Record<string, number>;
  onScreenVolume: (identity: string, volume: number) => void;
}

export function Stage({ screens, audios, screenVolumes, onScreenVolume }: Props) {
  // Identity de quem está com a barra de volume aberta. Uma por vez.
  const [aberto, setAberto] = useState<string | null>(null);

  if (screens.length === 0) return null;

  return (
    <div className="stage">
      {screens.map((s) => {
        const temSom = audios.some((a) => a.kind === 'screen' && a.identity === s.identity);
        const mostrando = temSom && aberto === s.identity;

        return (
          <div
            className="tile"
            key={s.identity}
            onClick={() => temSom && setAberto((a) => (a === s.identity ? null : s.identity))}
            title={temSom ? 'Clique para o volume' : undefined}
            style={temSom ? undefined : { cursor: 'default' }}
          >
            <VideoTile track={s.track} />

            <div className="tile__label">
              <IconBroadcast size={13} />
              {s.name}
            </div>

            {mostrando && (
              <ScreenVolume
                value={screenVolumes[s.identity] ?? 1}
                onChange={(v) => onScreenVolume(s.identity, v)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Volume do som da tela, separado da voz de quem compartilha.
 *
 * Vai de 0 a 100%: aqui a intenção é abaixar o jogo pra ouvir a pessoa,
 * nunca amplificar. O da voz vai até 200% porque lá o problema oposto é
 * comum — microfone baixo demais.
 */
function ScreenVolume({
  value, onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const pct = Math.round(value * 100);
  const mudo = pct === 0;

  return (
    // O clique aqui não pode subir pro quadro, senão mexer no slider
    // fecharia a própria barra que se está usando.
    <div className="tile__volbar" onClick={(e) => e.stopPropagation()}>
      <button
        className="tile__vol-btn"
        onClick={() => onChange(mudo ? 1 : 0)}
        title={mudo ? 'Voltar o som da tela' : 'Silenciar o som da tela'}
      >
        {mudo ? <IconHeadphonesOff size={15} /> : <IconHeadphones size={15} />}
      </button>
      <input
        type="range"
        className="tile__vol-slider"
        min={0}
        max={100}
        step={1}
        value={pct}
        autoFocus
        aria-label="Volume do som da tela"
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <span className="tile__vol-value">{pct}%</span>
    </div>
  );
}

function VideoTile({ track }: { track: RemoteTrack }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return <video ref={ref} autoPlay playsInline />;
}
