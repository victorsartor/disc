import { RoomServiceClient, TrackSource, type ParticipantInfo } from 'livekit-server-sdk';
import { config, CHANNELS } from './config.js';

/**
 * Quem está em cada canal de voz, para quem ainda NÃO entrou.
 *
 * O LiveKit só conta os participantes de uma sala para quem já está dentro
 * dela — é assim que o SFU funciona. Então a lista de quem está em outro
 * canal não tem como vir pelo cliente: ela sai daqui, do servidor, que fala
 * com a API de administração do LiveKit e já tem as chaves para isso.
 */

export interface PresenceMember {
  identity: string;
  name: string;
  avatarUrl: string | null;
  isMuted: boolean;
  isSharing: boolean;
}

export type Presence = Record<string, PresenceMember[]>;

const svc = new RoomServiceClient(
  config.livekit.internalUrl,
  config.livekit.apiKey,
  config.livekit.apiSecret,
);

/**
 * Cache curto.
 *
 * Todo mundo com o app aberto consulta isto de poucos em poucos segundos,
 * inclusive quem está fora de call. Sem cache, N pessoas viram N rajadas de
 * chamadas ao LiveKit para responder sempre a mesma coisa.
 */
const TTL_MS = 1500;
let cache: { at: number; value: Presence } | null = null;

function readAvatar(metadata: string): string | null {
  try {
    return metadata ? (JSON.parse(metadata).avatarUrl ?? null) : null;
  } catch {
    return null;
  }
}

function toMember(p: ParticipantInfo): PresenceMember {
  const mic = p.tracks.find((t) => t.source === TrackSource.MICROPHONE);
  return {
    identity: p.identity,
    name: p.name || p.identity,
    avatarUrl: readAvatar(p.metadata),
    // Sem faixa de microfone publicada também é mudo: é o estado de quem
    // está em "apertar para falar" e não está com a tecla pressionada.
    isMuted: !mic || mic.muted,
    isSharing: p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE),
  };
}

export async function presence(): Promise<Presence> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const out: Presence = {};

  await Promise.all(
    CHANNELS.map(async (ch) => {
      try {
        out[ch.id] = (await svc.listParticipants(ch.id)).map(toMember);
      } catch {
        // Sala em que ninguém entrou ainda não existe no LiveKit, e perguntar
        // por ela dá erro. Canal vazio é a resposta certa, não uma falha.
        out[ch.id] = [];
      }
    }),
  );

  cache = { at: Date.now(), value: out };
  return out;
}
