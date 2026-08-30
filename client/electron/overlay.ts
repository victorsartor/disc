import { BrowserWindow, screen } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings, patchSettings } from './settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WIDTH = 232;
const HEIGHT = 320;

let overlay: BrowserWindow | null = null;
let lastPayload: unknown = null;

export function isOpen(): boolean {
  return overlay !== null && !overlay.isDestroyed();
}

export function createOverlay(): BrowserWindow {
  if (isOpen()) return overlay!;

  const s = getSettings();
  const { workArea } = screen.getPrimaryDisplay();

  overlay = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: s.overlayX ?? workArea.x + workArea.width - WIDTH - 24,
    y: s.overlayY ?? workArea.y + 24,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,      // nunca rouba foco do jogo
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, 'overlay-preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Fica acima inclusive de jogos em tela cheia (borderless).
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Cliques atravessam por padrao. O 'forward' mantem os eventos de hover
  // chegando na pagina, que e como a alca de arrastar consegue reagir.
  overlay.setIgnoreMouseEvents(true, { forward: true });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    // new URL() em vez de concatenar: nao depende do devUrl terminar em barra
    void overlay.loadURL(new URL('overlay.html', devUrl).toString());
  } else {
    void overlay.loadFile(join(__dirname, '../dist/overlay.html'));
  }

  overlay.on('moved', () => {
    if (!overlay || overlay.isDestroyed()) return;
    const [x, y] = overlay.getPosition();
    patchSettings({ overlayX: x, overlayY: y });
  });

  overlay.on('closed', () => {
    overlay = null;
  });

  // Reenvia o ultimo estado quando a janela termina de carregar, senao
  // o overlay abre vazio ate a proxima mudanca de participantes.
  overlay.webContents.on('did-finish-load', () => {
    if (lastPayload) overlay?.webContents.send('overlay:state', lastPayload);
  });

  return overlay;
}

export function showOverlay(): void {
  const win = createOverlay();
  if (!win.isVisible()) win.showInactive(); // showInactive: nao tira foco do jogo
}

export function hideOverlay(): void {
  if (isOpen()) overlay!.hide();
}

export function destroyOverlay(): void {
  if (isOpen()) overlay!.destroy();
  overlay = null;
}

export function toggleOverlay(): boolean {
  const enabled = !getSettings().overlayEnabled;
  patchSettings({ overlayEnabled: enabled });
  if (enabled) showOverlay();
  else hideOverlay();
  return enabled;
}

/** Recebe o estado do renderer principal e repassa pro overlay. */
export function pushState(payload: unknown): void {
  lastPayload = payload;
  if (!isOpen()) return;
  overlay!.webContents.send('overlay:state', payload);
}

/** Deixa o overlay clicavel enquanto o mouse esta sobre a alca de arrastar. */
export function setInteractive(interactive: boolean): void {
  if (!isOpen()) return;
  overlay!.setIgnoreMouseEvents(!interactive, { forward: true });
}
