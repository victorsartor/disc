import { useLayoutEffect, useRef, useState } from 'react';
import type { Attachment, Message } from '../types';
import { Avatar } from './Profile';
import { Anexo, Lightbox, tamanhoLegivel } from './Anexo';
import { IconClipe, IconClose } from './Icons';
import { ehImagemAnimada, prepareChatImage } from '../lib/image';

const timeFmt = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Duas mensagens seguidas da mesma pessoa no mesmo dia viram um bloco só:
 * a foto e o nome aparecem na primeira, as outras entram como texto puro.
 * O dia é o limite porque, virando a data, repetir o cabeçalho é o que
 * separa uma conversa da outra.
 */
function mesmoDia(a: number, b: number) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** Teto por arquivo — o mesmo do servidor, avisado antes de subir. */
const MAX_BYTES = 200 * 1024 * 1024;

interface Props {
  messages: Message[];
  onSend: (body: string, attachmentId?: string) => Promise<void>;
  /** Clicar na foto ou no nome de quem escreveu abre o perfil da pessoa. */
  onOpenUser: (identity: string) => void;
  /** Volume dos áudios do chat, 0 a 100. Vem das configurações. */
  chatVolume: number;
}

export function Chat({ messages, onSend, onOpenUser, chatVolume }: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Já subiu e está esperando a mensagem que vai carregá-lo. */
  const [pendente, setPendente] = useState<Attachment | null>(null);
  const [subindo, setSubindo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  /** A imagem aberta em tela cheia. */
  const [ampliada, setAmpliada] = useState<Attachment | null>(null);

  /**
   * Sobe o arquivo NA HORA da escolha, antes de a mensagem existir.
   *
   * Podia esperar o Enter, mas aí um vídeo de 200 MB viraria um Enter que
   * não responde por um minuto. Subindo agora, a espera acontece enquanto a
   * pessoa escreve a legenda — e o servidor recolhe sozinho o que subiu e
   * nunca virou mensagem.
   */
  const escolher = async (file: File) => {
    setErro(null);

    if (file.size > MAX_BYTES) {
      setErro(`Esse arquivo tem ${tamanhoLegivel(file.size)}. O limite é 200 MB.`);
      return;
    }

    setSubindo(true);
    try {
      let r: { attachment: Attachment };

      // A divisão é entre imagem que a gente REPROCESSA e imagem que vai
      // crua. GIF (e WebP animado) não pode passar pelo canvas — sairia com
      // um quadro só — então não há nada pra reduzir, e mandar os bytes pelo
      // IPC seria copiar um arquivo inteiro na memória dos dois lados sem
      // ganho nenhum. Ela desce pelo caminho do arquivo, como todo mundo que
      // sobe cru; o servidor continua classificando image/gif como 'image',
      // então na conversa ela aparece igual.
      const reprocessavel =
        file.type.startsWith('image/') && !(await ehImagemAnimada(file));

      if (reprocessavel) {
        // Imagem passa pelo canvas primeiro: reduz e vai como bytes.
        const img = await prepareChatImage(file);
        r = await window.disc.arquivos.enviarImagem(img.bytes, img.nome, img.mime);
      } else {
        // O resto vai pelo CAMINHO, e o processo main faz stream do disco —
        // é o que impede 200 MB de atravessarem o IPC.
        r = await window.disc.arquivos.enviar(window.disc.arquivos.caminhoDe(file));
      }
      setPendente(r.attachment);
    } catch (err) {
      console.error(err);
      setErro('Não consegui enviar esse arquivo.');
    } finally {
      setSubindo(false);
    }
  };

  // Só rola sozinho se o usuário já estava no fim. Senão atrapalha
  // quem está lendo histórico enquanto a conversa continua.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = async () => {
    const text = draft.trim();
    // Foto sem legenda é normal; balão totalmente vazio não.
    if ((!text && !pendente) || sending || subindo) return;
    setSending(true);
    setErro(null);
    try {
      await onSend(text, pendente?.id);
      setDraft('');
      setPendente(null);
      pinnedRef.current = true;
    } catch (err) {
      console.error(err);
      setErro('Não consegui mandar a mensagem.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat">
      <div
        className="chat__log"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {messages.length === 0 ? (
          <div className="empty">Ninguém falou nada ainda.</div>
        ) : (
          messages.map((m, i) => {
            const anterior = messages[i - 1];
            const seguida =
              anterior !== undefined &&
              anterior.user_id === m.user_id &&
              mesmoDia(anterior.created_at, m.created_at);

            const hora = timeFmt.format(m.created_at);

            return (
              <div className={seguida ? 'msg msg--seguida' : 'msg'} key={m.id}>
                {seguida ? (
                  // Segura a coluna da esquerda no lugar da foto e guarda o
                  // horário, que só aparece quando o mouse passa por cima.
                  <div className="msg__vinco">
                    <span
                      className="msg__time msg__time--vinco"
                      title={`${m.author_name} às ${hora}`}
                    >
                      {hora}
                    </span>
                  </div>
                ) : (
                  <button
                    className="msg__avatar-btn"
                    onClick={() => onOpenUser(m.user_id)}
                    title={`Ver o perfil de ${m.author_name}`}
                  >
                    <Avatar
                      url={m.author_avatar}
                      name={m.author_name}
                      size={36}
                      className="msg__avatar"
                    />
                  </button>
                )}
                <div className="msg__body">
                  {!seguida && (
                    <div className="msg__head">
                      <button
                        className="msg__author msg__author--botao"
                        onClick={() => onOpenUser(m.user_id)}
                      >
                        {m.author_name}
                      </button>
                      <span className="msg__time">{hora}</span>
                    </div>
                  )}
                  {/* Texto puro via children do React — escapado automaticamente.
                      Nada de dangerouslySetInnerHTML aqui. */}
                  {m.body && <div className="msg__text">{m.body}</div>}
                  {m.attachments?.map((a) => (
                    <Anexo
                      key={a.id}
                      anexo={a}
                      chatVolume={chatVolume}
                      onAmpliar={setAmpliada}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      {ampliada && <Lightbox anexo={ampliada} onFechar={() => setAmpliada(null)} />}

      <div className="chat__composer">
        {erro && <div className="chat__erro">{erro}</div>}

        {(pendente || subindo) && (
          <div className="chat__pendente">
            {subindo ? (
              <span className="chat__pendente-nome">Enviando...</span>
            ) : (
              <>
                <span className="chat__pendente-nome" title={pendente!.name}>
                  {pendente!.name}
                </span>
                <span className="chat__pendente-tam">{tamanhoLegivel(pendente!.size)}</span>
                {/* Só tira daqui. Os bytes já subiram, e quem os recolhe é a
                    faxina de órfãos do servidor — não vale um round-trip
                    pra apagar algo que some sozinho. */}
                <button
                  className="chat__pendente-x"
                  onClick={() => setPendente(null)}
                  title="Tirar o anexo"
                >
                  <IconClose size={14} />
                </button>
              </>
            )}
          </div>
        )}

        <div className="chat__linha">
          {/* O input fica escondido: quem aparece é o botão do clipe, que
              casa com o resto da interface. */}
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              // Zera pra que escolher o MESMO arquivo de novo dispare o
              // change outra vez — sem isso, tirar e repor não funciona.
              e.target.value = '';
              if (f) void escolher(f);
            }}
          />
          <button
            className="chat__clipe"
            onClick={() => fileRef.current?.click()}
            disabled={subindo || Boolean(pendente)}
            title={pendente ? 'Já tem um anexo nesta mensagem' : 'Anexar arquivo'}
          >
            <IconClipe size={18} />
          </button>

          <textarea
            className="chat__input"
            rows={1}
            placeholder={pendente ? 'Legenda (opcional)...' : 'Escreve aqui...'}
            value={draft}
            maxLength={2000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
