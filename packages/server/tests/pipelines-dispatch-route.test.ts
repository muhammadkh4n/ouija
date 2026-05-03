/**
 * POST /api/v1/pipelines/dispatch — admin dispatch route smoke tests.
 *
 * Phase 2 Task 7. Asserts the route delegates to
 * Orchestrator.requestManualDispatch, enforces auth, and maps each
 * ManualDispatchOutcome variant to the right HTTP status.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Database } from '@ouija-dev/types';
import type { ManualDispatchOutcome } from '@ouija-dev/engine';

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
      findOverbudgetCandidates: (async () => []) as never,
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

function makeStubOrchestrator(outcome: ManualDispatchOutcome) {
  return {
    requestManualDispatch: vi.fn(
      async (_input: {
        agentId: string;
        title: string;
        description: string;
        boardId?: string;
        requestedBy: string;
      }) => outcome,
    ),
    requestAdminReset: vi.fn(),
    processTrigger: vi.fn(async () => undefined),
    processStallDetected: vi.fn(async () => undefined),
    processReviewBundle: vi.fn(async () => undefined),
  };
}

beforeAll(() => {
  process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
  process.env['OUIJA_API_KEY'] = API_KEY;
});

async function buildTestApp(outcome: ManualDispatchOutcome) {
  const orch = makeStubOrchestrator(outcome);
  const db = makeStubDatabase();
  const app = await buildApp({
    logger: false,
    db,
    orchestrator: orch as never,
  });
  return { app, orch };
}

describe('POST /api/v1/pipelines/dispatch', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app) await app.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    ({ app } = await buildTestApp({
      kind: 'dispatched',
      instanceId: 'inst_x',
      cardId: 'manual/c',
      boardId: 'b',
      dispatchId: 'd',
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/dispatch',
      payload: {
        agentId: 'agent-test',
        title: 't',
        description: 'd',
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects malformed bodies via the JSON schema (400)', async () => {
    ({ app } = await buildTestApp({
      kind: 'dispatched',
      instanceId: 'inst_x',
      cardId: 'manual/c',
      boardId: 'b',
      dispatchId: 'd',
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/dispatch',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { agentId: 'agent-test' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 202 with instanceId/cardId/boardId/dispatchId on success', async () => {
    const { app: built, orch } = await buildTestApp({
      kind: 'dispatched',
      instanceId: 'inst_dispatch_test',
      cardId: 'manual/aaaa',
      boardId: 'board_x',
      dispatchId: 'disp_y',
    });
    app = built;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/dispatch',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {
        agentId: 'agent-test',
        title: 'Bump deps',
        description: 'Run npm-check-updates and open a PR.',
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.instanceId).toBe('inst_dispatch_test');
    expect(body.cardId).toBe('manual/aaaa');
    expect(body.boardId).toBe('board_x');
    expect(body.dispatchId).toBe('disp_y');

    expect(orch.requestManualDispatch).toHaveBeenCalledTimes(1);
    const arg = orch.requestManualDispatch.mock.calls[0]![0];
    expect(arg.agentId).toBe('agent-test');
    expect(arg.title).toBe('Bump deps');
    expect(arg.description).toBe('Run npm-check-updates and open a PR.');
    // Bearer-key auth path resolves requestedBy to 'api'.
    expect(arg.requestedBy).toBe('api');
  });

  it('forwards explicit boardId + requestedBy when provided', async () => {
    const { app: built, orch } = await buildTestApp({
      kind: 'dispatched',
      instanceId: 'i',
      cardId: 'manual/c',
      boardId: 'board_specific',
      dispatchId: 'd',
    });
    app = built;

    await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/dispatch',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {
        agentId: 'agent-test',
        title: 't',
        description: 'd',
        boardId: 'board_specific',
        requestedBy: 'mk',
      },
    });

    const arg = orch.requestManualDispatch.mock.calls[0]![0];
    expect(arg.boardId).toBe('board_specific');
    expect(arg.requestedBy).toBe('mk');
  });

  it('maps no_board → 409 NO_BOARD_CONFIGURED', async () => {
    ({ app } = await buildTestApp({ kind: 'no_board' }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/dispatch',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { agentId: 'agent-test', title: 't', description: 'd' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('NO_BOARD_CONFIGURED');
  });

  it('maps ambiguous_board → 400 BOARD_ID_REQUIRED with candidate hints', async () => {
    ({ app } = await buildTestApp({
      kind: 'ambiguous_board',
      boardIds: ['board_a', 'board_b'],
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/dispatch',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { agentId: 'agent-test', title: 't', description: 'd' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('BOARD_ID_REQUIRED');
    expect(JSON.stringify(body.error.details)).toContain('board_a');
    expect(JSON.stringify(body.error.details)).toContain('board_b');
  });

  it('maps config_missing → 500 PIPELINE_CONFIG_MISSING', async () => {
    ({ app } = await buildTestApp({
      kind: 'config_missing',
      boardId: 'lost',
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/dispatch',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { agentId: 'agent-test', title: 't', description: 'd' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('PIPELINE_CONFIG_MISSING');
  });

  it('maps rejected → 409 DISPATCH_REJECTED with the reason verbatim', async () => {
    ({ app } = await buildTestApp({
      kind: 'rejected',
      reason: 'agentId is required',
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pipelines/dispatch',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { agentId: 'agent-test', title: 't', description: 'd' },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe('DISPATCH_REJECTED');
    expect(body.error.message).toBe('agentId is required');
  });
});
