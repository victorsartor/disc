import { uIOhook, UiohookKey } from 'uiohook-napi';
import { getSettings, ACOES_DE_ATALHO, type AcaoDeAtalho, debugLog } from './settings.js';

/**
 * Hold-to-talk global e atalhos globais.
 *
 * O globalShortcut do Electron so dispara no keydown - nao existe keyup -,
 * entao push-to-talk de verdade exige um hook de teclado no nivel do SO. Os
 * atalhos de mudo/surdo pegam carona no mesmo hook: subir um segundo
 * mecanismo pra escutar o mesmo teclado seria dobrar a superficie por nada.
 *
 * SEGURANCA, duas garantias:
 *
 * 1. O hook so sobe quando ha motivo: modo "apertar para falar" escolhido OU
 *    pelo menos um atalho vinculado. Sem nenhum dos dois - que e como o app
 *    sai de fabrica - nenhum hook de teclado existe.
 *    (Ate a 0.35 a unica condicao era o modo PTT; os atalhos da 0.36
 *    acrescentaram a segunda.)
 * 2. Enquanto ativo, ele so compara o keycode com as teclas vinculadas e
 *    descarta o resto na hora. Nada e gravado, acumulado ou enviado pra
 *    lugar nenhum. A unica excecao e o modo de captura, que le UMA tecla
 *    para o usuario vincular e se encerra.
 */

type Listener = (down: boolean) => void;
type AtalhoListener = (acao: AcaoDeAtalho) => void;

let handlersBound = false;
let running = false;
let available = true; // otimista ate uma tentativa de start falhar
let listener: Listener | null = null;
let atalhoListener: AtalhoListener | null = null;
let captureResolve: ((key: CapturedKey) => void) | null = null;
let held = false;

/**
 * Teclas de atalho ja disparadas e ainda seguradas.
 *
 * Atalho e alternancia: sem isto, segurar a tecla faria o auto-repeat do SO
 * ligar e desligar o microfone dezenas de vezes por segundo. Mesmo papel do
 * `held` do PTT, so que por tecla.
 */
const atalhosSegurados = new Set<number>();

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

export function init(onChange: Listener, onAtalho?: AtalhoListener): void {
  listener = onChange;
  atalhoListener = onAtalho ?? null;
}

/**
 * A acao vinculada a esta tecla, se houver.
 *
 * Percorre o mapa em vez de manter um indice invertido: sao duas acoes, e um
 * indice a mais e mais um lugar pra ficar dessincronizado do settings.json.
 */
function acaoDaTecla(keycode: number): AcaoDeAtalho | null {
  const { atalhos } = getSettings();
  for (const acao of ACOES_DE_ATALHO) {
    if (atalhos[acao]?.keycode === keycode) return acao;
  }
  return null;
}

/** Alguma tecla vinculada a alguma acao? Decide se o hook precisa subir. */
function temAtalho(): boolean {
  const { atalhos } = getSettings();
  return ACOES_DE_ATALHO.some((acao) => atalhos[acao] !== undefined);
}

/**
 * A tecla ja esta em uso por outra funcao?
 *
 * Vincular a mesma tecla duas vezes nao daria erro - daria as duas acoes de
 * uma vez, e ninguem entenderia por que mutar tambem ensurdece. Quem chama e
 * a rota de gravar, que recusa antes de escrever.
 */
export function teclaEmUso(keycode: number, exceto?: AcaoDeAtalho): AcaoDeAtalho | 'ptt' | null {
  const s = getSettings();
  if (s.pttKeycode === keycode) return 'ptt';
  for (const acao of ACOES_DE_ATALHO) {
    if (acao !== exceto && s.atalhos[acao]?.keycode === keycode) return acao;
  }
  return null;
}

function bindHandlers(): void {
  if (handlersBound) return;

  uIOhook.on('keydown', (e) => {
    // DIAGNOSTICO TEMPORARIO: toda tecla que o hook global recebe, pra
    // confirmar se ele esta vivo e com que keycode. Ver debugLog em
    // settings.ts - tirar junto com o resto do diagnostico.
    debugLog(`keydown bruto: keycode=${e.keycode} capturando=${!!captureResolve}`);

    // Modo de captura: le a proxima tecla e encerra imediatamente.
    if (captureResolve) {
      const resolve = captureResolve;
      captureResolve = null;
      // Esc cancela em vez de virar atalho - e o que todo mundo espera.
      if (e.keycode === ESC) resolve(null);
      else resolve({ keycode: e.keycode, label: labelFor(e.keycode) });
      return;
    }

    // Atalhos vem ANTES do PTT: a tecla so pode estar em uma das duas
    // funcoes (ver teclaEmUso), entao a ordem nunca decide nada de verdade -
    // mas se um settings.json editado a mao burlar a checagem, disparar o
    // atalho e nao o PTT e o lado menos pior: o PTT preso deixaria o
    // microfone aberto sem ninguem perceber.
    const acao = acaoDaTecla(e.keycode);
    if (acao) {
      debugLog(`atalho casou: acao=${acao} keycode=${e.keycode} segurada=${atalhosSegurados.has(e.keycode)}`);
      if (atalhosSegurados.has(e.keycode)) return; // auto-repeat do SO
      atalhosSegurados.add(e.keycode);
      atalhoListener?.(acao);
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
    // Solta a trava do auto-repeat mesmo que a tecla tenha deixado de ser
    // atalho no meio do caminho: sem isto, trocar a tecla enquanto ela esta
    // pressionada deixaria o keycode antigo presente no conjunto pra sempre,
    // e ele nunca mais dispararia se voltasse a ser vinculado.
    atalhosSegurados.delete(e.keycode);

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
  if (running) {
    debugLog('start(): ja estava rodando');
    return true;
  }
  try {
    bindHandlers();
    uIOhook.start();
    running = true;
    available = true;
    debugLog('start(): hook subiu ok');
  } catch (err) {
    // Acontece principalmente em Wayland, que bloqueia captura global de
    // teclado por design. O app continua funcionando no modo VAD.
    console.warn('hook de teclado global indisponivel:', err);
    debugLog(`start(): falhou - ${err}`);
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
  atalhosSegurados.clear();
  // Soltar a tecla enquanto o hook morre deixaria o mic aberto pra sempre.
  if (held) {
    held = false;
    listener?.(false);
  }
}

/**
 * Liga ou desliga o hook conforme o que esta configurado.
 * Chamado no boot e a cada mudanca de configuracao.
 *
 * Duas razoes pra ele subir agora, e basta UMA: o modo apertar-para-falar, ou
 * um atalho vinculado. Sem nenhuma delas o hook desce - e e o que garante que
 * quem nao usa nenhum dos dois nao tem hook de teclado nenhum rodando.
 */
export function syncWithSettings(): void {
  const s = getSettings();
  const deve = s.voiceMode === 'ptt' || temAtalho();
  debugLog(`syncWithSettings: voiceMode=${s.voiceMode} temAtalho=${temAtalho()} atalhos=${JSON.stringify(s.atalhos)} -> ${deve ? 'start' : 'stop'}`);
  if (deve) start();
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
