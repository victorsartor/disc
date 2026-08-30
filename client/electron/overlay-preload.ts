import { contextBridge, ipcRenderer } from 'electron';

export interface OverlayPeer {
  identity: string;
  name: string;
  avatarUrl: string | null;
  isSpeaking: boolean;
  isMuted: boolean;
  isSharing: boolean;
}

export interface OverlayState {
  channelName: string | null;
  peers: OverlayPeer[];
  micOn: boolean;
  pttActive: boolean;
}

const api = {
  onState: (cb: (state: OverlayState) => void) => {
    const h = (_e: unknown, s: OverlayState) => cb(s);
    ipcRenderer.on('overlay:state', h);
    return () => ipcRenderer.off('overlay:state', h);
  },
  /** Liga/desliga o click-through enquanto o mouse passa pela alça. */
  setInteractive: (v: boolean) => ipcRenderer.send('overlay:interactive', v),
};

contextBridge.exposeInMainWorld('overlay', api);

export type OverlayApi = typeof api;
