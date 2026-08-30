import { useEffect, useRef } from 'react';
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
  if (screens.length === 0) return null;

  return (
    <div className="stage">
      {screens.map((s) => {
        // A barra só aparece quando existe som pra controlar. Um slider que
        // não mexe em nada é pior que slider nenhum.
        const temSom = audios.some((a) => a.kind === 'screen' && a.identity === s.identity);
        return (
          <div className="tile" key={s.identity}>
            <VideoTile track={s.track} />
            <div className="tile__label">
              <IconBroadcast size={13} />
              {s.name}
            </div>
            {temSom && (
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
    <div className={`tile__vol${mudo ? ' tile__vol--mudo' : ''}`}>
      <button
        className="tile__vol-btn"
        onClick={() => onChange(mudo ? 1 : 0)}
        title={mudo ? 'Voltar o som da tela' : 'Silenciar o som da tela'}
      >
        {mudo ? <IconHeadphonesOff size={14} /> : <IconHeadphones size={14} />}
      </button>
      <input
        type="range"
        className="tile__vol-slider"
        min={0}
        max={100}
        step={1}
        value={pct}
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
