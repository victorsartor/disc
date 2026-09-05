import { app } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

/**
 * DIAGNOSTICO TEMPORARIO (bug dos atalhos que nao disparam, 05/09/2026).
 *
 * Grava num arquivo em vez de console.log porque o app empacotado nao tem
 * terminal nenhum grudado - console.log daqui simplesmente nao vai a lugar
 * nenhum. Tirar assim que o bug for encontrado.
 */
export function debugLog(msg: string): void {
  try {
    appendFileSync(
      join(app.getPath('userData'), 'atalhos-debug.log'),
      `${new Date().toISOString()} ${msg}\n`,
      'utf8',
    );
  } catch {
    /* diagnostico nao pode derrubar nada */
  }
}

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
  /**
   * Supressao de ruido por RNNoise (src/lib/rnnoise.ts).
   *
   * Diferente das tres acima, que sao flags entregues ao Chromium: esta
   * monta um no a mais no grafo de audio do microfone, com um modelo em
   * WebAssembly rodando na thread de audio. E a unica que age DENTRO da
   * fala - as outras so tratam o silencio entre as frases.
   */
  rnnoise: boolean;
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
  /**
   * Tirar a Disneia do som transmitido, no Linux. Ver audio-linux.ts.
   *
   * Ligado por padrao: sem ele quem assiste se ouve de volta, e essa e uma
   * falha que aparece pra TODO MUNDO na chamada, nao so pra quem transmite.
   * Da pra desligar porque ele mexe na saida padrao do servidor de som, e
   * isso e o tipo de coisa que a pessoa tem direito de recusar na propria
   * maquina.
   */
  isolarAudioNaTela: boolean;
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
  /**
   * Largura da barra lateral, em pixels. Preferencia da maquina.
   *
   * Mora aqui, e nao no localStorage do renderer, porque o userData sobrevive
   * a atualizacao do app e a pasta de instalacao nao: era exatamente o
   * "nao mudar toda vez que o app atualiza" que o pedido tinha.
   *
   * Os limites nao sao enfeite. Abaixo de LARGURA_MIN a linha do
   * participante (avatar + nome + etiqueta AO VIVO) para de caber e o nome
   * some inteiro atras das reticencias; acima de LARGURA_MAX a coluna comeca
   * a comer o chat. Como o valor entra num grid-template-columns, um NaN
   * gravado a mao no settings.json nao desenharia errado - invalidaria a
   * regra e colapsaria a coluna pra zero.
   */
  sidebarWidth: number;
  /**
   * Em que canto do chat a pilha de transmissoes fica ancorada.
   *
   * Uma escolha SO, e nao uma por transmissao: as janelinhas se empilham a
   * partir do canto, entao guardar canto por pessoa faria duas se cruzarem
   * na tela sem que ninguem tivesse pedido isso. O arrasto move a pilha
   * inteira, e por isso o que se salva e o canto dela.
   */
  telaCanto: TelaCanto;
  /**
   * Largura das janelinhas, em pixels. A altura sai da proporcao do video.
   *
   * Mesmo motivo do sidebarWidth de morar aqui e nao no localStorage: o
   * userData sobrevive a atualizacao do app. Os limites tambem nao sao
   * enfeite - abaixo de TELA_MIN o nome de quem transmite e o cronometro nao
   * cabem na etiqueta, e acima de TELA_MAX a janelinha deixa de ser um canto
   * e vira o palco de novo, que e justamente o que se estava tirando.
   */
  telaLargura: number;
  /**
   * Atalhos globais por acao. Ausente = aquela acao nao tem tecla.
   *
   * Mapa, e nao dois campos soltos por acao como o pttKeycode/pttKeyLabel:
   * sao duas acoes hoje e a lista deve crescer, e um par de campos novos por
   * acao espalharia a mesma regra por ALLOWED_KEYS, DEFAULTS e sanitize toda
   * vez. Aqui a acao nova custa uma string em ACOES_DE_ATALHO.
   */
  atalhos: Partial<Record<AcaoDeAtalho, Atalho>>;
}

/** Ver o comentario do sidebarWidth. Repetidos no CSS como var(--sidebar-w). */
export const LARGURA_MIN = 180;
export const LARGURA_MAX = 480;

/**
 * Os quatro cantos, em lista FECHADA.
 *
 * Mesma decisao dos emoji de reacao na 0.31 e das ACOES_DE_ATALHO: o valor
 * chega por IPC, e aceitar string qualquer poria lixo no settings.json - que
 * do outro lado vira nome de classe CSS e simplesmente nao casaria com regra
 * nenhuma, deixando a janelinha no canto de cima a esquerda sem explicacao.
 */
export const TELA_CANTOS = ['cima-esq', 'cima-dir', 'baixo-esq', 'baixo-dir'] as const;
export type TelaCanto = (typeof TELA_CANTOS)[number];

/** Ver o comentario do telaLargura. Repetidos no Stage.tsx, que segura o arrasto. */
export const TELA_MIN = 240;
export const TELA_MAX = 720;

/**
 * As acoes que aceitam atalho global, em lista FECHADA.
 *
 * Mesma decisao dos emoji de reacao na 0.31: a chave chega por IPC, e aceitar
 * qualquer string faria o settings.json virar deposito de qualquer coisa.
 * Acao que nao estiver aqui e descartada no patch.
 *
 * Escolhidas com ele em 02/09/2026. Ficou de fora "sair do canal" - sair da
 * call sem querer por causa de uma tecla mal escolhida e pior que o atalho
 * economiza.
 */
export const ACOES_DE_ATALHO = ['mudo', 'surdo'] as const;
export type AcaoDeAtalho = (typeof ACOES_DE_ATALHO)[number];

export interface Atalho {
  /** Keycode do uiohook, o mesmo vocabulario do pttKeycode. */
  keycode: number;
  /** Como mostrar na tela ("Ctrl esq.", "F9", "Ç"). */
  label: string;
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
  // Desligada por padrao, ao contrario das tres acima. Nao e desconfianca
  // do filtro: e que ele e um caminho de audio NOVO, e um caminho de audio
  // que da errado nao degrada - emudece. Quem ligar escolheu correr o risco
  // sabendo desligar. Vale reavaliar este padrao depois de algumas semanas
  // de chamada de verdade em maquina de todo mundo.
  rnnoise: false,
  volumes: {},
  screenVolumes: {},
  voiceVolume: 100,
  effectsVolume: 100,
  chatVolume: 100,
  screenAudioDeviceId: null,
  isolarAudioNaTela: true,
  theme: 'abissal',
  // Os do Abissal, que e o tema padrao. Valem so ate a primeira troca.
  themeBg: '#0d1b2a',
  themeBar: '#1b263b',
  themeSymbol: '#e0e1dd',
  sidebarWidth: 240,
  // Embaixo a direita, que e onde o preview do proprio compartilhamento ja
  // morava quando o palco existia - quem atualiza encontra a janelinha no
  // lugar em que aprendeu a procurar.
  telaCanto: 'baixo-dir',
  telaLargura: 360,
  atalhos: {},
};

let cache: Settings | null = null;

const file = () => join(app.getPath('userData'), 'settings.json');

/** Um 0 a 100 valido, ou o padrao. Usado na leitura e no patch. */
function percentual(v: unknown, padrao: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * So os atalhos bem formados, com acao conhecida. Usada na leitura e no patch.
 *
 * Peneira em vez de rejeitar o mapa inteiro: um atalho estragado (por edicao a
 * mao ou por uma acao que existiu numa versao futura) nao pode custar os
 * outros, que estao bons.
 */
function atalhos(v: unknown): Partial<Record<AcaoDeAtalho, Atalho>> {
  if (typeof v !== 'object' || v === null) return {};
  const out: Partial<Record<AcaoDeAtalho, Atalho>> = {};
  for (const [acao, bind] of Object.entries(v)) {
    if (!(ACOES_DE_ATALHO as readonly string[]).includes(acao)) continue;
    if (typeof bind !== 'object' || bind === null) continue;
    const { keycode, label } = bind as { keycode?: unknown; label?: unknown };
    // Keycode e indice de tecla, nao numero qualquer: um float ou um negativo
    // nunca casaria com um evento do uiohook e ficaria como atalho fantasma,
    // ocupando a tecla na tela sem nunca disparar.
    if (!Number.isInteger(keycode) || (keycode as number) < 0) continue;
    if (typeof label !== 'string' || !label.trim()) continue;
    out[acao as AcaoDeAtalho] = {
      keycode: keycode as number,
      // O rotulo so e desenhado, mas 40 caracteres ja e mais que qualquer
      // nome de tecla - o resto seria lixo entrando pelo IPC.
      label: label.trim().slice(0, 40),
    };
  }
  return out;
}

/** Uma largura dentro dos limites, ou o padrao. Usada na leitura e no patch. */
function largura(v: unknown, padrao: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(LARGURA_MAX, Math.max(LARGURA_MIN, Math.round(n)));
}

/** Um canto conhecido, ou o padrao. Usado na leitura e no patch. */
function canto(v: unknown, padrao: TelaCanto): TelaCanto {
  return typeof v === 'string' && (TELA_CANTOS as readonly string[]).includes(v)
    ? (v as TelaCanto)
    : padrao;
}

/** Uma largura de janelinha dentro dos limites. Usada na leitura e no patch. */
function larguraTela(v: unknown, padrao: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(TELA_MAX, Math.max(TELA_MIN, Math.round(n)));
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
      // Pelo mesmo motivo das cores: vai virar grid-template-columns, e um
      // valor invalido ali colapsa a barra lateral inteira.
      sidebarWidth: largura(raw.sidebarWidth, DEFAULTS.sidebarWidth),
      // O canto vira NOME DE CLASSE no CSS: um valor desconhecido nao pinta
      // errado, nao casa com regra nenhuma - e a janelinha fica sem ancora,
      // no canto de cima a esquerda, sem nada explicando por que.
      telaCanto: canto(raw.telaCanto, DEFAULTS.telaCanto),
      telaLargura: larguraTela(raw.telaLargura, DEFAULTS.telaLargura),
      // Mapa, entao pelo mesmo motivo do volumes/screenVolumes acima: o
      // spread copiaria a referencia do JSON lido, e um settings.json de
      // antes da 0.36 deixaria o campo undefined em vez do objeto vazio.
      atalhos: atalhos(raw.atalhos),
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
  'echoCancellation', 'autoGainControl', 'rnnoise', 'volumes', 'screenVolumes',
  'voiceVolume', 'effectsVolume', 'chatVolume',
  'screenAudioDeviceId', 'isolarAudioNaTela', 'theme',
  'themeBg', 'themeBar', 'themeSymbol', 'sidebarWidth',
  'telaCanto', 'telaLargura', 'atalhos',
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
    if (k === 'sidebarWidth') {
      if (!Number.isFinite(Number(v))) continue;
      out[k] = largura(v, DEFAULTS.sidebarWidth);
      continue;
    }
    // Canto desconhecido e DESCARTADO, e nao corrigido pro padrao: o patch e
    // parcial, e deixar de fora preserva o canto que a pessoa ja tinha
    // escolhido em vez de joga-la de volta pro de fabrica.
    if (k === 'telaCanto') {
      if (typeof v !== 'string' || !(TELA_CANTOS as readonly string[]).includes(v)) continue;
      out[k] = v;
      continue;
    }
    if (k === 'telaLargura') {
      if (!Number.isFinite(Number(v))) continue;
      out[k] = larguraTela(v, DEFAULTS.telaLargura);
      continue;
    }
    // O patch de atalhos e SUBSTITUICAO do mapa inteiro, nao merge por acao:
    // e assim que "tirar a tecla desta acao" tem como ser dito. Um merge
    // deixaria o campo ausente significar "nao mexe", e nunca "apaga".
    if (k === 'atalhos') {
      out[k] = atalhos(v);
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
