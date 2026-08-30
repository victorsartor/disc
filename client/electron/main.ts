import {
  app, BrowserWindow, ipcMain, shell, safeStorage,
  desktopCapturer, globalShortcut, clipboard,
} from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import {
  getSettings, patchSettings, setVolume, sanitizePatch,
} from './settings.js';
import {
  init as initPtt, syncWithSettings as syncPtt, shutdown as shutdownPtt,
  captureKey, cancelCapture, isAvailable as pttAvailable, resolveDomKey,
} from './ptt.js';
import {
  showOverlay, hideOverlay, destroyOverlay, toggleOverlay,
  pushState, setInteractive,
} from './overlay.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// URL do servidor. Em dev aponta pro backend local; em producao, pro DuckDNS.
const SERVER_URL = process.env.VITE_SERVER_URL ?? 'http://localhost:3000';
const PROTOCOL = 'disc';

let win: BrowserWindow | null = null;

// --- Sessao: fica no processo main, cifrada pelo keychain do SO. ---------
// O renderer NUNCA ve este token. Ele so recebe tokens de sala do LiveKit,
// que sao curtos (10min) e escopados - bem menos perigosos se vazarem.
const tokenPath = () => join(app.getPath('userData'), 'session.bin');
let sessionToken: string | null = null;

function loadSession(): void {
  try {
    const p = tokenPath();
    if (!existsSync(p)) return;
    const raw = readFileSync(p);
    sessionToken = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
  } catch {
    sessionToken = null;
  }
}

function saveSession(token: string | null): void {
  sessionToken = token;
  try {
    if (!token) {
      rmSync(tokenPath(), { force: true });
      return;
    }
    const data = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(token)
      : Buffer.from(token, 'utf8');
    writeFileSync(tokenPath(), data, { mode: 0o600 });
  } catch (err) {
    console.error('nao consegui gravar a sessao', err);
  }
}

// --- Chamadas a API: sempre daqui, nunca do renderer. --------------------
async function apiFetch(path: string, init: RequestInit = {}): Promise<any> {
  if (!sessionToken) throw new Error('sem sessao');

  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
    authorization: `Bearer ${sessionToken}`,
  };
  // content-type SO quando existe corpo. Um POST anunciando application/json
  // com corpo vazio e recusado pelo Fastify (FST_ERR_CTP_EMPTY_JSON_BODY),
  // que e o caso de /token e /whip.
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${SERVER_URL}${path}`, { ...init, headers });
  if (res.status === 401) {
    saveSession(null);
    win?.webContents.send('auth:changed', false);
    throw new Error('sessao expirada');
  }
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return res.json();
}

// --- Deep link disc://auth?token=... -------------------------------------
function handleDeepLink(url: string | undefined): void {
  if (!url?.startsWith(`${PROTOCOL}://`)) return;
  try {
    const token = new URL(url).searchParams.get('token');
    if (!token) return;
    saveSession(token);
    win?.webContents.send('auth:changed', true);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  } catch (err) {
    console.error('deep link invalido', err);
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1b2a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,   // renderer isolado do Node
      nodeIntegration: false,   // sem require() no renderer
      sandbox: false,           // exigido para preload em ESM
    },
  });

  // Links externos abrem no navegador do sistema, nunca dentro do app
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../dist/index.html'));
  }

  win.on('closed', () => {
    win = null;
    destroyOverlay();
  });
}

// --- Instancia unica (necessario pro deep link no Windows/Linux) ---------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    handleDeepLink(argv.find((a) => a.startsWith(`${PROTOCOL}://`)));
  });

  app.on('open-url', (e, url) => {
    e.preventDefault();
    handleDeepLink(url);
  });

  app.whenReady().then(() => {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1]]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }

    loadSession();
    createWindow();

    // Hold-to-talk real: hook de teclado no nivel do SO, com keydown E keyup.
    // So sobe se o modo escolhido for PTT. Ver a nota de seguranca em ptt.ts.
    initPtt((down) => win?.webContents.send('ptt:state', down));
    syncPtt();

    globalShortcut.register('Control+Shift+O', () => {
      const enabled = toggleOverlay();
      win?.webContents.send('overlay:enabled', enabled);
    });

    // Inicializacao fria no Windows: o deep link chega pelo argv
    handleDeepLink(process.argv.find((a) => a.startsWith(`${PROTOCOL}://`)));
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    shutdownPtt();
  });
}

// --- IPC: autenticacao ---------------------------------------------------
ipcMain.handle('auth:status', () => Boolean(sessionToken));
ipcMain.handle('auth:login', () => shell.openExternal(`${SERVER_URL}/auth/login`));
ipcMain.handle('auth:logout', () => {
  saveSession(null);
  win?.webContents.send('auth:changed', false);
});

// --- IPC: API ------------------------------------------------------------
ipcMain.handle('api:me', () => apiFetch('/api/me'));
ipcMain.handle('api:messages', () => apiFetch('/api/messages'));
ipcMain.handle('api:send-message', (_e, body: string) =>
  apiFetch('/api/messages', { method: 'POST', body: JSON.stringify({ body }) }));
ipcMain.handle('api:room-token', (_e, channelId: string) =>
  apiFetch(`/api/rooms/${encodeURIComponent(channelId)}/token`, { method: 'POST' }));
ipcMain.handle('api:whip-config', (_e, channelId: string) =>
  apiFetch(`/api/rooms/${encodeURIComponent(channelId)}/whip`, { method: 'POST' }));

// --- IPC: captura de tela ------------------------------------------------
ipcMain.handle('screen:sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    isScreen: s.id.startsWith('screen:'),
  }));
});

// --- IPC: configuracoes --------------------------------------------------
ipcMain.handle('settings:get', () => ({
  ...getSettings(),
  pttAvailable: pttAvailable(),
}));

ipcMain.handle('settings:patch', (_e, raw: unknown) => {
  const patch = sanitizePatch(raw);
  const next = patchSettings(patch);
  // Liga o hook ao entrar em PTT, derruba ao sair (soltando a tecla presa).
  if (patch.voiceMode) syncPtt();
  return { ...next, pttAvailable: pttAvailable() };
});

ipcMain.handle('settings:capture-key', () => captureKey());

// Traduz a tecla que o renderer pegou no keydown do DOM para o keycode do
// uiohook. O mapa vive no main porque e la que o UiohookKey existe - assim
// nao ha uma segunda copia da tabela desatualizando em silencio.
ipcMain.handle('settings:resolve-key', (_e, code: unknown, printable: unknown) =>
  typeof code === 'string'
    ? resolveDomKey(code, typeof printable === 'string' ? printable : undefined)
    : null);

ipcMain.handle('settings:set-volume', (_e, identity: string, volume: number) => {
  setVolume(identity, volume);
});

// --- IPC: overlay --------------------------------------------------------
ipcMain.handle('overlay:toggle', () => {
  const enabled = toggleOverlay();
  return enabled;
});

ipcMain.on('overlay:state', (_e, payload: unknown) => {
  const s = getSettings();
  const connected = Boolean((payload as { channelName?: string | null })?.channelName);
  // Overlay so faz sentido em call. Fora dela, some sozinho.
  if (s.overlayEnabled && connected) showOverlay();
  else hideOverlay();
  pushState(payload);
});

ipcMain.on('overlay:interactive', (_e, interactive: boolean) => {
  setInteractive(interactive);
});

// --- IPC: area de transferencia ------------------------------------------
// navigator.clipboard nao e confiavel em contexto file://, entao passa aqui.
ipcMain.handle('clipboard:write', (_e, text: string) => {
  clipboard.writeText(String(text));
});

ipcMain.handle('settings:cancel-capture', () => {
  cancelCapture();
});
