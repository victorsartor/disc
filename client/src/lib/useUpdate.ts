import { useEffect, useState } from 'react';
import type { UpdateState } from '../types';

export function useUpdate(): UpdateState {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });

  useEffect(() => {
    // Assina ANTES de perguntar. O main comeca a checar assim que a janela
    // e criada, entao um evento pode chegar enquanto a resposta esta a
    // caminho - e a resposta seria a antiga.
    const off = window.disc.update.onState(setState);
    void window.disc.update.state().then((s) => {
      setState((prev) => (prev.status === 'idle' ? s : prev));
    });
    return off;
  }, []);

  return state;
}

/**
 * Se a tela de atualizacao toma o app inteiro.
 *
 * 'checking' fica de fora de proposito: a checagem e rapida e quase sempre
 * nao acha nada. Piscar uma tela de carregamento a cada abertura, pra no fim
 * nao ter atualizacao nenhuma, seria pior do que nao mostrar nada.
 */
export function blocksApp(s: UpdateState): boolean {
  return (
    s.status === 'available' ||
    s.status === 'downloading' ||
    s.status === 'ready' ||
    s.status === 'error'
  );
}
