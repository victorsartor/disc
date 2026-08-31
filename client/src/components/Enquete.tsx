import { useState } from 'react';
import type { NovaEnquete, Poll } from '../types';
import { IconClose } from './Icons';

/**
 * A enquete dentro da conversa, e o formulário que cria uma.
 *
 * A APURAÇÃO SEMPRE VEM DO SERVIDOR. Nada aqui soma voto a partir do que
 * chegou pelo data channel: um aviso perdido no caminho deixaria dois apps
 * mostrando números diferentes, e nada os reconciliaria depois. O clique
 * manda o conjunto inteiro de opções marcadas e desenha o que voltar.
 *
 * Também não há camada otimista, de propósito. O servidor é o PC de alguém
 * na mesma tailnet — a resposta chega em milissegundos, e uma segunda fonte
 * da verdade pra cobrir essa janela custaria mais do que resolve.
 */

/** Os mesmos do servidor (config.ts). Aqui é pra avisar antes de mandar. */
const MAX_PERGUNTA = 200;
const MAX_OPCAO = 80;
const MIN_OPCOES = 2;
const MAX_OPCOES = 6;

interface Props {
  poll: Poll;
  meId: string;
  /** Como mostrar quem votou. 'Você' pra si mesmo — ver o nomeDe do App. */
  nomeDe: (id: string) => string;
  /** Troca a enquete pela apuração nova que o servidor devolveu. */
  onApurar: (poll: Poll) => void;
  /** Avisa a sala que o voto mudou, pra quem está nela reconsultar. */
  onVotou: (pollId: number) => void;
}

export function Enquete({ poll, meId, nomeDe, onApurar, onVotou }: Props) {
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState(false);

  const meus = new Set<number>();
  poll.options.forEach((o, i) => {
    if (o.voters.includes(meId)) meus.add(i);
  });

  // A porcentagem é sobre PESSOAS, não sobre votos. Numa enquete de
  // múltipla escolha as barras podem somar mais de 100%, e está certo:
  // "4 das 6 pessoas marcaram isto" é o que alguém quer saber.
  const pessoas = new Set(poll.options.flatMap((o) => o.voters)).size;
  const pct = (n: number) => (pessoas === 0 ? 0 : Math.round((n / pessoas) * 100));

  const votar = async (i: number) => {
    if (enviando) return;

    const novo = new Set(meus);
    if (novo.has(i)) {
      novo.delete(i);
    } else {
      // Voto único: escolher outra opção TROCA em vez de somar. Sem isto o
      // servidor recusaria com 400 e o clique não faria nada visível — o
      // pior tipo de erro, o que não aparece.
      if (!poll.multi) novo.clear();
      novo.add(i);
    }

    setEnviando(true);
    setErro(false);
    try {
      const { poll: fresco } = await window.disc.polls.vote(poll.id, [...novo]);
      onApurar(fresco);
      onVotou(poll.id);
    } catch (err) {
      console.error(err);
      setErro(true);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="enquete">
      <div className="enquete__pergunta">{poll.question}</div>

      <div className="enquete__opcoes">
        {poll.options.map((o, i) => {
          const marcada = meus.has(i);
          return (
            <button
              key={i}
              className={`enquete__opcao${marcada ? ' enquete__opcao--minha' : ''}`}
              onClick={() => void votar(i)}
              disabled={enviando}
              aria-pressed={marcada}
              title={
                o.voters.length > 0
                  ? o.voters.map(nomeDe).join(', ')
                  : 'ninguém votou nesta ainda'
              }
            >
              {/* A barra é irmã do conteúdo, não fundo dele: assim ela
                  anima a largura sem levar o texto junto. */}
              <span className="enquete__barra" style={{ width: `${pct(o.voters.length)}%` }} />
              <span className="enquete__linha">
                <span className="enquete__texto">{o.text}</span>
                <span className="enquete__num">{o.voters.length}</span>
              </span>
              {o.voters.length > 0 && (
                <span className="enquete__quem">{o.voters.map(nomeDe).join(', ')}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="enquete__rodape">
        {erro ? (
          <span className="enquete__erro">não consegui registrar seu voto</span>
        ) : (
          <>
            <span>
              {pessoas === 0
                ? 'ninguém votou ainda'
                : `${pessoas} ${pessoas === 1 ? 'pessoa votou' : 'pessoas votaram'}`}
            </span>
            {poll.multi && <span className="enquete__dica">dá pra marcar mais de uma</span>}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * O formulário de criar enquete, aberto pelo botão do chat.
 *
 * Nasce com duas opções vazias porque duas é o mínimo — mostrar uma só e
 * pedir pra somar seria esconder a regra atrás de um erro depois.
 */
export function NovaEnqueteForm({
  ocupado,
  onCriar,
  onCancelar,
}: {
  ocupado: boolean;
  onCriar: (enquete: NovaEnquete) => void;
  onCancelar: () => void;
}) {
  const [pergunta, setPergunta] = useState('');
  const [opcoes, setOpcoes] = useState<string[]>(['', '']);
  const [multi, setMulti] = useState(false);

  const preenchidas = opcoes.map((o) => o.trim()).filter(Boolean);
  const pronta = pergunta.trim().length > 0 && preenchidas.length >= MIN_OPCOES;

  const mexer = (i: number, valor: string) => {
    setOpcoes((prev) => prev.map((o, j) => (j === i ? valor : o)));
  };

  const criar = () => {
    if (!pronta || ocupado) return;
    // Manda só as preenchidas: o servidor descarta as vazias de qualquer
    // jeito, mas mandar menos é mais fácil de conferir dos dois lados.
    onCriar({ question: pergunta.trim(), options: preenchidas, multi });
  };

  return (
    <div className="nova-enquete">
      <div className="nova-enquete__topo">
        <span className="nova-enquete__titulo">Nova enquete</span>
        <button className="nova-enquete__x" onClick={onCancelar} title="Cancelar">
          <IconClose size={14} />
        </button>
      </div>

      <input
        className="nova-enquete__pergunta"
        value={pergunta}
        maxLength={MAX_PERGUNTA}
        placeholder="O que você quer perguntar?"
        onChange={(e) => setPergunta(e.target.value)}
        autoFocus
      />

      {opcoes.map((o, i) => (
        <div className="nova-enquete__opcao" key={i}>
          <input
            className="nova-enquete__campo"
            value={o}
            maxLength={MAX_OPCAO}
            placeholder={`Opção ${i + 1}`}
            onChange={(e) => mexer(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                criar();
              }
            }}
          />
          {opcoes.length > MIN_OPCOES && (
            <button
              className="nova-enquete__x"
              onClick={() => setOpcoes((prev) => prev.filter((_, j) => j !== i))}
              title="Tirar esta opção"
            >
              <IconClose size={13} />
            </button>
          )}
        </div>
      ))}

      <div className="nova-enquete__acoes">
        {opcoes.length < MAX_OPCOES && (
          <button
            className="nova-enquete__mais"
            onClick={() => setOpcoes((prev) => [...prev, ''])}
          >
            + opção
          </button>
        )}

        <label className="nova-enquete__multi">
          <input
            type="checkbox"
            checked={multi}
            onChange={(e) => setMulti(e.target.checked)}
          />
          várias respostas
        </label>

        <button className="nova-enquete__criar" onClick={criar} disabled={!pronta || ocupado}>
          {ocupado ? 'Criando...' : 'Criar'}
        </button>
      </div>
    </div>
  );
}
