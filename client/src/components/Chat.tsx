import { useLayoutEffect, useRef, useState } from 'react';
import type { Attachment, Message, NovaEnquete, Poll } from '../types';
import { Avatar } from './Profile';
import { Anexo, Lightbox, tamanhoLegivel } from './Anexo';
import { Enquete, NovaEnqueteForm } from './Enquete';
import { IconClipe, IconClose, IconDescer, IconEnquete } from './Icons';
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
  onSend: (body: string, attachmentId?: string, poll?: NovaEnquete) => Promise<void>;
  /** Clicar na foto ou no nome de quem escreveu abre o perfil da pessoa. */
  onOpenUser: (identity: string) => void;
  /** Volume dos áudios do chat, 0 a 100. Vem das configurações. */
  chatVolume: number;
  /** Pra saber em que opção da enquete VOCÊ votou. */
  meId: string;
  /** Como mostrar quem votou. 'Você' pra si mesmo. */
  nomeDe: (id: string) => string;
  /** Guarda a apuração nova que o servidor devolveu depois de um voto. */
  onApurarPoll: (poll: Poll) => void;
  /** Avisa a sala que o voto mudou, pra quem está nela reconsultar. */
  onVotou: (pollId: number) => void;
}

export function Chat({
  messages, onSend, onOpenUser, chatVolume, meId, nomeDe, onApurarPoll, onVotou,
}: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const listaRef = useRef<HTMLDivElement>(null);
  /** Preso no fim. Só um gesto da PESSOA solta — ver conferirPino. */
  const pinnedRef = useRef(true);
  /** Instante do último gesto de rolagem feito pela pessoa. */
  const gestoRef = useRef(0);
  /** Espelho do pino pra tela: é ele que mostra o botão de descer. */
  const [noFim, setNoFim] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  /** Aberto = o formulário de enquete no lugar da caixa de texto. */
  const [enquetando, setEnquetando] = useState(false);

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

  const irAoFim = () => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setNoFim(true);
  };

  /**
   * Recalcula o pino — e SÓ a partir de um gesto da pessoa.
   *
   * Aqui estava o bug de abrir o app numa mensagem antiga, e ele é mais
   * sutil do que parece. O pino morava no onScroll: "se o scroll não está
   * no fim, a pessoa subiu". Só que o scroll se mexe sozinho o tempo todo
   * durante a abertura — uma foto que carrega, um vídeo que descobre a
   * própria altura, a fonte que troca, o ancoramento de rolagem do
   * Chromium. Qualquer um desses eventos soltava o pino sem ninguém ter
   * tocado em nada, e a partir dali nada mais trazia a conversa pro fim.
   *
   * Exigir um gesto separa as duas coisas na origem, em vez de tentar
   * adivinhar pela geometria: roda do mouse, arrastar a barra, tecla,
   * toque. Conteúdo crescendo não é gesto.
   */
  const conferirPino = () => {
    const el = logRef.current;
    if (!el) return;
    const preso = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    pinnedRef.current = preso;
    setNoFim((antes) => (antes === preso ? antes : preso));
  };

  const marcarGesto = () => {
    gestoRef.current = Date.now();
  };

  /**
   * Manter a conversa no fim — observando o TAMANHO da lista, não a
   * chegada de mensagem.
   *
   * Observar `messages.length` não bastava: quando o efeito rodava, as
   * fotos ainda não tinham carregado. Uma <img> sem bytes ocupa altura
   * zero, então rolávamos até o fim de uma lista que ainda ia crescer.
   *
   * O ResizeObserver pega qualquer coisa que mude a altura — foto, vídeo,
   * fonte, janela mudando de largura, mensagem nova — e já dispara uma vez
   * ao começar a observar, o que cobre a primeira pintura.
   */
  useLayoutEffect(() => {
    const el = logRef.current;
    const lista = listaRef.current;
    if (!el || !lista) return;

    const observador = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    observador.observe(lista);
    return () => observador.disconnect();
  }, []);

  // Cinto e suspensório do anterior: se por algum motivo a lista crescer
  // sem o observador ver, mensagem nova ainda traz pro fim.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  /**
   * Cria a enquete como uma mensagem sem corpo.
   *
   * A pergunta É o texto do balão — repeti-la no corpo só daria a mesma
   * frase duas vezes, uma acima da outra.
   */
  const criarEnquete = async (enquete: NovaEnquete) => {
    if (sending) return;
    setSending(true);
    setErro(null);
    try {
      await onSend('', undefined, enquete);
      setEnquetando(false);
      pinnedRef.current = true;
      setNoFim(true);
    } catch (err) {
      console.error(err);
      setErro('Não consegui criar a enquete.');
    } finally {
      setSending(false);
    }
  };

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
      setNoFim(true);
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
        // Os quatro jeitos de rolar de propósito. Marcam o instante; quem
        // decide o pino é o onScroll logo abaixo, mas só dentro da janela
        // que estes gestos abrem.
        onWheel={marcarGesto}
        onPointerDown={marcarGesto}
        onTouchStart={marcarGesto}
        onKeyDown={marcarGesto}
        onScroll={() => {
          // 1,5s cobre a inércia da roda e o arrastar da barra, que
          // continuam gerando scroll depois do gesto ter acabado. Fora
          // dessa janela, quem mexeu no scroll foi o conteúdo — e conteúdo
          // não decide se a pessoa quer ou não estar lendo o histórico.
          if (Date.now() - gestoRef.current > 1500) return;
          conferirPino();
        }}
      >
        {/* A lista é um elemento à parte do container que rola porque é o
            TAMANHO DELA que o ResizeObserver precisa ver. Observar o
            .chat__log só mostraria a altura da janela, que não muda quando
            uma foto termina de carregar — justamente o momento em que o fim
            da conversa se desloca. */}
        <div className="chat__lista" ref={listaRef}>
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
                  {m.poll && (
                    <Enquete
                      poll={m.poll}
                      meId={meId}
                      nomeDe={nomeDe}
                      onApurar={onApurarPoll}
                      onVotou={onVotou}
                    />
                  )}
                </div>
              </div>
            );
          })
        )}
        </div>
      </div>

      {/* Aparece só quando a conversa NÃO está no fim. Além de ser o
          atalho óbvio pra voltar, ele torna o estado visível: se o botão
          está na tela, o pino está solto — que era exatamente o que não
          dava pra ver quando o chat abria fora do fim. */}
      {!noFim && (
        <button className="chat__descer" onClick={irAoFim} title="Ir pro fim da conversa">
          <IconDescer size={16} />
        </button>
      )}

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

        {/* O formulário TOMA O LUGAR da caixa de texto em vez de aparecer
            junto: com os dois na tela existiriam dois botões de mandar, e
            nenhuma pista de qual deles vale. */}
        {enquetando ? (
          <NovaEnqueteForm
            ocupado={sending}
            onCriar={(e) => void criarEnquete(e)}
            onCancelar={() => setEnquetando(false)}
          />
        ) : (
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

            <button
              className="chat__clipe"
              onClick={() => setEnquetando(true)}
              disabled={subindo || Boolean(pendente)}
              title={pendente ? 'Tire o anexo primeiro' : 'Criar enquete'}
            >
              <IconEnquete size={18} />
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
        )}
      </div>
    </div>
  );
}
