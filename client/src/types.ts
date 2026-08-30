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

export interface Message {
  id: number;
  body: string;
  created_at: number;
  user_id: string;
  author_name: string;
  author_avatar: string | null;
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

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
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
  /** identity -> volume do som da tela daquela pessoa (0 a 1). */
  screenVolumes: Record<string, number>;
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
  presence(): Promise<{ channels: Presence }>;
  sendMessage(body: string): Promise<{ message: Message }>;
  roomToken(channelId: string): Promise<RoomTokenResponse>;
  whipConfig(channelId: string): Promise<WhipConfig>;
  profile: {
    /** Perfil de qualquer um, pela identity do LiveKit ou pelo id. */
    of(identity: string): Promise<{ user: UserProfile }>;
    patch(patch: { bio?: string; statusText?: string }): Promise<{ user: UserProfile }>;
    /** dataUrl null remove: a capa some, a foto volta pra do Google. */
    image(kind: 'avatar' | 'banner', dataUrl: string | null): Promise<{ user: UserProfile }>;
  };
  /** Cores dos botões de janela: a barra é do SO e não lê o CSS do tema. */
  titlebar(color: string, symbolColor: string): Promise<void>;
  screenSources(): Promise<ScreenSource[]>;
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
