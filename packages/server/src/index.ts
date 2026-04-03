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
  let ouijaConfig: import('@ouija/config').OuijaConfig | undefined;

  try {
    const { loadConfig } = await import('@ouija/config');
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
  const { createDatabase } = await import('@ouija/engine');
  const { db, pool } = createDatabase(databaseUrl);

  // Verify DB connectivity before registering routes
  try {
    await db.ping();
  } catch (err) {
    throw new Error(
      `Database connection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Auto-run migrations
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  try {
    const engineDir = dirname(fileURLToPath(import.meta.resolve('@ouija/engine')));
    const migrationPath = join(
      engineDir,
      '..',
      'src',
      'migrations',
      '001-initial-schema.sql',
    );
    const migrationSql = readFileSync(migrationPath, 'utf-8');
    const client = await pool.connect();
    try {
      await client.query(migrationSql);
      console.info('Database migrations applied successfully');
    } finally {
      client.release();
    }
  } catch (err) {
    // Idempotent — tables may already exist from a previous run.
    console.warn(`Migration warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Create EventBus + JobQueue
  const redisConnection = { url: redisUrl };
  const { BullMQEventBus, BullMQJobQueue } = await import('@ouija/bus');
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
  const { PluginLoader } = await import('@ouija/plugin-sdk');
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
  ): import('@ouija/types').PluginContext<Record<string, unknown>> => ({
    config,
    logger: {
      debug: (msg, meta) => console.debug(JSON.stringify({ level: 'debug', plugin: pluginName, msg, ...meta })),
      info: (msg, meta) => console.info(JSON.stringify({ level: 'info', plugin: pluginName, msg, ...meta })),
      warn: (msg, meta) => console.warn(JSON.stringify({ level: 'warn', plugin: pluginName, msg, ...meta })),
      error: (msg, meta) => console.error(JSON.stringify({ level: 'error', plugin: pluginName, msg, ...meta })),
    },
    publishEvent: async (topic, payload) => {
      await eventBus.publish(topic as import('@ouija/types').OuijaTopic, payload as never);
    },
    enqueueJob: async (queue, job, options) => {
      const enqueueOpts: import('@ouija/bus').EnqueueOptions = {};
      if (options?.attempts !== undefined) enqueueOpts.attempts = options.attempts;
      if (options?.delay !== undefined) enqueueOpts.delayMs = options.delay;
      await jobQueue.enqueue(
        queue as import('@ouija/bus').QueueName,
        job as never,
        enqueueOpts,
      );
    },
  });

  // 6. Wire kanban plugin — real Plane if configured, placeholder otherwise
  const { Orchestrator, StallMonitor } = await import('@ouija/engine');

  let kanbanPlugin: import('@ouija/types').KanbanPlugin;
  let planePluginInstance: import('@ouija/plugin-plane').PlanePlugin | undefined;

  const planeApiToken = process.env['PLANE_API_TOKEN'];
  const planeBaseUrl = process.env['PLANE_BASE_URL'] ?? 'https://app.plane.so';
  const planeWorkspaceSlug = process.env['PLANE_WORKSPACE_SLUG'];
  const planeWebhookSecret = process.env['PLANE_WEBHOOK_SECRET'];

  if (planeApiToken && planeWorkspaceSlug && planeWebhookSecret) {
    console.info('Wiring real Plane kanban plugin');
    const { PlanePlugin } = await import('@ouija/plugin-plane');
    const planePlugin = new PlanePlugin();
    const planeConfig = {
      baseUrl: planeBaseUrl,
      apiToken: planeApiToken,
      workspaceSlug: planeWorkspaceSlug,
      webhookSecret: planeWebhookSecret,
    };
    // Double-cast: makePluginContext returns PluginContext<Record<string,unknown>> but init
    // expects PluginContext<PlaneConfig>. The shapes are structurally compatible at runtime.
    await planePlugin.init(
      makePluginContext('@ouija/plugin-plane', planeConfig) as unknown as Parameters<typeof planePlugin.init>[0],
    );
    await planePlugin.start();
    planePluginInstance = planePlugin;
    kanbanPlugin = planePlugin;
  } else {
    console.info(
      'Plane env vars not fully set — using kanban placeholder. ' +
      'Set PLANE_API_TOKEN, PLANE_WORKSPACE_SLUG, and PLANE_WEBHOOK_SECRET to enable.',
    );
    kanbanPlugin = {
      manifest: {
        name: '@ouija/kanban-placeholder',
        version: '0.1.0',
        type: 'kanban' as const,
        coreApiVersion: '>=1.0.0',
        configSchema: {},
      },
      init: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      healthCheck: async () => ({ healthy: true }),
      getCard: async (cardId: import('@ouija/types').CardId) => {
        throw new Error(`No kanban plugin loaded — cannot fetch card ${String(cardId)}`);
      },
      moveCard: async () => undefined,
      addComment: async () => undefined,
      assignUser: async () => undefined,
      getColumns: async () => [],
    };
  }

  // 6b. Provision agent Plane members if config is loaded
  let agentRegistry: import('@ouija/config').AgentMemberRegistry | undefined;

  if (ouijaConfig && planePluginInstance && planeWorkspaceSlug) {
    const { AgentMemberRegistry } = await import('@ouija/config');
    const registryPlaneClient: import('@ouija/config').PlaneClient = {
      getMembers: async (ws: string) => {
        return planePluginInstance!.getMembers(ws);
      },
      inviteMember: async (ws: string, email: string, role: number) => {
        return planePluginInstance!.inviteMember(ws, email, role as 5 | 10 | 15 | 20);
      },
    };
    agentRegistry = new AgentMemberRegistry(
      ouijaConfig.agents,
      registryPlaneClient,
      planeWorkspaceSlug,
      {
        info: (msg: string, ctx?: Record<string, unknown>) =>
          console.info(JSON.stringify({ level: 'info', component: 'agent-registry', msg, ...ctx })),
        warn: (msg: string, ctx?: Record<string, unknown>) =>
          console.warn(JSON.stringify({ level: 'warn', component: 'agent-registry', msg, ...ctx })),
        error: (msg: string, ctx?: Record<string, unknown>) =>
          console.error(JSON.stringify({ level: 'error', component: 'agent-registry', msg, ...ctx })),
      },
    );
    await agentRegistry.provision();
    console.info('Agent Plane members provisioned');
  }

  // 7. Create Orchestrator (with real logger — default is noopLogger which swallows everything)
  const orchestratorLogger = {
    info: (msg: string, ctx?: Record<string, unknown>) => console.info(JSON.stringify({ level: 'info', component: 'orchestrator', msg, ...ctx })),
    warn: (msg: string, ctx?: Record<string, unknown>) => console.warn(JSON.stringify({ level: 'warn', component: 'orchestrator', msg, ...ctx })),
    error: (msg: string, ctx?: Record<string, unknown>) => console.error(JSON.stringify({ level: 'error', component: 'orchestrator', msg, ...ctx })),
  };
  const orchestrator = new Orchestrator(db, eventBus, jobQueue, kanbanPlugin, orchestratorLogger, agentRegistry ?? undefined);

  // 8. Build Fastify app
  const appOpts: Parameters<typeof buildApp>[0] = {
    db,
    orchestrator,
    pluginLoader,
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

  // 9. Wire Telegram notification plugin (optional)
  let unsubscribeTelegram: (() => Promise<void>) | undefined;
  const telegramBotToken = process.env['TELEGRAM_BOT_TOKEN'];
  const telegramChatId = process.env['TELEGRAM_CHAT_ID'];

  if (telegramBotToken && telegramChatId) {
    console.info('Wiring Telegram notification plugin');
    const { TelegramNotifyPlugin } = await import('@ouija/plugin-notify-telegram');
    const telegramPlugin = new TelegramNotifyPlugin();
    const telegramConfig = {
      botToken: telegramBotToken,
      chatId: telegramChatId,
      dashboardBaseUrl: serverUrl,
    };
    // Double-cast: makePluginContext returns PluginContext<Record<string,unknown>>.
    await telegramPlugin.init(
      makePluginContext('@ouija/plugin-notify-telegram', telegramConfig) as unknown as Parameters<typeof telegramPlugin.init>[0],
    );
    await telegramPlugin.start();

    // Subscribe to notification.send events and forward to Telegram.
    unsubscribeTelegram = await eventBus.subscribe(
      'notification.send',
      async (event) => {
        const payload = event.payload;
        try {
          const notificationMsg: import('@ouija/types').Notification = {
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

  // 10. Start agent worker in-process (single-process mode)
  let workerHandle: { stop(): Promise<void> } | undefined;

  // Build agent profile map from config
  type AgentProfile = import('@ouija/agent-worker').AgentProfile;
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
      };
      if (defaultRepo?.url) profile.repoUrl = defaultRepo.url;
      if (defaultRepo?.path) profile.repoPath = defaultRepo.path;
      if (agent.configDir) profile.configDir = agent.configDir;
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
    const { startAgentWorker } = await import('@ouija/agent-worker');

    const workerOpts: Parameters<typeof startAgentWorker>[0] = {
      redisUrl,
      serverUrl,
      concurrency: parseInt(process.env['OUIJA_WORKER_CONCURRENCY'] ?? '1', 10),
    };
    if (agentProfiles) {
      workerOpts.agentProfiles = agentProfiles;
    }
    if (planePluginInstance !== undefined) {
      const _plane = planePluginInstance;
      workerOpts.getCardDetails = async (cardId: string) => {
        const card = await _plane.getCard(cardId as import('@ouija/types').CardId);
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

      // Stop Plane plugin if real one was loaded
      if (planePluginInstance) {
        await planePluginInstance.stop();
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
