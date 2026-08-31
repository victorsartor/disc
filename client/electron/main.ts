import {
  app, BrowserWindow, ipcMain, shell, safeStorage,
  desktopCapturer, globalShortcut, clipboard, Menu, session, dialog,
} from 'electron';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readFileSync, writeFileSync, rmSync, existsSync,
  createReadStream, createWriteStream, statSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  getSettings, patchSettings, setVolume, setScreenVolume, sanitizePatch,
} from './settings.js';
import {
  init as initPtt, syncWithSettings as syncPtt, shutdown as shutdownPtt,
  captureKey, cancelCapture, isAvailable as pttAvailable, resolveDomKey,
} from './ptt.js';
import {
  showOverlay, hideOverlay, destroyOverlay, toggleOverlay,
  pushState, setInteractive,
} from './overlay.js';
import {
  init as initUpdater, currentState as updateState, skip as skipUpdate,
} from './updater.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// No Wayland, o Chromium so enxerga janelas/telas pra compartilhar atraves
// do portal de tela (xdg-desktop-portal), que fica atras desta feature flag.
// Sem ela, desktopCapturer.getSources() volta uma lista vazia pra sempre -
// era exatamente o "Procurando janelas..." nunca resolver no Linux. Tem que
// ser antes do app ficar pronto; nao faz nada em X11 nem em outra plataforma.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
  // Sem isto o app roda por XWayland (caminho X11) enquanto so a captura vai
  // pelo caminho Wayland. Metade em cada lado e o que faz o portal abrir,
  // a pessoa escolher a tela, e a lista voltar vazia mesmo assim.
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

// Identidade da janela pro Windows, e tem que bater com o appId do
// electron-builder. Sem isto o Electron chuta um AppUserModelID a partir do
// caminho do executavel: a janela deixa de casar com o atalho instalado, o
// icone fixado na barra de tarefas abre um segundo grupo em vez de acender o
// que ja esta la, e as notificacoes saem assinadas com o nome errado.
if (process.platform === 'win32') app.setAppUserModelId('com.disneia.app');

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

// Mata o menu padrao (File/Edit/View/Window/Help) em vez de so escondê-lo.
// O autoHideMenuBar apenas oculta: qualquer Alt traz ele de volta - e Alt e
// justamente uma das teclas mais escolhidas pra apertar-para-falar, entao
// falar no jogo abria um menu por cima da tela.
//
// Copiar e colar continuam funcionando: quem trata Ctrl+C/V dentro de campo
// de texto e o proprio Chromium, nao os itens deste menu.
if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

/**
 * Altura da faixa dos botoes de janela. Bate com a .topbar do app pra que
 * minimizar/maximizar/fechar pousem na mesma linha da barra de cima em vez
 * de flutuarem num degrau proprio.
 */
const TITLEBAR_HEIGHT = 52;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1b2a',
    autoHideMenuBar: true,
    // Sem barra de titulo nativa: nome e icone do app saem, e ficam so os
    // tres botoes de janela, desenhados pelo Windows por cima do conteudo.
    // A identificacao passa a viver dentro do app, na sidebar - que e onde a
    // marca cabe grande o bastante pra ser lida. No titulo ela ia pra 16px e
    // virava um borrao.
    //
    // Isto tira o lugar de arrastar a janela: quem assume sao as faixas
    // marcadas com -webkit-app-region no theme.css.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1b263b',       // --level-2 do tema padrao; troca com o tema
      symbolColor: '#e0e1dd', // --alabaster
      height: TITLEBAR_HEIGHT,
    },
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

/**
 * Caminho do Wayland: o portal e quem escolhe, numa requisicao so.
 *
 * No X11 e no Windows a lista de fontes vive: da pra pedir getSources(),
 * desenhar um menu nosso, e so depois abrir a que a pessoa escolheu. No
 * Wayland nao - o id que o getSources() devolve (um marcador tipo
 * "window:1:0", sem nome) so vale enquanto a sessao do portal que o criou
 * estiver aberta. Entre listar e escolher no NOSSO modal essa sessao morre,
 * e a abertura falha com "target not found" vindo do PipeWire.
 *
 * Aqui getSources() e a entrega da fonte acontecem dentro da MESMA
 * requisicao de getDisplayMedia, entao a sessao continua viva no meio do
 * caminho. Quem desenha o seletor passa a ser o proprio KDE/GNOME.
 */
function initDisplayMedia(): void {
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer
      .getSources({ types: ['screen', 'window'] })
      .then((sources) => {
        const fonte = sources[0];
        if (!fonte) {
          // callback sem streams = pedido negado. O renderer recebe o erro
          // e mostra a mensagem, em vez de ficar esperando pra sempre.
          callback({});
          return;
        }
        callback({ video: fonte });
      })
      .catch((err) => {
        console.error('[display-media] getSources falhou', err);
        callback({});
      });
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

    initDisplayMedia();
    loadSession();
    createWindow();

    // Comeca a checar antes do renderer montar. O estado fica guardado no
    // modulo, entao a tela pega o que ja aconteceu quando perguntar.
    initUpdater(() => win);

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

// --- IPC: barra de titulo ------------------------------------------------
/**
 * Repinta os botoes de janela quando o tema muda.
 *
 * A barra e desenhada pelo SO, nao pelo CSS - trocar pro tema Artico, que e
 * claro, deixaria tres simbolos brancos sobre fundo branco se ninguem
 * avisasse o Windows.
 *
 * As cores vem do renderer, entao passam por validacao: so hex de 6 digitos.
 * IPC e fronteira de confianca como qualquer outra.
 */
const HEX = /^#[0-9a-fA-F]{6}$/;

ipcMain.handle('window:titlebar', (_e, color: unknown, symbolColor: unknown) => {
  if (process.platform === 'darwin') return;
  if (typeof color !== 'string' || typeof symbolColor !== 'string') return;
  if (!HEX.test(color) || !HEX.test(symbolColor)) return;
  try {
    win?.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
  } catch {
    /* janela ja fechada, ou plataforma sem suporte: cor errada nao quebra nada */
  }
});

// --- IPC: atualizacao ----------------------------------------------------
ipcMain.handle('update:state', () => updateState());
ipcMain.handle('update:skip', () => skipUpdate());
ipcMain.handle('app:version', () => app.getVersion());

// --- IPC: API ------------------------------------------------------------
ipcMain.handle('api:me', () => apiFetch('/api/me'));
ipcMain.handle('api:messages', () => apiFetch('/api/messages'));
ipcMain.handle('api:presence', () => apiFetch('/api/presence'));
ipcMain.handle('api:heartbeat', (_e, ativo: unknown) =>
  apiFetch('/api/me/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ ativo: ativo === true }),
  }));
ipcMain.handle('api:set-status', (_e, status: unknown) =>
  apiFetch('/api/me/status', { method: 'PATCH', body: JSON.stringify({ status }) }));
ipcMain.handle('api:send-message', (_e, body: string, attachmentId?: unknown) =>
  apiFetch('/api/messages', {
    method: 'POST',
    body: JSON.stringify({
      body,
      // undefined some do JSON; mandar null faria o servidor recusar por
      // tipo, ja que la a checagem e `!== undefined`.
      attachmentId: typeof attachmentId === 'string' ? attachmentId : undefined,
    }),
  }));
ipcMain.handle('api:room-token', (_e, channelId: string) =>
  apiFetch(`/api/rooms/${encodeURIComponent(channelId)}/token`, { method: 'POST' }));
ipcMain.handle('api:whip-config', (_e, channelId: string) =>
  apiFetch(`/api/rooms/${encodeURIComponent(channelId)}/whip`, { method: 'POST' }));

// --- IPC: captura de tela ------------------------------------------------

/**
 * Janelas que nao sao conteudo compartilhavel.
 *
 * Sao camadas do proprio sistema e overlays de outros programas: existem
 * como janela pro Windows, mas compartilhar qualquer uma delas so rende
 * retangulo preto. Ficavam no meio da lista atrapalhando a escolha.
 */
const JANELAS_IGNORADAS = [
  /^NVIDIA GeForce Overlay/i,
  /^Program Manager$/i,
  /^PopupHost$/i,

  // Em ingles e em portugues: o Windows nomeia as proprias janelas no idioma
  // do sistema, e conferi numa maquina pt-BR que "Experiencia de Entrada do
  // Windows" aparece exatamente assim. Cobrir so o ingles deixaria passar.
  /^Windows (Input Experience|Shell Experience Host)$/i,
  /^Experiência de Entrada do Windows$/i,
  /^Host de Experiência do Shell do Windows$/i,
  /^Microsoft Text Input Application$/i,
  /^Aplicativo de Entrada de Texto da Microsoft$/i,
];

ipcMain.handle('screen:sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    // No Wayland o thumbnail sai do portal, nao da captura direta: pedir
    // miniatura grande faz a chamada demorar (ou falhar) sem devolver nada
    // util, porque o portal so entrega frame depois do stream aberto.
    thumbnailSize: process.platform === 'linux'
      ? { width: 0, height: 0 }
      : { width: 320, height: 180 },
  });

  // Diagnostico: o que o Chromium devolveu ANTES de qualquer filtro nosso.
  // No Linux e a unica janela pra enxergar o que o portal entregou.
  console.log(
    '[screen:sources] cru =',
    JSON.stringify(sources.map((s) => ({ id: s.id, name: s.name }))),
  );

  // As janelas do proprio app saem pelo titulo real, perguntado ao Electron -
  // assim renomear o app nao deixa uma string velha pra tras aqui.
  const minhas = new Set(
    BrowserWindow.getAllWindows()
      .map((w) => w.getTitle())
      .filter(Boolean),
  );

  // A lista de ignorados e toda de janela do Windows, e o teste de tela por
  // prefixo 'screen:' e do caminho X11. No Wayland o portal ja e o filtro -
  // aplicar os nossos aqui so tem como tirar coisa demais.
  const linux = process.platform === 'linux';

  const lista = sources
    .filter((s) => {
      if (linux) return true;
      if (s.id.startsWith('screen:')) return true; // telas passam sempre
      if (!s.name.trim()) return false;
      if (minhas.has(s.name)) return false;
      return !JANELAS_IGNORADAS.some((re) => re.test(s.name));
    })
    .map((s) => ({
      id: s.id,
      name: s.name || 'Tela',
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      isScreen: s.id.startsWith('screen:'),
    }));

  console.log('[screen:sources] devolvido =', lista.length);
  return lista;
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

ipcMain.handle('settings:set-screen-volume', (_e, identity: string, volume: number) => {
  setScreenVolume(identity, volume);
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

// --- IPC: perfil ---------------------------------------------------------
// A imagem chega do renderer ja redimensionada, como data URL (ver
// lib/image.ts). Quem fala com o servidor continua sendo so este processo:
// o token de sessao nunca sai daqui.
ipcMain.handle('api:user', (_e, identity: string) =>
  apiFetch(`/api/users/${encodeURIComponent(identity)}`));

ipcMain.handle('api:profile-patch', (_e, patch: unknown) =>
  apiFetch('/api/me/profile', { method: 'PATCH', body: JSON.stringify(patch) }));

ipcMain.handle('api:profile-image', (_e, kind: unknown, dataUrl: unknown) => {
  const rota = kind === 'banner' ? 'banner' : 'avatar';
  const corpo = typeof dataUrl === 'string' ? dataUrl : null;
  return apiFetch(`/api/me/${rota}`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl: corpo }),
  });
});

// --- IPC: anexos do chat -------------------------------------------------
/** Igual ao do servidor. Aqui evita subir 200 MB pra receber 413 no fim. */
const MAX_FILE_BYTES = 200 * 1024 * 1024;

/**
 * Mime pela extensao.
 *
 * So precisa acertar imagem e audio: e isso que o servidor usa pra decidir
 * o que o chat desenha na conversa. Todo o resto ele trata como
 * octet-stream de qualquer jeito, entao um .docx que nao esteja aqui nao
 * muda nada - vira cartao de download, que e o que ele seria mesmo.
 */
const MIME_POR_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.weba': 'audio/webm',
};

const mimeDoNome = (nome: string) =>
  MIME_POR_EXT[extname(nome).toLowerCase()] ?? 'application/octet-stream';

/**
 * Manda bytes pro /api/arquivos.
 *
 * `corpo` pode ser um Buffer (imagem ja reduzida) ou um ReadableStream (o
 * arquivo do disco). O stream e o que segura os 200 MB: com `duplex: half`
 * o undici vai enviando conforme le, sem juntar o arquivo na memoria. O
 * cast existe porque o RequestInit do TypeScript ainda nao tem o campo.
 */
async function subirArquivo(
  corpo: Buffer | ReadableStream,
  nome: string,
  mime: string,
): Promise<unknown> {
  if (!sessionToken) throw new Error('sem sessao');

  const query = `nome=${encodeURIComponent(nome)}&mime=${encodeURIComponent(mime)}`;
  const res = await fetch(`${SERVER_URL}/api/arquivos?${query}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/octet-stream',
    },
    body: corpo,
    duplex: 'half',
  } as RequestInit);

  if (res.status === 401) {
    saveSession(null);
    win?.webContents.send('auth:changed', false);
    throw new Error('sessao expirada');
  }
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return res.json();
}

ipcMain.handle('api:upload-file', async (_e, caminho: unknown) => {
  if (typeof caminho !== 'string' || !caminho) throw new Error('caminho invalido');

  // Barra antes de subir: o servidor tambem barra, mas descobrir depois de
  // empurrar 200 MB pela rede e desperdicio dos dois lados.
  const tamanho = statSync(caminho).size;
  if (tamanho > MAX_FILE_BYTES) throw new Error('arquivo maior que 200 MB');
  if (tamanho === 0) throw new Error('arquivo vazio');

  const nome = basename(caminho);
  return subirArquivo(
    Readable.toWeb(createReadStream(caminho)) as ReadableStream,
    nome,
    mimeDoNome(nome),
  );
});

ipcMain.handle('api:upload-image', (_e, bytes: unknown, nome: unknown, mime: unknown) => {
  if (!(bytes instanceof Uint8Array)) throw new Error('imagem invalida');
  return subirArquivo(
    Buffer.from(bytes),
    typeof nome === 'string' ? nome : 'imagem.jpg',
    typeof mime === 'string' ? mime : 'image/jpeg',
  );
});

/**
 * Baixa pro disco, com a janela de salvar do sistema.
 *
 * Passa por aqui porque o renderer nao escreve arquivo - e tambem porque
 * assim o download e um stream do servidor direto pro destino escolhido,
 * sem o arquivo inteiro passar pela memoria de ninguem.
 */
ipcMain.handle('api:download-file', async (_e, id: unknown, nome: unknown) => {
  if (typeof id !== 'string') throw new Error('id invalido');

  const janela = win;
  if (!janela) return { salvo: false };

  const { canceled, filePath } = await dialog.showSaveDialog(janela, {
    defaultPath: typeof nome === 'string' ? nome : 'arquivo',
  });
  if (canceled || !filePath) return { salvo: false };

  // Sem authorization de proposito: a rota nao pede sessao, pelo mesmo
  // motivo do /api/img - e a mesma URL que a <img> e o <audio> usam.
  const res = await fetch(`${SERVER_URL}/api/arquivos/${encodeURIComponent(id)}`);
  if (!res.ok || !res.body) throw new Error(`nao consegui baixar (HTTP ${res.status})`);

  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(filePath));
  } catch (err) {
    // Meio arquivo no disco com o nome do inteiro engana mais que a falha.
    rmSync(filePath, { force: true });
    throw err;
  }

  return { salvo: true };
});
