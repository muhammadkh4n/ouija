/**
 * Health check routes (spec §5.2):
 *
 *   GET /healthz — liveness probe, unauthenticated, minimal: { status: "ok" }
 *   GET /readyz  — readiness probe:
 *     - Unauthenticated: { status: "ready" | "not_ready" }
 *     - Authenticated: includes plugin health statuses, queue depths, DB ping, version
 *
 * Neither endpoint is rate-limited (load balancer / k8s probe traffic).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Database } from '@ouija/types';
import type { PluginLoader } from '@ouija/plugin-sdk';

export interface HealthRouteOptions {
  db?: Database;
  pluginLoader?: PluginLoader;
}

export async function healthRoutes(
  app: FastifyInstance,
  opts: HealthRouteOptions,
): Promise<void> {
  const { db, pluginLoader } = opts;

  // ---- GET /healthz ----
  // Liveness probe — always 200 if the process is alive.
  // No auth, no rate limit, no external calls.
  app.get('/healthz', {
    config: { rateLimit: false },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  // ---- GET /readyz ----
  // Readiness probe — checks that core dependencies are reachable.
  // Unauthenticated callers get minimal response to prevent info disclosure.
  app.get('/readyz', {
    config: { rateLimit: false },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const isAuthenticated = !!request.user;

    let dbReachable = true;
    let dbError: string | undefined;
    let pluginStatuses: Record<string, unknown> | undefined;

    // Always attempt DB ping to determine readiness
    if (db) {
      try {
        await db.ping();
      } catch (err) {
        dbReachable = false;
        dbError = err instanceof Error ? err.message : String(err);
        app.log.warn({ err }, 'readyz: DB ping failed');
      }
    }

    const isReady = dbReachable;

    // Authenticated callers get full details
    if (isAuthenticated && pluginLoader) {
      const healthMap = await pluginLoader.getHealthStatuses().catch(() => new Map());
      pluginStatuses = {};
      for (const [name, health] of healthMap) {
        pluginStatuses[name] = health;
      }
    }

    const statusCode = isReady ? 200 : 503;

    if (!isAuthenticated) {
      return reply.status(statusCode).send({
        status: isReady ? 'ready' : 'not_ready',
      });
    }

    return reply.status(statusCode).send({
      status: isReady ? 'ready' : 'not_ready',
      version: process.env['npm_package_version'] ?? '0.1.0',
      database: {
        reachable: dbReachable,
        ...(dbError !== undefined ? { error: dbError } : {}),
      },
      plugins: pluginStatuses ?? {},
    });
  });
}
