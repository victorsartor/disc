import { useEffect, useRef, useState } from 'react';
import type { Channel, Me, Presence } from '../types';
import type { Peer } from '../lib/useRoom';
import {
  IconSpeaker, IconMic, IconMicOff, IconHeadphones,
  IconHeadphonesOff, IconLeave, IconSettings,
} from './Icons';
import { Avatar } from './Profile';
import logo from '../assets/logo.png';

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
}

interface Props {
  me: Me;
  channels: Channel[];
  activeChannel: string | null;
  peers: Peer[];
  presence: Presence;
  connecting: boolean;
  micOn: boolean;
  deafened: boolean;
  pttMode: boolean;
  pttDown: boolean;
  onJoin: (channelId: string) => void;
  onLeave: () => void;
  onToggleMic: () => void;
  onToggleDeafen: () => void;
  onVolumeChange: (identity: string, volume: number) => void;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
  /** Abre o perfil de quem foi clicado — inclusive o seu. */
  onOpenUser: (identity: string) => void;
}

export function Sidebar({
  me, channels, activeChannel, peers, presence, connecting, micOn, deafened,
  pttMode, pttDown, onJoin, onLeave, onToggleMic, onToggleDeafen,
  onVolumeChange, onOpenSettings, onOpenProfile, onOpenUser,
}: Props) {
  const status = connecting
    ? 'conectando...'
    : !activeChannel
      ? 'offline'
      : pttMode
        ? (pttDown ? 'falando' : 'aperte para falar')
        : 'conectado';

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <img className="sidebar__logo" src={logo} alt="" />
        Disneia
      </div>

      <div className="sidebar__scroll">
        <div className="sidebar__label">Canais de voz</div>

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
              }));

          return (
            <div key={ch.id} className={`channel${active ? ' channel--active' : ''}`}>
              <button className="channel__head" onClick={() => onJoin(ch.id)} disabled={connecting}>
                <span className="channel__icon"><IconSpeaker size={17} /></span>
                <span className="channel__name">{ch.name}</span>
                {members.length > 0 && <span className="channel__count">{members.length}</span>}
              </button>

              {members.length > 0 && (
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
        })}
      </div>

      {/* Nome numa linha e controles na outra: com quatro botoes numa coluna
          de 240px, tudo na mesma linha sobrava uma letra pro nome. */}
      <div className="userbar">
        <button
          className="userbar__id userbar__id--botao"
          onClick={onOpenProfile}
          title="Seu perfil"
        >
          <Avatar url={me.avatarUrl} name={me.name} size={32} />
          <div className="userbar__info">
            <div className="userbar__name">{me.name}</div>
            <div className={`userbar__status${activeChannel ? ' userbar__status--connected' : ''}`}>
              {status}
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
        <Avatar url={row.avatarUrl} name={row.name} size={24} className="member__avatar" />
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
