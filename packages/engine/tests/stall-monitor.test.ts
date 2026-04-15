/**
 * StallMonitor unit tests.
 *
 * All I/O is mocked. Tests verify:
 *   - scan finds stalled instances → fires stall_detected via processStallDetected
 *   - scan with no stalled instances → no triggers
 *   - start/stop lifecycle (setInterval / clearInterval)
 *   - double-start is a no-op
 *   - scan tolerates orchestrator failures per-instance
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StallMonitor } from '../src/stall-monitor.js';
import type { Database, PipelineInstance, PipelineRepository, PipelineEventRepository, BoardConfigRepository, DeduplicationRepository, UnitOfWork, CursorPage, PipelineConfig } from '@ouija-dev/types';
import {
  instanceId,
  cardId,
  boardId,
  dispatchId,
  agentId,
} from '@ouija-dev/types';

// ---- Minimal mock database ----

function createMinimalDatabase(stalledCandidates: PipelineInstance[] = []): Database {
  const pipelines: PipelineRepository = {
    async findById() { return undefined; },
    async findByCardId() { return undefined; },
    async listByBoard() { return { items: [] } as CursorPage<PipelineInstance>; },
    async save() { return; },
    async delete() { return; },
    async findStalledCandidates() { return stalledCandidates; },
  };
  const pipelineEvents: PipelineEventRepository = {
    async append() { return; },
    async appendMany() { return; },
    async listByInstance() { return []; },
  };
  const boardConfigs: BoardConfigRepository = {
    async findByBoardId() { return undefined; },
    async listAll() { return []; },
    async save() { return; },
    async delete() { return; },
  };
  const deduplication: DeduplicationRepository = {
    async isDuplicate() { return false; },
    async markProcessed() { return; },
    async purgeExpired() { return 0; },
  };
  return {
    pipelines,
    pipelineEvents,
    boardConfigs,
    deduplication,
    async transaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
      return fn({ pipelines, pipelineEvents, boardConfigs });
    },
    async ping() { return; },
  };
}

// ---- Minimal mock orchestrator ----

interface MockOrchestrator {
  processStallDetected: ReturnType<typeof vi.fn>;
  processTrigger: ReturnType<typeof vi.fn>;
  _configCache: Map<string, unknown>;
  invalidateConfigCache: ReturnType<typeof vi.fn>;
}

function createMockOrchestrator(): MockOrchestrator {
  return {
    processStallDetected: vi.fn().mockResolvedValue(undefined),
    processTrigger: vi.fn().mockResolvedValue(undefined),
    _configCache: new Map(),
    invalidateConfigCache: vi.fn(),
  };
}

// ---- Test fixtures ----

function makeStalledInstance(
  status: 'dispatching' | 'running' | 'provisioning' = 'running',
  dispatchedAtOffsetMs: number = 600_000,
): PipelineInstance {
  const iid = instanceId('inst-stalled-001');
  const dId = dispatchId('disp-stalled-001');
  const aId = agentId('agent-rex');
  const now = new Date().toISOString();
  const dispatchedAt = new Date(Date.now() - dispatchedAtOffsetMs).toISOString();

  const state =
    status === 'running'
      ? {
          status: 'running' as const,
          dispatchId: dId,
          agentId: aId,
          dispatchedAt,
          lastHeartbeatAt: dispatchedAt,
        }
      : status === 'provisioning'
        ? {
            status: 'provisioning' as const,
            dispatchId: dId,
            agentId: aId,
            dispatchedAt,
          }
        : {
            status: 'dispatching' as const,
            dispatchId: dId,
            agentId: aId,
            dispatchedAt,
          };

  return {
    id: iid,
    cardId: cardId('card-001'),
    boardId: boardId('board-001'),
    projectId: 'board-001',
    state,
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// ---- Tests ----

describe('StallMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Test 1: scan finds stalled instance → fires stall_detected ----

  it('scan: stalled running instance → calls processStallDetected', async () => {
    const stalledInstance = makeStalledInstance('running');
    const db = createMinimalDatabase([stalledInstance]);
    const orchestrator = createMockOrchestrator();
    const monitor = new StallMonitor(
      db,
      orchestrator as unknown as import('../src/orchestrator.js').Orchestrator,
      300_000,
    );

    await monitor.scan();

    expect(orchestrator.processStallDetected).toHaveBeenCalledTimes(1);
    const [calledInstanceId, calledDispatchId, calledDetectedAt] =
      orchestrator.processStallDetected.mock.calls[0]!;
    expect(calledInstanceId).toBe(String(stalledInstance.id));
    expect(calledDispatchId).toBe((stalledInstance.state as { dispatchId: string }).dispatchId);
    expect(typeof calledDetectedAt).toBe('string');
  });

  // ---- Test 2: scan finds dispatching instance → fires stall_detected ----

  it('scan: stalled dispatching instance → calls processStallDetected', async () => {
    const stalledInstance = makeStalledInstance('dispatching');
    const db = createMinimalDatabase([stalledInstance]);
    const orchestrator = createMockOrchestrator();
    const monitor = new StallMonitor(
      db,
      orchestrator as unknown as import('../src/orchestrator.js').Orchestrator,
      300_000,
    );

    await monitor.scan();

    expect(orchestrator.processStallDetected).toHaveBeenCalledTimes(1);
  });

  // ---- Test 3: scan with no stalled instances → no triggers ----

  it('scan: no stalled instances → processStallDetected not called', async () => {
    const db = createMinimalDatabase([]); // empty
    const orchestrator = createMockOrchestrator();
    const monitor = new StallMonitor(
      db,
      orchestrator as unknown as import('../src/orchestrator.js').Orchestrator,
      300_000,
    );

    await monitor.scan();

    expect(orchestrator.processStallDetected).not.toHaveBeenCalled();
  });

  // ---- Test 4: multiple stalled instances → fires for each ----

  it('scan: multiple stalled instances → processStallDetected called for each', async () => {
    const instances = [
      makeStalledInstance('running'),
      { ...makeStalledInstance('dispatching'), id: instanceId('inst-stalled-002'), cardId: cardId('card-002') },
    ];
    const db = createMinimalDatabase(instances);
    const orchestrator = createMockOrchestrator();
    const monitor = new StallMonitor(
      db,
      orchestrator as unknown as import('../src/orchestrator.js').Orchestrator,
      300_000,
    );

    await monitor.scan();

    expect(orchestrator.processStallDetected).toHaveBeenCalledTimes(2);
  });

  // ---- Test 5: start/stop lifecycle ----

  it('start/stop: setInterval created and cleared', () => {
    vi.useFakeTimers();

    const db = createMinimalDatabase();
    const orchestrator = createMockOrchestrator();
    const monitor = new StallMonitor(
      db,
      orchestrator as unknown as import('../src/orchestrator.js').Orchestrator,
      300_000,
    );

    expect(monitor.isRunning).toBe(false);

    monitor.start(60_000);
    expect(monitor.isRunning).toBe(true);

    monitor.stop();
    expect(monitor.isRunning).toBe(false);
  });

  // ---- Test 6: start called twice is a no-op ----

  it('start: calling start twice does not create two intervals', () => {
    vi.useFakeTimers();

    const db = createMinimalDatabase();
    const orchestrator = createMockOrchestrator();
    const monitor = new StallMonitor(
      db,
      orchestrator as unknown as import('../src/orchestrator.js').Orchestrator,
      300_000,
    );

    monitor.start(60_000);
    monitor.start(60_000); // second call should be ignored

    expect(monitor.isRunning).toBe(true);

    monitor.stop();
    expect(monitor.isRunning).toBe(false);
  });

  // ---- Test 7: stop when not started is safe ----

  it('stop: calling stop when not started does not throw', () => {
    const db = createMinimalDatabase();
    const orchestrator = createMockOrchestrator();
    const monitor = new StallMonitor(
      db,
      orchestrator as unknown as import('../src/orchestrator.js').Orchestrator,
      300_000,
    );

    expect(() => monitor.stop()).not.toThrow();
    expect(monitor.isRunning).toBe(false);
  });

  // ---- Test 8: scan interval fires on schedule ----

  it('start: scan runs after intervalMs passes', async () => {
    vi.useFakeTimers();

    const stalledInstance = makeStalledInstance('running');
    const db = createMinimalDatabase([stalledInstance]);
    const orchestrator = createMockOrchestrator();
    const monitor = new StallMonitor(
      db,
      orchestrator as unknown as import('../src/orchestrator.js').Orchestrator,
      300_000,
    );

    monitor.start(60_000);

    // Advance timer by one interval
    await vi.advanceTimersByTimeAsync(60_000);

    monitor.stop();

    expect(orchestrator.processStallDetected).toHaveBeenCalledTimes(1);
  });

  // ---- Test 9: orchestrator failure on one instance does not block others ----

  it('scan: orchestrator failure on one instance does not prevent others from being processed', async () => {
    const instances = [
      makeStalledInstance('running'),
      { ...makeStalledInstance('running'), id: instanceId('inst-stalled-002'), cardId: cardId('card-002') },
    ];
    const db = createMinimalDatabase(instances);
    const orchestrator = createMockOrchestrator();

    // First call throws, second succeeds
    let callCount = 0;
    orchestrator.processStallDetected.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('transient failure');
    });

    const monitor = new StallMonitor(
      db,
      orchestrator as unknown as import('../src/orchestrator.js').Orchestrator,
      300_000,
    );

    // Should not throw even though one instance fails
    await expect(monitor.scan()).resolves.not.toThrow();

    // Both instances should have been attempted
    expect(orchestrator.processStallDetected).toHaveBeenCalledTimes(2);
  });

  // ---- Test 10: DB query failure in scan is handled gracefully ----

  it('scan: DB query failure is caught and does not throw', async () => {
    const db = createMinimalDatabase();
    // Override findStalledCandidates to throw
    db.pipelines.findStalledCandidates = async () => {
      throw new Error('DB connection lost');
    };

    const orchestrator = createMockOrchestrator();
    const monitor = new StallMonitor(
      db,
      orchestrator as unknown as import('../src/orchestrator.js').Orchestrator,
      300_000,
    );

    await expect(monitor.scan()).resolves.not.toThrow();
    expect(orchestrator.processStallDetected).not.toHaveBeenCalled();
  });

  // ---- Test 11: provisioning instance within 2x grace period is skipped ----

  it('scan: provisioning instance within 2x grace period is NOT triggered', async () => {
    // dispatchedAt is 350_000 ms ago — past the 1x threshold (300_000) but inside 2x (600_000)
    // findStalledCandidates would return it (past 1x cutoff), but scan must filter it out
    const stalledInstance = makeStalledInstance('provisioning', 350_000);
    const db = createMinimalDatabase([stalledInstance]);
    const orchestrator = createMockOrchestrator();
    const monitor = new StallMonitor(
      db,
      orchestrator as unknown as import('../src/orchestrator.js').Orchestrator,
      300_000,
    );

    await monitor.scan();

    expect(orchestrator.processStallDetected).not.toHaveBeenCalled();
  });

  // ---- Test 12: provisioning instance past 2x grace period IS triggered ----

  it('scan: provisioning instance past 2x grace period IS triggered', async () => {
    // dispatchedAt is 700_000 ms ago — past the 2x threshold (600_000)
    const stalledInstance = makeStalledInstance('provisioning', 700_000);
    const db = createMinimalDatabase([stalledInstance]);
    const orchestrator = createMockOrchestrator();
    const monitor = new StallMonitor(
      db,
      orchestrator as unknown as import('../src/orchestrator.js').Orchestrator,
      300_000,
    );

    await monitor.scan();

    expect(orchestrator.processStallDetected).toHaveBeenCalledTimes(1);
    const [calledInstanceId] = orchestrator.processStallDetected.mock.calls[0]!;
    expect(calledInstanceId).toBe(String(stalledInstance.id));
  });
});
