import { useEffect, useState } from 'react';
import type { ScreenSource } from '../types';

interface Props {
  onPick: (sourceId: string) => void;
  onClose: () => void;
}

export function ScreenPicker({ onPick, onClose }: Props) {
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  // 'buscando' e um estado de verdade, separado de "achou zero". Antes os
  // dois mostravam o mesmo texto, entao lista vazia e erro na chamada ficavam
  // indistinguiveis de "ainda carregando" — e a tela travava em silencio.
  const [fase, setFase] = useState<'buscando' | 'pronto' | 'erro'>('buscando');
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    window.disc
      .screenSources()
      .then((lista) => {
        if (!vivo) return;
        setSources(lista);
        setFase('pronto');
      })
      .catch((err: unknown) => {
        if (!vivo) return;
        setErro((err as Error)?.message ?? 'falha desconhecida');
        setFase('erro');
      });
    return () => {
      vivo = false;
    };
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
          {fase === 'buscando' ? (
            <div className="empty">Procurando janelas...</div>
          ) : fase === 'erro' ? (
            <div className="empty">
              Não consegui listar as telas.
              <br />
              <span style={{ fontSize: 12, opacity: 0.8 }}>{erro}</span>
            </div>
          ) : sources.length === 0 ? (
            <div className="empty">
              O sistema não devolveu nenhuma tela nem janela.
              <br />
              <span style={{ fontSize: 12, opacity: 0.8 }}>
                No Linux isso costuma ser o portal de tela recusando o pedido.
              </span>
            </div>
          ) : (
            sources.map((s) => (
              <button
                key={s.id}
                className={`source${picked === s.id ? ' source--picked' : ''}`}
                onClick={() => setPicked(s.id)}
                onDoubleClick={() => onPick(s.id)}
              >
                {s.thumbnail
                  ? <img src={s.thumbnail} alt="" />
                  : <div className="source__sem-preview">{s.isScreen ? 'Tela' : 'Janela'}</div>}
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
