import { uIOhook, UiohookKey } from 'uiohook-napi';
import { getSettings, patchSettings } from './settings.js';

/**
 * Hold-to-talk global.
 *
 * O globalShortcut do Electron so dispara no keydown - nao existe keyup -,
 * entao push-to-talk de verdade exige um hook de teclado no nivel do SO.
 *
 * SEGURANCA, duas garantias:
 *
 * 1. O hook so sobe quando o usuario escolhe o modo "apertar para falar".
 *    No modo padrao (deteccao de voz) nenhum hook de teclado existe.
 * 2. Enquanto ativo, ele so compara o keycode com a tecla vinculada e
 *    descarta o resto na hora. Nada e gravado, acumulado ou enviado pra
 *    lugar nenhum. A unica excecao e o modo de captura, que le UMA tecla
 *    para o usuario vincular e se encerra.
 */

type Listener = (down: boolean) => void;

let handlersBound = false;
let running = false;
let available = true; // otimista ate uma tentativa de start falhar
let listener: Listener | null = null;
let captureResolve: ((key: CapturedKey) => void) | null = null;
let held = false;

/**
 * Nomes das teclas. A base vem do proprio UiohookKey invertido - assim nao
 * dependemos de eu ter decorado keycode certo. Por cima disso, nomes em
 * portugues para as teclas que a galera realmente usa em PTT.
 */
const FROM_LIB: Record<number, string> = Object.fromEntries(
  Object.entries(UiohookKey)
    .filter(([, code]) => typeof code === 'number')
    .map(([name, code]) => [code as number, name]),
);

const PT_BR: Record<number, string> = {
  [UiohookKey.Ctrl]: 'Ctrl esquerdo',
  [UiohookKey.CtrlRight]: 'Ctrl direito',
  [UiohookKey.Shift]: 'Shift esquerdo',
  [UiohookKey.ShiftRight]: 'Shift direito',
  [UiohookKey.Alt]: 'Alt esquerdo',
  [UiohookKey.AltRight]: 'Alt direito',
  [UiohookKey.Meta]: 'Windows',
  [UiohookKey.Space]: 'Espaco',
  [UiohookKey.CapsLock]: 'Caps Lock',
  [UiohookKey.Backquote]: 'Crase',
};

/** Esc nao vira atalho: e o jeito de cancelar a captura. */
const ESC = UiohookKey.Escape;

export function labelFor(keycode: number): string {
  return PT_BR[keycode] ?? FROM_LIB[keycode] ?? `Tecla ${keycode}`;
}

export function isAvailable(): boolean {
  return available;
}

export function isRunning(): boolean {
  return running;
}

export function init(onChange: Listener): void {
  listener = onChange;
}

function bindHandlers(): void {
  if (handlersBound) return;

  uIOhook.on('keydown', (e) => {
    // Modo de captura: le a proxima tecla e encerra imediatamente.
    if (captureResolve) {
      const resolve = captureResolve;
      captureResolve = null;
      // Esc cancela em vez de virar atalho - e o que todo mundo espera.
      if (e.keycode === ESC) resolve(null);
      else resolve({ keycode: e.keycode, label: labelFor(e.keycode) });
      return;
    }

    const s = getSettings();
    if (s.voiceMode !== 'ptt' || s.pttKeycode === null) return;
    if (e.keycode !== s.pttKeycode) return; // qualquer outra tecla e ignorada
    if (held) return;                        // ignora auto-repeat do SO
    held = true;
    listener?.(true);
  });

  uIOhook.on('keyup', (e) => {
    const s = getSettings();
    if (s.voiceMode !== 'ptt' || s.pttKeycode === null) return;
    if (e.keycode !== s.pttKeycode) return;
    if (!held) return;
    held = false;
    listener?.(false);
  });

  handlersBound = true;
}

function start(): boolean {
  if (running) return true;
  try {
    bindHandlers();
    uIOhook.start();
    running = true;
    available = true;
  } catch (err) {
    // Acontece principalmente em Wayland, que bloqueia captura global de
    // teclado por design. O app continua funcionando no modo VAD.
    console.warn('hook de teclado global indisponivel:', err);
    available = false;
    running = false;
  }
  return running;
}

function stop(): void {
  if (!running) return;
  try {
    uIOhook.stop();
  } catch {
    /* ja parado */
  }
  running = false;
  // Soltar a tecla enquanto o hook morre deixaria o mic aberto pra sempre.
  if (held) {
    held = false;
    listener?.(false);
  }
}

/**
 * Liga ou desliga o hook conforme o modo de voz escolhido.
 * Chamado no boot e a cada mudanca de configuracao.
 */
export function syncWithSettings(): void {
  if (getSettings().voiceMode === 'ptt') start();
  else stop();
}

export function shutdown(): void {
  stop();
}

type CapturedKey = { keycode: number; label: string } | null;

/** Le a proxima tecla pressionada e vincula como PTT. Esc cancela. */
export function captureKey(timeoutMs = 15000): Promise<CapturedKey> {
  // A captura acontece dentro das configuracoes, com o modo PTT ja escolhido,
  // mas garantimos o hook de pe de qualquer forma.
  if (!start()) return Promise.resolve(null);

  // Uma captura anterior ainda pendurada e descartada antes de comecar.
  cancelCapture();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      captureResolve = null;
      resolve(null);
    }, timeoutMs);

    captureResolve = (key) => {
      clearTimeout(timer);
      if (key) patchSettings({ pttKeycode: key.keycode, pttKeyLabel: key.label });
      resolve(key);
    };
  });
}

/** Aborta uma captura em andamento (clique fora, Esc na janela, fechar). */
export function cancelCapture(): void {
  const resolve = captureResolve;
  captureResolve = null;
  resolve?.(null);
}
