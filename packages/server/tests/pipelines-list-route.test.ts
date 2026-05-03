/**
 * GET /api/v1/pipelines — serializer payload smoke tests for Phase 2 Task 6.
 *
 * Asserts the dashboard contract for dwell-time badges + reset button:
 *   - `stateEnteredAt` is exposed verbatim from the row.
 *   - `dwellBudgetMs` mirrors `resolveDwellBudgetMs(status, boardConfig)`,
 *     falling back to `null` when the board config is absent.
 *   - `allowedActions` includes `'reset'` for the stuck-recoverable set.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type {
  BoardId,
  CardId,
  Database,
  InstanceId,
  PipelineConfig,
  PipelineInstance,
} from '@ouija-dev/types';

const API_KEY = 'ouija_test_admin_key_minimum_value';

function makeInstance(overrides: Partial<PipelineInstance> = {}): PipelineInstance {
  const now = '2026-05-03T17:00:00.000Z';
  return {
    id: 'inst_test_1' as InstanceId,
    cardId: 'card_test_1' as CardId,
    boardId: 'board_test' as BoardId,
    projectId: 'proj_test',
    state: { status: 'dispatching', dispatchId: 'disp_x' as never },
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    stateEnteredAt: now,
    ...overrides,
  } as PipelineInstance;
}

function makeStubDatabase(opts: {
  instances: PipelineInstance[];
  config?: PipelineConfig;
}): Database {
  const empty = async (): Promise<undefined> => undefined;
  return {
    pipelines: {
      findById: (async (id: InstanceId) =>
        opts.instances.find((i) => i.id === id)) as never,
      findByCardId: empty as never,
      listByBoard: (async (boardId: BoardId) => ({
        items: opts.instances.filter((i) => i.boardId === boardId),
      })) as never,
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
      findByBoardId: (async () => opts.config) as never,
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

function makeStubOrchestrator() {
  return {
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

async function buildTestApp(opts: {
  instances: PipelineInstance[];
  config?: PipelineConfig;
}) {
  const orch = makeStubOrchestrator();
  const db = makeStubDatabase(opts);
  const app = await buildApp({
    logger: false,
    db,
    orchestrator: orch as never,
  });
  return { app };
}

describe('GET /api/v1/pipelines (serializer payload)', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app) await app.close();
  });

  it('exposes stateEnteredAt and resolves dwellBudgetMs for dispatching against the board config', async () => {
    const config: PipelineConfig = {
      boardId: 'board_test' as BoardId,
      columnMappings: [],
      defaultStallThresholdMs: 600_000,
      autoStartOnAssign: false,
    };
    const inst = makeInstance({
      stateEnteredAt: '2026-05-03T16:55:00.000Z',
    });
    ({ app } = await buildTestApp({ instances: [inst], config }));

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/pipelines?boardId=board_test',
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{
        id: string;
        status: string;
        stateEnteredAt: string;
        dwellBudgetMs: number | null;
        allowedActions: string[];
      }>;
    };
    expect(body.items).toHaveLength(1);
    const [row] = body.items;
    expect(row).toBeDefined();
    expect(row?.id).toBe('inst_test_1');
    expect(row?.status).toBe('dispatching');
    expect(row?.stateEnteredAt).toBe('2026-05-03T16:55:00.000Z');
    // dispatching's static budget is 60_000ms.
    expect(row?.dwellBudgetMs).toBe(60_000);
    expect(row?.allowedActions).toContain('reset');
    expect(row?.allowedActions).toContain('cancel');
  });

  it('returns dwellBudgetMs=null when the board config is missing', async () => {
    const inst = makeInstance({ state: { status: 'awaiting_review' } as never });
    ({ app } = await buildTestApp({ instances: [inst] }));

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/pipelines?boardId=board_test',
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ status: string; dwellBudgetMs: number | null; allowedActions: string[] }>;
    };
    expect(body.items[0]?.dwellBudgetMs).toBeNull();
    expect(body.items[0]?.allowedActions).toContain('reset');
  });

  it('returns dwellBudgetMs=null for terminal states even when config is present', async () => {
    const config: PipelineConfig = {
      boardId: 'board_test' as BoardId,
      columnMappings: [],
      defaultStallThresholdMs: 600_000,
      autoStartOnAssign: false,
    };
    const inst = makeInstance({ state: { status: 'succeeded' } as never });
    ({ app } = await buildTestApp({ instances: [inst], config }));

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/pipelines?boardId=board_test',
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ status: string; dwellBudgetMs: number | null; allowedActions: string[] }>;
    };
    expect(body.items[0]?.status).toBe('succeeded');
    expect(body.items[0]?.dwellBudgetMs).toBeNull();
    expect(body.items[0]?.allowedActions).not.toContain('reset');
  });

  it('skips the board-config lookup when the page is empty', async () => {
    const findByBoardId = vi.fn(async () => undefined);
    const orch = makeStubOrchestrator();
    const db = {
      pipelines: {
        findById: (async () => undefined) as never,
        findByCardId: (async () => undefined) as never,
        listByBoard: (async () => ({ items: [] })) as never,
        save: (async () => undefined) as never,
        delete: (async () => undefined) as never,
        findStalledCandidates: (async () => []) as never,
        findOverbudgetCandidates: (async () => []) as never,
      },
      pipelineEvents: {
        append: (async () => undefined) as never,
        appendMany: (async () => undefined) as never,
        listByInstance: (async () => []) as never,
      },
      boardConfigs: {
        findByBoardId: findByBoardId as never,
        listAll: (async () => []) as never,
        save: (async () => undefined) as never,
        delete: (async () => undefined) as never,
      },
      deduplication: {
        isDuplicate: (async () => false) as never,
        markProcessed: (async () => undefined) as never,
        purgeExpired: (async () => 0) as never,
      },
      transaction: (async <T>(fn: (uow: never) => Promise<T>) =>
        fn({} as never)) as never,
      ping: (async () => undefined) as never,
    } as unknown as Database;

    app = await buildApp({ logger: false, db, orchestrator: orch as never });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/pipelines?boardId=board_empty',
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: undefined });
    expect(findByBoardId).not.toHaveBeenCalled();
  });
});
