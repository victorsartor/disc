import { contextBridge, ipcRenderer, webUtils } from 'electron';

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

  update: {
    state: () => ipcRenderer.invoke('update:state'),
    skip: (): Promise<void> => ipcRenderer.invoke('update:skip'),
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    onState: (cb: (state: unknown) => void) => {
      const h = (_e: unknown, v: unknown) => cb(v);
      ipcRenderer.on('update:state', h);
      return () => ipcRenderer.off('update:state', h);
    },
  },

  me: () => ipcRenderer.invoke('api:me'),
  messages: () => ipcRenderer.invoke('api:messages'),
  presence: () => ipcRenderer.invoke('api:presence'),
  heartbeat: (ativo: boolean) => ipcRenderer.invoke('api:heartbeat', ativo),
  setStatus: (status: string) => ipcRenderer.invoke('api:set-status', status),
  sendMessage: (body: string, attachmentId?: string) =>
    ipcRenderer.invoke('api:send-message', body, attachmentId),

  arquivos: {
    enviar: (caminho: string) => ipcRenderer.invoke('api:upload-file', caminho),
    enviarImagem: (bytes: Uint8Array, nome: string, mime: string) =>
      ipcRenderer.invoke('api:upload-image', bytes, nome, mime),
    baixar: (id: string, nome: string) => ipcRenderer.invoke('api:download-file', id, nome),
    /**
     * Caminho de um File escolhido no seletor.
     *
     * Sincrono e sem IPC: `File.path` foi removido no Electron 32 e este e o
     * substituto oficial. Precisa rodar AQUI, no preload - o webUtils nao
     * existe no renderer, e e justamente essa fronteira que impede uma
     * pagina de inventar um caminho pra ler.
     */
    caminhoDe: (file: File): string => webUtils.getPathForFile(file),
  },
  roomToken: (channelId: string) => ipcRenderer.invoke('api:room-token', channelId),
  whipConfig: (channelId: string) => ipcRenderer.invoke('api:whip-config', channelId),

  profile: {
    of: (identity: string) => ipcRenderer.invoke('api:user', identity),
    patch: (patch: unknown) => ipcRenderer.invoke('api:profile-patch', patch),
    image: (kind: 'avatar' | 'banner', dataUrl: string | null) =>
      ipcRenderer.invoke('api:profile-image', kind, dataUrl),
  },

  /** Cores dos botoes de janela: a barra e do SO e nao le o CSS do tema. */
  titlebar: (color: string, symbolColor: string): Promise<void> =>
    ipcRenderer.invoke('window:titlebar', color, symbolColor),

  screenSources: () => ipcRenderer.invoke('screen:sources'),

  /** No Wayland quem escolhe a tela e o portal do sistema, nao o nosso modal. */
  platform: process.platform,

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
    setScreenVolume: (identity: string, volume: number) =>
      ipcRenderer.invoke('settings:set-screen-volume', identity, volume),
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
