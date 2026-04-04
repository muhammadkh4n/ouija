/**
 * Webhook ingress tests.
 *
 * Key behaviors to verify:
 *   1. HMAC verification — valid sig passes, invalid fails (but still 200)
 *   2. Path secret check — wrong secret returns 200 (no enumeration)
 *   3. Always returns 200 — even on auth failure
 *   4. Deduplication — duplicate externalEventId is processed once
 *   5. Dispatches to orchestrator on valid webhook
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

// ---- Mock orchestrator ----

function makeMockOrchestrator() {
  const calls: unknown[] = [];
  return {
    processTrigger: vi.fn(async (event: unknown) => {
      calls.push(event);
    }),
    _calls: calls,
  };
}

// ---- Mock dedup store ----

function makeMockDb(dedupStore?: Map<string, boolean>) {
  const store = dedupStore ?? new Map<string, boolean>();
  return {
    ping: async () => undefined,
    pipelines: {} as never,
    pipelineEvents: {} as never,
    boardConfigs: {} as never,
    transaction: async () => undefined as never,
    deduplication: {
      isDuplicate: async (id: string) => store.has(id),
      markProcessed: async (id: string) => { store.set(id, true); },
      purgeExpired: async () => 0,
    },
  };
}

const PLANE_SECRET = 'plane-secret-token-abc123';
const GITHUB_SECRET = 'github-secret-token-xyz789';

function signBody(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

// ---- Plane webhook tests ----

describe('POST /hooks/plane/:secret', () => {
  let app: FastifyInstance;
  let orchestrator: ReturnType<typeof makeMockOrchestrator>;

  beforeAll(async () => {
    process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
    orchestrator = makeMockOrchestrator();
    app = await buildApp({
      logger: false,
      db: makeMockDb() as never,
      orchestrator: orchestrator as never,
      planeWebhookSecret: PLANE_SECRET,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 on valid HMAC + path secret', async () => {
    const body = JSON.stringify({
      event: 'issue_activity',
      event_id: 'evt-plane-001',
      data: { id: 'card-123', from: 'backlog', to: 'in-progress' },
    });
    const sig = signBody(body, PLANE_SECRET);

    const response = await app.inject({
      method: 'POST',
      url: `/hooks/plane/${PLANE_SECRET}`,
      headers: {
        'content-type': 'application/json',
        'x-plane-signature': sig,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });

  it('returns 200 (not 401/403) on wrong path secret — no enumeration', async () => {
    const body = JSON.stringify({ event: 'issue_activity', event_id: 'evt-plane-002' });
    const sig = signBody(body, PLANE_SECRET);

    const response = await app.inject({
      method: 'POST',
      url: '/hooks/plane/wrong-secret',
      headers: {
        'content-type': 'application/json',
        'x-plane-signature': sig,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });

  it('returns 200 (not 401) on invalid HMAC signature', async () => {
    const body = JSON.stringify({ event: 'issue_activity', event_id: 'evt-plane-003' });

    const response = await app.inject({
      method: 'POST',
      url: `/hooks/plane/${PLANE_SECRET}`,
      headers: {
        'content-type': 'application/json',
        'x-plane-signature': 'sha256=invalidsignature',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns 200 on missing signature header', async () => {
    const body = JSON.stringify({ event: 'issue_activity', event_id: 'evt-plane-004' });

    const response = await app.inject({
      method: 'POST',
      url: `/hooks/plane/${PLANE_SECRET}`,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
  });

  it('deduplicates events with same event_id', async () => {
    const dedupStore = new Map<string, boolean>();
    const dedupOrchestrator = makeMockOrchestrator();
    const dedupApp = await buildApp({
      logger: false,
      db: makeMockDb(dedupStore) as never,
      orchestrator: dedupOrchestrator as never,
      planeWebhookSecret: PLANE_SECRET,
    });

    const body = JSON.stringify({
      event: 'issue',
      action: 'updated',
      event_id: 'evt-dedup-test',
      webhook_id: 'wh-dedup-1',
      workspace_id: 'ws-dedup-1',
      data: {
        id: 'card-dedup',
        name: 'Dedup test card',
        description_html: '',
        state: { id: 'state-2', name: 'In Progress', group: 'started' },
        project: 'proj-dedup',
        workspace: 'ws-slug',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      activity: {
        field: 'state_id',
        old_value: 'Backlog',
        new_value: 'In Progress',
        old_identifier: 'state-1',
        new_identifier: 'state-2',
      },
    });
    const sig = signBody(body, PLANE_SECRET);

    // First call
    await dedupApp.inject({
      method: 'POST',
      url: `/hooks/plane/${PLANE_SECRET}`,
      headers: { 'content-type': 'application/json', 'x-plane-signature': sig },
      payload: body,
    });

    // Second call — same event_id
    await dedupApp.inject({
      method: 'POST',
      url: `/hooks/plane/${PLANE_SECRET}`,
      headers: { 'content-type': 'application/json', 'x-plane-signature': sig },
      payload: body,
    });

    // orchestrator should only be called once
    // Note: processTrigger is called async — wait briefly
    await new Promise((r) => setTimeout(r, 50));
    expect(dedupOrchestrator.processTrigger).toHaveBeenCalledTimes(1);

    await dedupApp.close();
  });
});

// ---- GitHub webhook tests ----

describe('POST /hooks/github/:secret', () => {
  let app: FastifyInstance;
  let orchestrator: ReturnType<typeof makeMockOrchestrator>;

  beforeAll(async () => {
    process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
    orchestrator = makeMockOrchestrator();
    app = await buildApp({
      logger: false,
      db: makeMockDb() as never,
      orchestrator: orchestrator as never,
      githubWebhookSecret: GITHUB_SECRET,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 on valid X-Hub-Signature-256', async () => {
    const body = JSON.stringify({
      action: 'closed',
      pull_request: {
        number: 42,
        merged: true,
        merged_at: '2026-04-01T10:00:00Z',
        head: { ref: 'ouija/test-instance-id' },
      },
    });
    const sig = signBody(body, GITHUB_SECRET);

    const response = await app.inject({
      method: 'POST',
      url: `/hooks/github/${GITHUB_SECRET}`,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sig,
        'x-github-event': 'pull_request',
        'x-github-delivery': 'gh-delivery-001',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });

  it('returns 200 on wrong path secret — no enumeration', async () => {
    const body = JSON.stringify({ action: 'closed' });
    const sig = signBody(body, GITHUB_SECRET);

    const response = await app.inject({
      method: 'POST',
      url: '/hooks/github/wrong-path-secret',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sig,
        'x-github-event': 'pull_request',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns 200 on invalid HMAC', async () => {
    const body = JSON.stringify({ action: 'opened' });

    const response = await app.inject({
      method: 'POST',
      url: `/hooks/github/${GITHUB_SECRET}`,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=badsignature',
        'x-github-event': 'push',
        'x-github-delivery': 'gh-delivery-002',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
  });

  it('deduplicates via X-GitHub-Delivery header', async () => {
    const dedupStore = new Map<string, boolean>();
    const dedupOrchestrator = makeMockOrchestrator();
    const dedupApp = await buildApp({
      logger: false,
      db: makeMockDb(dedupStore) as never,
      orchestrator: dedupOrchestrator as never,
      githubWebhookSecret: GITHUB_SECRET,
    });

    const body = JSON.stringify({
      action: 'closed',
      pull_request: {
        number: 99,
        merged: true,
        merged_at: '2026-04-01T12:00:00Z',
        head: { ref: 'ouija/dedup-instance' },
      },
    });
    const sig = signBody(body, GITHUB_SECRET);

    const headers = {
      'content-type': 'application/json',
      'x-hub-signature-256': sig,
      'x-github-event': 'pull_request',
      'x-github-delivery': 'unique-delivery-id-123',
    };

    await dedupApp.inject({ method: 'POST', url: `/hooks/github/${GITHUB_SECRET}`, headers, payload: body });
    await dedupApp.inject({ method: 'POST', url: `/hooks/github/${GITHUB_SECRET}`, headers, payload: body });

    await new Promise((r) => setTimeout(r, 50));
    expect(dedupOrchestrator.processTrigger).toHaveBeenCalledTimes(1);

    await dedupApp.close();
  });
});
