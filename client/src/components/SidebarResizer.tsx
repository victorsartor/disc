import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Limites da largura da barra lateral.
 *
 * São os mesmos de electron/settings.ts, de propósito repetidos: aquele é o
 * portão que protege o settings.json (patch vindo por IPC é entrada não
 * confiável), este é o que segura o arrasto na tela. Se um dia divergirem,
 * quem manda é o de lá — daqui sai pedido, não verdade.
 */
const MIN = 180;
const MAX = 480;

/** O de fábrica, que o duplo clique devolve. Igual ao DEFAULTS do main. */
const PADRAO = 240;

/**
 * Quanto de janela o resto do app precisa manter, em pixels.
 *
 * Sem isto, numa janela estreita o MAX de 480 sozinho deixaria o chat com
 * uma faixa de nada. O teto real é o menor entre os dois.
 */
const RESTO_MINIMO = 360;

interface Props {
  /** Largura salva, já validada pelo processo main. */
  largura: number;
  /** Chamado UMA vez, ao soltar — não a cada quadro do arrasto. */
  onSalvar: (largura: number) => void;
}

/**
 * A alça que puxa a borda direita da barra lateral.
 *
 * O arrasto NÃO passa por estado do React: cada movimento escreve direto na
 * variável CSS do <html>, que é de onde o grid do .app lê. Re-renderizar a
 * árvore inteira a 60 fps só pra mover uma coluna arrastaria a lista de
 * mensagens junto, e o arrasto engasgaria justamente em quem tem chat cheio.
 *
 * Quem pinta a largura VINDA DO DISCO é o App, num efeito à parte. A divisão
 * é o que evita o salto ao soltar: entre o pointerup e a resposta do IPC a
 * prop `largura` ainda carrega o valor antigo, e um efeito que repintasse a
 * partir dela devolveria a coluna ao tamanho de antes por alguns quadros.
 */
export function SidebarResizer({ largura, onSalvar }: Props) {
  const [arrastando, setArrastando] = useState(false);
  // Onde a largura parou. O pointerup não recebe a posição do mouse do mesmo
  // jeito, e o teclado precisa saber de onde partir.
  const atualRef = useRef(largura);

  // Só acompanha o disco quando o mouse não está no botão: durante o arrasto
  // o valor sob o dedo é mais novo que o que veio do settings.json.
  useEffect(() => {
    if (!arrastando) atualRef.current = largura;
  }, [largura, arrastando]);

  const mover = useCallback((clientX: number) => {
    // A barra começa em 0, então a largura é a própria posição do mouse. Se
    // um dia ela deixar de ser a primeira coluna, isto vira um getBoundingRect.
    const teto = Math.min(MAX, window.innerWidth - RESTO_MINIMO);
    // O Math.max por fora garante que numa janela minúscula o teto não fique
    // ABAIXO do piso e inverta a conta.
    const px = Math.round(Math.min(Math.max(clientX, MIN), Math.max(MIN, teto)));
    atualRef.current = px;
    document.documentElement.style.setProperty('--sidebar-w', `${px}px`);
  }, []);

  useEffect(() => {
    if (!arrastando) return;

    const onMove = (e: PointerEvent) => mover(e.clientX);
    const onUp = () => {
      setArrastando(false);
      onSalvar(atualRef.current);
    };

    // No window, não no elemento: o mouse sai da faixa de 7px no primeiro
    // movimento rápido, e um listener preso à alça perderia o resto do gesto.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // O cursor e o "não selecionar" valem pra tela inteira enquanto dura.
    document.body.classList.add('app--redimensionando');

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('app--redimensionando');
    };
  }, [arrastando, mover, onSalvar]);

  return (
    <div
      className={`sidebar__resizer${arrastando ? ' sidebar__resizer--ativa' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Largura da barra lateral"
      aria-valuenow={largura}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      tabIndex={0}
      title="Arraste para mudar a largura — clique duas vezes para o padrão"
      onPointerDown={(e) => {
        // Só o botão esquerdo: o direito abriria o menu de contexto no meio
        // do arrasto, e o do meio cola no Linux.
        if (e.button !== 0) return;
        e.preventDefault();
        setArrastando(true);
      }}
      // Volta ao padrão. É a saída de quem se enrolou e quer o tamanho de
      // fábrica sem ter que acertar 240 no olho.
      onDoubleClick={() => {
        mover(PADRAO);
        onSalvar(PADRAO);
      }}
      // Teclado move de 16 em 16: com passo de 1px seriam 60 toques pra
      // atravessar a faixa inteira.
      onKeyDown={(e) => {
        const passo = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
        if (!passo) return;
        e.preventDefault();
        mover(atualRef.current + passo);
        onSalvar(atualRef.current);
      }}
    />
  );
}
