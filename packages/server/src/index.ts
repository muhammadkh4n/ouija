/**
 * Ouija server entry point.
 *
 * Startup sequence:
 *   1. Validate env vars
 *   2. Create Database (PostgreSQL) and auto-run migrations
 *   3. Create EventBus + JobQueue (BullMQ)
 *   4. Create Redis client + set JWT denylist client
 *   5. Create PluginLoader
 *   6. Wire Plane plugin (if PLANE_API_TOKEN is set) or use kanban placeholder
 *   7. Create Orchestrator + StallMonitor
 *   8. Build Fastify app
 *   9. Wire Telegram notification plugin (if TELEGRAM_BOT_TOKEN is set)
 *  10. Start agent worker in-process (single-process mode)
 *  11. Start StallMonitor + app.listen()
 *
 * Graceful shutdown:
 *   SIGTERM / SIGINT → close Fastify, stop StallMonitor, stop agent worker,
 *   drain job queue, close event bus, quit Redis, pool.end()
 *
 * Environment variables:
 *   Required:
 *     OUIJA_SECRET_KEY          — Min 32 chars, shared with agent worker for JWT
 *     OUIJA_DATABASE_URL        — PostgreSQL connection URL
 *   Optional:
 *     OUIJA_REDIS_URL           — Default: redis://localhost:6379
 *     PORT                      — Default: 4000
 *     LOG_LEVEL                 — Default: info
 *     OUIJA_SERVER_URL          — Externally reachable URL (for agent callbacks)
 *     PLANE_API_TOKEN           — Enables real Plane plugin
 *     PLANE_BASE_URL            — Plane instance URL (default: https://app.plane.so)
 *     PLANE_WORKSPACE_SLUG      — Plane workspace slug
 *     PLANE_WEBHOOK_SECRET      — Plane webhook signature secret
 *     TELEGRAM_BOT_TOKEN        — Enables Telegram notification plugin
 *     TELEGRAM_CHAT_ID          — Telegram chat to send notifications to
 *     ANTHROPIC_API_KEY         — Required when agent worker is enabled
 *     GITHUB_WEBHOOK_SECRET     — GitHub webhook signature secret
 *     FIZZY_ACCESS_TOKEN        — Enables Fizzy kanban plugin (mutually exclusive with PLANE_*)
 *     FIZZY_BASE_URL            — Fizzy instance URL (required with FIZZY_ACCESS_TOKEN)
 *     FIZZY_WEBHOOK_SECRET      — Fizzy webhook HMAC signing secret
 */

import { buildApp } from './app.js';
import { setJWTRedisClient } from './jwt.js';

// ---- Env validation ----

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Required environment variable "${name}" is not set`);
  }
  return val;
}

// ---- Main ----

async function main(): Promise<void> {
  // 1. Validate required env vars
  const secretKey = requireEnv('OUIJA_SECRET_KEY');
  const databaseUrl = requireEnv('OUIJA_DATABASE_URL');
  const redisUrl = process.env['OUIJA_REDIS_URL'] ?? 'redis://localhost:6379';
  const port = parseInt(process.env['PORT'] ?? '4000', 10);
  // The server's own externally-reachable URL — used by agent worker for callbacks.
  const serverUrl = process.env['OUIJA_SERVER_URL'] ?? `http://localhost:${port}`;

  // ---- Load ouija config (optional — falls back to env-var-driven defaults) ----
  const configPath = process.env['OUIJA_CONFIG_PATH'] ?? 'ouija.config.yaml';
  let ouijaConfig: import('@ouija-dev/config').OuijaConfig | undefined;

  try {
    const { loadConfig } = await import('@ouija-dev/config');
    ouijaConfig = await loadConfig(configPath);
    console.info(`Loaded ouija config from ${configPath} — ${ouijaConfig.agents.length} agent(s) defined`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.info(`No ouija config found at ${configPath} — using env-var defaults`);
    } else {
      throw err; // Config exists but is invalid — fail fast
    }
  }

  if (secretKey.length < 32) {
    throw new Error('OUIJA_SECRET_KEY must be at least 32 characters');
  }

  // 2. Create database
  const { createDatabase } = await import('@ouija-dev/engine');
  const { db, pool } = createDatabase(databaseUrl);

  // Verify DB connectivity before registering routes
  try {
    await db.ping();
  } catch (err) {
    throw new Error(
      `Database connection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Auto-run migrations in filename-sort order (001, 002, 003, ...).
  // Each file is CREATE TABLE IF NOT EXISTS / ALTER ADD COLUMN IF NOT EXISTS
  // so re-running is safe — no migrations table needed at this scale.
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  try {
    const engineDir = dirname(fileURLToPath(import.meta.resolve('@ouija-dev/engine')));
    const migrationsDir = join(engineDir, '..', 'src', 'migrations');
    const migrations = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const client = await pool.connect();
    try {
      for (const filename of migrations) {
        const migrationSql = readFileSync(join(migrationsDir, filename), 'utf-8');
        await client.query(migrationSql);
        console.info(`Applied migration: ${filename}`);
      }
      console.info(`Database migrations applied successfully (${migrations.length} files)`);
    } finally {
      client.release();
    }
  } catch (err) {
    // Idempotent — tables may already exist from a previous run.
    console.warn(`Migration warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Create EventBus + JobQueue
  const redisConnection = { url: redisUrl };
  const { BullMQEventBus, BullMQJobQueue } = await import('@ouija-dev/bus');
  const eventBus = new BullMQEventBus(redisConnection);
  const jobQueue = new BullMQJobQueue(redisConnection);

  // 4. Set up Redis client for JWT denylist using ioredis
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(redisUrl, { lazyConnect: true });
  await redis.connect();

  setJWTRedisClient({
    set: async (key: string, value: string, options: { ex: number }) => {
      await redis.set(key, value, 'EX', options.ex);
    },
    get: async (key: string) => redis.get(key),
  });

  // 5. Create PluginLoader
  const { PluginLoader } = await import('@ouija-dev/plugin-sdk');
  const startupLogger = {
    debug: (msg: string) => console.debug(msg),
    info: (msg: string) => console.info(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  };
  const pluginLoader = new PluginLoader(startupLogger);

  // ---- Shared PluginContext factory ----
  // Plugins get access to the event bus and job queue but not the DB directly.
  const makePluginContext = (
    pluginName: string,
    config: Record<string, unknown>,
  ): import('@ouija-dev/types').PluginContext<Record<string, unknown>> => ({
    config,
    logger: {
      debug: (msg, meta) => console.debug(JSON.stringify({ level: 'debug', plugin: pluginName, msg, ...meta })),
      info: (msg, meta) => console.info(JSON.stringify({ level: 'info', plugin: pluginName, msg, ...meta })),
      warn: (msg, meta) => console.warn(JSON.stringify({ level: 'warn', plugin: pluginName, msg, ...meta })),
      error: (msg, meta) => console.error(JSON.stringify({ level: 'error', plugin: pluginName, msg, ...meta })),
    },
    publishEvent: async (topic, payload) => {
      await eventBus.publish(topic as import('@ouija-dev/types').OuijaTopic, payload as never);
    },
    enqueueJob: async (queue, job, options) => {
      const enqueueOpts: import('@ouija-dev/bus').EnqueueOptions = {};
      if (options?.attempts !== undefined) enqueueOpts.attempts = options.attempts;
      if (options?.delay !== undefined) enqueueOpts.delayMs = options.delay;
      await jobQueue.enqueue(
        queue as import('@ouija-dev/bus').QueueName,
        job as never,
        enqueueOpts,
      );
    },
  });

  // 6. Wire kanban plugin — Plane, Fizzy, or placeholder
  const { Orchestrator, StallMonitor } = await import('@ouija-dev/engine');

  let kanbanPlugin: import('@ouija-dev/types').KanbanPlugin;
  let planePluginInstance: import('@ouija-dev/plugin-plane').PlanePlugin | undefined;
  let fizzyPluginInstance: import('@ouija-dev/plugin-fizzy').FizzyPlugin | undefined;
  let kanbanBackend: 'plane' | 'fizzy' | 'none' = 'none';

  const planeApiToken = process.env['PLANE_API_TOKEN'];
  const planeBaseUrl = process.env['PLANE_BASE_URL'] ?? 'https://app.plane.so';
  const planeWorkspaceSlug = process.env['PLANE_WORKSPACE_SLUG'];
  const planeWebhookSecret = process.env['PLANE_WEBHOOK_SECRET'];

  const fizzyAccessToken = process.env['FIZZY_ACCESS_TOKEN'];
  const fizzyBaseUrl = process.env['FIZZY_BASE_URL'];
  const fizzyWebhookSecret = process.env['FIZZY_WEBHOOK_SECRET'];

  const planeConfigured = !!(planeApiToken && planeWorkspaceSlug && planeWebhookSecret);
  const fizzyConfigured = !!(fizzyAccessToken && fizzyBaseUrl && fizzyWebhookSecret);

  if (planeConfigured && fizzyConfigured) {
    throw new Error(
      'Cannot configure both Plane and Fizzy as kanban backends. ' +
      'Set either PLANE_* or FIZZY_* env vars, not both.',
    );
  }

  if (planeConfigured) {
    console.info('Wiring Plane kanban plugin');
    const { PlanePlugin } = await import('@ouija-dev/plugin-plane');
    const planePlugin = new PlanePlugin();

    // Pass through config.boards so the plugin can auto-create Plane
    // projects that reference a projectId which doesn't yet exist. Idempotent.
    // The ouija server URL enables the startup log with the exact webhook
    // URL for the self-hoster to paste into Plane's webhook admin.
    const planeBoardsSpec = (ouijaConfig?.boards ?? []).map((b) => ({
      ...(b.projectId ? { projectId: b.projectId } : {}),
      ...(b.boardId ? { boardId: b.boardId } : {}),
    }));
    const planeConfig: Record<string, unknown> = {
      baseUrl: planeBaseUrl,
      apiToken: planeApiToken!,
      workspaceSlug: planeWorkspaceSlug!,
      webhookSecret: planeWebhookSecret!,
      ...(planeBoardsSpec.length > 0 ? { boards: planeBoardsSpec } : {}),
      ouijaServerUrl: serverUrl,
    };
    await planePlugin.init(
      makePluginContext('@ouija-dev/plugin-plane', planeConfig) as unknown as Parameters<typeof planePlugin.init>[0],
    );
    await planePlugin.start();
    planePluginInstance = planePlugin;
    kanbanPlugin = planePlugin;
    kanbanBackend = 'plane';
  } else if (fizzyConfigured) {
    console.info('Wiring Fizzy kanban plugin');
    const { FizzyPlugin } = await import('@ouija-dev/plugin-fizzy');
    const fizzyPlugin = new FizzyPlugin();

    // Optional auto-webhook registration. If OUIJA_SERVER_URL is set and
    // the ouija.config.yaml declares one or more Fizzy boards, FizzyPlugin
    // will POST a webhook to each on start. Skip if OUIJA_SERVER_URL is
    // missing — the self-hoster can still wire Fizzy's webhook manually.
    const ouijaServerUrl = process.env['OUIJA_SERVER_URL'];
    // When Fizzy is the configured backend, every declared board is assumed
    // to live on that Fizzy instance — no `kanban:` discriminator yet.
    const fizzyBoardIds = (ouijaConfig?.boards ?? [])
      .map((b) => b.boardId ?? b.projectId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const fizzyConfig: Record<string, unknown> = {
      baseUrl: fizzyBaseUrl!,
      accessToken: fizzyAccessToken!,
      webhookSecret: fizzyWebhookSecret!,
      ...(ouijaServerUrl && fizzyBoardIds.length > 0
        ? {
            webhookUrl: `${ouijaServerUrl.replace(/\/$/, '')}/hooks/fizzy/${fizzyWebhookSecret!}`,
            boardIds: fizzyBoardIds,
          }
        : {}),
    };
    await fizzyPlugin.init(
      makePluginContext('@ouija-dev/plugin-fizzy', fizzyConfig) as unknown as Parameters<typeof fizzyPlugin.init>[0],
    );
    await fizzyPlugin.start();
    fizzyPluginInstance = fizzyPlugin;
    kanbanPlugin = fizzyPlugin;
    kanbanBackend = 'fizzy';
  } else {
    console.info(
      'No kanban backend configured — using placeholder. ' +
      'Set PLANE_* or FIZZY_* env vars to enable.',
    );
    kanbanPlugin = {
      manifest: {
        name: '@ouija-dev/kanban-placeholder',
        version: '0.1.0',
        type: 'kanban' as const,
        coreApiVersion: '>=1.0.0',
        configSchema: {},
      },
      init: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      healthCheck: async () => ({ healthy: true }),
      getCard: async (cardId: import('@ouija-dev/types').CardId) => {
        throw new Error(`No kanban plugin loaded — cannot fetch card ${String(cardId)}`);
      },
      moveCard: async () => undefined,
      addComment: async () => undefined,
      assignUser: async () => undefined,
      getColumns: async () => [],
    };
  }

  // 6b. Provision agent kanban members if config is loaded
  let agentRegistry: import('@ouija-dev/config').AgentMemberRegistry | undefined;

  const registryLogger = {
    info: (msg: string, ctx?: Record<string, unknown>) =>
      console.info(JSON.stringify({ level: 'info', component: 'agent-registry', msg, ...ctx })),
    warn: (msg: string, ctx?: Record<string, unknown>) =>
      console.warn(JSON.stringify({ level: 'warn', component: 'agent-registry', msg, ...ctx })),
    error: (msg: string, ctx?: Record<string, unknown>) =>
      console.error(JSON.stringify({ level: 'error', component: 'agent-registry', msg, ...ctx })),
  };

  if (ouijaConfig && kanbanBackend === 'plane' && planePluginInstance && planeWorkspaceSlug) {
    const { AgentMemberRegistry } = await import('@ouija-dev/config');
    const registryClient: import('@ouija-dev/config').KanbanMemberClient = {
      getMembers: async (ws: string) => planePluginInstance!.getMembers(ws),
      inviteMember: async (ws: string, email: string, role: number) =>
        planePluginInstance!.inviteMember(ws, email, role as 5 | 10 | 15 | 20),
    };
    agentRegistry = new AgentMemberRegistry(ouijaConfig.agents, registryClient, planeWorkspaceSlug, registryLogger);
    await agentRegistry.provision();
    console.info('Agent kanban members provisioned (Plane)');
  } else if (ouijaConfig && kanbanBackend === 'fizzy') {
    // Fizzy: no inviteMember API. Agents must use kanbanUserId in config or be pre-created.
    const { AgentMemberRegistry } = await import('@ouija-dev/config');
    const noopClient: import('@ouija-dev/config').KanbanMemberClient = {
      getMembers: async () => [],
      inviteMember: async () => { throw new Error('Fizzy does not support programmatic member creation — set kanbanUserId in agent config'); },
    };
    agentRegistry = new AgentMemberRegistry(ouijaConfig.agents, noopClient, '', registryLogger);
    await agentRegistry.provision();
    console.info('Agent kanban members provisioned (Fizzy — using kanbanUserId mappings)');
  }

  // 6c. Seed board configs from ouija config (works with any kanban plugin)
  if (ouijaConfig?.boards && ouijaConfig.boards.length > 0) {
    const { buildPipelineConfig } = await import('@ouija-dev/config');
    const { boardId: makeBoardId, columnId: makeColumnId, agentId: makeAgentId } = await import('@ouija-dev/types');

    for (const boardConf of ouijaConfig.boards) {
      const resolvedId = boardConf.boardId ?? boardConf.projectId;
      if (!resolvedId) {
        console.warn('Board config missing boardId/projectId, skipping');
        continue;
      }
      const bid = makeBoardId(resolvedId);
      const existing = await db.boardConfigs.findByBoardId(bid);
      if (existing) {
        console.info(`Board config already exists for ${resolvedId}, skipping seed`);
        continue;
      }

      const kanbanColumnClient = {
        getColumns: async (boardId: string) => {
          const cols = await kanbanPlugin.getColumns(makeBoardId(boardId));
          return cols.map(c => ({ id: String(c.id), name: c.name }));
        },
      };

      const seedable = await buildPipelineConfig(
        boardConf,
        kanbanColumnClient,
        {
          info: (msg: string, ctx?: Record<string, unknown>) =>
            console.info(JSON.stringify({ level: 'info', component: 'board-seeder', msg, ...ctx })),
          warn: (msg: string, ctx?: Record<string, unknown>) =>
            console.warn(JSON.stringify({ level: 'warn', component: 'board-seeder', msg, ...ctx })),
        },
      );

      const pipelineConfig = {
        boardId: bid,
        columnMappings: seedable.columnMappings.map(m => ({
          columnId: makeColumnId(m.columnId),
          columnName: m.columnName,
          action: m.action,
          ...(m.agentId ? { agentId: makeAgentId(m.agentId) } : {}),
          guards: m.guards.map(g => ({ type: g.type as 'min_description_length' | 'has_label' | 'has_assignee', value: g.value })),
          ...(m.stallThresholdMs !== undefined ? { stallThresholdMs: m.stallThresholdMs } : {}),
        })),
        defaultStallThresholdMs: seedable.defaultStallThresholdMs,
        autoStartOnAssign: seedable.autoStartOnAssign,
      };

      await db.boardConfigs.save(pipelineConfig as import('@ouija-dev/types').PipelineConfig);
      console.info(`Seeded board config for ${resolvedId}`);
    }
  }

  // 7. Create Orchestrator (with real logger — default is noopLogger which swallows everything)
  const orchestratorLogger = {
    info: (msg: string, ctx?: Record<string, unknown>) => console.info(JSON.stringify({ level: 'info', component: 'orchestrator', msg, ...ctx })),
    warn: (msg: string, ctx?: Record<string, unknown>) => console.warn(JSON.stringify({ level: 'warn', component: 'orchestrator', msg, ...ctx })),
    error: (msg: string, ctx?: Record<string, unknown>) => console.error(JSON.stringify({ level: 'error', component: 'orchestrator', msg, ...ctx })),
  };
  const orchestrator = new Orchestrator(db, eventBus, jobQueue, kanbanPlugin, orchestratorLogger, agentRegistry ?? undefined);

  // 7b. Live event fan-out for SSE subscribers.
  //
  // One process-local emitter bridges instance-scoped OuijaEvents from the
  // durable bus to dashboard SSE connections — see live-events.ts. This
  // avoids spinning up a per-connection BullMQ subscriber, which would
  // create and tear down Redis-backed queues on every dashboard visit.
  const { LiveEventBus, registerLiveEventsBridge } = await import('./live-events.js');
  const liveEvents = new LiveEventBus();
  const unsubscribeLiveBridge = await registerLiveEventsBridge(eventBus, liveEvents);

  // 7c. Review loop: subscribe to PR review/comment topics, debounce with the
  // bundler, and hand each flushed bundle to the orchestrator. When
  // pr_instance_index (migration 004) is missing, the orchestrator's
  // processReviewBundle becomes a no-op — the loop stays dormant but the
  // server keeps running.
  const { registerReviewLoop } = await import('./review-loop.js');
  const reviewLoop = await registerReviewLoop({
    eventBus,
    orchestrator,
    // Boot-time logger — Fastify's app.log isn't ready yet. Bundler log volume
    // is low (one line per pushed event + one per flush) so console is fine.
    logger: {
      debug: (msg, ctx) => console.debug(msg, ctx ?? {}),
      info: (msg, ctx) => console.info(msg, ctx ?? {}),
      warn: (msg, ctx) => console.warn(msg, ctx ?? {}),
      error: (msg, ctx) => console.error(msg, ctx ?? {}),
    },
    ...(process.env['OUIJA_REVIEW_DEBOUNCE_MS']
      ? { debounceMs: parseInt(process.env['OUIJA_REVIEW_DEBOUNCE_MS'], 10) }
      : {}),
  });

  // 8. Build Fastify app
  const appOpts: Parameters<typeof buildApp>[0] = {
    db,
    orchestrator,
    pluginLoader,
    liveEvents,
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
    },
  };
  if (process.env['PLANE_WEBHOOK_SECRET']) {
    appOpts.planeWebhookSecret = process.env['PLANE_WEBHOOK_SECRET'];
  }
  if (process.env['GITHUB_WEBHOOK_SECRET']) {
    appOpts.githubWebhookSecret = process.env['GITHUB_WEBHOOK_SECRET'];
  }

  const app = await buildApp(appOpts);

  // NOTE: Plane webhook route is already registered by buildApp → routes/webhooks.ts.
  // Do NOT call planePluginInstance.registerRoutes() — it would duplicate the route.

  // Fizzy webhook route is registered by the plugin itself (no duplicate in routes/webhooks.ts).
  if (fizzyPluginInstance) {
    await fizzyPluginInstance.registerRoutes(app);
    console.info('Fizzy webhook route registered at POST /hooks/fizzy/:secret');
  }

  // 9. Wire Telegram notification plugin (optional)
  let unsubscribeTelegram: (() => Promise<void>) | undefined;
  const telegramBotToken = process.env['TELEGRAM_BOT_TOKEN'];
  const telegramChatId = process.env['TELEGRAM_CHAT_ID'];

  if (telegramBotToken && telegramChatId) {
    console.info('Wiring Telegram notification plugin');
    const { TelegramNotifyPlugin } = await import('@ouija-dev/plugin-notify-telegram');
    const telegramPlugin = new TelegramNotifyPlugin();
    const telegramConfig = {
      botToken: telegramBotToken,
      chatId: telegramChatId,
      dashboardBaseUrl: serverUrl,
    };
    // Double-cast: makePluginContext returns PluginContext<Record<string,unknown>>.
    await telegramPlugin.init(
      makePluginContext('@ouija-dev/plugin-notify-telegram', telegramConfig) as unknown as Parameters<typeof telegramPlugin.init>[0],
    );
    await telegramPlugin.start();

    // Subscribe to notification.send events and forward to Telegram.
    unsubscribeTelegram = await eventBus.subscribe(
      'notification.send',
      async (event) => {
        const payload = event.payload;
        try {
          const notificationMsg: import('@ouija-dev/types').Notification = {
            title: payload.title,
            body: payload.body,
            level: payload.level,
            occurredAt: event.timestamp,
            idempotencyKey: payload.idempotencyKey,
          };
          // Only set actions when actually present (exactOptionalPropertyTypes)
          if (payload.actions !== undefined) {
            notificationMsg.actions = payload.actions;
          }
          await telegramPlugin.send(notificationMsg);
        } catch (err) {
          app.log.error(
            { err, instanceId: payload.instanceId },
            'Telegram notification send failed',
          );
        }
      },
    );

    app.log.info('Telegram notification plugin active');
  } else {
    console.info(
      'Telegram env vars not set — notifications disabled. ' +
      'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable.',
    );
  }

  // 9b. Wire Engram memory plugin (optional)
  //
  // Forwards every `notification.send` event to `engram-ingest` so pipeline
  // events land in the shared Engram memory graph. The Claude Code agent
  // dispatched on the next run reads that memory via its own MCP tools —
  // this is the "agents that remember" loop with zero changes to the agent
  // subprocess itself.
  let unsubscribeEngram: (() => Promise<void>) | undefined;
  const engramEnabled = process.env['OUIJA_ENGRAM_ENABLED'] === '1';

  if (engramEnabled) {
    console.info('Wiring Engram memory plugin');
    const { EngramNotifyPlugin } = await import('@ouija-dev/plugin-engram');
    const engramPlugin = new EngramNotifyPlugin();
    const engramConfig: import('@ouija-dev/plugin-engram').EngramConfig = {};
    const binaryOverride = process.env['OUIJA_ENGRAM_BINARY'];
    if (binaryOverride !== undefined) engramConfig.binaryPath = binaryOverride;
    const projectOverride = process.env['OUIJA_ENGRAM_PROJECT'];
    if (projectOverride !== undefined) engramConfig.project = projectOverride;

    await engramPlugin.init(
      makePluginContext(
        '@ouija-dev/plugin-engram',
        engramConfig as unknown as Record<string, unknown>,
      ) as unknown as Parameters<typeof engramPlugin.init>[0],
    );
    await engramPlugin.start();

    unsubscribeEngram = await eventBus.subscribe(
      'notification.send',
      async (event) => {
        const payload = event.payload;
        try {
          const notificationMsg: import('@ouija-dev/types').Notification = {
            title: payload.title,
            body: payload.body,
            level: payload.level,
            occurredAt: event.timestamp,
            idempotencyKey: payload.idempotencyKey,
          };
          if (payload.actions !== undefined) {
            notificationMsg.actions = payload.actions;
          }
          await engramPlugin.send(notificationMsg);
        } catch (err) {
          app.log.error(
            { err, instanceId: payload.instanceId },
            'Engram memory ingest failed',
          );
        }
      },
    );

    app.log.info('Engram memory plugin active');
  } else {
    console.info(
      'Engram integration disabled — set OUIJA_ENGRAM_ENABLED=1 to forward ' +
      'pipeline events to the Engram memory graph.',
    );
  }

  // 10. Start agent worker in-process (single-process mode)
  let workerHandle: { stop(): Promise<void> } | undefined;

  // Build agent profile map from config
  type AgentProfile = import('@ouija-dev/agent-worker').AgentProfile;
  let agentProfiles: Map<string, AgentProfile> | undefined;

  if (ouijaConfig) {
    agentProfiles = new Map();
    for (const agent of ouijaConfig.agents) {
      const defaultRepo = agent.repos.find((r) => r.default);
      const profile: AgentProfile = {
        id: agent.id,
        name: agent.name,
        systemPrompt: agent.systemPrompt ?? '',
        secretRef: agent.auth.secretRef,
        model: agent.model,
        maxDurationMs: agent.limits.maxDurationMs,
        baseBranch: defaultRepo?.baseBranch ?? 'main',
        triggerMode: agent.triggerMode,
        authMethod: agent.auth.method,
        repos: agent.repos.map((r) => ({
          url: r.url,
          path: r.path,
          baseBranch: r.baseBranch,
          projectId: r.projectId,
          default: r.default,
        })),
      };
      if (defaultRepo?.url) profile.repoUrl = defaultRepo.url;
      if (defaultRepo?.path) profile.repoPath = defaultRepo.path;
      if (agent.configDir) profile.configDir = agent.configDir;
      if (agent.runner) profile.runner = agent.runner;
      agentProfiles.set(agent.id, profile);
    }
  }

  // Agent worker: always start. Claude Code CLI authenticates via its own
  // session (~/.claude), not via ANTHROPIC_API_KEY env var. The env var is
  // still passed to the subprocess if set (for headless/CI use), but is not
  // required for local dogfooding.
  const agentWorkerDisabled = process.env['OUIJA_DISABLE_AGENT_WORKER'] === '1';
  if (!agentWorkerDisabled) {
    app.log.info('Starting agent worker in-process (single-process mode)');
    const { startAgentWorker } = await import('@ouija-dev/agent-worker');

    const workerOpts: Parameters<typeof startAgentWorker>[0] = {
      redisUrl,
      serverUrl,
      concurrency: parseInt(process.env['OUIJA_WORKER_CONCURRENCY'] ?? '1', 10),
    };
    if (agentProfiles) {
      workerOpts.agentProfiles = agentProfiles;
    }
    // DB-first lookup: dashboard-created agents override any YAML entry. When
    // migration 003 hasn't been applied (db.agents is undefined), this is a
    // no-op and the YAML-backed map serves alone.
    if (db.agents !== undefined) {
      const agentsRepo = db.agents;
      const { agentConfigToProfile } = await import('@ouija-dev/agent-worker');
      workerOpts.getAgentProfileFromDb = async (agentId: string) => {
        const record = await agentsRepo.findById(agentId);
        if (record === undefined || !record.active) return undefined;
        try {
          return agentConfigToProfile(record.config);
        } catch (err) {
          app.log.error(
            { err, agentId },
            'agentConfigToProfile failed — DB row has invalid shape, falling back to YAML',
          );
          return undefined;
        }
      };
    }
    if (ouijaConfig?.claudeHome) {
      workerOpts.claudeHome = ouijaConfig.claudeHome;
    }
    if (kanbanBackend !== 'none') {
      const _kanban = kanbanPlugin;
      workerOpts.getCardDetails = async (cardId: string) => {
        const card = await _kanban.getCard(cardId as import('@ouija-dev/types').CardId);
        return {
          title: card.title,
          description: card.description,
          acceptanceCriteria: [] as string[],
          labels: card.labels,
        };
      };
    }

    workerHandle = await startAgentWorker(workerOpts);

    app.log.info('Agent worker started in-process');
  } else {
    app.log.info('Agent worker disabled via OUIJA_DISABLE_AGENT_WORKER=1');
  }

  // 11. Start StallMonitor
  const stallMonitor = new StallMonitor(db, orchestrator, 300_000, {
    info: (msg: string, ctx?: Record<string, unknown>) => app.log.info(ctx ?? {}, msg),
    warn: (msg: string, ctx?: Record<string, unknown>) => app.log.warn(ctx ?? {}, msg),
    error: (msg: string, ctx?: Record<string, unknown>) => app.log.error(ctx ?? {}, msg),
  });
  stallMonitor.start(60_000);

  // 12. Start listening
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info({ port }, 'Ouija server started');

  // ---- Graceful shutdown ----

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutdown signal received');

    try {
      stallMonitor.stop();
      await app.close();

      // Stop agent worker before draining the queue
      if (workerHandle) {
        await workerHandle.stop();
      }

      // Unsubscribe Telegram listener
      if (unsubscribeTelegram) {
        await unsubscribeTelegram();
      }

      // Unsubscribe Engram listener
      if (unsubscribeEngram) {
        await unsubscribeEngram();
      }

      // Unsubscribe SSE live-event bridge
      await unsubscribeLiveBridge();

      // Unsubscribe review-loop listeners
      await reviewLoop.stop();

      // Stop kanban plugin if real one was loaded
      if (planePluginInstance) {
        await planePluginInstance.stop();
      }
      if (fizzyPluginInstance) {
        await fizzyPluginInstance.stop();
      }

      await jobQueue.close();
      await eventBus.close();
      await redis.quit();
      await pool.end();
      app.log.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      console.error('SIGTERM handler error:', err);
      process.exit(1);
    });
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      console.error('SIGINT handler error:', err);
      process.exit(1);
    });
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
