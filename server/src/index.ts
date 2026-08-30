import Fastify from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { config, CHANNELS, isValidChannel, MAX_MESSAGE_LENGTH } from './config.js';
import { registerAuthRoutes, userFromRequest } from './auth.js';
import { recentMessages, saveMessage, type User } from './db.js';
import { rateLimit } from './ratelimit.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: true, // está atrás do Caddy
});

registerAuthRoutes(app);

/** Exige sessão válida. Responde 401 e retorna null se não houver. */
async function requireUser(req: any, reply: any): Promise<User | null> {
  const user = await userFromRequest(req);
  if (!user) {
    reply.code(401).send({ error: 'não autenticado' });
    return null;
  }
  return user;
}

app.get('/health', async () => ({ ok: true }));

app.get('/api/me', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatar_url,
    channels: CHANNELS,
    livekitUrl: config.livekit.url,
  };
});

/**
 * Emite token de sala do LiveKit.
 * Curto (10min), escopado a UMA sala e UMA identidade, assinado aqui no servidor.
 * O cliente nunca escolhe suas próprias permissões.
 */
app.post('/api/rooms/:channelId/token', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  const { channelId } = req.params as { channelId: string };
  if (!isValidChannel(channelId)) {
    return reply.code(404).send({ error: 'canal inexistente' });
  }

  if (!rateLimit(`token:${user.id}`, 30, 60_000)) {
    return reply.code(429).send({ error: 'muitas tentativas, aguarde' });
  }

  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: user.id,
    name: user.name,
    metadata: JSON.stringify({ avatarUrl: user.avatar_url }),
    ttl: '10m',
  });

  at.addGrant({
    roomJoin: true,
    room: channelId,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    // Ninguém administra sala pelo cliente
    roomAdmin: false,
    roomCreate: false,
  });

  return { token: await at.toJwt(), url: config.livekit.url, channelId };
});

/**
 * Token de ingress WHIP — é o que o OBS usa pra publicar com NVENC.
 * Reaproveita a identidade do usuário, com sufixo pra não colidir com a sessão de voz.
 */
app.post('/api/rooms/:channelId/whip', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  const { channelId } = req.params as { channelId: string };
  if (!isValidChannel(channelId)) {
    return reply.code(404).send({ error: 'canal inexistente' });
  }

  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: `${user.id}_obs`,
    name: `${user.name} (tela)`,
    ttl: '2h',
  });
  at.addGrant({ roomJoin: true, room: channelId, canPublish: true, canSubscribe: false });

  return {
    endpoint: `${config.publicUrl}/whip`,
    bearerToken: await at.toJwt(),
    channelId,
  };
});

app.get('/api/messages', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;
  return { messages: recentMessages(100) };
});

app.post('/api/messages', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  if (!rateLimit(`msg:${user.id}`, 20, 10_000)) {
    return reply.code(429).send({ error: 'devagar aí' });
  }

  const { body } = (req.body ?? {}) as { body?: unknown };
  if (typeof body !== 'string') {
    return reply.code(400).send({ error: 'corpo inválido' });
  }

  const text = body.trim();
  if (!text) return reply.code(400).send({ error: 'mensagem vazia' });
  if (text.length > MAX_MESSAGE_LENGTH) {
    return reply.code(400).send({ error: 'mensagem muito longa' });
  }

  // Guardamos o texto cru. A sanitização acontece na renderização,
  // que é o único lugar onde XSS pode virar execução.
  const id = saveMessage(user.id, text);

  return {
    message: {
      id,
      body: text,
      created_at: Date.now(),
      user_id: user.id,
      author_name: user.name,
      author_avatar: user.avatar_url,
    },
  };
});

const start = async () => {
  if (config.allowlist.length === 0) {
    app.log.warn('ALLOWED_EMAILS está vazio — ninguém vai conseguir entrar');
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`allowlist: ${config.allowlist.length} e-mail(s)`);
};

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
