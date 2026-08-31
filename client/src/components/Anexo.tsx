import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '../types';
import { IconBaixar, IconArquivo } from './Icons';

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
        title={`${anexo.name} — clique para ampliar`}
      >
        <img className="anexo__img" src={anexo.url} alt={anexo.name} loading="lazy" />
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
      <video
        ref={ref}
        className="anexo__video"
        src={anexo.url}
        controls
        preload="metadata"
        playsInline
      />
      <span className="anexo__nome" title={anexo.name}>{anexo.name}</span>
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
 * Fecha no Esc, no clique no fundo e no botão — três saídas porque é uma
 * camada que cobre tudo, e ficar preso nela é o pior que pode acontecer.
 */
export function Lightbox({ anexo, onFechar }: { anexo: Attachment; onFechar: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onFechar();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onFechar]);

  return (
    <div className="lightbox" onClick={onFechar}>
      <div className="lightbox__barra">
        <span className="lightbox__nome">{anexo.name}</span>
        <button
          className="lightbox__acao"
          onClick={(e) => {
            e.stopPropagation();
            void window.disc.arquivos.baixar(anexo.id, anexo.name);
          }}
        >
          Baixar
        </button>
        <button className="lightbox__acao" onClick={onFechar}>Fechar</button>
      </div>
      {/* Para o clique de fechar do fundo: clicar NA imagem não fecha. */}
      <img
        className="lightbox__img"
        src={anexo.url}
        alt={anexo.name}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
