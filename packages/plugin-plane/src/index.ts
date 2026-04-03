// ---- Plane kanban plugin ----
// Implements KanbanPlugin<PlaneConfig> against the Plane REST API v1.
//
// Responsibilities:
//   - Lifecycle: init, start, stop, healthCheck
//   - Route: POST /hooks/plane/:secret  (HMAC + path-secret verification)
//   - KanbanPlugin: getCard, moveCard, addComment, assignUser, getColumns

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type {
  KanbanPlugin,
  KanbanCard,
  KanbanColumn,
  PluginManifest,
  PluginContext,
  PluginHealth,
} from '@ouija/types';
import { cardId, columnId, boardId } from '@ouija/types';
import type { CardId, ColumnId, BoardId } from '@ouija/types';

import { planeConfigSchema } from './config.js';
import type { PlaneConfig } from './config.js';
import { PlaneApiClient } from './api-client.js';
import { normalizeWebhook, verifyPlaneSignature, isWebhookFresh } from './webhook-handler.js';
import type { PluginFactory } from '@ouija/plugin-sdk';

// ---- Plugin manifest (static — safe to read before init) ----

const manifest: PluginManifest = {
  name: '@ouija/plugin-plane',
  version: '0.1.0',
  type: 'kanban',
  coreApiVersion: '>=1.0.0 <2.0.0',
  configSchema: planeConfigSchema as unknown as Record<string, unknown>,
  dependencies: [],
  events: {
    produces: ['kanban.card.moved', 'kanban.card.assigned'],
    consumes: [],
  },
};

// ---- PlanePlugin ----

export class PlanePlugin implements KanbanPlugin<PlaneConfig> {
  readonly manifest = manifest;

  private config!: PlaneConfig;
  private client!: PlaneApiClient;
  private context!: PluginContext<PlaneConfig>;

  // ---- Lifecycle ----

  async init(context: PluginContext<PlaneConfig>): Promise<void> {
    this.context = context;
    this.config = context.config;
    this.client = new PlaneApiClient(this.config.baseUrl, this.config.apiToken);
    context.logger.info('PlanePlugin initialised', {
      baseUrl: this.config.baseUrl,
      workspaceSlug: this.config.workspaceSlug,
    });
  }

  async start(): Promise<void> {
    // Verify connectivity. This will throw and prevent the plugin starting
    // if the API is unreachable, which is the correct behaviour.
    await this.client.ping(this.config.workspaceSlug);
    this.context.logger.info('PlanePlugin started — API connectivity verified');
  }

  async stop(): Promise<void> {
    this.context.logger.info('PlanePlugin stopped');
  }

  async healthCheck(): Promise<PluginHealth> {
    try {
      await this.client.ping(this.config.workspaceSlug);
      return { healthy: true, message: 'Plane API reachable' };
    } catch (err) {
      return {
        healthy: false,
        message: `Plane API unreachable: ${String(err)}`,
        details: { error: String(err) },
      };
    }
  }

  // ---- Route registration ----

  /**
   * Register the Plane webhook ingress route on the Fastify server.
   *
   * Route: POST /hooks/plane/:secret
   *
   * Security (per spec §5.5):
   *   1. Path secret — cheap first-pass filter
   *   2. HMAC-SHA256 signature (X-Plane-Signature header)
   *   3. Timestamp freshness — reject events older than 5 minutes
   *
   * Always responds 200 (even on auth failure) to prevent path enumeration.
   */
  async registerRoutes(server: FastifyInstance): Promise<void> {
    const plugin = this;

    server.post(
      '/hooks/plane/:secret',
      {
        config: {
          // Fastify 5: disable built-in body parsing so we can read raw body for HMAC.
          rawBody: true,
        },
      },
      async (
        request: FastifyRequest<{ Params: { secret: string } }>,
        reply: FastifyReply,
      ) => {
        const { secret } = request.params;

        // 1. Path secret check.
        if (secret !== plugin.config.webhookSecret) {
          plugin.context.logger.warn('Plane webhook: invalid path secret', {
            ip: request.ip,
          });
          // Return 200 to prevent enumeration.
          return reply.status(200).send({ ok: false });
        }

        // 2. HMAC signature verification.
        const sigHeader = request.headers['x-plane-signature'] as string | undefined;
        const rawBody: Buffer | string =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (request as any).rawBody ?? JSON.stringify(request.body);

        if (!verifyPlaneSignature(plugin.config.webhookSecret, rawBody, sigHeader)) {
          plugin.context.logger.warn('Plane webhook: invalid HMAC signature', {
            ip: request.ip,
          });
          return reply.status(200).send({ ok: false });
        }

        // 3. Timestamp freshness.
        const body = request.body as Record<string, unknown> | null;
        const timestamp = typeof body?.['timestamp'] === 'string' ? body['timestamp'] : undefined;

        if (!isWebhookFresh(timestamp)) {
          plugin.context.logger.warn('Plane webhook: stale timestamp', {
            timestamp,
            ip: request.ip,
          });
          return reply.status(200).send({ ok: false });
        }

        // 4. Normalize and publish.
        const event = normalizeWebhook(body, manifest.name, plugin.config.baseUrl);

        if (event !== null) {
          await plugin.context.publishEvent(event.topic, event.payload);
          plugin.context.logger.info('Plane webhook processed', {
            topic: event.topic,
            eventId: event.id,
          });
        } else {
          plugin.context.logger.debug('Plane webhook: no-op event (field not tracked)', {
            event: (body as Record<string, unknown> | null)?.['event'],
          });
        }

        return reply.status(200).send({ ok: true });
      },
    );
  }

  // ---- KanbanPlugin methods ----

  /**
   * Fetch a single card (Plane issue) by its ID.
   *
   * The cardId must be in the form "<projectId>/<issueId>" so the plugin
   * knows which project the issue belongs to, or a plain issue UUID when
   * the default project from the plugin's workspace context is used.
   *
   * Convention adopted: cardId format is "<projectId>/<issueId>".
   * This avoids storing project context separately and keeps card IDs
   * self-contained.
   */
  async getCard(id: CardId): Promise<KanbanCard> {
    const { workspaceSlug } = this.config;
    const { projectId, issueId } = splitCardId(id);

    const issue = await this.client.getIssue(workspaceSlug, projectId, issueId);

    return {
      id: cardId(`${issue.project}/${issue.id}`),
      title: issue.name,
      description: issue.description_html,
      columnId: columnId(typeof issue.state === 'string' ? issue.state : (issue.state as Record<string, string>)?.id ?? issue.state),
      boardId: boardId(issue.project),
      labels: (issue.label_details ?? (issue as unknown as Record<string, unknown>)['labels'] as typeof issue.label_details ?? []).map((l) => l.name),
      assignees: (issue.assignee_details ?? (issue as unknown as Record<string, unknown>)['assignees'] as typeof issue.assignee_details ?? []).map((a) => a.id),
      url: issueUrl(this.config.baseUrl, workspaceSlug, issue.project, issue.id),
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    };
  }

  /**
   * Move a card to a different column by updating the issue's state.
   */
  async moveCard(id: CardId, toColumnId: ColumnId): Promise<void> {
    const { workspaceSlug } = this.config;
    const { projectId, issueId } = splitCardId(id);

    await this.client.updateIssue(workspaceSlug, projectId, issueId, {
      state: toColumnId as string,
    });
  }

  /**
   * Add a comment to a card (Plane issue).
   */
  async addComment(id: CardId, body: string): Promise<void> {
    const { workspaceSlug } = this.config;
    const { projectId, issueId } = splitCardId(id);

    await this.client.addComment(workspaceSlug, projectId, issueId, body);
  }

  /**
   * Assign a user (member ID) to a card.
   */
  async assignUser(id: CardId, userId: string): Promise<void> {
    const { workspaceSlug } = this.config;
    const { projectId, issueId } = splitCardId(id);

    await this.client.assignMember(workspaceSlug, projectId, issueId, userId);
  }

  /** Expose getMembers for agent registry provisioning. */
  async getMembers(workspaceSlug?: string): Promise<import('./api-client.js').PlaneMember[]> {
    const slug = workspaceSlug ?? this.config.workspaceSlug;
    return this.client.getMembers(slug);
  }

  /** Expose inviteMember for agent registry provisioning. */
  async inviteMember(
    workspaceSlug: string | undefined,
    email: string,
    role: 5 | 10 | 15 | 20 = 10,
  ): Promise<{ id: string; email: string; role: number }> {
    const slug = workspaceSlug ?? this.config.workspaceSlug;
    return this.client.createMember(slug, email, role);
  }

  /**
   * Return all columns (states) for a given board (project).
   * The boardId is the Plane project UUID.
   */
  async getColumns(board: BoardId): Promise<KanbanColumn[]> {
    const { workspaceSlug } = this.config;
    const states = await this.client.getStates(workspaceSlug, board as string);

    return states
      .sort((a, b) => a.sequence - b.sequence)
      .map((s, index) => ({
        id: columnId(s.id),
        name: s.name,
        position: index,
      }));
  }
}

// ---- Helpers ----

/**
 * Split a composite card ID "<projectId>/<issueId>" into its parts.
 * Falls back to treating the whole string as the issueId if no slash present
 * (to handle legacy or direct-issue-ID callers).
 */
function splitCardId(id: CardId): { projectId: string; issueId: string } {
  const raw = id as string;
  const slashIdx = raw.indexOf('/');

  if (slashIdx === -1) {
    // Single UUID — assume it's the issue ID. Project must be inferred elsewhere.
    // In practice, callers should always pass "<projectId>/<issueId>".
    throw new Error(
      `PlanePlugin: cardId "${raw}" must be in "<projectId>/<issueId>" format`,
    );
  }

  return {
    projectId: raw.slice(0, slashIdx),
    issueId: raw.slice(slashIdx + 1),
  };
}

function issueUrl(
  baseUrl: string,
  workspaceSlug: string,
  projectId: string,
  issueId: string,
): string {
  return `${baseUrl.replace(/\/$/, '')}/${workspaceSlug}/projects/${projectId}/issues/${issueId}`;
}

// ---- PluginFactory (default export for plugin-loader) ----

const planePluginFactory: PluginFactory<PlaneConfig> = {
  manifest,
  create(): PlanePlugin {
    return new PlanePlugin();
  },
};

export default planePluginFactory;

// Named export for consumers who prefer it.
export { planePluginFactory as PluginFactory };
