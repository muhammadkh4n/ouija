/**
 * DwellReconciler unit tests.
 *
 * In-memory mock for both `db.pipelines` (just `findOverbudgetCandidates`)
 * and `Orchestrator.requestTimedOut`. Verifies:
 *   - Per-status iteration picks up over-budget rows.
 *   - Under-budget rows are skipped after the per-row re-check.
 *   - Lifecycle (start/stop/idempotent start).
 *   - Resolver returning undefined skips the row instead of crashing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DwellReconciler } from '../src/reconciler.js';
import { DEFAULT_DWELL_BUDGETS_MS } from '../src/dwell-budgets.js';
import type {
  Database,
  PipelineConfig,
  PipelineInstance,
  PipelineStatus,
} from '@ouija-dev/types';
import type { Orchestrator } from '../src/orchestrator.js';
import {
  instanceId as makeInstanceId,
  cardId as makeCardId,
  boardId as makeBoardId,
  dispatchId as makeDispatchId,
  agentId as makeAgentId,
} from '@ouija-dev/types';

// ---- Fixtures ----

const BOARD_ID = makeBoardId('board-test');
const TEST_CONFIG: PipelineConfig = {
  boardId: BOARD_ID,
  defaultStallThresholdMs: 300_000,
  autoStartOnAssign: false,
  columnMappings: [],
};

function makeInstance(
  status: PipelineStatus,
  ageMs: number,
  idSuffix = '',
): PipelineInstance {
  const enteredAt = new Date(Date.now() - ageMs).toISOString();
  const base = {
    id: makeInstanceId(`inst-${status}-${idSuffix || ageMs}`),
    cardId: makeCardId(`card-${status}-${idSuffix || ageMs}`),
    boardId: BOARD_ID,
    projectId: 'proj-1',
    attempt: 0,
    stateEnteredAt: enteredAt,
    createdAt: enteredAt,
    updatedAt: enteredAt,
  };

  // Build a state that matches the discriminated union arm for `status`.
  switch (status) {
    case 'dispatching':
      return {
        ...base,
        state: {
          status: 'dispatching',
          dispatchId: makeDispatchId('d-1'),
          agentId: makeAgentId('agent-1'),
          dispatchedAt: enteredAt,
        },
      };
    case 'provisioning':
      return {
        ...base,
        state: {
          status: 'provisioning',
          dispatchId: makeDispatchId('d-1'),
          agentId: makeAgentId('agent-1'),
          dispatchedAt: enteredAt,
        },
      };
    case 'running':
      return {
        ...base,
        state: {
          status: 'running',
          dispatchId: makeDispatchId('d-1'),
          agentId: makeAgentId('agent-1'),
          dispatchedAt: enteredAt,
          lastHeartbeatAt: enteredAt,
        },
      };
    case 'awaiting_review':
      return {
        ...base,
        state: {
          status: 'awaiting_review',
          dispatchId: makeDispatchId('d-1'),
          agentId: makeAgentId('agent-1'),
          prUrl: 'https://example.com/pr/1',
          prId: makeCardId('pr-1') as unknown as import('@ouija-dev/types').PrId,
          iteration: 1,
          enteredAt,
        },
      };
    default:
      throw new Error(`makeInstance: unsupported status ${status}`);
  }
}

function makeMockDb(rows: PipelineInstance[]): Database {
  return {
    pipelines: {
      findOverbudgetCandidates: vi.fn(
        async (status: PipelineStatus, cutoff: Date, limit: number) => {
          const matches = rows.filter(
            (r) => r.state.status === status && new Date(r.stateEnteredAt) < cutoff,
          );
          return matches.slice(0, limit);
        },
      ),
    } as unknown as Database['pipelines'],
  } as unknown as Database;
}

function makeMockOrchestrator() {
  return {
    requestTimedOut: vi.fn(
      async (_id: string, _from: PipelineStatus, _budget: number, _dwell: number) => ({
        kind: 'timed_out' as const,
        prevStatus: _from,
        nextStatus: 'failed' as const,
      }),
    ),
  };
}

// ---- Tests ----

describe('DwellReconciler', () => {
  let orchestrator: ReturnType<typeof makeMockOrchestrator>;

  beforeEach(() => {
    orchestrator = makeMockOrchestrator();
  });

  it('fires timed_out on dispatching rows older than the 60s budget', async () => {
    const overbudget = makeInstance('dispatching', 90_000); // 90s > 60s budget
    const db = makeMockDb([overbudget]);
    const r = new DwellReconciler(
      db,
      orchestrator as unknown as Orchestrator,
      async () => TEST_CONFIG,
    );

    const fired = await r.scan();
    expect(fired).toBe(1);
    expect(orchestrator.requestTimedOut).toHaveBeenCalledTimes(1);
    expect(orchestrator.requestTimedOut).toHaveBeenCalledWith(
      String(overbudget.id),
      'dispatching',
      DEFAULT_DWELL_BUDGETS_MS.dispatching,
      expect.any(Number),
    );
  });

  it('skips dispatching rows still under the 60s budget', async () => {
    const underbudget = makeInstance('dispatching', 30_000); // 30s < 60s budget
    const db = makeMockDb([underbudget]);
    const r = new DwellReconciler(
      db,
      orchestrator as unknown as Orchestrator,
      async () => TEST_CONFIG,
    );

    const fired = await r.scan();
    expect(fired).toBe(0);
    expect(orchestrator.requestTimedOut).not.toHaveBeenCalled();
  });

  it('honours the 14d budget on awaiting_review rows', async () => {
    const fifteenDays = 15 * 24 * 60 * 60 * 1000;
    const oldReview = makeInstance('awaiting_review', fifteenDays);
    const freshReview = makeInstance('awaiting_review', 60 * 60 * 1000, 'fresh'); // 1h
    const db = makeMockDb([oldReview, freshReview]);
    const r = new DwellReconciler(
      db,
      orchestrator as unknown as Orchestrator,
      async () => TEST_CONFIG,
    );

    const fired = await r.scan();
    expect(fired).toBe(1);
    expect(orchestrator.requestTimedOut).toHaveBeenCalledWith(
      String(oldReview.id),
      'awaiting_review',
      DEFAULT_DWELL_BUDGETS_MS.awaiting_review,
      expect.any(Number),
    );
  });

  it('skips a row when the per-board config resolver returns undefined', async () => {
    const overbudget = makeInstance('dispatching', 90_000);
    const db = makeMockDb([overbudget]);
    const r = new DwellReconciler(
      db,
      orchestrator as unknown as Orchestrator,
      async () => undefined,
    );

    const fired = await r.scan();
    expect(fired).toBe(0);
    expect(orchestrator.requestTimedOut).not.toHaveBeenCalled();
  });

  it('reconciles multiple rows across multiple statuses in one tick', async () => {
    const rows = [
      makeInstance('dispatching', 90_000, 'a'),
      makeInstance('provisioning', 200_000, 'b'),
      makeInstance('awaiting_review', 16 * 24 * 60 * 60 * 1000, 'c'),
      makeInstance('dispatching', 30_000, 'd-fresh'), // under budget
    ];
    const db = makeMockDb(rows);
    const r = new DwellReconciler(
      db,
      orchestrator as unknown as Orchestrator,
      async () => TEST_CONFIG,
    );

    const fired = await r.scan();
    expect(fired).toBe(3);
    expect(orchestrator.requestTimedOut).toHaveBeenCalledTimes(3);
  });

  it('respects the batchSize cap per status', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeInstance('dispatching', 90_000 + i, `bulk-${i}`),
    );
    const db = makeMockDb(rows);
    const r = new DwellReconciler(
      db,
      orchestrator as unknown as Orchestrator,
      async () => TEST_CONFIG,
      { batchSize: 3 },
    );

    const fired = await r.scan();
    expect(fired).toBe(3);
    expect(orchestrator.requestTimedOut).toHaveBeenCalledTimes(3);
  });

  it('continues to next status when one status query fails', async () => {
    const goodRow = makeInstance('awaiting_review', 16 * 24 * 60 * 60 * 1000);
    const db = {
      pipelines: {
        findOverbudgetCandidates: vi.fn(
          async (status: PipelineStatus, _cutoff: Date, _limit: number) => {
            if (status === 'dispatching') throw new Error('boom');
            if (status === 'awaiting_review') return [goodRow];
            return [];
          },
        ),
      } as unknown as Database['pipelines'],
    } as unknown as Database;
    const r = new DwellReconciler(
      db,
      orchestrator as unknown as Orchestrator,
      async () => TEST_CONFIG,
    );

    const fired = await r.scan();
    expect(fired).toBe(1);
    expect(orchestrator.requestTimedOut).toHaveBeenCalledWith(
      String(goodRow.id),
      'awaiting_review',
      DEFAULT_DWELL_BUDGETS_MS.awaiting_review,
      expect.any(Number),
    );
  });

  it('start/stop lifecycle is idempotent', async () => {
    const db = makeMockDb([]);
    const r = new DwellReconciler(
      db,
      orchestrator as unknown as Orchestrator,
      async () => TEST_CONFIG,
      { intervalMs: 60_000 },
    );

    expect(r.isRunning).toBe(false);
    r.start();
    expect(r.isRunning).toBe(true);
    r.start(); // second start: warns + no-ops
    expect(r.isRunning).toBe(true);
    r.stop();
    expect(r.isRunning).toBe(false);
    r.stop(); // safe to call when not running
    expect(r.isRunning).toBe(false);
  });
});
