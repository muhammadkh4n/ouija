/**
 * Tests for the webhook activity indicator endpoint + underlying tracker.
 *
 * Covers the UX-critical path: when a self-hoster wires a Plane webhook, the
 * dashboard must be able to answer "has at least one real webhook landed?"
 * without requiring them to drag a card.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { WebhookActivityTracker } from '../src/webhook-activity.js';

const PLANE_SECRET = 'plane-secret-activity-test-abcdef';
const API_KEY = 'ouija_activity-test-key';

function signBody(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

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

async function buildTestApp(): Promise<FastifyInstance> {
  return buildApp({
    logger: false,
    db: makeMockDb() as never,
    orchestrator: { processTrigger: async () => undefined } as never,
    planeWebhookSecret: PLANE_SECRET,
  });
}

beforeAll(() => {
  process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
  process.env['OUIJA_API_KEY'] = API_KEY;
});

afterAll(() => {
  delete process.env['OUIJA_API_KEY'];
});

describe('WebhookActivityTracker (unit)', () => {
  it('returns null last when nothing has been recorded', () => {
    const tracker = new WebhookActivityTracker();
    expect(tracker.snapshot().last).toBeNull();
    expect(tracker.snapshot().perSource).toEqual({});
  });

  it('records per-source and overall on record()', () => {
    const tracker = new WebhookActivityTracker();
    tracker.record('plane');
    const snap = tracker.snapshot();
    expect(snap.last?.source).toBe('plane');
    expect(snap.perSource['plane']).toBeDefined();
  });

  it('preserves older source timestamps when a newer source fires', () => {
    const tracker = new WebhookActivityTracker();
    tracker.record('plane');
    const planeTs = tracker.snapshot().perSource['plane'];
    tracker.record('github');
    const snap = tracker.snapshot();
    expect(snap.last?.source).toBe('github');
    expect(snap.perSource['plane']).toBe(planeTs);
    expect(snap.perSource['github']).toBeDefined();
  });
});

describe('GET /api/v1/webhooks/activity', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns an empty snapshot before any webhook arrives', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/webhooks/activity',
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.last).toBeNull();
    expect(body.perSource).toEqual({});
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/webhooks/activity',
    });
    expect(response.statusCode).toBe(401);
  });

  it('records activity after a signature-verified Plane webhook', async () => {
    const body = JSON.stringify({
      event: 'issue',
      event_id: `evt-${Date.now()}`,
      webhook_id: 'wh-activity',
      workspace_id: 'ws-activity',
      data: {
        id: 'card-activity',
        name: 'test',
        description_html: '',
        state: { id: 'state-x', name: 'Backlog', group: 'unstarted' },
        project: 'proj-activity',
        workspace: 'ws-slug',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      activity: {
        field: 'state_id',
        old_value: 'Backlog',
        new_value: 'In Progress',
        old_identifier: 'a',
        new_identifier: 'b',
      },
    });

    const webhookResp = await app.inject({
      method: 'POST',
      url: `/hooks/plane/${PLANE_SECRET}`,
      headers: {
        'content-type': 'application/json',
        'x-plane-signature': signBody(body, PLANE_SECRET),
      },
      payload: body,
    });
    expect(webhookResp.statusCode).toBe(200);

    const resp = await app.inject({
      method: 'GET',
      url: '/api/v1/webhooks/activity',
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const snap = resp.json();
    expect(snap.last?.source).toBe('plane');
    expect(snap.perSource.plane).toBeDefined();
  });

  it('does NOT record when HMAC verification fails', async () => {
    const app2 = await buildTestApp();
    const body = JSON.stringify({ event: 'issue', event_id: 'evt-fail' });
    await app2.inject({
      method: 'POST',
      url: `/hooks/plane/${PLANE_SECRET}`,
      headers: {
        'content-type': 'application/json',
        'x-plane-signature': 'sha256=deadbeef',
      },
      payload: body,
    });
    const resp = await app2.inject({
      method: 'GET',
      url: '/api/v1/webhooks/activity',
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(resp.json().last).toBeNull();
    await app2.close();
  });
});
