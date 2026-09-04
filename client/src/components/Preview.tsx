import { useCallback, useEffect, useRef, useState } from 'react';
import { CANTOS, type TelaCanto } from '../types';

interface Props {
  /** Sua própria tela. Só entra em cena quando você está compartilhando. */
  track: MediaStreamTrack;
  /** Canto salvo, já validado pelo processo main. */
  canto: TelaCanto;
  /** Largura salva, já validada pelo processo main. */
  largura: number;
  /** Chamado UMA vez, ao soltar — não a cada quadro do gesto. */
  onCanto: (canto: TelaCanto) => void;
  onLargura: (px: number) => void;
}

/**
 * Limites da largura da janelinha.
 *
 * São os mesmos de electron/settings.ts, de propósito repetidos, pelo mesmo
 * motivo do SidebarResizer: aquele é o portão que protege o settings.json
 * (patch vindo por IPC é entrada não confiável), este é o que segura o
 * arrasto na tela. Se um dia divergirem, quem manda é o de lá.
 */
const MIN = 240;
const MAX = 720;

/** O de fábrica, que o duplo clique na alça devolve. Igual ao DEFAULTS. */
const PADRAO = 360;

/**
 * Quanto o ponteiro precisa andar pra virar arrasto, em pixels.
 *
 * Sem esta folga, a mão que treme num clique sairia arrastando a janelinha
 * junto, e ela trocaria de canto sem ninguém ter pedido.
 */
const FOLGA = 4;

/**
 * Um número entre dois limites, aguentando limites invertidos.
 *
 * O `Math.min` por fora é o que salva quando a janelinha é MAIOR que a área:
 * ali o mínimo passa o máximo, e um clamp ingênuo devolveria o piso — ela
 * saltaria pra um canto no primeiro pixel de arrasto.
 */
function preso(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, Math.min(min, max)), Math.max(min, max));
}

/**
 * O seu próprio compartilhamento, numa janelinha flutuante.
 *
 * Só o SEU. Quem você assiste voltou pro palco na 0.40: janelinha é bom pra
 * conferir, e ruim pra ver — o teto do tamanho dela é a largura do app, e
 * quem estava assistindo chegou nesse máximo sem conseguir ler o que passava
 * na tela do outro. Conferir a própria transmissão é o problema oposto:
 * precisa caber num canto e não roubar a conversa, que é o que a janelinha
 * faz bem.
 *
 * Ela flutua por cima do chat, arrasta com a mão e gruda no canto mais perto
 * dos quatro. Canto e largura vão pro settings.json (telaCanto/telaLargura),
 * que sobrevive à atualização do app.
 */
export function Preview({ track, canto, largura, onCanto, onLargura }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const caixaRef = useRef<HTMLDivElement>(null);

  const [arrastando, setArrastando] = useState(false);
  const [medindo, setMedindo] = useState(false);
  /**
   * O gesto em curso.
   *
   * `rect` é a caixa da janelinha ANTES do transform, medida no pointerdown:
   * é contra ela que o arrasto é limitado à área, e remedir a cada movimento
   * daria a caixa já deslocada — o limite andaria junto com o dedo e ela
   * escaparia pela borda assim mesmo.
   */
  const gesto = useRef<{
    x: number;
    y: number;
    moveu: boolean;
    rect: DOMRect | null;
    /** Qual das duas alças foi pega. Só no redimensionamento. */
    lado: 'esq' | 'dir';
  } | null>(null);
  /** Onde a largura parou. O pointerup não traz a posição do mouse. */
  const larguraRef = useRef(largura);

  useEffect(() => {
    if (!medindo) larguraRef.current = largura;
  }, [largura, medindo]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = new MediaStream([track]);
    return () => {
      el.srcObject = null;
    };
  }, [track]);

  // ── Arrastar ───────────────────────────────────────────────────────────
  // Como no SidebarResizer, o gesto NÃO passa por estado do React: cada
  // movimento escreve direto no transform. Re-renderizar a árvore a 60fps
  // arrastaria o <video> junto, e o vídeo é o que não pode piscar.
  useEffect(() => {
    if (!arrastando) return;
    const caixa = caixaRef.current;
    const area = caixa?.parentElement;
    if (!caixa || !area) return;

    const onMove = (e: PointerEvent) => {
      const g = gesto.current;
      if (!g?.rect) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      // Antes da folga não mexe em nada: um tremor no clique não pode
      // parecer o começo de um arrasto.
      if (!g.moveu && Math.hypot(dx, dy) < FOLGA) return;
      g.moveu = true;

      // Presa na área. Sem isto a janelinha sai por cima do resto do sistema
      // operacional durante o gesto — a janela do app não recorta o que está
      // com transform, e o que a pessoa vê é o vídeo passeando por fora do
      // programa.
      const r = g.rect;
      const a = area.getBoundingClientRect();
      caixa.style.transform =
        `translate(${preso(dx, a.left - r.left, a.right - r.right)}px, ` +
        `${preso(dy, a.top - r.top, a.bottom - r.bottom)}px)`;
    };

    const onUp = () => {
      setArrastando(false);
      const g = gesto.current;
      gesto.current = null;
      if (!g?.moveu) {
        caixa.style.transform = '';
        return;
      }

      // Medir ANTES de limpar o transform: depois de limpo a janelinha já
      // voltou pro canto antigo e a conta daria sempre ele.
      const r = caixa.getBoundingClientRect();
      const a = area.getBoundingClientRect();

      // A conta é sobre o espaço LIVRE, não sobre a área inteira: 0 é
      // encostada num lado, 1 no outro, seja qual for o tamanho dela.
      //
      // Com o centro dela contra a largura total — que era como estava — uma
      // janelinha grande numa janela estreita mal saía do meio, e o canto
      // mais perto dava sempre o mesmo: ela grudava de um lado só e não havia
      // arrasto que a levasse pro outro.
      const folgaX = a.width - r.width;
      const folgaY = a.height - r.height;
      const fx = folgaX > 1 ? preso((r.left - a.left) / folgaX, 0, 1) : 0.5;
      const fy = folgaY > 1 ? preso((r.top - a.top) / folgaY, 0, 1) : 0.5;

      let melhor = canto;
      let perto = Infinity;
      for (const [nome, p] of Object.entries(CANTOS)) {
        const d = (fx - p.x) ** 2 + (fy - p.y) ** 2;
        if (d < perto) {
          perto = d;
          melhor = nome as TelaCanto;
        }
      }
      if (melhor !== canto) onCanto(melhor);

      // Um quadro depois, e não agora: a classe --arrastando (que desliga a
      // transição) só sai no render deste setArrastando, e zerar o transform
      // antes disso faria a janelinha TELEPORTAR pro canto em vez de deslizar
      // até ele. É o deslize que conta que o gesto grudou em algum canto.
      requestAnimationFrame(() => {
        caixa.style.transform = '';
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [arrastando, canto, onCanto]);

  // ── Redimensionar pela quina ───────────────────────────────────────────
  useEffect(() => {
    if (!medindo) return;

    // Cada alça cresce pro seu lado: puxar a da esquerda PARA a esquerda
    // aumenta, e a da direita para a direita. É o que a mão espera de uma
    // quina, e vale igual nos quatro cantos — a borda ancorada é a que fica
    // parada, mas quem segura a alça vê a largura seguindo o dedo.
    const sinal = gesto.current?.lado === 'esq' ? -1 : 1;
    const inicioX = gesto.current?.x ?? 0;
    const inicioW = larguraRef.current;

    const onMove = (e: PointerEvent) => {
      const px = Math.round(
        Math.min(MAX, Math.max(MIN, inicioW + sinal * (e.clientX - inicioX))),
      );
      larguraRef.current = px;
      document.documentElement.style.setProperty('--tela-w', `${px}px`);
    };
    const onUp = () => {
      setMedindo(false);
      gesto.current = null;
      onLargura(larguraRef.current);
    };

    // A diagonal do cursor sai da quina em que a alça está: ancorada
    // embaixo ela fica em cima, e vice-versa.
    const emCima = CANTOS[canto].y === 1;
    const esq = gesto.current?.lado === 'esq';
    const diag = emCima === esq ? 'app--diag-nwse' : 'app--diag-nesw';

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.classList.add(diag);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove(diag);
    };
  }, [medindo, canto, onLargura]);

  const pegar = useCallback((e: React.PointerEvent) => {
    // Só o botão esquerdo: o do meio cola no Linux.
    if (e.button !== 0) return;
    // A alça é alça: puxar o tamanho não pode virar arrasto junto.
    if ((e.target as HTMLElement).closest('.pilha__alca')) return;
    gesto.current = {
      x: e.clientX,
      y: e.clientY,
      moveu: false,
      rect: caixaRef.current?.getBoundingClientRect() ?? null,
      lado: 'dir',
    };
    setArrastando(true);
  }, []);

  const puxar = (lado: 'esq' | 'dir') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Sem isto o pointerdown sobe pra janelinha e o gesto vira arrasto junto.
    e.stopPropagation();
    gesto.current = { x: e.clientX, y: e.clientY, moveu: true, rect: null, lado };
    setMedindo(true);
  };

  return (
    <div className="flutuantes">
      {/* Sem etiqueta nenhuma, nem no passar do mouse: quem está transmitindo
          já sabe que está, e o botão vermelho na barra de cima diz isso o
          tempo todo. Esta janelinha existe pra CONFERIR o que está indo, e
          qualquer coisa escrita por cima cobre justamente o que se veio
          olhar. */}
      <div
        ref={caixaRef}
        className={
          `pilha pilha--${canto}` +
          (arrastando ? ' pilha--arrastando' : '') +
          (medindo ? ' pilha--medindo' : '')
        }
        onPointerDown={pegar}
        title="O que você está compartilhando"
      >
        <div className="quadro quadro--meu">
          {/* Mudo obrigatoriamente: é o som que já sai da sua máquina. */}
          <video ref={videoRef} autoPlay playsInline muted />
        </div>

        {/* Uma alça de cada lado, e não só a do lado livre: com uma só, quem
            estivesse com a janelinha à direita tinha que atravessá-la inteira
            pra achar a quina. As duas ficam na borda vertical que aponta pra
            DENTRO — encostadas na de fora, metade delas cairia fora da área
            clicável. */}
        {(['esq', 'dir'] as const).map((lado) => (
          <div
            key={lado}
            className={`pilha__alca pilha__alca--${lado}`}
            role="separator"
            aria-label="Tamanho do seu preview"
            title="Arraste para mudar o tamanho — clique duas vezes para o padrão"
            onPointerDown={puxar(lado)}
            onDoubleClick={() => {
              larguraRef.current = PADRAO;
              document.documentElement.style.setProperty('--tela-w', `${PADRAO}px`);
              onLargura(PADRAO);
            }}
          />
        ))}
      </div>
    </div>
  );
}
