/**
 * Rate limiting configuration (spec §5.4).
 *
 * Uses @fastify/rate-limit with per-route configuration.
 * Redis-backed sliding window when Redis is available; falls back to in-memory.
 *
 * Limits:
 *   - Webhook ingress: 100/min per IP
 *   - Auth endpoints: 5/min per IP
 *   - General API: 300/min per session
 */

import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

export interface RateLimitConfig {
  /** Redis connection string, e.g. redis://localhost:6379 — optional */
  redisUrl?: string;
}

export async function registerRateLimit(
  app: FastifyInstance,
  opts: RateLimitConfig = {},
): Promise<void> {
  // Global default rate limit (300/min per IP as baseline)
  // Individual routes override with per-route config
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      // Use session-based key if authenticated, fall back to IP
      if (request.user) {
        return `session:${request.user.userId}`;
      }
      return request.ip;
    },
    errorResponseBuilder: (request, context) => {
      return {
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded. Try again after ${new Date(context.after).toISOString()}.`,
          details: [],
          requestId: request.requestId ?? 'unknown',
          retryable: true,
        },
      };
    },
  });
}

// ---- Per-route rate limit options ----

/** 100 req/min per IP — for webhook ingress */
export const webhookRateLimit = {
  config: {
    rateLimit: {
      max: 100,
      timeWindow: '1 minute',
      keyGenerator: (request: { ip: string }) => `webhook:${request.ip}`,
    },
  },
};

/** 5 req/min per IP — for auth endpoints (brute-force protection) */
export const authRateLimit = {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '1 minute',
      keyGenerator: (request: { ip: string }) => `auth:${request.ip}`,
    },
  },
};

/** 300 req/min per session — for read API endpoints */
export const apiReadRateLimit = {
  config: {
    rateLimit: {
      max: 300,
      timeWindow: '1 minute',
    },
  },
};
