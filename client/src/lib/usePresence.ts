import { useCallback, useEffect, useRef, useState } from 'react';
import type { Presence, StatusEfetivo, StatusEscolhido, UserPresence } from '../types';

/**
 * Quem está em cada canal, inclusive nos que você não entrou, e o status de
 * todo mundo do servidor — inclusive de quem não entrou em canal nenhum.
 *
 * Isto precisa vir do servidor: o LiveKit só conta os participantes de uma
 * sala para quem já está dentro dela. Por isso é polling e não evento — não
 * há conexão com um canal em que você não entrou para carregar um evento.
 *
 * `activeChannel` entra como dependência de propósito: entrar ou sair de um
 * canal refaz a busca na hora, em vez de esperar o próximo ciclo.
 */
export function usePresence(
  enabled: boolean,
  activeChannel: string | null,
): { channels: Presence; users: UserPresence[] } {
  const [presence, setPresence] = useState<Presence>({});
  const [users, setUsers] = useState<UserPresence[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const load = async () => {
      try {
        const { channels, users } = await window.disc.presence();
        if (!alive) return;
        setPresence(channels);
        setUsers(users ?? []);
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

  return { channels: presence, users };
}

/**
 * Intervalo do batimento.
 *
 * Bem menor que os 70s que o servidor espera antes de dar alguém como
 * offline: assim três batidas podem se perder seguidas sem que ninguém
 * desapareça da lista por causa de rede ruim.
 */
const BATIDA_MS = 20_000;

/**
 * O seu próprio status: o que você escolheu, e o que os outros veem.
 *
 * Os dois são coisas diferentes. Você escolhe "Disponível", mas fica dez
 * minutos mudo e os outros passam a ver "Ausente" — sem que a sua escolha
 * tenha mudado. Por isso quem decide o efetivo é o servidor, e a resposta do
 * batimento é que traz de volta.
 *
 * `ativo` é o microfone aberto, não a fala: quem está ouvindo de mic aberto
 * continua presente por mais calado que fique. Guardamos num ref em vez de
 * mandar na hora porque o que o servidor precisa saber é se o microfone
 * esteve aberto em ALGUM momento desde a última batida — mutar por dez
 * segundos no meio de uma conversa não pode zerar o relógio.
 */
export function useStatus(enabled: boolean, ativo: boolean) {
  const [escolhido, setEscolhido] = useState<StatusEscolhido>('disponivel');
  const [efetivo, setEfetivo] = useState<StatusEfetivo>('offline');
  const ativoRef = useRef(false);

  if (ativo) ativoRef.current = true;

  useEffect(() => {
    if (!enabled) {
      setEfetivo('offline');
      return;
    }
    let alive = true;

    const bater = async () => {
      const houve = ativoRef.current;
      ativoRef.current = false;
      try {
        const { status } = await window.disc.heartbeat(houve);
        if (alive) setEfetivo(status);
      } catch {
        /* a próxima batida cobre */
      }
    };

    // Abrir o app já conta como sinal de vida, e como fala: senão quem
    // acabou de entrar apareceria ausente até falar pela primeira vez.
    ativoRef.current = true;
    void bater();

    const id = setInterval(bater, BATIDA_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled]);

  const escolher = useCallback(async (status: StatusEscolhido) => {
    setEscolhido(status);
    try {
      await window.disc.setStatus(status);
      // Uma batida logo em seguida pra que o efetivo acompanhe na hora, em
      // vez de a sidebar ficar até 20s mostrando o estado antigo.
      const { status: novo } = await window.disc.heartbeat(false);
      setEfetivo(novo);
    } catch {
      /* fica na escolha local; a próxima batida reconcilia */
    }
  }, []);

  return { escolhido, efetivo, escolher };
}
