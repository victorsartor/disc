import { useEffect, useState } from 'react';
import type { ScreenSource } from '../types';

interface Props {
  onPick: (sourceId: string) => void;
  onClose: () => void;
}

export function ScreenPicker({ onPick, onClose }: Props) {
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    void window.disc.screenSources().then(setSources);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__box" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">O que você quer compartilhar?</div>

        <div className="modal__grid">
          {sources.length === 0 ? (
            <div className="empty">Procurando janelas...</div>
          ) : (
            sources.map((s) => (
              <button
                key={s.id}
                className={`source${picked === s.id ? ' source--picked' : ''}`}
                onClick={() => setPicked(s.id)}
                onDoubleClick={() => onPick(s.id)}
              >
                <img src={s.thumbnail} alt="" />
                <div className="source__name">{s.name}</div>
              </button>
            ))
          )}
        </div>

        <div className="modal__foot">
          <span style={{ flex: 1, fontSize: 11.5, color: 'var(--lavender)', alignSelf: 'center' }}>
            Jogo precisa estar em modo janela sem borda, senão sai tela preta.
          </span>
          <button className="btn btn--ghost" onClick={onClose}>Cancelar</button>
          <button
            className="btn btn--accent"
            disabled={!picked}
            onClick={() => picked && onPick(picked)}
          >
            Compartilhar
          </button>
        </div>
      </div>
    </div>
  );
}
