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
  /** Monitor do PipeWire de onde tirar o som da tela no Linux. */
  screenAudioDeviceId: string | null;
  overlayEnabled: boolean;
  overlayX: number | null;
  overlayY: number | null;
  /** Id de um dos temas em src/lib/themes.ts. Preferencia da maquina. */
  theme: string;
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
  screenAudioDeviceId: null,
  overlayEnabled: true,
  overlayX: null,
  overlayY: null,
  theme: 'abissal',
};

let cache: Settings | null = null;

const file = () => join(app.getPath('userData'), 'settings.json');

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
  'screenAudioDeviceId',
  'overlayEnabled', 'overlayX', 'overlayY', 'theme',
]);

export function sanitizePatch(input: unknown): Partial<Settings> {
  if (typeof input !== 'object' || input === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (ALLOWED_KEYS.has(k as keyof Settings)) out[k] = v;
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
