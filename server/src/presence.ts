import { RoomServiceClient, TrackSource, type ParticipantInfo } from 'livekit-server-sdk';
import { config } from './config.js';
import { allUsers, listChannels, type StatusEfetivo, type User } from './db.js';

/**
 * Sem sinal de vida por este tempo, a pessoa é dada como offline.
 *
 * Precisa ser bem maior que o intervalo do batimento do cliente: uma
 * requisição perdida não pode apagar alguém da lista. O cliente bate a cada
 * 20s, então três batidas falhas seguidas ainda não derrubam ninguém.
 */
const OFFLINE_MS = 70_000;

/**
 * Mudo por 10 minutos vira ausente.
 *
 * O relógio conta MICROFONE DESLIGADO, não silêncio: quem está com o
 * microfone aberto continua disponível mesmo passando meia hora sem falar —
 * está ali, ouvindo. Quem mutou e esqueceu é que sai de cena.
 */
const AUSENTE_MS = 10 * 60_000;

export interface UserPresence {
  identity: string;
  name: string;
  avatarUrl: string | null;
  status: StatusEfetivo;
}

/**
 * O que os OUTROS veem — nunca a escolha crua.
 *
 * A ordem das perguntas é o que faz a regra: app fechado ganha de tudo, e
 * quem escolheu se esconder vira offline sem passar pelo resto. Só quem se
 * declarou disponível é que ainda pode cair pra ausente pelo relógio; quem
 * marcou ausente na mão fica ausente mesmo falando.
 */
export function statusEfetivo(u: User, agora = Date.now()): StatusEfetivo {
  if (!u.last_seen || agora - u.last_seen > OFFLINE_MS) return 'offline';
  if (u.status === 'invisivel') return 'offline';
  if (u.status === 'ausente') return 'ausente';
  if (!u.last_active || agora - u.last_active > AUSENTE_MS) return 'ausente';
  return 'disponivel';
}

export function usersPresence(): UserPresence[] {
  const agora = Date.now();
  return allUsers().map((u) => ({
    identity: u.id,
    name: u.name,
    avatarUrl: u.avatar_url,
    status: statusEfetivo(u, agora),
  }));
}

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

/**
 * O identity do LiveKit é o id do usuário — menos o do ingress do OBS, que
 * ganha sufixo pra não colidir com a sessão de voz da mesma pessoa.
 */
function idDoUsuario(identity: string): string {
  return identity.endsWith('_obs') ? identity.slice(0, -4) : identity;
}

/**
 * Nome e foto saem do BANCO, não do metadata do LiveKit.
 *
 * O metadata é gravado no token, uma vez, quando a pessoa entra na sala — é
 * um retrato do momento da entrada. Quem trocasse de foto durante uma call
 * continuava com a antiga na lista de todo mundo até sair e voltar, que foi
 * exatamente a queixa. O banco é a fonte da verdade e já está aqui.
 *
 * O metadata segue sendo emitido no token: o CLIENTE ainda o lê pro primeiro
 * quadro, antes de a primeira volta da presença chegar.
 */
function toMember(p: ParticipantInfo, donos: Map<string, User>): PresenceMember {
  const mic = p.tracks.find((t) => t.source === TrackSource.MICROPHONE);
  const dono = donos.get(idDoUsuario(p.identity));
  return {
    identity: p.identity,
    name: dono?.name || p.name || p.identity,
    avatarUrl: dono?.avatar_url ?? null,
    // Sem faixa de microfone publicada também é mudo: é o estado de quem
    // está em "apertar para falar" e não está com a tecla pressionada.
    isMuted: !mic || mic.muted,
    isSharing: p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE),
  };
}

/**
 * Tira alguém de todas as salas menos a que acabou de entrar.
 *
 * Trocar de canal depressa deixava a pessoa aparecendo NAS DUAS: o LiveKit
 * leva alguns segundos pra perceber sozinho que a conexão antiga morreu, e
 * nesse meio tempo `listParticipants` responde com ela nos dois lugares.
 * Aqui a saída é dita na hora, e não esperada.
 *
 * Falha de propósito em silêncio: sala que não existe, participante que já
 * saiu — tudo isso é o resultado desejado, e nenhum deles pode impedir a
 * pessoa de entrar no canal novo. A deduplicação em `presence()` é a rede
 * embaixo disto pro caso de a chamada não chegar.
 */
export async function tirarDasOutrasSalas(userId: string, salaNova: string): Promise<void> {
  await Promise.all(
    listChannels()
      .filter((ch) => ch.id !== salaNova)
      .map((ch) => svc.removeParticipant(ch.id, userId).catch(() => {})),
  );
  // O cache de 1,5s guardaria a foto anterior do mundo justamente agora, que
  // é quando ela mais engana: a pessoa já saiu e a lista ainda a mostra lá.
  cache = null;
}

export async function presence(): Promise<Presence> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const donos = new Map(allUsers().map((u) => [u.id, u]));
  const bruto: Record<string, ParticipantInfo[]> = {};

  await Promise.all(
    listChannels().map(async (ch) => {
      try {
        bruto[ch.id] = await svc.listParticipants(ch.id);
      } catch {
        // Sala em que ninguém entrou ainda não existe no LiveKit, e perguntar
        // por ela dá erro. Canal vazio é a resposta certa, não uma falha.
        bruto[ch.id] = [];
      }
    }),
  );

  /**
   * Uma pessoa está num canal só — o mais recente em que entrou.
   *
   * Rede de segurança do `tirarDasOutrasSalas`: se aquela chamada não
   * chegou (rede, LiveKit reiniciando, queda feia do cliente), a sessão
   * velha ainda aparece por alguns segundos. `joinedAtMs`, e não `joinedAt`,
   * porque a troca rápida de canal — que é justamente o caso — acontece
   * dentro do mesmo segundo, e em segundos as duas empatariam.
   */
  const maisRecente = new Map<string, { sala: string; quando: bigint }>();
  for (const [sala, ps] of Object.entries(bruto)) {
    for (const p of ps) {
      const chave = idDoUsuario(p.identity);
      const atual = maisRecente.get(chave);
      if (!atual || p.joinedAtMs > atual.quando) {
        maisRecente.set(chave, { sala, quando: p.joinedAtMs });
      }
    }
  }

  const out: Presence = {};
  for (const [sala, ps] of Object.entries(bruto)) {
    out[sala] = ps
      .filter((p) => maisRecente.get(idDoUsuario(p.identity))?.sala === sala)
      .map((p) => toMember(p, donos));
  }

  cache = { at: Date.now(), value: out };
  return out;
}
