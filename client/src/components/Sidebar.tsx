import { useEffect, useRef, useState } from 'react';
import type { Channel, Me } from '../types';
import type { Peer } from '../lib/useRoom';
import {
  IconSpeaker, IconMic, IconMicOff, IconHeadphones,
  IconHeadphonesOff, IconLeave, IconSettings,
} from './Icons';

interface Props {
  me: Me;
  channels: Channel[];
  activeChannel: string | null;
  peers: Peer[];
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
}

export function Sidebar({
  me, channels, activeChannel, peers, connecting, micOn, deafened,
  pttMode, pttDown, onJoin, onLeave, onToggleMic, onToggleDeafen,
  onVolumeChange, onOpenSettings,
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
        <span className="sidebar__dot" />
        Concord
      </div>

      <div className="sidebar__scroll">
        <div className="sidebar__label">Canais de voz</div>

        {channels.map((ch) => {
          const active = activeChannel === ch.id;
          const members = active ? peers : [];
          return (
            <div key={ch.id} className={`channel${active ? ' channel--active' : ''}`}>
              <button className="channel__head" onClick={() => onJoin(ch.id)} disabled={connecting}>
                <span className="channel__icon"><IconSpeaker size={17} /></span>
                <span className="channel__name">{ch.name}</span>
                {members.length > 0 && <span className="channel__count">{members.length}</span>}
              </button>

              {members.length > 0 && (
                <div className="channel__members">
                  {members.map((p) => (
                    <MemberRow key={p.identity} peer={p} onVolumeChange={onVolumeChange} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="userbar">
        <img className="userbar__avatar" src={me.avatarUrl ?? undefined} alt="" referrerPolicy="no-referrer" />
        <div className="userbar__info">
          <div className="userbar__name">{me.name}</div>
          <div className={`userbar__status${activeChannel ? ' userbar__status--connected' : ''}`}>
            {status}
          </div>
        </div>

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
    </aside>
  );
}

function MemberRow({
  peer,
  onVolumeChange,
}: {
  peer: Peer;
  onVolumeChange: (identity: string, volume: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
        className={`member${peer.isSpeaking ? ' member--speaking' : ''}`}
        title={peer.isLocal ? peer.name : `${peer.name} — botão direito para o volume`}
        onContextMenu={(e) => {
          if (peer.isLocal) return;
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        <img className="member__avatar" src={peer.avatarUrl ?? undefined} alt="" referrerPolicy="no-referrer" />
        <span className="member__name">{peer.name}</span>
        {peer.isSharing && <span className="member__tag member__tag--live">AO VIVO</span>}
        {peer.isMuted && <span className="member__icon--muted"><IconMicOff size={13} /></span>}
      </div>

      {open && !peer.isLocal && (
        <div className="volume">
          <div className="volume__head">
            <span>Volume</span>
            <span className="volume__value">{Math.round(peer.volume * 100)}%</span>
          </div>
          <input
            type="range"
            className="volume__slider"
            min={0}
            max={200}
            step={5}
            value={Math.round(peer.volume * 100)}
            onChange={(e) => onVolumeChange(peer.identity, Number(e.target.value) / 100)}
          />
        </div>
      )}
    </div>
  );
}
