/**
 * Agent Worker — standalone process entry point.
 *
 * Runs as a separate process from the Fastify server (or in-process when
 * embedded by the server via startAgentWorker()).
 *
 * Separate-process startup:
 *   node packages/agent-worker/dist/index.js
 *
 * Required env vars:
 *   OUIJA_SECRET_KEY          — Shared secret for JWT issuance (min 32 chars)
 *   OUIJA_SERVER_URL          — Base URL of the Ouija server, e.g. http://ouija:4000
 *
 * Optional env vars:
 *   OUIJA_REDIS_URL           — Redis URL (default: redis://localhost:6379)
 *   OUIJA_DATABASE_URL        — Postgres URL (used by assembler for card lookups)
 *   CLAUDE_MODEL              — Claude model ID (default: claude-sonnet-4-20250514)
 *   ANTHROPIC_API_KEY         — Anthropic API key (resolved from env by the plugin)
 *   DEFAULT_REPO_URL          — Fallback repo URL for the hardcoded agent profile
 *   DEFAULT_BASE_BRANCH       — Fallback base branch (default: main)
 *   OUIJA_WORKER_CONCURRENCY  — Number of concurrent dispatches (default: 1)
 */

import { BullMQJobQueue } from '@ouija-dev/bus';
import { autoDetectAuthProvider, ClaudeAgentPlugin } from '@ouija-dev/plugin-agent-claude';
import { AgentDispatchWorker } from './worker.js';
import { IdentityResolver } from './identity-resolver.js';
import type { AssemblerDeps, AgentProfile } from './work-order-assembler.js';

export type { AgentProfile } from './work-order-assembler.js';
export { agentConfigToProfile } from './work-order-assembler.js';
import { issueAgentJWT } from './jwt-helper.js';

// ---- Logger (structured JSON to stdout) ----

const logger = {
  info: (msg: string, ctx?: Record<string, unknown>) =>
    console.info(JSON.stringify({ level: 'info', msg, ...ctx })),
  warn: (msg: string, ctx?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: 'warn', msg, ...ctx })),
  error: (msg: string, ctx?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: 'error', msg, ...ctx })),
  debug: (msg: string, ctx?: Record<string, unknown>) =>
    console.debug(JSON.stringify({ level: 'debug', msg, ...ctx })),
};

// ---- Env helpers ----

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var "${name}" is not set`);
  return val;
}

// ---- startAgentWorker (exported for in-process embedding) ----

export interface StartWorkerOptions {
  redisUrl?: string;
  serverUrl: string;
  concurrency?: number;
  /** Override assembler deps for testing or custom wiring. */
  assemblerDeps?: AssemblerDeps;
  /** Optional kanban plugin for card detail lookups. */
  getCardDetails?: (cardId: string) => Promise<{
    title: string;
    description: string;
    acceptanceCriteria: string[];
    labels: string[];
  }>;
  /** Agent profiles from ouija.config.yaml — replaces hardcoded profile. */
  agentProfiles?: Map<string, import('./work-order-assembler.js').AgentProfile>;
  /**
   * Optional async lookup used before the YAML-backed agentProfiles map. Returns
   * an AgentProfile if the agent exists in the DB (agents table), otherwise
   * undefined to fall back to YAML. Injected by the server when the agents repo
   * is available so dashboard-created agents dispatch without YAML edits.
   */
  getAgentProfileFromDb?: (agentId: string) => Promise<import('./work-order-assembler.js').AgentProfile | undefined>;
  /**
   * Legacy static claudeHome from `ouija.config.yaml`. **Deprecated** —
   * pre-Phase-3 self-hosters bind-mounted `~/.claude` into the runner
   * and pointed `claudeHome` at the mount target. Phase 3 Task 8
   * removes the bind mount; new self-hosters get a per-dispatch
   * materialised home via `identityResolver` instead.
   */
  claudeHome?: string | null;
  /**
   * Phase 3 Task 8 — pre-built `IdentityResolver` (test injection).
   * When unset, `startAgentWorker` auto-detects an `AuthProvider`
   * from the environment via `autoDetectAuthProvider()` and wraps
   * it. Setting this skips auto-detection (used by the integration
   * test harness + by ops who pre-resolved the provider).
   */
  identityResolver?: import('./identity-resolver.js').IdentityResolver;
  /**
   * Override the per-dispatch claudeHome root dir. Defaults to
   * `/run/ouija/claude-home` (path Phase 3's compose reserves).
   */
  claudeHomeRoot?: string;
  /**
   * When `true` and no `identityResolver` / `assemblerDeps` is
   * provided, fail loud at startup if no `AuthProvider` auto-
   * detects. Default `true` — Phase 3 Task 8 deliberately removes
   * the legacy bind-mount fallback. Set `false` only for migration
   * smokes that must boot without subscription auth wired.
   */
  failWhenNoIdentity?: boolean;
}

export interface WorkerHandle {
  worker: AgentDispatchWorker;
  plugin: ClaudeAgentPlugin;
  jobQueue: BullMQJobQueue;
  stop(): Promise<void>;
}

/**
 * Create and start the agent worker. Can be called from the server (in-process
 * mode) or from main() (separate-process mode).
 *
 * Returns a handle with a stop() function for graceful shutdown.
 */
export async function startAgentWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
  const redisUrl = options.redisUrl ?? 'redis://localhost:6379';
  const concurrency = options.concurrency ?? 1;

  // 1. Job queue
  const jobQueue = new BullMQJobQueue({ url: redisUrl });

  // 2. Claude agent plugin
  const claudePlugin = new ClaudeAgentPlugin();
  await claudePlugin.init({
    config: {
      secretRef: 'env:ANTHROPIC_API_KEY',
      defaultModel: process.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-20250514',
      maxDurationMs: 1_800_000,
      repoAccessTokens: {},
    },
    logger,
    publishEvent: async () => undefined,
    enqueueJob: async () => undefined,
  });
  await claudePlugin.start();

  // 2a. Identity resolver (Phase 3 Task 8) — auto-detect an
  // AuthProvider and wrap it so each dispatch gets a private
  // materialised home. Test harnesses pass a pre-built resolver via
  // `options.identityResolver` to skip auto-detection. Setting
  // `assemblerDeps` directly also bypasses this — those callers own
  // their own dispatch-home wiring.
  let identityResolver: IdentityResolver | null = options.identityResolver ?? null;
  const failWhenNoIdentity = options.failWhenNoIdentity ?? true;
  if (identityResolver === null && options.assemblerDeps === undefined) {
    const provider = await autoDetectAuthProvider();
    if (provider !== null) {
      const resolverOpts: { rootDir?: string } = {};
      if (options.claudeHomeRoot !== undefined) {
        resolverOpts.rootDir = options.claudeHomeRoot;
      }
      identityResolver = new IdentityResolver(provider, resolverOpts);
      logger.info('IdentityResolver wired', { source: provider.kind });
    } else if (failWhenNoIdentity) {
      throw new Error(
        'startAgentWorker: no AuthProvider auto-detected. ' +
          'Set ANTHROPIC_API_KEY (EnvProvider), sign into Claude CLI ' +
          '(KeychainProvider on macOS, CredentialFileProvider on Linux), ' +
          'or pass `identityResolver` explicitly. Set `failWhenNoIdentity: false` ' +
          'to boot without subscription auth (migration smokes only).',
      );
    } else {
      logger.warn(
        'No AuthProvider auto-detected; agents will run without a materialised home — set ANTHROPIC_API_KEY or sign into Claude CLI to enable.',
      );
    }
  }

  // 3. Assembler deps — DB first, YAML map second, hardcoded stub last. That
  // order means dashboard-created agents override any YAML entry with the same
  // id, which is the expected UX: edits in the dashboard win.
  const baseDeps: AssemblerDeps = {
    getAgentProfile: async (agentId: string) => {
      if (options.getAgentProfileFromDb) {
        const dbProfile = await options.getAgentProfileFromDb(agentId);
        if (dbProfile) {
          logger.info('Agent profile resolved from DB', { agentId });
          return dbProfile;
        }
      }
      if (options.agentProfiles && options.agentProfiles.has(agentId)) {
        logger.info('Agent profile resolved from YAML', { agentId });
        return options.agentProfiles.get(agentId);
      }
      // Fallback: single hardcoded profile for backwards compatibility
      logger.warn('Agent profile falling back to env-based default', { agentId });
      return {
        id: 'rex-coder',
        name: 'Rex Coder',
        systemPrompt: 'You are an expert software engineer. Write clean, well-tested code.',
        secretRef: 'env:ANTHROPIC_API_KEY',
        model: process.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-20250514',
        maxDurationMs: 1_800_000,
        repoUrl: process.env['DEFAULT_REPO_URL'] ?? '',
        baseBranch: process.env['DEFAULT_BASE_BRANCH'] ?? 'main',
        triggerMode: 'auto' as const,
      };
    },
    getCardDetails: options.getCardDetails ?? (async (cardId: string) => ({
      title: `Card ${cardId}`,
      description: '',
      acceptanceCriteria: [],
      labels: [],
    })),
    serverBaseUrl: options.serverUrl,
    issueJwt: issueAgentJWT,
    claudeHome: options.claudeHome ?? undefined,
  };
  if (identityResolver !== null) {
    baseDeps.resolveDispatchClaudeHome = (dispatchId: string) =>
      identityResolver!.resolve(dispatchId).then(({ claudeHome }) => ({ claudeHome }));
  }
  const assemblerDeps: AssemblerDeps = options.assemblerDeps ?? baseDeps;

  // 4. Worker
  const worker = new AgentDispatchWorker({
    jobQueue,
    agentPlugin: claudePlugin,
    assemblerDeps,
    logger,
    concurrency,
  });

  await worker.start();

  const handle: WorkerHandle = {
    worker,
    plugin: claudePlugin,
    jobQueue,
    async stop() {
      await worker.stop();
      await claudePlugin.stop();
      await jobQueue.close();
    },
  };

  return handle;
}

// ---- Separate-process entry point ----

async function main(): Promise<void> {
  // Validate required env vars before doing any async work.
  requireEnv('OUIJA_SECRET_KEY');
  const serverUrl = requireEnv('OUIJA_SERVER_URL');

  const redisUrl = process.env['OUIJA_REDIS_URL'] ?? 'redis://localhost:6379';
  const concurrency = parseInt(process.env['OUIJA_WORKER_CONCURRENCY'] ?? '1', 10);

  logger.info('Agent worker starting', { serverUrl, redisUrl, concurrency });

  const handle = await startAgentWorker({ redisUrl, serverUrl, concurrency });

  logger.info('Agent worker running — waiting for jobs');

  // Graceful shutdown handlers
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Shutdown signal received: ${signal}`);
    try {
      await handle.stop();
      logger.info('Agent worker shut down cleanly');
      process.exit(0);
    } catch (err) {
      logger.error('Error during agent worker shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(() => process.exit(1));
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(() => process.exit(1));
  });
}

// Only run main() when this file is the process entry point (not when imported).
// In ESM, import.meta.url === process.argv[1] doesn't work reliably in all cases,
// so we use a try-safe heuristic: check if we have a parent that called us.
// For standalone process mode, the file is invoked directly via node.
const isMain = process.argv[1]?.includes('agent-worker');
if (isMain) {
  main().catch((err) => {
    console.error('Fatal agent worker error:', err);
    process.exit(1);
  });
}
