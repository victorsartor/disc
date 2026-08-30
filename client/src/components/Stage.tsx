import { useEffect, useRef } from 'react';
import type { RemoteTrack } from 'livekit-client';
import type { ScreenFeed } from '../lib/useRoom';
import { IconBroadcast } from './Icons';

export function Stage({ screens }: { screens: ScreenFeed[] }) {
  if (screens.length === 0) return null;

  return (
    <div className="stage">
      {screens.map((s) => (
        <div className="tile" key={s.identity}>
          <VideoTile track={s.track} />
          <div className="tile__label">
            <IconBroadcast size={13} />
            {s.name}
          </div>
        </div>
      ))}
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
