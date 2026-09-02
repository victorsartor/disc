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
  sendMessage: (body: string, attachmentId?: string, poll?: unknown, replyToId?: number) =>
    ipcRenderer.invoke('api:send-message', body, attachmentId, poll, replyToId),
  editMessage: (id: number, body: string) =>
    ipcRenderer.invoke('api:edit-message', id, body),
  deleteMessage: (id: number) => ipcRenderer.invoke('api:delete-message', id),
  purgeMessage: (id: number) => ipcRenderer.invoke('api:purge-message', id),
  reactMessage: (id: number, emoji: string) =>
    ipcRenderer.invoke('api:react-message', id, emoji),
  markRead: (messageId: number) => ipcRenderer.invoke('api:mark-read', messageId),

  polls: {
    of: (id: number) => ipcRenderer.invoke('api:poll', id),
    vote: (id: number, options: number[]) => ipcRenderer.invoke('api:poll-vote', id, options),
  },

  audio: {
    // Linux: orquestra o servidor de som por fora.
    isolar: () => ipcRenderer.invoke('audio:isolar'),
    liberar: () => ipcRenderer.invoke('audio:liberar'),
    disponivel: () => ipcRenderer.invoke('audio:disponivel'),
    // Windows: o addon nativo entrega quadros PCM, que viram faixa aqui.
    iniciar: (taxa: number, canais: number) =>
      ipcRenderer.invoke('audio:iniciar', taxa, canais),
    parar: () => ipcRenderer.invoke('audio:parar'),
    onQuadros: (cb: (amostras: Float32Array) => void) => {
      const h = (_e: unknown, buf: Uint8Array) => {
        // Float32Array exige deslocamento multiplo de 4, e um Buffer que
        // atravessa o IPC pode chegar como VISTA de um bloco maior, com
        // deslocamento qualquer. Nesse caso a construcao direta lanca
        // RangeError - em producao, no meio de uma transmissao.
        //
        // Alem do alinhamento, so vale a pena seguir adiante com um buffer
        // que seja SO nosso: o lado de la transfere a posse pro worklet, e
        // transferir uma vista arrastaria o bloco inteiro junto.
        const proprio =
          buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
            ? buf
            : new Uint8Array(buf); // copia, ja alinhada e do tamanho certo
        cb(new Float32Array(proprio.buffer, 0, proprio.byteLength / 4));
      };
      ipcRenderer.on('audio:quadros', h);
      return () => ipcRenderer.off('audio:quadros', h);
    },
  },

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
    onProgress: (cb: (percent: number) => void) => {
      const h = (_e: unknown, percent: number) => cb(percent);
      ipcRenderer.on('upload:progress', h);
      return () => ipcRenderer.off('upload:progress', h);
    },
  },
  roomToken: (channelId: string) => ipcRenderer.invoke('api:room-token', channelId),
  whipConfig: (channelId: string) => ipcRenderer.invoke('api:whip-config', channelId),

  profile: {
    of: (identity: string) => ipcRenderer.invoke('api:user', identity),
    patch: (patch: unknown) => ipcRenderer.invoke('api:profile-patch', patch),
    image: (kind: 'avatar' | 'banner', dataUrl: string | null) =>
      ipcRenderer.invoke('api:profile-image', kind, dataUrl),
  },

  /**
   * Cores dos botoes de janela: a barra e do SO e nao le o CSS do tema.
   *
   * `bg` e o fundo da janela (--level-1). Nao muda nada agora - a janela ja
   * esta aberta e o CSS ja pintou por cima - mas fica guardado pra proxima
   * abertura, que e quando a cor errada apareceria como flash.
   */
  titlebar: (color: string, symbolColor: string, bg?: string): Promise<void> =>
    ipcRenderer.invoke('window:titlebar', color, symbolColor, bg),

  screenSources: () => ipcRenderer.invoke('screen:sources'),

  /** No Wayland quem escolhe a tela e o portal do sistema, nao o nosso modal. */
  platform: process.platform,

  copy: (text: string) => ipcRenderer.invoke('clipboard:write', text),

  /** Balaozinho do sistema. So sai com a janela fora de foco - o main confere. */
  notificarMencao: (autor: string, corpo: string): Promise<void> =>
    ipcRenderer.invoke('notify:mention', autor, corpo),

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
    /** A funcao que ja ocupa esta tecla ('ptt', uma acao, ou null). */
    keyInUse: (keycode: number, exceto?: string) =>
      ipcRenderer.invoke('settings:key-in-use', keycode, exceto),
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

  /**
   * Atalho global apertado. Chega so o NOME da acao ('mudo', 'surdo') - quem
   * decide o que ela faz e este lado, que e onde o estado do microfone mora.
   */
  onAtalho: (cb: (acao: string) => void) => {
    const h = (_e: unknown, acao: string) => cb(acao);
    ipcRenderer.on('atalho:acionado', h);
    return () => ipcRenderer.off('atalho:acionado', h);
  },
};

contextBridge.exposeInMainWorld('disc', api);

export type DiscApi = typeof api;
