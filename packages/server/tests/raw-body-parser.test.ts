/**
 * Regression test for the global raw-body JSON parser (packages/server/src/app.ts).
 *
 * Before the fix, the parser was registered inside the `webhookRoutes`
 * encapsulated plugin. Plugins whose routes land on the root Fastify app —
 * most notably `fizzyPlugin.registerRoutes(app)` — saw Fastify's default
 * parser, which drops the original bytes after JSON.parse. Their HMAC
 * verification then fell back to `JSON.stringify(request.body)`, which
 * produces a different serialisation (whitespace, key ordering) than the
 * upstream signed — every Fizzy webhook silently failed HMAC.
 *
 * This test guards the fix: a route registered at the root app level sees
 * `request.rawBody` populated with the exact incoming bytes.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildApp } from '../src/app.js';

function makeMockDb() {
  return {
    ping: async () => undefined,
    pipelines: {} as never,
    pipelineEvents: {} as never,
    boardConfigs: {} as never,
    transaction: async () => undefined as never,
    deduplication: {
      isDuplicate: async () => false,
      markProcessed: async () => undefined,
      purgeExpired: async () => 0,
    },
  };
}

describe('global raw-body JSON parser (regression for Fizzy webhook silent failure)', () => {
  let app: FastifyInstance;
  let captured: { rawBody: Buffer | undefined; parsed: unknown } = {
    rawBody: undefined,
    parsed: undefined,
  };

  beforeAll(async () => {
    process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
    app = await buildApp({
      logger: false,
      db: makeMockDb() as never,
      orchestrator: { processTrigger: vi.fn(async () => undefined) } as never,
    });

    // Simulate a plugin that mounts its route on the ROOT app (outside the
    // encapsulated `webhookRoutes` plugin). This mirrors the real call site
    // in packages/server/src/index.ts: `fizzyPluginInstance.registerRoutes(app)`.
    app.post(
      '/test/root-plugin-route',
      async (
        request: FastifyRequest,
        reply,
      ) => {
        const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
        captured = { rawBody, parsed: request.body };
        return reply.status(200).send({ ok: true });
      },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('populates request.rawBody on a root-level route — exact bytes preserved', async () => {
    // Note the non-standard whitespace: a JSON.stringify of the parsed body
    // would lose this, making the two representations diverge. That
    // divergence was the silent-failure root cause.
    const payload = '{"event":"card_triaged",  "id":"evt-001","nested":{"b":2,"a":1}}';

    const res = await app.inject({
      method: 'POST',
      url: '/test/root-plugin-route',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(captured.rawBody).toBeInstanceOf(Buffer);
    expect(captured.rawBody!.toString('utf8')).toBe(payload);
    // The parsed body is also available for convenience.
    expect(captured.parsed).toEqual({
      event: 'card_triaged',
      id: 'evt-001',
      nested: { b: 2, a: 1 },
    });
  });

  it('handles empty-body POSTs without throwing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/root-plugin-route',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(res.statusCode).toBe(200);
    expect(captured.rawBody).toBeInstanceOf(Buffer);
    expect(captured.rawBody!.length).toBe(0);
    expect(captured.parsed).toBeNull();
  });

  it('rejects malformed JSON without crashing the server', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/root-plugin-route',
      headers: { 'content-type': 'application/json' },
      payload: '{not-json',
    });

    // The specific status depends on the global error handler — the
    // important guarantee is (a) the malformed body doesn't slip through as
    // an empty request and reach the handler, and (b) the server is still
    // alive afterwards.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const follow = await app.inject({
      method: 'POST',
      url: '/test/root-plugin-route',
      headers: { 'content-type': 'application/json' },
      payload: '{"ok":true}',
    });
    expect(follow.statusCode).toBe(200);
  });
});
