import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Attachment } from '../types';
import { IconBaixar, IconArquivo, IconClose } from './Icons';

/**
 * Como cada anexo aparece na conversa.
 *
 * O `kind` vem decidido do servidor, não do mime aqui: só o que ele se
 * dispõe a servir com o content-type de verdade vira 'image' ou 'audio'.
 * Confiar no mime deste lado deixaria a tela tentar desenhar como imagem
 * uma coisa que desce como octet-stream.
 */

/** "2,4 MB". Vírgula porque o resto do app fala português. */
export function tamanhoLegivel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0).replace('.', ',')} MB`;
}

interface Props {
  anexo: Attachment;
  /** 0 a 100, das configurações. Só o áudio usa. */
  chatVolume: number;
  /** Abre a imagem em tela cheia. */
  onAmpliar: (anexo: Attachment) => void;
}

export function Anexo({ anexo, chatVolume, onAmpliar }: Props) {
  if (anexo.kind === 'image') {
    return (
      <button
        className="anexo anexo--imagem"
        onClick={() => onAmpliar(anexo)}
        title="Clique para ampliar"
      >
        {/* O nome do arquivo não aparece em lugar nenhum de uma FOTO — nem
            no alt, nem no title, nem na barra do lightbox. Nome de foto é
            quase sempre lixo de câmera ou de print ("IMG-20260830-WA0007",
            "Captura de tela 2026-08-30 143512"), às vezes com o acento já
            estropiado pelo caminho, e não diz nada que a própria imagem não
            diga melhor. O alt genérico importa por um motivo a mais: é ele
            que vira TEXTO na tela quando a imagem não carrega. */}
        <img className="anexo__img" src={anexo.url} alt="Imagem" loading="lazy" />
      </button>
    );
  }

  if (anexo.kind === 'audio') return <AnexoAudio anexo={anexo} volume={chatVolume} />;

  if (anexo.kind === 'video') return <AnexoVideo anexo={anexo} volume={chatVolume} />;

  return <AnexoArquivo anexo={anexo} />;
}

function AnexoVideo({ anexo, volume }: { anexo: Attachment; volume: number }) {
  const ref = useRef<HTMLVideoElement>(null);

  // Mesma razão do áudio: `volume` é propriedade do elemento, não atributo
  // do HTML. Escrever volume={x} no JSX não faria nada.
  useEffect(() => {
    const el = ref.current;
    if (el) el.volume = Math.min(1, Math.max(0, volume / 100));
  }, [volume]);

  return (
    <div className="anexo anexo--video">
      {/* preload="metadata" traz só o cabeçalho — duração, tamanho e o
          primeiro quadro — em vez de baixar o vídeo inteiro de toda
          mensagem a cada abertura do chat. Pular pro meio funciona porque o
          servidor responde Range desde os áudios.

          playsInline pro vídeo tocar no lugar dele, e não tomar a tela. */}
      {/* Sem o nome do arquivo, pelo mesmo motivo da foto: nome de clipe de
          jogo é gerado pelo gravador ("MedalTVMarvelRivals20260803195209909
          -trim-1785797706..."), ocupa duas linhas e não diz nada que o
          próprio vídeo não diga. Continua indo pro arquivo salvo ao baixar. */}
      <video
        ref={ref}
        className="anexo__video"
        src={anexo.url}
        controls
        preload="metadata"
        playsInline
      />
    </div>
  );
}

function AnexoAudio({ anexo, volume }: { anexo: Attachment; volume: number }) {
  const ref = useRef<HTMLAudioElement>(null);

  // Num efeito, e não no atributo: `volume` é propriedade do elemento, não
  // atributo do HTML — escrever volume={x} no JSX não faz nada. Depender de
  // `volume` também faz o ajuste valer na hora, sem recarregar o áudio.
  useEffect(() => {
    const el = ref.current;
    if (el) el.volume = Math.min(1, Math.max(0, volume / 100));
  }, [volume]);

  return (
    <div className="anexo anexo--audio">
      {/* preload="metadata" traz só a duração, pra barrinha nascer com o
          tamanho certo. Sem isso o navegador ou baixa o áudio inteiro de
          cada mensagem ao abrir o chat, ou mostra duração 0 até apertar
          play. Pular no meio funciona porque o servidor responde Range. */}
      <audio ref={ref} className="anexo__player" src={anexo.url} controls preload="metadata" />
      <span className="anexo__nome" title={anexo.name}>{anexo.name}</span>
    </div>
  );
}

function AnexoArquivo({ anexo }: { anexo: Attachment }) {
  const [baixando, setBaixando] = useState(false);
  const [erro, setErro] = useState(false);

  const baixar = async () => {
    if (baixando) return;
    setBaixando(true);
    setErro(false);
    try {
      await window.disc.arquivos.baixar(anexo.id, anexo.name);
    } catch (err) {
      console.error(err);
      setErro(true);
    } finally {
      setBaixando(false);
    }
  };

  return (
    <button
      className={`anexo anexo--arquivo${erro ? ' anexo--erro' : ''}`}
      onClick={() => void baixar()}
      disabled={baixando}
      title={`Baixar ${anexo.name}`}
    >
      <span className="anexo__icone"><IconArquivo /></span>
      <span className="anexo__info">
        <span className="anexo__nome">{anexo.name}</span>
        <span className="anexo__meta">
          {erro ? 'não consegui baixar' : baixando ? 'baixando...' : tamanhoLegivel(anexo.size)}
        </span>
      </span>
      <span className="anexo__baixar"><IconBaixar /></span>
    </button>
  );
}

/**
 * Imagem em tela cheia.
 *
 * Fecha no Esc, no clique no fundo e no X do canto — três saídas porque é
 * uma camada que cobre tudo, e ficar preso nela é o pior que pode
 * acontecer.
 *
 * Baixar saiu da barra de cima e virou botão direito na imagem. A barra
 * nascia em cima da faixa de arrastar da janela, e o clique NUNCA chegava
 * nos botões — nem no "Baixar", nem no "Fechar" (ver .lightbox no
 * theme.css). Menos coisa na frente da foto, e a saída num lugar só.
 */
export function Lightbox({ anexo, onFechar }: { anexo: Attachment; onFechar: () => void }) {
  /** Onde desenhar o menu do botão direito. null = sem menu aberto. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // O Esc tira uma camada por vez: primeiro o menu, depois a imagem.
    // Fechar as duas de uma vez faria a foto sumir de quem só desistiu do
    // menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menu) setMenu(null);
      else onFechar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onFechar, menu]);

  // Nasce no cursor, mas é empurrado pra dentro da tela se não couber.
  // Medido depois de existir porque a largura vem do CSS e do texto, não
  // daqui; o useLayoutEffect corrige antes de pintar, sem piscar no lugar
  // errado.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))}px`;
  }, [menu]);

  return (
    <div className="lightbox" onClick={onFechar}>
      <button className="lightbox__x" onClick={onFechar} title="Fechar (Esc)">
        <IconClose size={18} />
      </button>

      {/* Para o clique de fechar do fundo: clicar NA imagem não fecha.
          O title é o único aviso de que o botão direito baixa — sem ele o
          jeito de salvar a foto não existe em lugar nenhum da tela. */}
      <img
        className="lightbox__img"
        src={anexo.url}
        alt="Imagem"
        title="Botão direito para baixar"
        onClick={(e) => {
          e.stopPropagation();
          setMenu(null);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />

      {menu && (
        <div
          className="lightbox__menu"
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* O nome do arquivo continua indo pro `baixar` e nomeando o que
              se salva — some da tela, não do arquivo. */}
          <button
            className="lightbox__menu-item"
            onClick={() => {
              setMenu(null);
              void window.disc.arquivos.baixar(anexo.id, anexo.name);
            }}
          >
            <IconBaixar size={14} />
            Baixar imagem
          </button>
        </div>
      )}
    </div>
  );
}
