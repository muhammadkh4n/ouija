import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type {
  GitPlugin,
  PluginManifest,
  PluginContext,
  PluginHealth,
  StandardPR,
  OpenPRParams,
} from '@ouija-dev/types';
import type { PrId } from '@ouija-dev/types';
import type { PluginFactory } from '@ouija-dev/plugin-sdk';
import { githubConfigSchema, type GitHubConfig } from './config.js';
import { GitHubApiClient, parseRepoUrl } from './api-client.js';
import { normalizeWebhook, verifySignature } from './webhook-handler.js';

// ---- Plugin manifest ----

const manifest: PluginManifest = {
  name: '@ouija-dev/plugin-github',
  version: '0.1.0',
  type: 'git',
  coreApiVersion: '>=1.0.0 <2.0.0',
  configSchema: githubConfigSchema as unknown as Record<string, unknown>,
  dependencies: [],
  events: {
    produces: ['git.pr.opened', 'git.pr.merged'],
    consumes: [],
  },
};

// ---- Plugin implementation ----

export class GitHubPlugin implements GitPlugin<GitHubConfig> {
  readonly manifest: PluginManifest = manifest;

  private client!: GitHubApiClient;
  private context!: PluginContext<GitHubConfig>;

  // ---- Lifecycle ----

  async init(context: PluginContext<GitHubConfig>): Promise<void> {
    this.context = context;
    this.client = new GitHubApiClient(context.config.personalAccessToken);
    context.logger.info('GitHubPlugin initialised');
  }

  /**
   * Verify that the personal access token has list-repos scope.
   * A 401/403 at this point surfaces immediately rather than silently at PR time.
   */
  async start(): Promise<void> {
    try {
      await this.client.verifyToken();
      this.context.logger.info('GitHubPlugin started — token verified');
    } catch (err) {
      this.context.logger.error('GitHubPlugin start failed — token verification error', {
        error: String(err),
      });
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.context.logger.info('GitHubPlugin stopped');
  }

  async healthCheck(): Promise<PluginHealth> {
    try {
      const user = await this.client.getAuthenticatedUser();
      return {
        healthy: true,
        message: `Authenticated as ${user.login}`,
        details: { login: user.login },
      };
    } catch (err) {
      return {
        healthy: false,
        message: `GitHub API unreachable: ${String(err)}`,
      };
    }
  }

  // ---- Route registration ----

  /**
   * Register the GitHub webhook ingress route.
   *
   * Route: POST /hooks/github/:secret
   *
   * The :secret path segment is compared against `config.webhookSecret` to
   * allow routing multiple GitHub app installations to different endpoints
   * without embedding secrets in GitHub's per-repo webhook URL. The
   * X-Hub-Signature-256 header is additionally verified with HMAC-SHA256
   * so that even a leaked URL cannot be abused.
   */
  async registerRoutes(fastify: FastifyInstance): Promise<void> {
    const webhookSecret = this.context.config.webhookSecret;

    fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
        done(null, body);
      },
    );

    fastify.post<{
      Params: { secret: string };
      Headers: { 'x-github-event'?: string; 'x-hub-signature-256'?: string };
    }>(
      '/hooks/github/:secret',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const params = request.params as { secret: string };
        const headers = request.headers as {
          'x-github-event'?: string;
          'x-hub-signature-256'?: string;
        };

        // 1. Constant-time secret comparison is handled inside verifySignature.
        //    We additionally check the path secret matches to ensure correct routing.
        if (params.secret !== webhookSecret) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const signatureHeader = headers['x-hub-signature-256'] ?? '';
        const rawBody = request.body as Buffer;

        if (!verifySignature(webhookSecret, rawBody, signatureHeader)) {
          return reply.status(403).send({ error: 'Invalid signature' });
        }

        // 2. Parse and normalize the webhook.
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
        } catch {
          return reply.status(400).send({ error: 'Invalid JSON body' });
        }

        const githubEvent = headers['x-github-event'] ?? '';
        const event = normalizeWebhook(githubEvent, parsed);

        if (event !== null) {
          try {
            await this.context.publishEvent(event.topic, event.payload);
          } catch (err) {
            this.context.logger.error('Failed to publish webhook event', {
              topic: event.topic,
              error: String(err),
            });
            // Still return 200 — GitHub will retry on non-2xx responses, which
            // would cause duplicate events. We log and move on.
          }
        }

        return reply.status(200).send({ ok: true });
      },
    );
  }

  // ---- GitPlugin interface ----

  /**
   * Create a branch from `fromBranch` on the repo identified by `repoUrl`.
   */
  async createBranch(repoUrl: string, branchName: string, fromBranch: string): Promise<void> {
    const { owner, repo } = parseRepoUrl(repoUrl);
    await this.client.createBranch(owner, repo, branchName, fromBranch);
  }

  /**
   * Open a pull request on the repo identified by `repoUrl`.
   */
  async openPR(repoUrl: string, params: OpenPRParams): Promise<StandardPR> {
    return this.client.openPR(repoUrl, params);
  }

  /**
   * Merge the pull request identified by `prId`.
   */
  async mergePR(id: PrId): Promise<void> {
    await this.client.mergePR(id);
  }

  /**
   * Add a comment to the pull request identified by `prId`.
   */
  async addPRComment(id: PrId, body: string): Promise<void> {
    await this.client.addPRComment(id, body);
  }

  /**
   * Get the current state of a pull request by its `prId`.
   */
  async getPR(id: PrId): Promise<StandardPR> {
    return this.client.getPR(id);
  }
}

// ---- PluginFactory (required by PluginLoader) ----

const PluginFactoryExport: PluginFactory<GitHubConfig> = {
  manifest,
  create(): GitHubPlugin {
    return new GitHubPlugin();
  },
};

export { PluginFactoryExport as PluginFactory };
export default PluginFactoryExport;
