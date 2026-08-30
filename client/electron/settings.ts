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
  /** identity -> multiplicador de volume (0 a 2) */
  volumes: Record<string, number>;
  overlayEnabled: boolean;
  overlayX: number | null;
  overlayY: number | null;
}

const DEFAULTS: Settings = {
  voiceMode: 'vad',
  pttKeycode: null,
  pttKeyLabel: '',
  micDeviceId: null,
  speakerDeviceId: null,
  volumes: {},
  overlayEnabled: true,
  overlayX: null,
  overlayY: null,
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
    next = { ...DEFAULTS, ...raw, volumes: { ...(raw.volumes ?? {}) } };
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
  'speakerDeviceId', 'volumes', 'overlayEnabled', 'overlayX', 'overlayY',
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
