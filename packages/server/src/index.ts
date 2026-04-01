/**
 * Ouija server entry point.
 *
 * Startup sequence:
 *   1. Validate env vars
 *   2. Create Database (PostgreSQL)
 *   3. Create EventBus + JobQueue (BullMQ)
 *   4. Create PluginLoader
 *   5. Create Orchestrator
 *   6. Build Fastify app
 *   7. Start StallMonitor
 *   8. app.listen({ port: 4000, host: '0.0.0.0' })
 *
 * Graceful shutdown:
 *   - SIGTERM / SIGINT: close Fastify, stop StallMonitor, drain workers, quit Redis, pool.end()
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

  if (secretKey.length < 32) {
    throw new Error('OUIJA_SECRET_KEY must be at least 32 characters');
  }

  // 2. Create database
  // createDatabase returns { db: PostgresDatabase, pool: Pool }
  // PostgresDatabase implements Database
  const { createDatabase } = await import('@ouija/engine');
  const { db, pool } = createDatabase(databaseUrl);

  // Verify DB connectivity before registering routes
  try {
    await db.ping();
  } catch (err) {
    throw new Error(`Database connection failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Create EventBus + JobQueue
  // BullMQ takes ConnectionOptions (host/port object or URL object) — parse the URL
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

  // Logger placeholder — will be properly wired once app is created
  const startupLogger = {
    debug: (msg: string) => console.debug(msg),
    info: (msg: string) => console.info(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  };

  const pluginLoader = new PluginLoader(startupLogger);

  // 6. Create Orchestrator with kanban placeholder
  const { Orchestrator, StallMonitor } = await import('@ouija/engine');

  const kanbanPlaceholder: import('@ouija/types').KanbanPlugin = {
    manifest: {
      name: '@ouija/kanban-placeholder',
      version: '0.1.0',
      type: 'kanban' as const,
      coreApiVersion: '>=1.0.0',
      configSchema: {},
    },
    init: async (_ctx: import('@ouija/types').PluginContext) => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    healthCheck: async () => ({ healthy: true }),
    getCard: async (cardId: import('@ouija/types').CardId) => {
      throw new Error(`No kanban plugin loaded — cannot fetch card ${String(cardId)}`);
    },
    moveCard: async (_cardId: import('@ouija/types').CardId, _col: import('@ouija/types').ColumnId) => undefined,
    addComment: async (_cardId: import('@ouija/types').CardId, _body: string) => undefined,
    assignUser: async (_cardId: import('@ouija/types').CardId, _userId: string) => undefined,
    getColumns: async (_boardId: import('@ouija/types').BoardId) => [],
  };

  const orchestrator = new Orchestrator(db, eventBus, jobQueue, kanbanPlaceholder);

  // 7. Build app
  const appOpts: Parameters<typeof buildApp>[0] = {
    db,
    orchestrator,
    pluginLoader,
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
    },
  };
  if (process.env['PLANE_WEBHOOK_SECRET']) appOpts.planeWebhookSecret = process.env['PLANE_WEBHOOK_SECRET'];
  if (process.env['GITHUB_WEBHOOK_SECRET']) appOpts.githubWebhookSecret = process.env['GITHUB_WEBHOOK_SECRET'];

  const app = await buildApp(appOpts);

  // 8. Start StallMonitor
  const stallMonitor = new StallMonitor(db, orchestrator, 300_000, {
    info: (msg: string, ctx?: Record<string, unknown>) => app.log.info(ctx ?? {}, msg),
    warn: (msg: string, ctx?: Record<string, unknown>) => app.log.warn(ctx ?? {}, msg),
    error: (msg: string, ctx?: Record<string, unknown>) => app.log.error(ctx ?? {}, msg),
  });
  stallMonitor.start(60_000);

  // 9. Start listening
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info({ port }, 'Ouija server started');

  // ---- Graceful shutdown ----

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutdown signal received');

    try {
      stallMonitor.stop();
      await app.close();
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
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
