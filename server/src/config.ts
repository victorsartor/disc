import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

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

  dbPath: process.env.DB_PATH ?? './data/disc.db',

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
