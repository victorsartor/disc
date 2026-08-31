export interface Channel {
  id: string;
  name: string;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  channels: Channel[];
  livekitUrl: string;
}

/**
 * O perfil de alguém, visto por qualquer pessoa do servidor.
 *
 * É o que abre ao clicar num nome — inclusive no seu. Vem do servidor a
 * cada abertura, então uma foto trocada pelo outro lado aparece aqui sem
 * precisar reiniciar o app.
 */
export interface UserProfile {
  id: string;
  name: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string;
  statusText: string;
}

/**
 * Como o chat desenha o anexo. Vem decidido do servidor, não do mime.
 *
 * 'image' aparece na conversa e amplia no clique, 'audio' ganha um player,
 * 'file' vira cartão pra baixar. O servidor só marca image/audio pra
 * formato que ele mesmo se dispõe a servir com o content-type de verdade —
 * o resto cai em 'file' e desce como octet-stream.
 */
export type AttachmentKind = 'image' | 'audio' | 'file';

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  /** Bytes. É o que o cartão mostra como "2,4 MB". */
  size: number;
  kind: AttachmentKind;
  /**
   * Endereço pronto pra <img> e <audio>, montado pelo servidor — mesma
   * escolha da foto de perfil. Sem sessão: tag não manda header de
   * autorização, e quem protege é o id aleatório mais a tailnet.
   */
  url: string;
}

export interface Message {
  id: number;
  body: string;
  created_at: number;
  user_id: string;
  author_name: string;
  author_avatar: string | null;
  /**
   * Vazio na esmagadora maioria das mensagens. Pode faltar por completo
   * numa mensagem que chegou pelo data channel de um app antigo, daí o
   * opcional — quem lê precisa tratar undefined.
   */
  attachments?: Attachment[];
}

/**
 * Quem está num canal, visto de fora dele.
 *
 * Vem do servidor (que pergunta ao LiveKit), não da sala — por isso tem
 * menos informação que um Peer: sem "falando agora", sem volume. Essas
 * duas só existem para o canal em que você está.
 */
export interface PresenceMember {
  identity: string;
  name: string;
  avatarUrl: string | null;
  isMuted: boolean;
  isSharing: boolean;
}

/** canalId -> quem está lá dentro */
export type Presence = Record<string, PresenceMember[]>;

/** O que a pessoa escolhe no seletor da sidebar. */
export type StatusEscolhido = 'disponivel' | 'ausente' | 'invisivel';

/** O que se vê dos outros. 'invisivel' nunca chega aqui: vira 'offline'. */
export type StatusEfetivo = 'disponivel' | 'ausente' | 'offline';

/** Todo mundo do servidor, esteja em call ou não. */
export interface UserPresence {
  identity: string;
  name: string;
  avatarUrl: string | null;
  status: StatusEfetivo;
}

export interface ScreenSource {
  id: string;
  name: string;
  /** null quando o sistema nao entrega miniatura — o caso do Wayland. */
  thumbnail: string | null;
  isScreen: boolean;
}

export interface RoomTokenResponse {
  token: string;
  url: string;
  channelId: string;
}

export interface WhipConfig {
  endpoint: string;
  bearerToken: string;
  channelId: string;
}

export type VoiceMode = 'vad' | 'ptt';

/** Tecla do push-to-talk: keycode do uiohook + como mostrar na tela. */
export interface KeyBinding {
  keycode: number;
  label: string;
}

export interface Settings {
  voiceMode: VoiceMode;
  pttKeycode: number | null;
  pttKeyLabel: string;
  micDeviceId: string | null;
  speakerDeviceId: string | null;
  /** Corte do portão de ruído, 0 a 100. 0 desliga o portão. */
  micSensitivity: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  volumes: Record<string, number>;
  /** identity -> volume do som da tela daquela pessoa (0 a 2). */
  screenVolumes: Record<string, number>;
  /**
   * Volume geral da voz, 0 a 100. Multiplica o slider de cada pessoa — não
   * substitui, então quem já tinha alguém baixado mantém a proporção.
   */
  voiceVolume: number;
  /** Volume dos sons de evento (entrar, sair, tela, notificação), 0 a 100. */
  effectsVolume: number;
  /** Volume dos áudios que as pessoas mandam no chat, 0 a 100. */
  chatVolume: number;
  /**
   * Dispositivo de onde tirar o som ao compartilhar tela no Linux.
   *
   * Existe porque o Chromium nao captura som de sistema no Linux: la o jeito
   * e gravar de um "monitor" do PipeWire, que aparece como se fosse
   * microfone. null = compartilhar so o video.
   */
  screenAudioDeviceId: string | null;
  overlayEnabled: boolean;
  overlayX: number | null;
  overlayY: number | null;
  /** Um dos ids de lib/themes.ts. Vale pra maquina, nao pra conta. */
  theme: string;
  /** Falso em Wayland e onde o hook global de teclado nao sobe. */
  pttAvailable: boolean;
}

/** Espelha o UpdateState do processo main (electron/updater.ts). */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | {
      status: 'downloading';
      version: string;
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

export interface DiscApi {
  auth: {
    status(): Promise<boolean>;
    login(): Promise<void>;
    logout(): Promise<void>;
    onChanged(cb: (loggedIn: boolean) => void): () => void;
  };
  update: {
    state(): Promise<UpdateState>;
    skip(): Promise<void>;
    version(): Promise<string>;
    onState(cb: (state: UpdateState) => void): () => void;
  };
  me(): Promise<Me>;
  messages(): Promise<{ messages: Message[] }>;
  presence(): Promise<{ channels: Presence; users: UserPresence[] }>;
  /** Batimento do app aberto. `ativo` renova o relógio dos 10 minutos. */
  heartbeat(ativo: boolean): Promise<{ status: StatusEfetivo }>;
  setStatus(status: StatusEscolhido): Promise<{ status: StatusEscolhido }>;
  sendMessage(body: string, attachmentId?: string): Promise<{ message: Message }>;
  arquivos: {
    /**
     * Sobe um arquivo do disco pelo CAMINHO, não pelos bytes.
     *
     * O processo main lê do disco e faz stream direto pro servidor: 200 MB
     * atravessando o IPC seriam copiados na memória dos dois lados. O
     * caminho sai do webUtils.getPathForFile — `File.path` foi removido no
     * Electron 32.
     */
    enviar(caminho: string): Promise<{ attachment: Attachment }>;
    /** Imagem já reduzida no renderer: pequena, então os bytes podem vir. */
    enviarImagem(bytes: Uint8Array, nome: string, mime: string): Promise<{ attachment: Attachment }>;
    /** Abre a janela de salvar e baixa. `false` = a pessoa cancelou. */
    baixar(id: string, nome: string): Promise<{ salvo: boolean }>;
    /** Caminho no disco de um File escolhido no seletor. */
    caminhoDe(file: File): string;
  };
  roomToken(channelId: string): Promise<RoomTokenResponse>;
  whipConfig(channelId: string): Promise<WhipConfig>;
  profile: {
    /** Perfil de qualquer um, pela identity do LiveKit ou pelo id. */
    of(identity: string): Promise<{ user: UserProfile }>;
    patch(patch: { name?: string; bio?: string; statusText?: string }): Promise<{ user: UserProfile }>;
    /** dataUrl null remove: a capa some, a foto volta pra do Google. */
    image(kind: 'avatar' | 'banner', dataUrl: string | null): Promise<{ user: UserProfile }>;
  };
  /** Cores dos botões de janela: a barra é do SO e não lê o CSS do tema. */
  titlebar(color: string, symbolColor: string): Promise<void>;
  screenSources(): Promise<ScreenSource[]>;
  /** 'linux', 'win32', 'darwin' — decide quem desenha o seletor de tela. */
  platform: string;
  copy(text: string): Promise<void>;
  settings: {
    get(): Promise<Settings>;
    patch(patch: Partial<Settings>): Promise<Settings>;
    captureKey(): Promise<KeyBinding | null>;
    cancelKeyCapture(): Promise<void>;
    resolveKey(code: string, printable?: string): Promise<KeyBinding | null>;
    setVolume(identity: string, volume: number): Promise<void>;
    setScreenVolume(identity: string, volume: number): Promise<void>;
  };
  overlay: {
    toggle(): Promise<boolean>;
    push(state: unknown): void;
    onEnabled(cb: (enabled: boolean) => void): () => void;
  };
  onPushToTalk(cb: (down: boolean) => void): () => void;
}

declare global {
  interface Window {
    disc: DiscApi;
  }
}
