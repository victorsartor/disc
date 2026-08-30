import { SignJWT, jwtVerify } from 'jose';
import { nanoid } from 'nanoid';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { upsertUser, findUserById, type User } from './db.js';

const secret = new TextEncoder().encode(config.sessionSecret);
const SESSION_TTL = '30d';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

const redirectUri = `${config.publicUrl}/auth/callback`;

/** Sessão de longa duração — fica guardada no keychain do SO pelo Electron. */
export async function issueSession(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secret);
}

export async function verifySession(token: string): Promise<User | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (typeof payload.sub !== 'string') return null;
    return findUserById(payload.sub) ?? null;
  } catch {
    return null;
  }
}

/** Extrai e valida o usuário do header Authorization. Retorna null se inválido. */
export async function userFromRequest(req: FastifyRequest): Promise<User | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return verifySession(header.slice(7));
}

// State de OAuth guardado em memória. Nó único, some no restart — tudo bem,
// vale por 10 minutos e só protege contra CSRF no fluxo de login.
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function newState(): string {
  const s = nanoid(32);
  pendingStates.set(s, Date.now() + STATE_TTL_MS);
  return s;
}

function consumeState(s: string | undefined): boolean {
  if (!s) return false;
  const exp = pendingStates.get(s);
  pendingStates.delete(s);
  return exp !== undefined && exp > Date.now();
}

setInterval(() => {
  const now = Date.now();
  for (const [s, exp] of pendingStates) if (exp <= now) pendingStates.delete(s);
}, 60_000).unref();

function page(title: string, message: string, tone: 'ok' | 'erro'): string {
  const accent = tone === 'ok' ? '#4cc9c0' : '#e5484d';
  return `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;
       background:#0d1b2a;color:#e0e1dd;
       font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
  .card{background:#1b263b;border:1px solid #415a77;border-radius:14px;
        padding:2.5rem 3rem;text-align:center;max-width:26rem}
  h1{margin:0 0 .5rem;font-size:1.25rem;color:${accent}}
  p{margin:0;color:#778da9;font-size:.95rem}
</style>
<div class="card"><h1>${title}</h1><p>${message}</p></div>`;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  // Passo 1 — o Electron abre isto no navegador do sistema.
  // (Google bloqueia OAuth dentro de webview embutida, então tem que ser fora.)
  app.get('/auth/login', async (_req, reply) => {
    const url = new URL(GOOGLE_AUTH);
    url.searchParams.set('client_id', config.google.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', newState());
    url.searchParams.set('prompt', 'select_account');
    return reply.redirect(url.toString());
  });

  // Passo 2 — Google devolve aqui. Validamos, checamos a allowlist,
  // e mandamos a sessão de volta pro app via deep link disc://
  app.get('/auth/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };

    if (!consumeState(state)) {
      return reply.type('text/html').code(400)
        .send(page('Sessão expirada', 'O login demorou demais. Tente de novo pelo app.', 'erro'));
    }
    if (!code) {
      return reply.type('text/html').code(400)
        .send(page('Login cancelado', 'Nenhum código foi recebido do Google.', 'erro'));
    }

    const tokenRes = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      req.log.error({ status: tokenRes.status }, 'falha ao trocar code por token');
      return reply.type('text/html').code(502)
        .send(page('Erro no login', 'Não foi possível confirmar com o Google.', 'erro'));
    }

    const { access_token } = (await tokenRes.json()) as { access_token: string };

    const infoRes = await fetch(GOOGLE_USERINFO, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    if (!infoRes.ok) {
      return reply.type('text/html').code(502)
        .send(page('Erro no login', 'Não foi possível ler seu perfil do Google.', 'erro'));
    }

    const profile = (await infoRes.json()) as {
      sub: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };

    const email = profile.email?.toLowerCase();

    // Allowlist — é aqui que o controle de acesso acontece de verdade.
    if (!email || !profile.email_verified || !config.allowlist.includes(email)) {
      req.log.warn({ email }, 'tentativa de login fora da allowlist');
      return reply.type('text/html').code(403)
        .send(page('Acesso negado', 'Esta conta não está liberada neste servidor.', 'erro'));
    }

    const user = upsertUser({
      id: `u_${profile.sub}`,
      email,
      name: profile.name ?? email.split('@')[0],
      avatarUrl: profile.picture ?? null,
    });

    const session = await issueSession(user.id);
    const deepLink = `${config.appProtocol}://auth?token=${encodeURIComponent(session)}`;

    return reply.type('text/html').send(`<!doctype html><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${deepLink}">
${page('Tudo certo', 'Pode voltar pro app — já pode fechar esta aba.', 'ok')}
<script>location.href=${JSON.stringify(deepLink)}</script>`);
  });
}
