// ---- Fizzy kanban plugin ----
// Implements KanbanPlugin<FizzyConfig> against the Fizzy REST API.
//
// Responsibilities:
//   - Lifecycle: init, start, stop, healthCheck
//   - Route: POST /hooks/fizzy/:secret (HMAC verification)
//   - KanbanPlugin: getCard, moveCard, addComment, assignUser, getColumns

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type {
  KanbanPlugin,
  KanbanCard,
  KanbanColumn,
  PluginManifest,
  PluginContext,
  PluginHealth,
} from '@ouija-dev/types';
import { cardId, columnId, boardId } from '@ouija-dev/types';
import type { CardId, ColumnId, BoardId } from '@ouija-dev/types';

import { fizzyConfigSchema } from './config.js';
import type { FizzyConfig } from './config.js';
import { FizzyApiClient } from './api-client.js';
import { normalizeFizzyWebhook, verifyFizzySignature, isWebhookFresh } from './webhook-handler.js';
import type { PluginFactory } from '@ouija-dev/plugin-sdk';

// ---- Plugin manifest ----

const manifest: PluginManifest = {
  name: '@ouija-dev/plugin-fizzy',
  version: '0.1.0',
  type: 'kanban',
  coreApiVersion: '>=1.0.0 <2.0.0',
  configSchema: fizzyConfigSchema as unknown as Record<string, unknown>,
  dependencies: [],
  events: {
    produces: ['kanban.card.moved', 'kanban.card.assigned'],
    consumes: [],
  },
};

// ---- FizzyPlugin ----

export class FizzyPlugin implements KanbanPlugin<FizzyConfig> {
  readonly manifest = manifest;

  private config!: FizzyConfig;
  private client!: FizzyApiClient;
  private context!: PluginContext<FizzyConfig>;

  // ---- Lifecycle ----

  async init(context: PluginContext<FizzyConfig>): Promise<void> {
    this.context = context;
    this.config = context.config;
    this.client = new FizzyApiClient(this.config.baseUrl, this.config.accessToken);
    context.logger.info('FizzyPlugin initialised', { baseUrl: this.config.baseUrl });
  }

  async start(): Promise<void> {
    await this.client.ping();
    this.context.logger.info('FizzyPlugin started — API connectivity verified');

    // Auto-register webhooks if the config provides a public URL and board
    // IDs. Idempotent — ensureWebhook() skips boards that already have a
    // webhook pointing at the same URL.
    const webhookUrl = this.config.webhookUrl;
    const boardIds = this.config.boardIds ?? [];
    if (webhookUrl && boardIds.length > 0) {
      const actions = [
        'card_triaged',
        'card_assigned',
        'card_published',
        'card_closed',
        'card_sent_back_to_triage',
      ];
      for (const bid of boardIds) {
        try {
          const wh = await this.client.ensureWebhook(bid, webhookUrl, 'ouija', actions);
          this.context.logger.info('Fizzy webhook ensured', {
            boardId: bid,
            webhookId: wh.id,
            url: wh.url,
            actions: wh.subscribed_actions,
          });
        } catch (err) {
          this.context.logger.warn('Fizzy webhook registration failed', {
            boardId: bid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.context.logger.info('FizzyPlugin stopped');
  }

  async healthCheck(): Promise<PluginHealth> {
    try {
      await this.client.ping();
      return { healthy: true, message: 'Fizzy API reachable' };
    } catch (err) {
      return {
        healthy: false,
        message: `Fizzy API unreachable: ${String(err)}`,
        details: { error: String(err) },
      };
    }
  }

  // ---- Route registration ----

  async registerRoutes(server: FastifyInstance): Promise<void> {
    const plugin = this;

    server.post(
      '/hooks/fizzy/:secret',
      {
        config: { rawBody: true },
      },
      async (
        request: FastifyRequest<{ Params: { secret: string } }>,
        reply: FastifyReply,
      ) => {
        const { secret } = request.params;

        // 1. Path secret check
        if (secret !== plugin.config.webhookSecret) {
          plugin.context.logger.warn('Fizzy webhook: invalid path secret', { ip: request.ip });
          return reply.status(200).send({ ok: false });
        }

        // 2. HMAC signature verification
        const sigHeader = request.headers['x-webhook-signature'] as string | undefined;
        const rawBody: Buffer | string =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (request as any).rawBody ?? JSON.stringify(request.body);

        if (!verifyFizzySignature(plugin.config.webhookSecret, rawBody, sigHeader)) {
          plugin.context.logger.warn('Fizzy webhook: invalid HMAC signature', { ip: request.ip });
          return reply.status(200).send({ ok: false });
        }

        // 3. Timestamp freshness
        const timestampHeader = request.headers['x-webhook-timestamp'] as string | undefined;
        if (!isWebhookFresh(timestampHeader)) {
          plugin.context.logger.warn('Fizzy webhook: stale timestamp', {
            timestamp: timestampHeader,
            ip: request.ip,
          });
          return reply.status(200).send({ ok: false });
        }

        // 4. Normalize and publish
        const body = request.body as Record<string, unknown>;
        const event = normalizeFizzyWebhook(body, manifest.name);

        if (event !== null) {
          await plugin.context.publishEvent(event.topic, event.payload);
          plugin.context.logger.info('Fizzy webhook processed', {
            topic: event.topic,
            eventId: event.id,
            action: body['action'],
          });
        } else {
          plugin.context.logger.debug('Fizzy webhook: no-op event', {
            action: body['action'],
          });
        }

        return reply.status(200).send({ ok: true });
      },
    );
  }

  // ---- KanbanPlugin methods ----

  async getCard(id: CardId): Promise<KanbanCard> {
    const fizzyCard = await this.client.getCard(id as string);

    return {
      id: cardId(fizzyCard.id),
      title: fizzyCard.title,
      description: fizzyCard.description_html,
      columnId: columnId(fizzyCard.column ? fizzyCard.column.id : '0'),
      boardId: boardId(fizzyCard.board.id),
      labels: fizzyCard.tags,
      assignees: fizzyCard.assignees.map((a) => a.id),
      url: fizzyCard.url,
      createdAt: fizzyCard.created_at,
      updatedAt: fizzyCard.created_at,
    };
  }

  async moveCard(id: CardId, toColumnId: ColumnId): Promise<void> {
    await this.client.triageCard(id as string, toColumnId as string);
  }

  async addComment(id: CardId, body: string): Promise<void> {
    await this.client.addComment(id as string, body);
  }

  async assignUser(id: CardId, userId: string): Promise<void> {
    await this.client.assignUser(id as string, userId);
  }

  async getColumns(board: BoardId): Promise<KanbanColumn[]> {
    const columns = await this.client.getColumns(board as string);

    return columns.map((c, index) => ({
      id: columnId(c.id),
      name: c.name,
      position: index,
    }));
  }
}

// ---- PluginFactory ----

const fizzyPluginFactory: PluginFactory<FizzyConfig> = {
  manifest,
  create(): FizzyPlugin {
    return new FizzyPlugin();
  },
};

export default fizzyPluginFactory;
export { fizzyPluginFactory as PluginFactory };
export type { FizzyConfig } from './config.js';
