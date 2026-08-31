import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { userFromRequest } from './auth.js';
import { rateLimit } from './ratelimit.js';
import {
  findUserById, saveImage, deleteImage, loadImage,
  setAvatar, setBanner, patchProfile, type User,
} from './db.js';

export const MAX_BIO_LENGTH = 300;
export const MAX_STATUS_LENGTH = 60;
export const MAX_NAME_LENGTH = 32;

/**
 * Os efeitos de perfil que existem.
 *
 * Lista fechada, e é ela que decide — o valor vira nome de classe CSS do
 * outro lado, e classe CSS montada com texto do usuário é como se escreve
 * um seletor arbitrário no documento de todo mundo que abrir o cartão.
 *
 * Espelha o EFEITOS de client/src/lib/efeitos.ts. Os dois têm que andar
 * juntos: aqui mora a permissão, lá mora a aparência.
 */
const PROFILE_EFFECTS = new Set([
  'nenhum', 'brilho', 'parallax', 'pulso', 'granulado',
]);

/** Teto do arquivo já decodificado. O cliente redimensiona antes de mandar;
 *  isto é a rede de segurança contra quem falar com a API na mão. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * Teto de imagem animada — maior, porque é a única que ninguém reduziu.
 *
 * As outras chegam aqui já passadas pelo canvas do cliente, num tamanho que
 * a tela vai realmente usar. Um GIF não pode: canvas desenha um quadro só, e
 * reduzir mataria a animação junto. Então ele sobe do jeito que saiu do
 * disco, e o teto sobe com ele. Bate com o MAX_ANIMADA_BYTES do
 * client/src/lib/image.ts — os dois números têm que andar juntos.
 *
 * Estes bytes viram BLOB no SQLite (ver o comentário da tabela images), e o
 * better-sqlite3 é síncrono: 8 MB ainda é rápido o bastante pra não travar
 * o event loop de forma perceptível. Um teto muito acima disso seria o
 * sinal de que as imagens deveriam ir pro filesDir, como os anexos foram.
 */
const MAX_ANIMATED_BYTES = 8 * 1024 * 1024;

// Só formatos que todo navegador desenha. Nada de SVG: SVG é documento, e
// documento com <script> dentro servido do nosso domínio é XSS de graça.
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Os que podem chegar animados, e por isso ganham o teto maior.
 *
 * Não checamos se o arquivo REALMENTE está animado — um PNG disfarçado de
 * GIF só compraria 5 MB a mais de espaço, e o custo de decodificar todo
 * upload pra confirmar não paga isso.
 */
const ANIMATED_MIME = new Set(['image/gif', 'image/webp']);

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

/** Base64 gordo o bastante pra virar os 8 MB de um animado depois de
 *  decodificado — o base64 infla um terço, e ainda sobra pro JSON em volta. */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

/**
 * A identidade do LiveKit é o id do usuário — exceto a do ingress do OBS,
 * que ganha sufixo pra não colidir com a sessão de voz. Quem clica no
 * retângulo "(tela)" está clicando na pessoa, então desfazemos o sufixo.
 */
function userIdFromIdentity(identity: string): string {
  return identity.endsWith('_obs') ? identity.slice(0, -4) : identity;
}

function imageUrl(id: string): string {
  return `${config.publicUrl}/api/img/${id}`;
}

/** O que qualquer pessoa do servidor pode ver de qualquer outra. */
function publicProfile(u: User) {
  return {
    id: u.id,
    name: u.name,
    avatarUrl: u.avatar_url,
    bannerUrl: u.banner_url,
    bio: u.bio ?? '',
    statusText: u.status_text ?? '',
    /** Bruto, em ms. Quem escolhe como apresentar é a tela. */
    voiceMs: u.voice_ms ?? 0,
    // O ?? cobre a linha que existia antes da coluna: o DEFAULT do ALTER
    // vale pra linha nova, mas um banco em uso pode devolver null aqui.
    profileEffect: u.profile_effect ?? 'nenhum',
  };
}

/** Decodifica e valida o data URL vindo do renderer. Lança em qualquer erro. */
function decodeDataUrl(raw: unknown): { mime: string; bytes: Buffer } {
  if (typeof raw !== 'string') throw new Error('imagem inválida');
  const m = DATA_URL.exec(raw);
  if (!m) throw new Error('imagem inválida');

  const mime = m[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) throw new Error('formato não suportado');

  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length === 0) throw new Error('imagem vazia');

  const teto = ANIMATED_MIME.has(mime) ? MAX_ANIMATED_BYTES : MAX_IMAGE_BYTES;
  if (bytes.length > teto) throw new Error('imagem muito grande');

  return { mime, bytes };
}

/** Se a URL antiga apontava pro nosso próprio /api/img, devolve o id dela. */
function ownImageId(url: string | null): string | null {
  if (!url) return null;
  const prefix = `${config.publicUrl}/api/img/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

export function registerProfileRoutes(app: FastifyInstance): void {
  /**
   * Bytes da imagem, sem sessão.
   *
   * É uma tag <img> do renderer que busca isto, e tag não manda header de
   * autorização. O que protege é o id: 21 caracteres aleatórios por imagem,
   * do mesmo jeito que a URL do avatar do Google — mais o fato de o servidor
   * inteiro só existir dentro da tailnet.
   */
  app.get('/api/img/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const img = loadImage(id);
    if (!img) return reply.code(404).send({ error: 'imagem inexistente' });

    return reply
      .header('content-type', img.mime)
      // O id muda toda vez que a imagem muda, então o conteúdo de uma URL
      // nunca muda: dá pra guardar pra sempre.
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(img.bytes);
  });

  /** Perfil de qualquer um — é o que abre ao clicar numa pessoa. */
  app.get('/api/users/:identity', async (req, reply) => {
    const me = await userFromRequest(req);
    if (!me) return reply.code(401).send({ error: 'não autenticado' });

    const { identity } = req.params as { identity: string };
    const user = findUserById(userIdFromIdentity(identity));
    if (!user) return reply.code(404).send({ error: 'pessoa inexistente' });

    return { user: publicProfile(user) };
  });

  /** Texto do próprio perfil: recado e "sobre mim". */
  app.patch('/api/me/profile', async (req, reply) => {
    const me = await userFromRequest(req);
    if (!me) return reply.code(401).send({ error: 'não autenticado' });

    if (!rateLimit(`profile:${me.id}`, 30, 60_000)) {
      return reply.code(429).send({ error: 'devagar aí' });
    }

    const { name, bio, statusText, profileEffect } = (req.body ?? {}) as {
      name?: unknown;
      bio?: unknown;
      statusText?: unknown;
      profileEffect?: unknown;
    };

    const patch: {
      name?: string;
      bio?: string;
      statusText?: string;
      profileEffect?: string;
    } = {};

    if (name !== undefined) {
      if (typeof name !== 'string') return reply.code(400).send({ error: 'apelido inválido' });
      const limpo = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
      if (!limpo) return reply.code(400).send({ error: 'apelido não pode ficar vazio' });
      patch.name = limpo;
    }
    if (bio !== undefined) {
      if (typeof bio !== 'string') return reply.code(400).send({ error: 'bio inválida' });
      patch.bio = bio.trim().slice(0, MAX_BIO_LENGTH);
    }
    if (statusText !== undefined) {
      if (typeof statusText !== 'string') {
        return reply.code(400).send({ error: 'recado inválido' });
      }
      // Uma linha só: quebra de linha aqui vira layout torto na sidebar.
      patch.statusText = statusText.replace(/\s+/g, ' ').trim().slice(0, MAX_STATUS_LENGTH);
    }
    if (profileEffect !== undefined) {
      // Contra a lista, não contra um formato. O valor vira nome de classe
      // no cartão de todo mundo, então "parece um id" não basta — tem que
      // ser um dos que existem.
      if (typeof profileEffect !== 'string' || !PROFILE_EFFECTS.has(profileEffect)) {
        return reply.code(400).send({ error: 'efeito inválido' });
      }
      patch.profileEffect = profileEffect;
    }

    return { user: publicProfile(patchProfile(me.id, patch)) };
  });

  // Foto e capa compartilham tudo menos a coluna que gravam.
  for (const kind of ['avatar', 'banner'] as const) {
    app.post(
      `/api/me/${kind}`,
      { bodyLimit: MAX_BODY_BYTES },
      async (req, reply) => {
        const me = await userFromRequest(req);
        if (!me) return reply.code(401).send({ error: 'não autenticado' });

        if (!rateLimit(`img:${me.id}`, 20, 60_000)) {
          return reply.code(429).send({ error: 'devagar aí' });
        }

        const { dataUrl } = (req.body ?? {}) as { dataUrl?: unknown };
        const antiga = kind === 'avatar' ? me.avatar_url : me.banner_url;

        // null limpa: a capa some, a foto volta pra do Google.
        if (dataUrl === null) {
          const user = kind === 'avatar'
            ? setAvatar(me.id, me.google_avatar_url, false)
            : setBanner(me.id, null);
          const velha = ownImageId(antiga);
          if (velha) deleteImage(velha);
          return { user: publicProfile(user) };
        }

        let img: { mime: string; bytes: Buffer };
        try {
          img = decodeDataUrl(dataUrl);
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }

        const id = nanoid();
        saveImage(id, img.mime, img.bytes);

        const user = kind === 'avatar'
          ? setAvatar(me.id, imageUrl(id), true)
          : setBanner(me.id, imageUrl(id));

        // Só depois de a nova estar gravada e apontada. Se algo explodir no
        // meio, o pior caso é uma imagem órfã — não um perfil sem foto.
        const velha = ownImageId(antiga);
        if (velha) deleteImage(velha);

        return { user: publicProfile(user) };
      },
    );
  }
}
