import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './overlay.css';

interface OverlayPeer {
  identity: string;
  name: string;
  avatarUrl: string | null;
  isSpeaking: boolean;
  isMuted: boolean;
  isSharing: boolean;
}

interface OverlayState {
  channelName: string | null;
  peers: OverlayPeer[];
  micOn: boolean;
  pttActive: boolean;
}

declare global {
  interface Window {
    overlay: {
      onState(cb: (s: OverlayState) => void): () => void;
      setInteractive(v: boolean): void;
    };
  }
}

function Overlay() {
  const [state, setState] = useState<OverlayState | null>(null);

  useEffect(() => window.overlay.onState(setState), []);

  if (!state?.channelName) return null;

  return (
    <div className="ov">
      {/* A alça é a única região clicável: o main libera o click-through
          enquanto o mouse está sobre ela, para o overlay poder ser arrastado. */}
      <div
        className="ov__grip"
        onMouseEnter={() => window.overlay.setInteractive(true)}
        onMouseLeave={() => window.overlay.setInteractive(false)}
      >
        <span className={`ov__dot${state.micOn ? ' ov__dot--live' : ''}`} />
        <span className="ov__channel">{state.channelName}</span>
      </div>

      <div className="ov__list">
        {state.peers.map((p) => (
          <div
            key={p.identity}
            className={`ov__peer${p.isSpeaking ? ' ov__peer--speaking' : ''}${
              p.isMuted ? ' ov__peer--muted' : ''
            }`}
          >
            <img className="ov__avatar" src={p.avatarUrl ?? undefined} alt="" referrerPolicy="no-referrer" />
            <span className="ov__name">{p.name}</span>
            {p.isSharing && <span className="ov__live">●</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById('overlay-root')!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>,
);
