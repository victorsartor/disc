import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RemoteTrack } from 'livekit-client';
import { type AudioFeed, type ScreenFeed } from '../lib/useRoom';
import { CANTOS, type TelaCanto } from '../types';
import {
  IconBroadcast, IconHeadphones, IconHeadphonesOff,
  IconFullscreen, IconFullscreenExit, IconEye,
} from './Icons';

interface Props {
  screens: ScreenFeed[];
  /** Usado só para saber quem está mandando som junto com a tela. */
  audios: AudioFeed[];
  screenVolumes: Record<string, number>;
  onScreenVolume: (identity: string, volume: number) => void;
  /** Fecha uma transmissão pelo olho do próprio quadro. */
  onParar: (identity: string) => void;
  /** Sua própria tela, se você estiver compartilhando. */
  localScreen: MediaStreamTrack | null;
  /** Quando a SUA transmissão começou. null = você não está compartilhando. */
  shareStartedAt: number | null;
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
 * Sem esta folga, a mão que treme no clique do botão direito (que abre o
 * volume) sairia arrastando a pilha junto — e o menu nasceria com a
 * transmissão já no meio do caminho pra outro canto.
 */
const FOLGA = 4;

/**
 * "07:12" até uma hora; "1:07:12" depois dela.
 *
 * Sem a casa da hora quando ela é zero: a maioria das transmissões dura
 * minutos, e um "0:07:12" fixo gasta espaço com um dígito que quase nunca
 * muda.
 */
function duracao(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const dd = (n: number) => String(n).padStart(2, '0');
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${dd(m)}:${dd(s)}` : `${dd(m)}:${dd(s)}`;
}

/**
 * Há quanto tempo a live está no ar.
 *
 * `desde` já vem no relógio DESTA máquina — quem converte é o useRoom, a
 * partir da duração que o transmissor anuncia. Aqui é só a diferença pra
 * agora, de segundo em segundo.
 *
 * Componente próprio, e não um estado no Quadro, porque ele re-renderiza a
 * cada segundo: isolado assim, o que volta a desenhar é este <span> — não o
 * <video> ao lado dele.
 */
function Cronometro({ desde }: { desde: number }) {
  const [agora, setAgora] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setAgora(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="quadro__tempo" title="Tempo de transmissão">
      {duracao(agora - desde)}
    </span>
  );
}

/** Quem está com a caixinha aberta, e em que ponto da tela ela nasceu. */
interface Aberto {
  identity: string;
  x: number;
  y: number;
}

/**
 * As transmissões, numa pilha flutuante por cima do chat.
 *
 * Não há mais palco: até a 0.38 isto era um irmão do chat e dividia altura
 * com ele (flex 3 contra 2), então quem compartilhasse custava metade da
 * janela a todo mundo — inclusive a quem só queria ler a conversa. Agora as
 * janelinhas flutuam num canto e o chat fica inteiro embaixo.
 *
 * A pilha tem UM canto e UMA largura pra todas: arrastar move o conjunto, e
 * ao soltar ele gruda no canto mais perto. Canto e tamanho por transmissão
 * fariam duas se cruzarem na tela sem ninguém ter pedido isso.
 *
 * Ver grande continua existindo, mas agora é a tela cheia de verdade (duplo
 * clique ou o botão do canto) — o estado intermediário "ampliado", que
 * ocupava o palco todo, foi junto com o palco.
 */
export function Stage({
  screens, audios, screenVolumes, onScreenVolume, onParar, localScreen, shareStartedAt,
  canto, largura, onCanto, onLargura,
}: Props) {
  // Uma por vez: abrir noutro quadro fecha a anterior sozinho.
  const [aberto, setAberto] = useState<Aberto | null>(null);
  const pilhaRef = useRef<HTMLDivElement>(null);

  const [arrastando, setArrastando] = useState(false);
  const [medindo, setMedindo] = useState(false);
  /** Onde o gesto começou, e se ele já passou da FOLGA pra virar arrasto. */
  const gesto = useRef<{ x: number; y: number; moveu: boolean } | null>(null);
  /** Onde a largura parou. O pointerup não traz a posição do mouse. */
  const larguraRef = useRef(largura);

  useEffect(() => {
    if (!medindo) larguraRef.current = largura;
  }, [largura, medindo]);

  // Fechar clicando fora e no Escape. Sem isto a caixinha só sairia da tela
  // clicando de novo exatamente no mesmo quadro.
  useEffect(() => {
    if (!aberto) return;
    const fecha = () => setAberto(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAberto(null);
    window.addEventListener('pointerdown', fecha);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', fecha);
      window.removeEventListener('keydown', onKey);
    };
  }, [aberto]);

  // ── Arrastar a pilha ───────────────────────────────────────────────────
  // Como no SidebarResizer, o gesto NÃO passa por estado do React: cada
  // movimento escreve direto no transform. Re-renderizar a árvore a 60fps
  // arrastaria o <video> junto, e o vídeo é o que não pode piscar.
  useEffect(() => {
    if (!arrastando) return;
    const pilha = pilhaRef.current;
    const area = pilha?.parentElement;
    if (!pilha || !area) return;

    const onMove = (e: PointerEvent) => {
      const g = gesto.current;
      if (!g) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      // Antes da folga não mexe em nada: um tremor no clique não pode
      // parecer o começo de um arrasto.
      if (!g.moveu && Math.hypot(dx, dy) < FOLGA) return;
      g.moveu = true;
      pilha.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    const onUp = () => {
      setArrastando(false);
      const g = gesto.current;
      gesto.current = null;
      if (!g?.moveu) {
        pilha.style.transform = '';
        return;
      }

      // Medir ANTES de limpar o transform: depois de limpo a pilha já
      // voltou pro canto antigo e a conta daria sempre ele.
      const r = pilha.getBoundingClientRect();
      const a = area.getBoundingClientRect();
      const fx = (r.left + r.width / 2 - a.left) / Math.max(1, a.width);
      const fy = (r.top + r.height / 2 - a.top) / Math.max(1, a.height);

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
      // antes disso faria a pilha TELEPORTAR pro canto em vez de deslizar
      // até ele. É o deslize que conta que o gesto grudou em algum canto.
      requestAnimationFrame(() => {
        pilha.style.transform = '';
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
    const pilha = pilhaRef.current;
    if (!pilha) return;

    // Ancorada à direita, a quina de puxar aponta pra ESQUERDA da tela: ali
    // arrastar pra esquerda é que aumenta. À esquerda, o contrário.
    const sinal = CANTOS[canto].x === 1 ? -1 : 1;
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

    // A diagonal do cursor segue a quina: nos cantos em que ela aponta pra
    // baixo-direita ou cima-esquerda é a "\", nos outros dois a "/".
    const diag = CANTOS[canto].x === CANTOS[canto].y ? 'app--diag-nwse' : 'app--diag-nesw';

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
    // Só o botão esquerdo: o direito abre o volume, e o do meio cola no Linux.
    if (e.button !== 0) return;
    // Botão é botão: parar de assistir e tela cheia não podem virar arrasto.
    if ((e.target as HTMLElement).closest('button, .pilha__alca')) return;
    gesto.current = { x: e.clientX, y: e.clientY, moveu: false };
    setArrastando(true);
  }, []);

  if (screens.length === 0 && !localScreen) return null;

  const menuVolume = (identity: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    setAberto({ identity, x: e.clientX, y: e.clientY });
  };

  return (
    <div className="flutuantes">
      <div
        ref={pilhaRef}
        className={
          `pilha pilha--${canto}` +
          (arrastando ? ' pilha--arrastando' : '') +
          (medindo ? ' pilha--medindo' : '')
        }
        onPointerDown={pegar}
      >
        {screens.map((s) => (
          <Quadro
            key={s.identity}
            nome={s.name}
            track={s.track}
            startedAt={s.startedAt}
            onParar={() => onParar(s.identity)}
            onVolume={menuVolume(s.identity)}
          />
        ))}

        {localScreen && <MeuPreview track={localScreen} startedAt={shareStartedAt} />}

        {/* Na quina que aponta pra dentro da janela: encostada na borda ela
            ficaria em cima da moldura da própria pilha, e metade da alça
            cairia fora da área clicável. */}
        <div
          className="pilha__alca"
          role="separator"
          aria-label="Tamanho da transmissão"
          title="Arraste para mudar o tamanho — clique duas vezes para o padrão"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            gesto.current = { x: e.clientX, y: e.clientY, moveu: true };
            setMedindo(true);
          }}
          onDoubleClick={() => {
            larguraRef.current = PADRAO;
            document.documentElement.style.setProperty('--tela-w', `${PADRAO}px`);
            onLargura(PADRAO);
          }}
        />
      </div>

      {aberto && (
        <ScreenVolume
          x={aberto.x}
          y={aberto.y}
          // A caixinha abre mesmo sem som pra ajustar. Ela guardava o próprio
          // motivo de existir: transmissão de Wayland vai só com vídeo (o
          // portal do KDE não entrega áudio), e antes o clique direito
          // simplesmente não fazia nada — sem dizer que não havia som.
          temSom={audios.some(
            (a) => a.kind === 'screen' && a.identity === aberto.identity,
          )}
          value={screenVolumes[aberto.identity] ?? 1}
          onChange={(v) => onScreenVolume(aberto.identity, v)}
        />
      )}
    </div>
  );
}

/**
 * Uma transmissão que você está assistindo.
 *
 * Dois tamanhos agora, e não três: a janelinha na pilha e a tela cheia de
 * verdade. O estado do meio ("ampliada", ocupando o palco todo) saiu junto
 * com o palco — ele existia pra dar ao vídeo mais espaço que a miniatura sem
 * cobrir o app inteiro, e é exatamente esse meio-termo que a janelinha
 * redimensionável passou a resolver melhor.
 *
 * Duplo clique leva pra tela cheia. É o gesto que todo player de vídeo já
 * tem, e aqui ele não disputa com nada: o clique simples arrasta a pilha, e
 * arrastar precisa da FOLGA de qualquer jeito.
 */
function Quadro({
  nome, track, startedAt, onParar, onVolume,
}: {
  nome: string;
  track: RemoteTrack;
  startedAt: number;
  onParar: () => void;
  onVolume: (e: React.MouseEvent) => void;
}) {
  const caixaRef = useRef<HTMLDivElement>(null);
  const [cheia, setCheia] = useState(false);

  // O estado da tela cheia é do documento, não nosso: sair pelo F11 ou pelo
  // Esc do navegador não passa pelo nosso botão, e sem ouvir o evento o
  // ícone ficaria mentindo.
  useEffect(() => {
    const sync = () => setCheia(document.fullscreenElement === caixaRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const alternarCheia = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void caixaRef.current?.requestFullscreen().catch(() => {
      /* recusado: fica do tamanho que está, e a pilha continua arrastável */
    });
  };

  return (
    <div
      ref={caixaRef}
      className="quadro"
      onDoubleClick={alternarCheia}
      onContextMenu={onVolume}
      title="Arraste para mover; dois cliques para tela cheia; botão direito para o volume"
    >
      <VideoTile track={track} />

      <div className="quadro__label">
        <IconBroadcast size={13} />
        {nome}
        <Cronometro desde={startedAt} />
      </div>

      <div className="quadro__acoes">
        <button className="quadro__btn" onClick={onParar} title={`Parar de assistir ${nome}`}>
          <IconEye size={16} />
        </button>
        <button
          className="quadro__btn"
          onClick={alternarCheia}
          title={cheia ? 'Sair da tela cheia' : 'Tela cheia'}
        >
          {cheia ? <IconFullscreenExit size={16} /> : <IconFullscreen size={16} />}
        </button>
      </div>
    </div>
  );
}

/**
 * O seu próprio compartilhamento.
 *
 * Serve só pra conferir que está indo o que você acha que está indo. Vem da
 * mesma faixa que sobe pro servidor, então o que aparece aqui é literalmente
 * o que os outros recebem.
 *
 * Agora é mais um item da pilha, com a mesma moldura dos outros: quando ele
 * era o único flutuante do app tinha classe própria e um canto só dele, e
 * duas coisas com a mesma cara em cantos diferentes davam a impressão de que
 * uma delas tinha travado.
 */
function MeuPreview({
  track, startedAt,
}: {
  track: MediaStreamTrack;
  startedAt: number | null;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = new MediaStream([track]);
    return () => {
      el.srcObject = null;
    };
  }, [track]);

  return (
    <div className="quadro quadro--meu" title="O que você está compartilhando">
      {/* Mudo obrigatoriamente: é o som que já está saindo da sua máquina. */}
      <video ref={ref} autoPlay playsInline muted />
      <div className="quadro__label">
        Você está compartilhando
        {startedAt !== null && <Cronometro desde={startedAt} />}
      </div>
    </div>
  );
}

/** Largura da caixinha, e a folga que ela guarda das bordas da janela. */
const CAIXA_LARGURA = 232;
const MARGEM = 8;

/**
 * Volume do som da tela, separado da voz de quem compartilha.
 *
 * Nasce onde o botão direito clicou, como um menu de contexto. Vai de 0 a
 * 200%: abaixar pra ouvir a pessoa por cima do jogo é o caso comum, mas
 * transmissão com áudio baixo demais também acontece, e aí só resta subir.
 */
function ScreenVolume({
  x, y, temSom, value, onChange,
}: {
  x: number;
  y: number;
  /** Falso quando a transmissão vem só com vídeo — o caso do Wayland. */
  temSom: boolean;
  value: number;
  onChange: (v: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Nasce no cursor, mas não pode vazar da janela: se estourar a direita ou
  // o rodapé, dobra pro outro lado do ponto clicado, como todo menu faz.
  useLayoutEffect(() => {
    const alturaReal = ref.current?.offsetHeight ?? 96;
    const left = Math.min(x, window.innerWidth - CAIXA_LARGURA - MARGEM);
    const top = y + alturaReal + MARGEM > window.innerHeight
      ? y - alturaReal
      : y;
    setPos({ left: Math.max(MARGEM, left), top: Math.max(MARGEM, top) });
  }, [x, y]);

  const pct = Math.round(value * 100);
  const mudo = pct === 0;

  return (
    // O pointerdown não pode subir: quem fecha a caixinha é o listener na
    // window, e ele fecharia a própria caixa ao encostar no slider.
    <div
      ref={ref}
      className="volpop"
      style={{ left: pos.left, top: pos.top, width: CAIXA_LARGURA }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="volpop__head">
        <span>Som da tela</span>
        {temSom && <span className="volpop__value">{pct}%</span>}
      </div>

      {temSom ? (
        <div className="volpop__linha">
          <button
            className="tile__vol-btn"
            onClick={() => onChange(mudo ? 1 : 0)}
            title={mudo ? 'Voltar o som da tela' : 'Silenciar o som da tela'}
          >
            {mudo ? <IconHeadphonesOff size={15} /> : <IconHeadphones size={15} />}
          </button>
          <input
            type="range"
            className="tile__vol-slider"
            min={0}
            max={200}
            step={5}
            value={pct}
            autoFocus
            aria-label="Volume do som da tela"
            onChange={(e) => onChange(Number(e.target.value) / 100)}
          />
        </div>
      ) : (
        <p className="volpop__aviso">
          Esta transmissão está indo só com vídeo, então não há som pra ajustar.
          Quem compartilha do Linux cai nisso: o sistema de janelas de lá não
          entrega o áudio junto com a tela.
        </p>
      )}
    </div>
  );
}

function VideoTile({ track }: { track: RemoteTrack }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return <video ref={ref} autoPlay playsInline />;
}
