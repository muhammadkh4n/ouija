/**
 * Health route tests — /healthz and /readyz
 *
 * Uses Fastify inject() to avoid network I/O.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

// ---- Minimal mock Database ----

function makeMockDb(pingResolves: boolean) {
  return {
    ping: async () => {
      if (!pingResolves) throw new Error('DB unreachable');
    },
    pipelines: {} as never,
    pipelineEvents: {} as never,
    boardConfigs: {} as never,
    deduplication: {} as never,
    transaction: async () => undefined as never,
  };
}

// ---- Test suite ----

describe('/healthz', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with { status: "ok" }', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('does not require authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      // no Authorization header
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('/readyz — unauthenticated', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
    app = await buildApp({
      logger: false,
      db: makeMockDb(true) as never,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns { status: "ready" } when DB is reachable (unauthenticated)', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ready');
    // Unauthenticated: must NOT include database details (info disclosure protection)
    expect(body.database).toBeUndefined();
    expect(body.plugins).toBeUndefined();
  });

  it('returns { status: "not_ready" } when DB ping fails', async () => {
    const appDown = await buildApp({
      logger: false,
      db: makeMockDb(false) as never,
    });

    try {
      const response = await appDown.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(503);
      expect(response.json().status).toBe('not_ready');
    } finally {
      await appDown.close();
    }
  });
});

describe('/readyz — authenticated', () => {
  let app: FastifyInstance;
  const apiKey = 'ouija_test-api-key-for-health-test';

  beforeAll(async () => {
    process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
    process.env['OUIJA_API_KEY'] = apiKey;
    app = await buildApp({
      logger: false,
      db: makeMockDb(true) as never,
    });
  });

  afterAll(async () => {
    await app.close();
    delete process.env['OUIJA_API_KEY'];
  });

  it('returns full details when authenticated', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/readyz',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ready');
    // Authenticated: includes database details
    expect(body.database).toBeDefined();
    expect(body.database.reachable).toBe(true);
  });
});

describe('/healthz and /readyz are not rate-limited', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('can be called many times without being rate-limited', async () => {
    const requests = Array.from({ length: 10 }, () =>
      app.inject({ method: 'GET', url: '/healthz' }),
    );
    const responses = await Promise.all(requests);
    for (const r of responses) {
      expect(r.statusCode).toBe(200);
    }
  });
});
