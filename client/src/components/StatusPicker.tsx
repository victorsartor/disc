import { useEffect, useRef, useState } from 'react';
import type { StatusEscolhido } from '../types';
import { ESCOLHAS, STATUS } from '../lib/status';

/**
 * O seletor de status: uma bolinha que abre as três opções.
 *
 * Mostra a ESCOLHA, não o efetivo: se você escolheu "Disponível" e o
 * relógio te deixou ausente, o certo é o seletor continuar marcando
 * Disponível — senão parece que alguém mexeu na sua opção. Quem mostra o
 * efetivo é a linha do seu nome, no rodapé da coluna.
 *
 * `direcao` existe porque o mesmo menu já morou em dois cantos da tela: no
 * rodapé ele só cabe abrindo pra cima, e embaixo da foto do perfil, que
 * fica no topo da janela, só cabe abrindo pra baixo.
 */
export function StatusPicker({
  escolhido, onChange, direcao = 'cima', grande = false,
}: {
  escolhido: StatusEscolhido;
  onChange: (s: StatusEscolhido) => void;
  direcao?: 'cima' | 'baixo';
  grande?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      className={`statuspick${grande ? ' statuspick--grande' : ''}`}
      ref={ref}
      // O Escape com o menu aberto fecha o MENU, e para aí. Sem este
      // stopPropagation ele atravessaria até a janela de perfil atrás do
      // seletor e fecharia as duas coisas de uma tecla só.
      onKeyDown={(e) => {
        if (!open || e.key !== 'Escape') return;
        e.stopPropagation();
        setOpen(false);
      }}
    >
      <button
        className="statuspick__btn"
        onClick={() => setOpen((v) => !v)}
        title="Mudar seu status"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="bolinha" style={{ background: STATUS[escolhido].cor }} />
      </button>

      {open && (
        <div className={`statuspick__menu statuspick__menu--${direcao}`} role="menu">
          {ESCOLHAS.map(({ id, dica }) => (
            <button
              key={id}
              role="menuitemradio"
              aria-checked={escolhido === id}
              className={`statuspick__item${escolhido === id ? ' statuspick__item--ativo' : ''}`}
              onClick={() => {
                onChange(id);
                setOpen(false);
              }}
            >
              <span className="bolinha" style={{ background: STATUS[id].cor }} />
              <span className="statuspick__texto">
                <span className="statuspick__nome">{STATUS[id].label}</span>
                <span className="statuspick__dica">{dica}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
