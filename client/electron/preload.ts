import { contextBridge, ipcRenderer } from 'electron';

/**
 * Unica ponte entre o processo main e o renderer.
 * Nada de ipcRenderer solto - so estes metodos, com assinatura fixa.
 */
const api = {
  auth: {
    status: (): Promise<boolean> => ipcRenderer.invoke('auth:status'),
    login: (): Promise<void> => ipcRenderer.invoke('auth:login'),
    logout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
    onChanged: (cb: (loggedIn: boolean) => void) => {
      const h = (_e: unknown, v: boolean) => cb(v);
      ipcRenderer.on('auth:changed', h);
      return () => ipcRenderer.off('auth:changed', h);
    },
  },

  me: () => ipcRenderer.invoke('api:me'),
  messages: () => ipcRenderer.invoke('api:messages'),
  sendMessage: (body: string) => ipcRenderer.invoke('api:send-message', body),
  roomToken: (channelId: string) => ipcRenderer.invoke('api:room-token', channelId),
  whipConfig: (channelId: string) => ipcRenderer.invoke('api:whip-config', channelId),

  screenSources: () => ipcRenderer.invoke('screen:sources'),

  copy: (text: string) => ipcRenderer.invoke('clipboard:write', text),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    patch: (patch: unknown) => ipcRenderer.invoke('settings:patch', patch),
    captureKey: () => ipcRenderer.invoke('settings:capture-key'),
    cancelKeyCapture: () => ipcRenderer.invoke('settings:cancel-capture'),
    resolveKey: (code: string, printable?: string) =>
      ipcRenderer.invoke('settings:resolve-key', code, printable),
    setVolume: (identity: string, volume: number) =>
      ipcRenderer.invoke('settings:set-volume', identity, volume),
  },

  overlay: {
    toggle: (): Promise<boolean> => ipcRenderer.invoke('overlay:toggle'),
    push: (state: unknown) => ipcRenderer.send('overlay:state', state),
    onEnabled: (cb: (enabled: boolean) => void) => {
      const h = (_e: unknown, v: boolean) => cb(v);
      ipcRenderer.on('overlay:enabled', h);
      return () => ipcRenderer.off('overlay:enabled', h);
    },
  },

  /** Hold-to-talk: true no keydown, false no keyup. */
  onPushToTalk: (cb: (down: boolean) => void) => {
    const h = (_e: unknown, down: boolean) => cb(down);
    ipcRenderer.on('ptt:state', h);
    return () => ipcRenderer.off('ptt:state', h);
  },
};

contextBridge.exposeInMainWorld('disc', api);

export type DiscApi = typeof api;
