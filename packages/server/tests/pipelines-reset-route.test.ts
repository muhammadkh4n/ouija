/**
 * POST /api/v1/pipelines/:id/reset — admin recovery route smoke tests.
 *
 * Phase 2 Tasks 2 + 3. Asserts the route delegates to
 * Orchestrator.requestAdminReset, enforces auth, and maps each
 * AdminResetOutcome variant to the right HTTP status.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Database } from '@ouija-dev/types';
import type { AdminResetOutcome } from '@ouija-dev/engine';

const API_KEY = 'ouija_test_admin_key_minimum_value';

function makeStubDatabase(): Database {
  const empty = async (): Promise<undefined> => undefined;
  return {
    pipelines: {
      findById: empty as never,
      findByCardId: empty as never,
      listByBoard: (async () => ({ items: [] })) as never,
      save: empty as never,
      delete: empty as never,
      findStalledCandidates: (async () => []) as never,
    },
    pipelineEvents: {
      append: empty as never,
      appendMany: empty as never,
      listByInstance: (async () => []) as never,
    },
    boardConfigs: {
      findByBoardId: empty as never,
      listAll: (async () => []) as never,
      save: empty as never,
      delete: empty as never,
    },
    deduplication: {
      isDuplicate: (async () => false) as never,
      markProcessed: empty as never,
      purgeExpired: (async () => 0) as never,
    },
    transaction: (async <T>(fn: (uow: never) => Promise<T>) =>
      fn({} as never)) as never,
    ping: empty as never,
  } as unknown as Database;
}

function makeStubOrchestrator(outcome: AdminResetOutcome) {
  return {
    requestAdminReset: vi.fn(async (_id: string, _by: string) => outcome),
    processTrigger: vi.fn(async (_e: unknown) => undefined),
    processStallDetected: vi.fn(async () => undefined),
    processReviewBundle: vi.fn(async () => undefined),
  };
}

beforeAll(() => {
  process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
  process.env['OUIJA_API_KEY'] = API_KEY;
});

async function buildTestApp(outcome: AdminResetOutcome) {
  const orch = makeStubOrchestrator(outcome);
  const db = makeStubDatabase();
  const app = await buildApp({
    logger: false,
    db,
    orchestrator: orch as never,
  });
  return { app, orch };
}

describe('POST /api/v1/pipelines/:id/reset', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app) await app.close();
  });

  it('returns 401 without auth header', async () => {
    ({ app } = await buildTestApp({ kind: 'not_found' }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/inst-001/reset',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('returns 200 + prevStatus/nextStatus on accepted reset', async () => {
    let orch: ReturnType<typeof makeStubOrchestrator>;
    ({ app, orch } = await buildTestApp({
      kind: 'reset',
      prevStatus: 'dispatching',
      nextStatus: 'idle',
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/inst-001/reset',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      payload: { requestedBy: 'mk' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.instanceId).toBe('inst-001');
    expect(body.prevStatus).toBe('dispatching');
    expect(body.nextStatus).toBe('idle');

    expect(orch.requestAdminReset).toHaveBeenCalledTimes(1);
    expect(orch.requestAdminReset).toHaveBeenCalledWith('inst-001', 'mk');
    await app.close();
  });

  it('falls back to authenticated user id when body has no requestedBy', async () => {
    let orch: ReturnType<typeof makeStubOrchestrator>;
    ({ app, orch } = await buildTestApp({
      kind: 'reset',
      prevStatus: 'stalled',
      nextStatus: 'idle',
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/inst-002/reset',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    // OUIJA_API_KEY auth populates request.user.userId = 'api'
    expect(orch.requestAdminReset).toHaveBeenCalledWith('inst-002', 'api');
    await app.close();
  });

  it('returns 404 when orchestrator reports not_found', async () => {
    ({ app } = await buildTestApp({ kind: 'not_found' }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/missing/reset',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PIPELINE_NOT_FOUND');
    await app.close();
  });

  it('returns 409 when orchestrator rejects the transition', async () => {
    ({ app } = await buildTestApp({
      kind: 'rejected',
      reason: 'Cannot reset: pipeline is in state "idle"',
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/idle-pipeline/reset',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe('PIPELINE_NOT_RESETTABLE');
    expect(body.error.message).toContain('idle');
    await app.close();
  });

  it('returns 500 when board config is missing', async () => {
    ({ app } = await buildTestApp({
      kind: 'config_missing',
      boardId: 'board-x',
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/inst-no-config/reset',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('PIPELINE_CONFIG_MISSING');
    await app.close();
  });
});
