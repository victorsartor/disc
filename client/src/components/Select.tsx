import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Select proprio, no lugar do <select> nativo.
 *
 * O popup do <select> do Chromium e desenhado pelo SO, fora do alcance do
 * CSS da pagina: num tema escuro ele sai com texto quase invisivel e a linha
 * selecionada em azul de sistema. Como a lista de dispositivos de audio e
 * justamente onde a pessoa precisa LER pra escolher, vale o componente
 * proprio - aqui a lista e HTML normal e obedece o tema.
 *
 * A lista vai num portal, posicionada em coordenadas de tela. Dentro do
 * fluxo ela seria cortada pela borda do modal, que tem overflow escondido.
 * O portal fica na arvore React do componente, entao o clique numa opcao
 * continua subindo ate o modal - que e quem impede o clique de fechar tudo.
 */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Texto pequeno a direita, tipo "indisponivel". */
  hint?: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Nome do campo para leitores de tela. */
  label: string;
}

const LIST_MAX_HEIGHT = 230;
const GAP = 6;

interface Placement {
  left: number;
  width: number;
  /** Uma das duas: ancorada pelo topo ou pela base. */
  top?: number;
  bottom?: number;
}

export function Select({ value, options, onChange, label }: Props) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value);

  const close = useCallback(() => {
    setOpen(false);
    setPlace(null);
  }, []);

  // Antes de pintar, pra lista nao aparecer no lugar errado por um quadro:
  // abre pra baixo se couber, senao pra cima.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const below = window.innerHeight - rect.bottom - GAP;
    const above = rect.top - GAP;
    const base = { left: rect.left, width: rect.width };

    setPlace(
      below >= LIST_MAX_HEIGHT || below >= above
        ? { ...base, top: rect.bottom + GAP }
        : { ...base, bottom: window.innerHeight - rect.top + GAP },
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close();
    };
    // Fase de captura: fecha a lista sem deixar o Esc chegar no modal e
    // fechar tudo de uma vez.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
      triggerRef.current?.focus();
    };
    // A lista esta em coordenadas de tela: se a pagina rola ou a janela muda
    // de tamanho, ela descola do campo. Fechar e mais honesto que recalcular.
    const onMove = () => close();

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, close]);

  return (
    <div className={`select${open ? ' select--open' : ''}`}>
      <button
        type="button"
        ref={triggerRef}
        className="select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="select__value">{current?.label ?? '—'}</span>
        <svg className="select__chevron" viewBox="0 0 24 24" width="13" height="13"
             fill="none" stroke="currentColor" strokeWidth="2.5"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && place && createPortal(
        <div
          ref={listRef}
          className="select__list"
          role="listbox"
          aria-label={label}
          style={{
            left: place.left,
            width: place.width,
            top: place.top,
            bottom: place.bottom,
          }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              disabled={o.disabled}
              className={`select__option${o.value === value ? ' select__option--on' : ''}`}
              onClick={() => {
                onChange(o.value);
                close();
              }}
            >
              <span className="select__option-label">{o.label}</span>
              {o.hint && <span className="select__option-hint">{o.hint}</span>}
              {o.value === value && (
                <svg className="select__check" viewBox="0 0 24 24" width="14" height="14"
                     fill="none" stroke="currentColor" strokeWidth="3"
                     strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
