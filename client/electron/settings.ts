import { app } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

export type VoiceMode = 'vad' | 'ptt';

export interface Settings {
  voiceMode: VoiceMode;
  /** Keycode do uiohook. null = nenhuma tecla vinculada ainda. */
  pttKeycode: number | null;
  pttKeyLabel: string;
  micDeviceId: string | null;
  speakerDeviceId: string | null;
  /**
   * Corte do portao de ruido, de 0 a 100, na mesma escala do medidor.
   * 0 desliga o portao: tudo que o microfone captar vai pro ar.
   */
  micSensitivity: number;
  /** Supressao de ruido do proprio Chromium (WebRTC NS). */
  noiseSuppression: boolean;
  echoCancellation: boolean;
  /** Ganho automatico. Ligado, ele AMPLIFICA o silencio entre as frases -
   *  e a causa classica de "meu microfone pega tudo". */
  autoGainControl: boolean;
  /** identity -> multiplicador de volume da VOZ (0 a 2) */
  volumes: Record<string, number>;
  /** identity -> volume do SOM DA TELA daquela pessoa (0 a 1) */
  screenVolumes: Record<string, number>;
  /**
   * Volume geral da voz, de 0 a 100. MULTIPLICA o slider de cada pessoa em
   * vez de substitui-lo: quem ja tinha alguem baixado continua com ele
   * baixado em relacao aos outros.
   */
  voiceVolume: number;
  /** Volume dos sons de evento (entrar, sair, tela, notificacao), 0 a 100. */
  effectsVolume: number;
  /** Volume dos audios que as pessoas mandam no chat, 0 a 100. */
  chatVolume: number;
  /** Monitor do PipeWire de onde tirar o som da tela no Linux. */
  screenAudioDeviceId: string | null;
  overlayEnabled: boolean;
  overlayX: number | null;
  overlayY: number | null;
  /** Id de um dos temas em src/lib/themes.ts. Preferencia da maquina. */
  theme: string;
  /**
   * As tres cores do tema em vigor, em hex, gravadas pelo renderer a cada
   * troca de tema.
   *
   * Nao sao fonte da verdade - o themes.css e. Elas existem porque a JANELA
   * nasce antes do CSS: o BrowserWindow precisa de uma cor de fundo e de uma
   * cor de barra de titulo no construtor, e ate a 0.26 essas duas eram o
   * azul do Abissal, fixas. Em qualquer tema que nao fosse o padrao isso era
   * um flash da cor errada em toda abertura - e no Total Black, um flash
   * azul-marinho sobre um app preto.
   *
   * Guardar o valor JA RESOLVIDO (e nao o id do tema) evita duplicar a
   * tabela de cores aqui dentro, que e o que faria o main e o CSS
   * divergirem na primeira vez que uma cor mudasse.
   */
  themeBg: string;
  themeBar: string;
  themeSymbol: string;
}

const DEFAULTS: Settings = {
  voiceMode: 'vad',
  pttKeycode: null,
  pttKeyLabel: '',
  micDeviceId: null,
  speakerDeviceId: null,
  // 8 corta ventilador e ar-condicionado sem engolir quem fala baixo. Quem
  // quiser o comportamento antigo (tudo passa) e so zerar.
  micSensitivity: 8,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  volumes: {},
  screenVolumes: {},
  voiceVolume: 100,
  effectsVolume: 100,
  chatVolume: 100,
  screenAudioDeviceId: null,
  overlayEnabled: true,
  overlayX: null,
  overlayY: null,
  theme: 'abissal',
  // Os do Abissal, que e o tema padrao. Valem so ate a primeira troca.
  themeBg: '#0d1b2a',
  themeBar: '#1b263b',
  themeSymbol: '#e0e1dd',
};

let cache: Settings | null = null;

const file = () => join(app.getPath('userData'), 'settings.json');

/** Um 0 a 100 valido, ou o padrao. Usado na leitura e no patch. */
function percentual(v: unknown, padrao: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** Um #rrggbb valido, ou o padrao. Usado na leitura; o patch tem o seu. */
function cor(v: unknown, padrao: string): string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())
    ? v.trim()
    : padrao;
}

export function getSettings(): Settings {
  if (cache) return cache;

  let next: Settings;
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    if (typeof raw !== 'object' || raw === null) throw new Error('formato invalido');
    // Merge raso contra os defaults: campo novo em versao nova nao quebra
    // um settings.json antigo.
    next = {
      ...DEFAULTS,
      ...raw,
      // Os mapas sao clonados a parte: o spread copiaria a referencia do JSON
      // lido, e um settings.json antigo (sem screenVolumes) deixaria o campo
      // como undefined em vez do objeto vazio do DEFAULTS.
      volumes: { ...(raw.volumes ?? {}) },
      screenVolumes: { ...(raw.screenVolumes ?? {}) },
      // Pelo mesmo motivo dos mapas acima: o spread copia o que estiver no
      // arquivo, e um null gravado por uma versao futura ou pela mao de
      // alguem passaria por cima do default e viraria ganho invalido.
      voiceVolume: percentual(raw.voiceVolume, DEFAULTS.voiceVolume),
      effectsVolume: percentual(raw.effectsVolume, DEFAULTS.effectsVolume),
      chatVolume: percentual(raw.chatVolume, DEFAULTS.chatVolume),
      // Pelo mesmo motivo, e com uma consequencia pior: estas tres entram no
      // construtor do BrowserWindow, e um valor invalido ali nao pinta
      // errado - lanca antes de a janela existir. Um settings.json
      // corrompido nao pode ser o motivo de o app nao abrir.
      themeBg: cor(raw.themeBg, DEFAULTS.themeBg),
      themeBar: cor(raw.themeBar, DEFAULTS.themeBar),
      themeSymbol: cor(raw.themeSymbol, DEFAULTS.themeSymbol),
    };
  } catch {
    next = { ...DEFAULTS };
  }

  cache = next;
  return next;
}

/**
 * Chaves aceitas vindas do renderer. O patch chega pelo IPC, entao tratamos
 * como entrada nao confiavel: o que nao estiver aqui e descartado em vez de
 * ir parar no settings.json.
 */
const ALLOWED_KEYS = new Set<keyof Settings>([
  'voiceMode', 'pttKeycode', 'pttKeyLabel', 'micDeviceId',
  'speakerDeviceId', 'micSensitivity', 'noiseSuppression',
  'echoCancellation', 'autoGainControl', 'volumes', 'screenVolumes',
  'voiceVolume', 'effectsVolume', 'chatVolume',
  'screenAudioDeviceId',
  'overlayEnabled', 'overlayX', 'overlayY', 'theme',
  'themeBg', 'themeBar', 'themeSymbol',
]);

/**
 * Chaves cujo valor tambem e checado, e nao so o nome.
 *
 * Estas viram ganho de Web Audio do outro lado, e ali um NaN nao e um som
 * errado: e uma excecao que derruba o no de audio. Um valor negativo
 * inverte a fase em vez de abaixar. Como e o unico lugar por onde elas
 * entram, o conserto fica aqui.
 */
const PERCENT_KEYS = new Set<keyof Settings>([
  'voiceVolume', 'effectsVolume', 'chatVolume',
]);

/**
 * Chaves que so aceitam #rrggbb.
 *
 * Pelo mesmo motivo das PERCENT_KEYS: do outro lado elas viram argumento do
 * BrowserWindow e do setTitleBarOverlay, e ali um valor invalido nao pinta
 * errado - lanca. Como o patch chega pelo IPC, a checagem mora aqui.
 */
const COLOR_KEYS = new Set<keyof Settings>([
  'themeBg', 'themeBar', 'themeSymbol',
]);

const HEX = /^#[0-9a-f]{6}$/i;

export function sanitizePatch(input: unknown): Partial<Settings> {
  if (typeof input !== 'object' || input === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!ALLOWED_KEYS.has(k as keyof Settings)) continue;
    // Lixo aqui e descartado em vez de virar o padrao: o patch e parcial, e
    // deixar de fora preserva o que ja estava salvo.
    if (PERCENT_KEYS.has(k as keyof Settings)) {
      if (!Number.isFinite(Number(v))) continue;
      out[k] = percentual(v, 100);
      continue;
    }
    if (COLOR_KEYS.has(k as keyof Settings)) {
      if (typeof v !== 'string' || !HEX.test(v.trim())) continue;
      out[k] = v.trim();
      continue;
    }
    out[k] = v;
  }
  return out as Partial<Settings>;
}

export function patchSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  cache = next;
  try {
    writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('nao consegui gravar settings', err);
  }
  return next;
}

export function setVolume(identity: string, volume: number): void {
  const s = getSettings();
  patchSettings({ volumes: { ...s.volumes, [identity]: volume } });
}

export function setScreenVolume(identity: string, volume: number): void {
  const s = getSettings();
  patchSettings({ screenVolumes: { ...s.screenVolumes, [identity]: volume } });
}
