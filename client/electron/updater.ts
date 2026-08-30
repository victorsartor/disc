import { app, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';

/**
 * Atualizacao automatica.
 *
 * O feed (latest.yml + instalador) e servido pelo proprio Caddy do grupo, na
 * rota /atualizacoes, com o certificado do Tailscale. Nao ha GitHub Releases
 * nem nada publico: quem nao esta na tailnet nao alcanca o endereco.
 *
 * A rota NAO exige login, e nao tem como exigir - o app checa atualizacao
 * antes de existir sessao. A tranca aqui e a tailnet, nao a allowlist.
 *
 * O app nao e assinado, entao o electron-updater pula a verificacao de
 * assinatura (ela so roda quando existe publisherName no app-update.yml, que
 * o electron-builder so escreve pra app assinado). Ou seja: quem controla o
 * servidor controla o que roda na maquina de quem instalou. Dentro de um
 * grupo fechado de amigos com o servidor na sua propria maquina, tudo bem -
 * mas e uma escolha, nao um descuido.
 */

// electron-updater e CommonJS: em ESM o import nomeado nao e confiavel.
const { autoUpdater } = electronUpdater;

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | {
      status: 'downloading';
      version: string;
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

let state: UpdateState = { status: 'idle' };
let getWindow: () => BrowserWindow | null = () => null;

export function currentState(): UpdateState {
  return state;
}

function set(next: UpdateState): void {
  state = next;
  getWindow()?.webContents.send('update:state', next);
}

/**
 * Desiste da atualizacao e libera o app.
 *
 * Existe porque a tela de atualizacao bloqueia o app inteiro: se o download
 * travar no meio (relay do Tailscale caindo, servidor reiniciando), sem isto
 * o amigo ficaria preso numa barra de progresso parada, sem nem conseguir
 * usar a versao que ja tem instalada.
 */
export function skip(): void {
  set({ status: 'idle' });
}

export function init(win: () => BrowserWindow | null): void {
  getWindow = win;

  // Em dev nao existe app-update.yml dentro do pacote, e o electron-updater
  // lanca em vez de so nao achar. Nada a fazer aqui.
  if (!app.isPackaged) return;

  autoUpdater.logger = {
    info: (m: unknown) => console.log('[updater]', m),
    warn: (m: unknown) => console.warn('[updater]', m),
    error: (m: unknown) => console.error('[updater]', m),
    debug: () => {},
  };

  autoUpdater.autoDownload = true;
  // Se a pessoa fechar o app no meio do download, instala na saida.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));

  autoUpdater.on('update-available', (info) => {
    set({ status: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => set({ status: 'idle' }));

  autoUpdater.on('download-progress', (p) => {
    const version = 'version' in state ? state.version : app.getVersion();
    set({
      status: 'downloading',
      version,
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'ready', version: info.version });
    // Um respiro pra tela mostrar "pronto" antes da janela sumir. Silencioso
    // (o progresso ja foi mostrado pelo app) e volta sozinho depois.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 1400);
  });

  autoUpdater.on('error', (err) => {
    // Falhar ANTES de achar atualizacao e o caso comum: servidor fora do ar,
    // amigo sem tailnet no momento. Isso nao pode travar ninguem - o app abre
    // normalmente na versao que ja tem.
    if (state.status === 'checking' || state.status === 'idle') {
      console.warn('[updater] checagem falhou:', err?.message ?? err);
      set({ status: 'idle' });
      return;
    }
    set({ status: 'error', message: err?.message ?? 'falha ao atualizar' });
  });

  void autoUpdater.checkForUpdates().catch(() => {
    /* o handler de 'error' acima ja tratou */
  });
}
