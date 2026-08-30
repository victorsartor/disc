import { useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '../types';
import { Avatar } from './Profile';

const timeFmt = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
});

interface Props {
  messages: Message[];
  onSend: (body: string) => Promise<void>;
  /** Clicar na foto ou no nome de quem escreveu abre o perfil da pessoa. */
  onOpenUser: (identity: string) => void;
}

export function Chat({ messages, onSend, onOpenUser }: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Só rola sozinho se o usuário já estava no fim. Senão atrapalha
  // quem está lendo histórico enquanto a conversa continua.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onSend(text);
      setDraft('');
      pinnedRef.current = true;
    } catch (err) {
      console.error(err);
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
          messages.map((m) => (
            <div className="msg" key={m.id}>
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
              <div className="msg__body">
                <div className="msg__head">
                  <button
                    className="msg__author msg__author--botao"
                    onClick={() => onOpenUser(m.user_id)}
                  >
                    {m.author_name}
                  </button>
                  <span className="msg__time">{timeFmt.format(m.created_at)}</span>
                </div>
                {/* Texto puro via children do React — escapado automaticamente.
                    Nada de dangerouslySetInnerHTML aqui. */}
                <div className="msg__text">{m.body}</div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="chat__composer">
        <textarea
          className="chat__input"
          rows={1}
          placeholder="Escreve aqui..."
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
  );
}
