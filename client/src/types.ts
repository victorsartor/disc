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

export interface Message {
  id: number;
  body: string;
  created_at: number;
  user_id: string;
  author_name: string;
  author_avatar: string | null;
}

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

export interface Settings {
  voiceMode: VoiceMode;
  pttKeycode: number | null;
  pttKeyLabel: string;
  micDeviceId: string | null;
  speakerDeviceId: string | null;
  volumes: Record<string, number>;
  overlayEnabled: boolean;
  overlayX: number | null;
  overlayY: number | null;
  /** Falso em Wayland e onde o hook global de teclado nao sobe. */
  pttAvailable: boolean;
}

export interface DiscApi {
  auth: {
    status(): Promise<boolean>;
    login(): Promise<void>;
    logout(): Promise<void>;
    onChanged(cb: (loggedIn: boolean) => void): () => void;
  };
  me(): Promise<Me>;
  messages(): Promise<{ messages: Message[] }>;
  sendMessage(body: string): Promise<{ message: Message }>;
  roomToken(channelId: string): Promise<RoomTokenResponse>;
  whipConfig(channelId: string): Promise<WhipConfig>;
  screenSources(): Promise<ScreenSource[]>;
  copy(text: string): Promise<void>;
  settings: {
    get(): Promise<Settings>;
    patch(patch: Partial<Settings>): Promise<Settings>;
    captureKey(): Promise<{ keycode: number; label: string } | null>;
    cancelKeyCapture(): Promise<void>;
    setVolume(identity: string, volume: number): Promise<void>;
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
