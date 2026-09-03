import { useEffect, useRef, useState } from 'react';
import { ConnectionQuality } from 'livekit-client';
import type {
  Channel, Me, Presence, StatusEfetivo, UserPresence,
} from '../types';
import type { Peer } from '../lib/useRoom';
import {
  IconSpeaker, IconMic, IconMicOff, IconHeadphones,
  IconHeadphonesOff, IconLeave, IconSettings, IconLapis, IconLixeira,
} from './Icons';
import { Avatar } from './Profile';
import { SidebarResizer } from './SidebarResizer';
import { STATUS } from '../lib/status';
import logo from '../assets/logo.png';

/**
 * Teto do nome de um canal — espelha o MAX_CHANNEL_NAME do servidor.
 *
 * Aqui é só o `maxLength` do input, pra não deixar digitar o que a rota vai
 * recusar. Quem valida de verdade é o servidor.
 */
const MAX_NOME_CANAL = 40;

/**
 * Uma linha de participante, venha ela de onde vier.
 *
 * O canal em que você está entrega dados ao vivo pela própria sala; os
 * outros vêm do servidor a cada poucos segundos e sabem menos — não há como
 * saber quem está falando numa sala em que você não entrou. `live` é o que
 * distingue os dois, e é o que decide se a linha aceita ajuste de volume.
 */
interface Row {
  identity: string;
  name: string;
  avatarUrl: string | null;
  isMuted: boolean;
  isSharing: boolean;
  isSpeaking: boolean;
  isDeafened: boolean;
  isLocal: boolean;
  volume: number;
  live: boolean;
  connectionQuality: ConnectionQuality;
}

/**
 * Cor da bolinha de qualidade, ou null quando não vale mostrar.
 *
 * 'unknown' fica sem bolinha de propósito: é o estado de quem acabou de
 * entrar, antes do primeiro relatório do SFU chegar, e uma bolinha cinza ali
 * pareceria um alarme sem motivo.
 */
function corQualidade(q: ConnectionQuality): string | null {
  switch (q) {
    case ConnectionQuality.Excellent: return 'var(--ok)';
    case ConnectionQuality.Good: return 'var(--live)';
    case ConnectionQuality.Poor:
    case ConnectionQuality.Lost: return 'var(--danger)';
    default: return null;
  }
}

function tituloQualidade(q: ConnectionQuality): string {
  switch (q) {
    case ConnectionQuality.Excellent: return 'Conexão ótima';
    case ConnectionQuality.Good: return 'Conexão boa';
    case ConnectionQuality.Poor: return 'Conexão ruim';
    case ConnectionQuality.Lost: return 'Conexão perdida';
    default: return '';
  }
}

interface Props {
  me: Me;
  channels: Channel[];
  activeChannel: string | null;
  peers: Peer[];
  presence: Presence;
  /** Todo mundo do servidor, pra lista de quem está online fora de call. */
  users: UserPresence[];
  /**
   * O seu status como os outros veem — pode divergir do escolhido. Aqui
   * ele só se mostra; quem TROCA é a bolinha embaixo da sua foto, no
   * perfil, e por isso a escolha não passa mais por esta coluna.
   */
  status: StatusEfetivo;
  connecting: boolean;
  micOn: boolean;
  deafened: boolean;
  pttMode: boolean;
  pttDown: boolean;
  onJoin: (channelId: string) => void;
  onLeave: () => void;
  /**
   * Criar, renomear e apagar canal. Só chega preenchido pra admin — o botão
   * some pros outros, e o servidor recusa de novo (403) de qualquer jeito.
   * As três não mexem na lista aqui: a próxima volta da presença traz.
   */
  onCriarCanal: (nome: string) => Promise<void>;
  onRenomearCanal: (id: string, nome: string) => Promise<void>;
  onRemoverCanal: (id: string) => Promise<void>;
  onToggleMic: () => void;
  onToggleDeafen: () => void;
  onVolumeChange: (identity: string, volume: number) => void;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
  /** Abre o perfil de quem foi clicado — inclusive o seu. */
  onOpenUser: (identity: string) => void;
  /** Largura salva desta coluna, em pixels. */
  largura: number;
  onLarguraChange: (largura: number) => void;
}

export function Sidebar({
  me, channels, activeChannel, peers, presence, users, status,
  connecting, micOn, deafened,
  pttMode, pttDown, onJoin, onLeave, onToggleMic, onToggleDeafen,
  onVolumeChange, onOpenSettings, onOpenProfile, onOpenUser,
  onCriarCanal, onRenomearCanal, onRemoverCanal,
  largura, onLarguraChange,
}: Props) {
  const podeEditarCanais = me.isAdmin ?? false;
  const [criando, setCriando] = useState(false);
  // Este é o estado da CONEXÃO com o canal, não o status de presença. São
  // coisas diferentes: dá pra estar "Disponível" sem estar em canal nenhum.
  const conexao = connecting
    ? 'conectando...'
    : !activeChannel
      ? null
      : pttMode
        ? (pttDown ? 'falando' : 'aperte para falar')
        : 'conectado';

  return (
    <aside className="sidebar">
      <SidebarResizer largura={largura} onSalvar={onLarguraChange} />
      <div className="sidebar__brand">
        <img className="sidebar__logo" src={logo} alt="" />
        Disneia
      </div>

      <div className="sidebar__scroll">
        <div className="sidebar__label sidebar__label--linha">
          <span>Canais de voz</span>
          {podeEditarCanais && !criando && (
            <button
              className="sidebar__label-btn"
              title="Criar canal"
              onClick={() => setCriando(true)}
            >
              +
            </button>
          )}
        </div>

        {criando && (
          <NomeCanalInput
            inicial=""
            placeholder="nome do canal"
            onConfirmar={async (nome) => {
              await onCriarCanal(nome);
              setCriando(false);
            }}
            onCancelar={() => setCriando(false)}
          />
        )}

        {channels.map((ch) => {
          const active = activeChannel === ch.id;
          // No canal em que você está, a sala é a fonte da verdade e chega
          // na hora. Nos outros, o que o servidor viu por último.
          const members: Row[] = active
            ? peers.map((p) => ({ ...p, live: true }))
            : (presence[ch.id] ?? []).map((m) => ({
                ...m,
                isSpeaking: false,
                isDeafened: false,
                isLocal: false,
                volume: 1,
                live: false,
                // Qualidade so existe pra quem esta NA sua sala: fora dela
                // nao ha conexao ao SFU pra medir.
                connectionQuality: ConnectionQuality.Unknown,
              }));

          return (
            <CanalItem
              key={ch.id}
              ch={ch}
              active={active}
              connecting={connecting}
              members={members}
              podeEditar={podeEditarCanais}
              onJoin={onJoin}
              onRenomear={onRenomearCanal}
              onRemover={onRemoverCanal}
              onVolumeChange={onVolumeChange}
              onOpenUser={onOpenUser}
            />
          );
        })}

        <OnlineList
          users={users}
          emCall={new Set(
            channels.flatMap((ch) =>
              (activeChannel === ch.id ? peers : (presence[ch.id] ?? []))
                .map((m) => m.identity),
            ),
          )}
          meId={me.id}
          onOpenUser={onOpenUser}
        />
      </div>

      {/* Nome numa linha e controles na outra: com quatro botoes numa coluna
          de 240px, tudo na mesma linha sobrava uma letra pro nome. */}
      <div className="userbar">
        <button
          className="userbar__id userbar__id--botao"
          onClick={onOpenProfile}
          title="Seu perfil — e onde se troca o status"
        >
          <span className="userbar__foto">
            <Avatar url={me.avatarUrl} name={me.name} size={32} />
            <span
              className="bolinha bolinha--borda"
              style={{ background: STATUS[status].cor }}
            />
          </span>
          <div className="userbar__info">
            <div className="userbar__name">{me.name}</div>
            <div className={`userbar__status${activeChannel ? ' userbar__status--connected' : ''}`}>
              {conexao ?? STATUS[status].label}
            </div>
          </div>
        </button>

        <div className="userbar__actions">
          <button
            className={`iconbtn${!micOn ? ' iconbtn--on' : ''}`}
            onClick={onToggleMic}
            disabled={!activeChannel}
            title={pttMode ? 'Em modo apertar para falar' : 'Microfone'}
          >
            {micOn ? <IconMic /> : <IconMicOff />}
          </button>

          <button
            className={`iconbtn${deafened ? ' iconbtn--on' : ''}`}
            onClick={onToggleDeafen}
            disabled={!activeChannel}
            title="Ensurdecer"
          >
            {deafened ? <IconHeadphonesOff /> : <IconHeadphones />}
          </button>

          <button className="iconbtn" onClick={onOpenSettings} title="Configurações">
            <IconSettings />
          </button>

          {activeChannel && (
            <button className="iconbtn" onClick={onLeave} title="Sair do canal">
              <IconLeave />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/**
 * Quem está com o app aberto mas fora de call.
 *
 * Quem está em canal já aparece dentro dele, e repetir a mesma pessoa em
 * dois lugares faria a coluna mentir sobre quanta gente tem online.
 */
function OnlineList({
  users, emCall, meId, onOpenUser,
}: {
  users: UserPresence[];
  emCall: Set<string>;
  meId: string;
  onOpenUser: (identity: string) => void;
}) {
  const fora = users.filter(
    (u) => u.status !== 'offline' && !emCall.has(u.identity) && u.identity !== meId,
  );
  if (fora.length === 0) return null;

  return (
    <>
      <div className="sidebar__label">Online</div>
      {fora.map((u) => (
        <div
          key={u.identity}
          className="member member--away"
          role="button"
          tabIndex={0}
          onClick={() => onOpenUser(u.identity)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenUser(u.identity);
            }
          }}
        >
          <span className="member__foto">
            <Avatar url={u.avatarUrl} name={u.name} size={24} className="member__avatar" />
            <span
              className="bolinha bolinha--borda"
              style={{ background: STATUS[u.status].cor }}
            />
          </span>
          <span className="member__name">{u.name}</span>
        </div>
      ))}
    </>
  );
}

/**
 * Um campo de nome de canal — serve tanto pra criar quanto pra renomear.
 *
 * Enter confirma, Esc e clicar fora cancelam. Fica desabilitado enquanto a
 * chamada não volta, pra dois Enter não virarem dois canais. Nome vazio ou
 * igual ao que já era não chama nada — só fecha.
 */
function NomeCanalInput({
  inicial,
  placeholder,
  onConfirmar,
  onCancelar,
}: {
  inicial: string;
  placeholder?: string;
  onConfirmar: (nome: string) => Promise<void>;
  onCancelar: () => void;
}) {
  const [valor, setValor] = useState(inicial);
  const [ocupado, setOcupado] = useState(false);
  // Guarda síncrona: o Enter (ou o Esc) dispara uma ação e o blur do input
  // desmontando vem logo atrás. Sem isto, dar Enter criaria dois canais, e
  // apertar Esc com algo digitado ainda criaria um no blur.
  const encerrado = useRef(false);

  const cancelar = () => {
    if (encerrado.current) return;
    encerrado.current = true;
    onCancelar();
  };

  const confirmar = async () => {
    if (encerrado.current) return;
    const nome = valor.trim();
    if (!nome || nome === inicial.trim()) {
      cancelar();
      return;
    }
    encerrado.current = true;
    setOcupado(true);
    try {
      await onConfirmar(nome);
    } catch {
      // A rota recusou (nome, rede, ou o 403 que não devia acontecer aqui).
      // Volta pro estado de leitura em vez de deixar o campo preso.
      onCancelar();
    }
  };

  return (
    <form
      className="channel__nome-form"
      onSubmit={(e) => {
        e.preventDefault();
        void confirmar();
      }}
    >
      <input
        className="channel__nome-input"
        autoFocus
        value={valor}
        placeholder={placeholder}
        maxLength={MAX_NOME_CANAL}
        disabled={ocupado}
        onChange={(e) => setValor(e.target.value)}
        onBlur={() => void confirmar()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancelar();
          }
        }}
      />
    </form>
  );
}

/**
 * Uma linha de canal na coluna: o botão de entrar, a lista de quem está
 * dentro e — só pra admin — renomear e apagar.
 *
 * `modo` é o que a linha está mostrando: a leitura normal, o campo de
 * renomear, ou a confirmação de apagar. Um estado só, porque os três são
 * exclusivos e misturar dois seria a linha mentindo sobre o que um clique faz.
 */
function CanalItem({
  ch, active, connecting, members, podeEditar,
  onJoin, onRenomear, onRemover, onVolumeChange, onOpenUser,
}: {
  ch: Channel;
  active: boolean;
  connecting: boolean;
  members: Row[];
  podeEditar: boolean;
  onJoin: (channelId: string) => void;
  onRenomear: (id: string, nome: string) => Promise<void>;
  onRemover: (id: string) => Promise<void>;
  onVolumeChange: (identity: string, volume: number) => void;
  onOpenUser: (identity: string) => void;
}) {
  const [modo, setModo] = useState<'normal' | 'renomeando' | 'apagando'>('normal');

  return (
    <div className={`channel${active ? ' channel--active' : ''}`}>
      {modo === 'renomeando' ? (
        <NomeCanalInput
          inicial={ch.name}
          onConfirmar={async (nome) => {
            await onRenomear(ch.id, nome);
            setModo('normal');
          }}
          onCancelar={() => setModo('normal')}
        />
      ) : (
        <div className="channel__linha">
          <button
            className="channel__head"
            onClick={() => onJoin(ch.id)}
            disabled={connecting}
          >
            <span className="channel__icon"><IconSpeaker size={17} /></span>
            <span className="channel__name">{ch.name}</span>
            {members.length > 0 && modo === 'normal' && (
              <span className="channel__count">{members.length}</span>
            )}
          </button>

          {podeEditar && modo === 'normal' && (
            <div className="channel__acoes">
              <button
                className="channel__acao"
                title="Renomear"
                onClick={() => setModo('renomeando')}
              >
                <IconLapis size={13} />
              </button>
              <button
                className="channel__acao"
                title="Apagar canal"
                onClick={() => setModo('apagando')}
              >
                <IconLixeira size={13} />
              </button>
            </div>
          )}

          {podeEditar && modo === 'apagando' && (
            <div className="channel__confirma">
              <span>Apagar?</span>
              <button
                className="channel__confirma-sim"
                onClick={async () => {
                  try {
                    await onRemover(ch.id);
                  } finally {
                    setModo('normal');
                  }
                }}
              >
                sim
              </button>
              <button onClick={() => setModo('normal')}>não</button>
            </div>
          )}
        </div>
      )}

      {members.length > 0 && modo === 'normal' && (
        <div className="channel__members">
          {members.map((m) => (
            <MemberRow
              key={m.identity}
              row={m}
              onVolumeChange={onVolumeChange}
              onOpenUser={onOpenUser}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MemberRow({
  row,
  onVolumeChange,
  onOpenUser,
}: {
  row: Row;
  onVolumeChange: (identity: string, volume: number) => void;
  onOpenUser: (identity: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Ajustar volume exige a faixa de áudio em mãos, e ela só existe no canal
  // em que você está. Fora dele a linha é só informativa.
  const adjustable = row.live && !row.isLocal;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="member-wrap" ref={ref}>
      <div
        className={`member${row.isSpeaking ? ' member--speaking' : ''}${row.live ? '' : ' member--away'}`}
        role="button"
        tabIndex={0}
        title={adjustable ? `${row.name} — botão direito para o volume` : row.name}
        onClick={() => onOpenUser(row.identity)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenUser(row.identity);
          }
        }}
        onContextMenu={(e) => {
          if (!adjustable) return;
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        <span className="member__foto">
          <Avatar url={row.avatarUrl} name={row.name} size={24} className="member__avatar" />
          {/* So em quem esta AO VIVO na sua sala: fora dela nao existe
              conexao ao SFU pra medir, e 'unknown' ja sai sem cor. */}
          {row.live && corQualidade(row.connectionQuality) && (
            <span
              className="bolinha bolinha--borda"
              title={tituloQualidade(row.connectionQuality)}
              style={{ background: corQualidade(row.connectionQuality)! }}
            />
          )}
        </span>
        <span className="member__name">{row.name}</span>
        {row.isSharing && <span className="member__tag member__tag--live">AO VIVO</span>}
        {row.isMuted && (
          <span className="member__icon--muted" title="Microfone desligado">
            <IconMicOff size={13} />
          </span>
        )}
        {row.isDeafened && (
          <span className="member__icon--muted" title="Não está ouvindo ninguém">
            <IconHeadphonesOff size={13} />
          </span>
        )}
      </div>

      {open && adjustable && (
        <div className="volume">
          {/* "da voz" porque agora existem dois: este e o do som da tela,
              que fica no próprio quadro da transmissão. */}
          <div className="volume__head">
            <span>Volume da voz</span>
            <span className="volume__value">{Math.round(row.volume * 100)}%</span>
          </div>
          <input
            type="range"
            className="volume__slider"
            min={0}
            max={200}
            step={5}
            value={Math.round(row.volume * 100)}
            onChange={(e) => onVolumeChange(row.identity, Number(e.target.value) / 100)}
          />
        </div>
      )}
    </div>
  );
}
