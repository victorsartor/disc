import 'dotenv/config';
import { dirname, join } from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

const dbPath = process.env.DB_PATH ?? './data/disc.db';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  publicUrl: required('PUBLIC_URL'),
  sessionSecret: required('SESSION_SECRET'),

  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
  },

  livekit: {
    url: required('LIVEKIT_URL'),
    // Endereço interno, dentro da rede do compose. O LIVEKIT_URL público sai
    // pela tailnet e volta pelo Caddy só pra chegar no container vizinho —
    // daqui o LiveKit está a um hop de distância.
    internalUrl: process.env.LIVEKIT_INTERNAL_URL ?? 'http://livekit:7880',
    apiKey: required('LIVEKIT_API_KEY'),
    apiSecret: required('LIVEKIT_API_SECRET'),
  },

  // Controle de acesso: só estes e-mails entram. Sem convite, sem cadastro aberto.
  allowlist: (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /**
   * Quem pode apagar mensagem dos outros.
   *
   * Mesma forma do allowlist, e de propósito: é uma variável de ambiente, e
   * não uma coluna em `users`. Admin aqui não é um papel que muda — é o dono
   * do servidor. Uma coluna traria migração, uma tela pra promover alguém e
   * um segundo lugar pra desincronizar, tudo pra representar uma lista que
   * hoje tem um nome só.
   *
   * Quem está aqui NÃO precisa estar no ALLOWED_EMAILS: as duas listas são
   * independentes, e um admin que não pode entrar seria só uma pegadinha.
   * Confira as duas ao adicionar alguém.
   */
  admins: (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  dbPath,

  /**
   * Bytes dos anexos do chat.
   *
   * Ficam em ARQUIVO, não como BLOB no SQLite (que é onde moram as fotos de
   * perfil): o better-sqlite3 é síncrono e materializa o BLOB inteiro em
   * memória, então um anexo de 200 MB travaria o event loop a cada download.
   *
   * DERIVADO do dbPath, e não uma variável de ambiente própria, porque os
   * dois têm que morar no mesmo volume. Como caminho independente ele
   * nasceu errado: o compose passa DB_PATH=/data/disc.db mas não passaria um
   * FILES_DIR, então os anexos iam pro ./data/arquivos relativo — dentro da
   * camada descartável do container, e apagados no próximo build. Derivando,
   * não existe como configurar um e esquecer o outro.
   */
  filesDir: join(dirname(dbPath), 'arquivos'),

  // Protocolo do deep link que devolve a sessão pro app Electron
  appProtocol: process.env.APP_PROTOCOL ?? 'disc',
};

// Servidor único, canais fixos. Nada de criar/deletar sala em runtime.
export const CHANNELS = [
  { id: 'sala-1', name: 'Sala 1' },
  { id: 'sala-2', name: 'Sala 2' },
] as const;

export type ChannelId = (typeof CHANNELS)[number]['id'];

export function isValidChannel(id: string): id is ChannelId {
  return CHANNELS.some((c) => c.id === id);
}

export const MAX_MESSAGE_LENGTH = 2000;

/**
 * Enquete: os limites da pergunta e das opções.
 *
 * O mínimo de 2 opções é o que separa uma enquete de um anúncio. O máximo
 * de 6 é a leitura: acima disso as barras ficam finas demais pra comparar
 * de relance, que é a única coisa que uma enquete precisa fazer bem.
 */
export const MAX_POLL_QUESTION = 200;
export const MAX_POLL_OPTION = 80;
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 6;

/** Teto de um anexo. O cliente também barra antes de subir; aqui é a rede. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

/**
 * Os emojis que dá pra usar numa reação.
 *
 * Lista FECHADA, e o servidor recusa o que não estiver aqui. Um picker
 * completo significaria aceitar qualquer string curta do cliente — e uma
 * coluna que aceita qualquer coisa vira uma coluna com qualquer coisa
 * dentro. Seis cobrem o que seis pessoas usam; a ordem é a que aparece na
 * tirinha do hover.
 */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'] as const;

export function isValidReaction(emoji: string): boolean {
  return (REACTION_EMOJIS as readonly string[]).includes(emoji);
}

/**
 * Teto do espaço TOTAL de anexos.
 *
 * Ao estourar, os mais antigos saem até caber de novo (ver faxina em
 * arquivos.ts). Existe porque o servidor é o PC de alguém: sem um teto,
 * cinco pessoas mandando vídeo enchem o disco e derrubam o banco junto —
 * e quem descobre é o dono da máquina, do jeito ruim.
 */
export const MAX_TOTAL_BYTES = Number(process.env.MAX_TOTAL_BYTES ?? 20 * 1024 * 1024 * 1024);
