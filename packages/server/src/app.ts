/**
 * Fastify application factory.
 *
 * Returns a configured Fastify instance without calling listen().
 * Separation enables:
 *   - Testing via app.inject() (no network required)
 *   - Deferred listen() in the entry point
 *   - Clean teardown in tests
 *
 * Registration order:
 *   1. Core plugins (helmet, cors, cookie)
 *   2. Rate limiting (before routes)
 *   3. Request ID hook
 *   4. Auth middleware (global onRequest hook)
 *   5. Error handler
 *   6. Routes
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';

import type { Database } from '@ouija-dev/types';
import type { Orchestrator } from '@ouija-dev/engine';
import type { PluginLoader } from '@ouija-dev/plugin-sdk';
import { randomUUID } from 'node:crypto';

import { registerRateLimit } from './middleware/rate-limit.js';
import { registerAuthMiddleware } from './middleware/auth.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { healthRoutes } from './routes/health.js';
import type { HealthRouteOptions } from './routes/health.js';
import { webhookRoutes } from './routes/webhooks.js';
import type { WebhookRouteOptions } from './routes/webhooks.js';
import { agentCallbackRoutes } from './routes/agent-callback.js';
import { pipelineRoutes } from './routes/pipelines.js';
import { pipelineStreamRoutes } from './routes/pipeline-stream.js';
import { projectRoutes } from './routes/projects.js';
import { agentRoutes } from './routes/agents.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { LiveEventBus } from './live-events.js';

// ---- App options ----

export interface AppOptions {
  db?: Database;
  orchestrator?: Orchestrator;
  pluginLoader?: PluginLoader;
  planeWebhookSecret?: string;
  githubWebhookSecret?: string;
  logger?: boolean | object;
  /**
   * Process-local event fan-out for SSE subscribers. When provided alongside
   * `db`, the /api/v1/pipelines/:id/stream route is registered. Tests pass
   * their own instance; production wires it to the durable event bus via
   * registerLiveEventsBridge().
   */
  liveEvents?: LiveEventBus;
}

// ---- Factory ----

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const isProd = process.env['NODE_ENV'] === 'production';

  const app = Fastify({
    logger: opts.logger ?? (isProd
      ? { level: 'info' }
      : {
          level: 'info',
          transport: { target: 'pino-pretty', options: { colorize: true } },
        }
    ),
    bodyLimit: 1024 * 1024,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    genReqId: () => `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    disableRequestLogging: false,
  });

  // ---- 1. Request ID decoration ----
  app.addHook('onRequest', async (request) => {
    (request as unknown as { requestId: string }).requestId =
      (request as unknown as { id: string }).id;
  });

  // ---- 2. Security headers ----
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
    },
    xContentTypeOptions: true,
    frameguard: { action: 'deny' },
  });

  // ---- 3. CORS ----
  await app.register(cors, {
    origin: process.env['CORS_ORIGIN'] ?? false,
    credentials: true,
  });

  // ---- 4. Cookie plugin ----
  await app.register(cookie, {
    secret: process.env['OUIJA_SECRET_KEY'] ?? 'dev-cookie-secret-change-in-prod',
    parseOptions: {},
  });

  // ---- 5. Rate limiting ----
  await registerRateLimit(app);

  // ---- 6. Auth middleware ----
  registerAuthMiddleware(app);

  // ---- 7. Error handler ----
  registerErrorHandler(app);

  // ---- 8. Routes ----

  // Health (unauthenticated, no rate limit)
  // Build options object only with defined properties to satisfy exactOptionalPropertyTypes
  const healthOpts: HealthRouteOptions = {};
  if (opts.db !== undefined) healthOpts.db = opts.db;
  if (opts.pluginLoader !== undefined) healthOpts.pluginLoader = opts.pluginLoader;

  await app.register(healthRoutes, healthOpts);

  // Webhook ingress
  if (opts.orchestrator !== undefined && opts.db !== undefined) {
    const webhookOpts: WebhookRouteOptions = {
      orchestrator: opts.orchestrator,
      db: opts.db,
    };
    if (opts.planeWebhookSecret !== undefined) webhookOpts.planeWebhookSecret = opts.planeWebhookSecret;
    if (opts.githubWebhookSecret !== undefined) webhookOpts.githubWebhookSecret = opts.githubWebhookSecret;

    await app.register(webhookRoutes, webhookOpts);
  } else {
    // Stub webhook routes — always return 200
    app.post('/hooks/plane/:secret', async (_req, reply) =>
      reply.status(200).send({ ok: true }),
    );
    app.post('/hooks/github/:secret', async (_req, reply) =>
      reply.status(200).send({ ok: true }),
    );
  }

  // Agent callback
  if (opts.orchestrator !== undefined) {
    await app.register(agentCallbackRoutes, { orchestrator: opts.orchestrator });
  }

  // Pipeline + project API routes
  if (opts.db !== undefined && opts.orchestrator !== undefined) {
    await app.register(pipelineRoutes, {
      db: opts.db,
      orchestrator: opts.orchestrator,
    });

    await app.register(projectRoutes, { db: opts.db });
    await app.register(agentRoutes, { db: opts.db });
  }

  // Pipeline live SSE stream (only when liveEvents wiring is provided).
  if (opts.db !== undefined && opts.liveEvents !== undefined) {
    await app.register(pipelineStreamRoutes, {
      db: opts.db,
      live: opts.liveEvents,
    });
  }

  // Dashboard static serving (best-effort — falls back to a placeholder when
  // the built assets aren't available, e.g. during tests).
  await registerDashboardRoutes(app);

  return app;
}
