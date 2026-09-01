/**
 * Anexos do chat: subir, baixar e a faxina que segura o disco.
 *
 * Os bytes vão pra config.filesDir, um arquivo por id, e nunca pro SQLite —
 * o porquê está no comentário do filesDir em config.ts. O banco guarda só
 * os metadados.
 *
 * Nada de multipart nem de base64. O processo main do app manda os bytes
 * crus e os metadados na query, e aqui eles vão de stream direto pro disco.
 * Base64 (o caminho das fotos de perfil) infla 33% e obriga a segurar o
 * arquivo inteiro na memória: num anexo de 200 MB isso é meio giga de RAM
 * por pessoa subindo.
 */

import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { config, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from './config.js';
import { userFromRequest } from './auth.js';
import { rateLimit } from './ratelimit.js';
import {
  saveAttachment, findAttachment, deleteAttachmentRow,
  totalAttachmentBytes, oldestAttachments, orphanAttachments,
  type AttachmentKind,
} from './db.js';

mkdirSync(config.filesDir, { recursive: true });

/**
 * O que o chat desenha na própria conversa, e portanto o que pode ser
 * servido com o content-type de verdade.
 *
 * Nada de SVG, pelo mesmo motivo do profile.ts: SVG é documento, e
 * documento com <script> dentro servido do nosso domínio é XSS de graça.
 */
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const AUDIO_MIME = new Set([
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav',
  'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac',
]);

/**
 * Vídeo que o Chromium toca de verdade.
 *
 * A lista é curta de propósito, e .mkv (video/x-matroska) fica DE FORA: o
 * Chromium abre o container mas quase nunca toca o codec que vem dentro, e
 * o resultado seria um retângulo preto no lugar de um botão de baixar que
 * funciona. Classificar como vídeo o que não toca é pior que não
 * classificar — cair em 'file' pelo menos entrega o arquivo.
 *
 * O caminho já estava pronto pro player: o GET responde Range desde os
 * áudios, que é exatamente o que permite pular pro meio do vídeo.
 */
const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/ogg']);

/** Onde os bytes de um anexo moram. O id é o nome: nada vindo do usuário. */
const caminho = (id: string) => join(config.filesDir, id);

/**
 * O anexo como o app o recebe — com a URL pronta.
 *
 * Mesma escolha do imageUrl() do profile.ts: quem sabe o endereço público é
 * o servidor, e montar URL no cliente significaria ensinar o cliente a
 * saber disso também.
 */
export function paraCliente(a: {
  id: string; name: string; mime: string; size: number; kind: AttachmentKind;
}) {
  return {
    id: a.id,
    name: a.name,
    mime: a.mime,
    size: a.size,
    kind: a.kind,
    url: `${config.publicUrl}/api/arquivos/${a.id}`,
  };
}

/**
 * Decide como o anexo vai ser tratado, a partir do mime que o cliente
 * declarou.
 *
 * O que NÃO estiver nas três listas vira 'file' e perde o mime declarado:
 * passa a ser servido como octet-stream, pra download. É de propósito —
 * servir bytes de usuário com o content-type que o próprio usuário escolheu
 * é o caminho curto pra alguém mandar um "audio/mpeg" que na verdade é
 * text/html e virar script rodando no nosso domínio.
 */
function classificar(mimeDeclarado: string): { kind: AttachmentKind; mime: string } {
  const m = mimeDeclarado.toLowerCase().split(';')[0].trim();
  if (IMAGE_MIME.has(m)) return { kind: 'image', mime: m };
  if (AUDIO_MIME.has(m)) return { kind: 'audio', mime: m };
  if (VIDEO_MIME.has(m)) return { kind: 'video', mime: m };
  return { kind: 'file', mime: 'application/octet-stream' };
}

/**
 * Nome de arquivo apresentável.
 *
 * Não é defesa de path traversal aqui — no disco quem nomeia é o nanoid,
 * este nome nunca vira caminho do lado de cá. É que ele volta pro app, que
 * o usa como sugestão na janela de salvar; barra e caractere de controle
 * atrapalham lá.
 */
function limparNome(bruto: string): string {
  const limpo = bruto
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 200);
  return limpo || 'arquivo';
}

/**
 * Apaga os bytes e a linha. Some dos dois lugares ou de nenhum.
 *
 * Exportado porque apagar mensagem também passa por aqui: a lápide leva o
 * anexo junto, e a faxina não recolheria esse arquivo nunca (ela procura
 * message_id NULL, e o dele continua preenchido). Ver deleteMessage no db.ts.
 */
export function apagarAnexo(id: string): void {
  try {
    rmSync(caminho(id), { force: true });
  } catch (err) {
    console.error('nao consegui apagar os bytes do anexo', id, err);
    // Segue pro delete da linha assim mesmo: um arquivo órfão no disco é
    // menos ruim que uma linha apontando pra bytes que já sumiram.
  }
  deleteAttachmentRow(id);
}

/** Uma hora sem virar mensagem e o anexo é lixo de quem desistiu de mandar. */
const VALIDADE_ORFAO = 60 * 60 * 1000;

/**
 * Segura o disco em dois passos.
 *
 * Primeiro os órfãos, que não são de ninguém. Só depois, se ainda estourar
 * o teto, os mais antigos — esses estão numa conversa e alguém vai sentir
 * falta, então são o último recurso.
 *
 * Roda depois de cada upload, que é o único momento em que o total cresce.
 */
function faxina(): void {
  for (const a of orphanAttachments(Date.now() - VALIDADE_ORFAO)) apagarAnexo(a.id);

  let total = totalAttachmentBytes();
  if (total <= MAX_TOTAL_BYTES) return;

  // Em lotes: apagar de 50 em 50 evita carregar a tabela inteira quando o
  // teto for baixado de uma vez.
  while (total > MAX_TOTAL_BYTES) {
    const lote = oldestAttachments(50);
    if (lote.length === 0) break;
    for (const a of lote) {
      apagarAnexo(a.id);
      total -= a.size;
      if (total <= MAX_TOTAL_BYTES) break;
    }
  }
}

export function registerFileRoutes(app: FastifyInstance): void {
  /**
   * Bytes crus. Sem este parser o Fastify recusaria o content-type, e com
   * um `parseAs` ele juntaria o arquivo todo na memória antes de entregar —
   * exatamente o que este caminho existe pra evitar.
   */
  app.addContentTypeParser(
    'application/octet-stream',
    (_req, payload, done) => done(null, payload),
  );

  app.post(
    '/api/arquivos',
    // O teto de verdade é contado byte a byte lá embaixo: content-length
    // pode mentir ou nem vir. Isto aqui é só o corte barato de quem anuncia
    // o exagero de antemão.
    { bodyLimit: MAX_FILE_BYTES },
    async (req, reply) => {
      const me = await userFromRequest(req);
      if (!me) return reply.code(401).send({ error: 'não autenticado' });

      if (!rateLimit(`arquivo:${me.id}`, 20, 60_000)) {
        return reply.code(429).send({ error: 'devagar aí' });
      }

      const { nome, mime } = (req.query ?? {}) as { nome?: unknown; mime?: unknown };
      if (typeof nome !== 'string' || typeof mime !== 'string') {
        return reply.code(400).send({ error: 'faltou nome ou tipo do arquivo' });
      }

      const id = nanoid();
      const destino = caminho(id);
      const { kind, mime: mimeFinal } = classificar(mime);

      let escritos = 0;
      try {
        await pipeline(
          req.body as Readable,
          // Conta enquanto passa e corta na hora de estourar, em vez de
          // gravar 2 GB no disco pra só então reclamar do tamanho.
          async function* (origem) {
            for await (const pedaco of origem) {
              escritos += pedaco.length;
              if (escritos > MAX_FILE_BYTES) throw new Error('grande demais');
              yield pedaco;
            }
          },
          createWriteStream(destino),
        );
      } catch (err) {
        rmSync(destino, { force: true });
        const grande = (err as Error).message === 'grande demais';
        return reply
          .code(grande ? 413 : 400)
          .send({ error: grande ? 'arquivo maior que o limite' : 'upload falhou' });
      }

      if (escritos === 0) {
        rmSync(destino, { force: true });
        return reply.code(400).send({ error: 'arquivo vazio' });
      }

      const registro = {
        id,
        name: limparNome(nome),
        mime: mimeFinal,
        size: escritos,
        kind,
      };
      saveAttachment({ ...registro, userId: me.id });

      faxina();

      return { attachment: paraCliente(registro) };
    },
  );

  /**
   * Bytes de volta, sem sessão — mesma razão do /api/img/:id: é uma tag
   * <img> ou <audio> que busca isto, e tag não manda header de autorização.
   * Quem protege é o id aleatório mais o fato de o servidor só existir
   * dentro da tailnet.
   *
   * Responde Range porque é o que faz a barrinha do áudio conseguir pular
   * pro meio, e o que deixa um download interrompido continuar de onde
   * parou em vez de recomeçar.
   */
  app.get('/api/arquivos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const meta = findAttachment(id);
    if (!meta) return reply.code(404).send({ error: 'arquivo inexistente' });

    let tamanho: number;
    try {
      tamanho = statSync(caminho(id)).size;
    } catch {
      // Linha viva e bytes sumidos: a faxina ou uma limpeza na mão.
      return reply.code(404).send({ error: 'arquivo inexistente' });
    }

    // O mime já foi decidido e sanitizado no upload (ver classificar), então
    // aqui dá pra confiar nele. `attachment` no que não é imagem nem áudio
    // fecha a porta de abrir um arquivo qualquer dentro da nossa origem.
    reply
      .header('content-type', meta.mime)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff');

    if (meta.kind === 'file') {
      reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
    }

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const inicio = range[1] ? Number(range[1]) : 0;
      const fim = range[2] ? Math.min(Number(range[2]), tamanho - 1) : tamanho - 1;

      if (inicio >= tamanho || fim < inicio) {
        return reply
          .code(416)
          .header('content-range', `bytes */${tamanho}`)
          .send();
      }

      return reply
        .code(206)
        .header('content-range', `bytes ${inicio}-${fim}/${tamanho}`)
        .header('content-length', fim - inicio + 1)
        .send(createReadStream(caminho(id), { start: inicio, end: fim }));
    }

    return reply
      .header('content-length', tamanho)
      .send(createReadStream(caminho(id)));
  });
}
