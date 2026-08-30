import { useEffect, useState } from 'react';
import type { Presence } from '../types';

/**
 * Quem está em cada canal, inclusive nos que você não entrou.
 *
 * Isto precisa vir do servidor: o LiveKit só conta os participantes de uma
 * sala para quem já está dentro dela. Por isso é polling e não evento — não
 * há conexão com um canal em que você não entrou para carregar um evento.
 *
 * `activeChannel` entra como dependência de propósito: entrar ou sair de um
 * canal refaz a busca na hora, em vez de esperar o próximo ciclo.
 */
export function usePresence(enabled: boolean, activeChannel: string | null): Presence {
  const [presence, setPresence] = useState<Presence>({});

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const load = async () => {
      try {
        const { channels } = await window.disc.presence();
        if (alive) setPresence(channels);
      } catch {
        /* offline momentâneo: a próxima volta pega */
      }
    };

    void load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled, activeChannel]);

  return presence;
}
