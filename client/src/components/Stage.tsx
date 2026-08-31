import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RemoteTrack } from 'livekit-client';
import { MAX_ASSISTINDO, type AudioFeed, type ScreenFeed } from '../lib/useRoom';
import {
  IconBroadcast, IconHeadphones, IconHeadphonesOff,
  IconFullscreen, IconFullscreenExit, IconClose, IconEye, IconEyeOff,
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
}

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

export function Stage({
  screens, audios, screenVolumes, onScreenVolume, onParar, localScreen, shareStartedAt,
}: Props) {
  // Uma por vez: abrir noutro quadro fecha a anterior sozinho.
  const [aberto, setAberto] = useState<Aberto | null>(null);
  /** Identity da transmissão aberta em grande. null = todas em miniatura. */
  const [ampliado, setAmpliado] = useState<string | null>(null);

  // Quem parou de transmitir enquanto estava ampliado não pode deixar o
  // palco preso numa transmissão que não existe mais.
  useEffect(() => {
    if (ampliado && !screens.some((s) => s.identity === ampliado)) {
      setAmpliado(null);
    }
  }, [ampliado, screens]);

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

  if (screens.length === 0 && !localScreen) return null;

  const grande = ampliado ? screens.find((s) => s.identity === ampliado) : null;

  const menuVolume = (identity: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    setAberto({ identity, x: e.clientX, y: e.clientY });
  };

  // Uma transmissão ocupa o palco todo; duas dividem em COLUNAS. Empilhar
  // seria dar a cada uma metade da altura, que é a dimensão escassa aqui —
  // as telas são largas, e é a altura que decide se dá pra ler alguma coisa.
  const colunas = grande ? 1 : Math.min(screens.length, 2);

  return (
    <div className={`stage${grande ? ' stage--ampliado' : ''}${colunas === 2 ? ' stage--duas' : ''}`}>
      {(grande ? [grande] : screens).map((s) => (
        <Quadro
          key={s.identity}
          nome={s.name}
          track={s.track}
          startedAt={s.startedAt}
          ampliado={Boolean(grande)}
          onAmpliar={() => setAmpliado(grande ? null : s.identity)}
          onParar={() => onParar(s.identity)}
          onVolume={menuVolume(s.identity)}
        />
      ))}

      {localScreen && <MeuPreview track={localScreen} startedAt={shareStartedAt} />}

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
 * Três tamanhos, e os botões do canto levam de um pro outro: miniatura
 * (dividindo o palco com as outras) → ampliada (o palco todo, com o chat
 * ainda embaixo) → tela cheia de verdade, pelo fullscreen do sistema.
 *
 * Os botões moram no mesmo canto e aparecem juntos no passar do mouse:
 * fechar a live, ampliar e tela cheia são a mesma família de decisão, e
 * espalhá-los pela tela era o que deixava o clique longe do que ele afeta.
 */
function Quadro({
  nome, track, startedAt, ampliado = false, onAmpliar, onParar, onVolume,
}: {
  nome: string;
  track: RemoteTrack;
  startedAt: number;
  ampliado?: boolean;
  onAmpliar: () => void;
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

  // Escape volta da ampliada — mas só quando NÃO está em tela cheia, senão o
  // primeiro Escape faria as duas coisas de uma vez.
  useEffect(() => {
    if (!ampliado) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) onAmpliar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ampliado, onAmpliar]);

  const alternarCheia = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void caixaRef.current?.requestFullscreen().catch(() => {
      /* recusado: fica do tamanho que está, que já é a maior parte da janela */
    });
  };

  return (
    <div
      ref={caixaRef}
      className={ampliado ? 'quadro quadro--ampliado' : 'quadro quadro--mini'}
      onClick={ampliado ? undefined : onAmpliar}
      onContextMenu={onVolume}
      title={ampliado ? undefined : 'Clique para abrir; botão direito para o volume'}
    >
      <VideoTile track={track} />

      <div className="quadro__label">
        <IconBroadcast size={13} />
        {nome}
        <Cronometro desde={startedAt} />
      </div>

      {/* O clique nos botões não pode subir pro quadro: ele ampliaria a
          transmissão no mesmo gesto que fecha ou põe em tela cheia. */}
      <div className="quadro__acoes" onClick={(e) => e.stopPropagation()}>
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
        {ampliado && !cheia && (
          <button className="quadro__btn" onClick={onAmpliar} title="Voltar pra miniatura">
            <IconClose size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * O seu próprio compartilhamento, em miniatura.
 *
 * Serve só pra conferir que está indo o que você acha que está indo — daí
 * ficar no canto, por cima, sem tirar espaço de quem se está assistindo. Vem
 * da mesma faixa que sobe pro servidor, então o que aparece aqui é
 * literalmente o que os outros recebem.
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
    <div className="preview" title="O que você está compartilhando">
      {/* Mudo obrigatoriamente: é o som que já está saindo da sua máquina. */}
      <video ref={ref} autoPlay playsInline muted />
      <div className="preview__label">
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
