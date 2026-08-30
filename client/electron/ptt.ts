import { uIOhook, UiohookKey } from 'uiohook-napi';
import { getSettings } from './settings.js';

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
  [UiohookKey.Ctrl]: 'Ctrl esq.',
  [UiohookKey.CtrlRight]: 'Ctrl dir.',
  [UiohookKey.Shift]: 'Shift esq.',
  [UiohookKey.ShiftRight]: 'Shift dir.',
  [UiohookKey.Alt]: 'Alt esq.',
  [UiohookKey.AltRight]: 'Alt dir.',
  [UiohookKey.Meta]: 'Windows',
  [UiohookKey.MetaRight]: 'Windows dir.',
  [UiohookKey.Space]: 'Espaço',
  [UiohookKey.CapsLock]: 'Caps Lock',
  [UiohookKey.Enter]: 'Enter',
  [UiohookKey.Tab]: 'Tab',
  [UiohookKey.Backspace]: 'Backspace',
  [UiohookKey.ArrowUp]: 'Seta cima',
  [UiohookKey.ArrowDown]: 'Seta baixo',
  [UiohookKey.ArrowLeft]: 'Seta esq.',
  [UiohookKey.ArrowRight]: 'Seta dir.',
  [UiohookKey.Insert]: 'Insert',
  [UiohookKey.Delete]: 'Delete',
  [UiohookKey.Home]: 'Home',
  [UiohookKey.End]: 'End',
  [UiohookKey.PageUp]: 'Page Up',
  [UiohookKey.PageDown]: 'Page Down',
  [UiohookKey.NumLock]: 'Num Lock',
  [UiohookKey.ScrollLock]: 'Scroll Lock',
  [UiohookKey.PrintScreen]: 'Print Screen',
  [UiohookKey.NumpadEnter]: 'Enter (num)',
  [UiohookKey.NumpadAdd]: '+ (num)',
  [UiohookKey.NumpadSubtract]: '- (num)',
  [UiohookKey.NumpadMultiply]: '* (num)',
  [UiohookKey.NumpadDivide]: '/ (num)',
  [UiohookKey.NumpadDecimal]: '. (num)',
};

/**
 * DOM KeyboardEvent.code -> keycode do uiohook.
 *
 * Existe porque a captura da tecla acontece no renderer, com o keydown do
 * proprio DOM: e o unico caminho que sempre dispara enquanto a janela tem
 * foco. O hook global continua sendo quem DETECTA a tecla durante o jogo -
 * este mapa so traduz o que o usuario apertou na tela de configuracoes.
 *
 * Fora de letras e digitos, os nomes do uiohook ja batem com os do DOM
 * (Space, F5, Numpad3, ArrowLeft, Backquote...), entao o resto e copiado.
 */
const FROM_DOM_CODE: Record<string, number> = (() => {
  const map: Record<string, number> = {
    ControlLeft: UiohookKey.Ctrl,
    ControlRight: UiohookKey.CtrlRight,
    ShiftLeft: UiohookKey.Shift,
    ShiftRight: UiohookKey.ShiftRight,
    AltLeft: UiohookKey.Alt,
    AltRight: UiohookKey.AltRight,
    MetaLeft: UiohookKey.Meta,
    MetaRight: UiohookKey.MetaRight,
    OSLeft: UiohookKey.Meta,
    OSRight: UiohookKey.MetaRight,
  };

  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    map[`Key${letter}`] = (UiohookKey as Record<string, number>)[letter];
  }
  for (let d = 0; d <= 9; d++) {
    map[`Digit${d}`] = (UiohookKey as Record<string, number>)[String(d)];
  }
  for (const [name, code] of Object.entries(UiohookKey)) {
    if (typeof code === 'number' && !(name in map)) map[name] = code;
  }
  return map;
})();

/** Esc nao vira atalho: e o jeito de cancelar a captura. */
const ESC = UiohookKey.Escape;

function labelFor(keycode: number): string {
  return PT_BR[keycode] ?? FROM_LIB[keycode] ?? `Tecla ${keycode}`;
}

/**
 * Traduz uma tecla vinda do DOM em keycode + rotulo.
 *
 * `printable` e o KeyboardEvent.key: quando e um unico caractere, ele mostra
 * o que esta ESCRITO na tecla do usuario (Ç no ABNT2, por exemplo), coisa que
 * o code sozinho nao sabe. Fora isso, cai no nome traduzido.
 *
 * Retorna null para teclas que o uiohook nao enxerga - o renderer ignora e
 * continua escutando em vez de vincular algo que nunca vai funcionar.
 */
export function resolveDomKey(
  code: string,
  printable?: string,
): { keycode: number; label: string } | null {
  const keycode = FROM_DOM_CODE[code];
  if (typeof keycode !== 'number') return null;

  const named = PT_BR[keycode];
  if (named) return { keycode, label: named };

  // [...str] conta caracteres, nao unidades UTF-16: acentos e emoji nao viram
  // "2 caracteres" e escapam do teste.
  if (printable && [...printable].length === 1 && printable !== ' ') {
    return { keycode, label: printable.toUpperCase() };
  }
  return { keycode, label: labelFor(keycode) };
}

export function isAvailable(): boolean {
  return available;
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

    // Quem grava e o renderer, pelo settings:patch normal. Gravar tambem aqui
    // daria dois escritores para o mesmo campo, com o cache do settings.ts no
    // meio - e um deles sempre acabaria sobrescrevendo o outro.
    captureResolve = (key) => {
      clearTimeout(timer);
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
