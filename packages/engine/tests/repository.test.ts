/**
 * Repository integration tests.
 *
 * These tests require a live PostgreSQL database and are skipped unless the
 * DATABASE_URL environment variable is set.
 *
 * To run locally:
 *   DATABASE_URL=postgres://ouija:ouija@localhost:5432/ouija_test \
 *     npx vitest run packages/engine/tests/repository.test.ts
 *
 * The target database must already have the schema applied via
 *   psql $DATABASE_URL -f packages/engine/src/migrations/001-initial-schema.sql
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresPipelineRepository,
  PostgresPipelineEventRepository,
  PostgresBoardConfigRepository,
  PostgresDeduplicationRepository,
  PostgresDatabase,
  createDatabase,
} from '../src/repository.js';
import type { PipelineInstance, PipelineConfig, PipelineEventRecord } from '@ouija-dev/types';
import {
  instanceId,
  cardId,
  boardId,
  dispatchId,
  agentId,
  columnId,
} from '@ouija-dev/types';

// ---- Skip guard ----

const DATABASE_URL = process.env['DATABASE_URL'];
const hasDb = DATABASE_URL !== undefined && DATABASE_URL.length > 0;

// ---- Test fixtures ----

function makeInstance(overrides: Partial<PipelineInstance> = {}): PipelineInstance {
  const id = instanceId(`inst-${Math.random().toString(36).slice(2)}`);
  const cid = cardId(`card-${Math.random().toString(36).slice(2)}`);
  return {
    id,
    cardId: cid,
    boardId: boardId('board-test-1'),
    projectId: 'project-test-1',
    state: { status: 'idle' },
    attempt: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEventRecord(
  iid: ReturnType<typeof instanceId>,
  seq: number,
  overrides: Partial<PipelineEventRecord> = {},
): PipelineEventRecord {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    instanceId: iid,
    topic: 'kanban.card.moved',
    payload: {
      cardId: cardId('card-abc'),
      fromColumnId: columnId('col-from'),
      toColumnId: columnId('col-to'),
      movedBy: 'test-user',
    },
    occurredAt: new Date().toISOString(),
    sequence: seq,
    ...overrides,
  };
}

function makeBoardConfig(bid: ReturnType<typeof boardId>): PipelineConfig {
  return {
    boardId: bid,
    columnMappings: [
      {
        columnId: columnId('col-progress'),
        columnName: 'In Progress',
        action: 'dispatch_agent',
        agentId: agentId('agent-rex'),
        guards: [{ type: 'min_description_length', value: 50 }],
        stallThresholdMs: 300_000,
      },
    ],
    defaultStallThresholdMs: 300_000,
    autoStartOnAssign: false,
  };
}

// ---- Suite ----

describe.skipIf(!hasDb)('PostgresPipelineRepository', () => {
  let pool: Pool;
  let repo: PostgresPipelineRepository;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new PostgresPipelineRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Truncate test data; cascade removes dependent rows
    await pool.query('TRUNCATE pipeline_instances CASCADE');
    await pool.query('TRUNCATE board_configs CASCADE');
    await pool.query('TRUNCATE webhook_dedup CASCADE');
  });

  it('save and findById round-trip', async () => {
    const inst = makeInstance();
    await repo.save(inst);

    const found = await repo.findById(inst.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(inst.id);
    expect(found?.cardId).toBe(inst.cardId);
    expect(found?.boardId).toBe(inst.boardId);
    expect(found?.state).toEqual({ status: 'idle' });
  });

  it('findById returns undefined for unknown id', async () => {
    const result = await repo.findById(instanceId('does-not-exist'));
    expect(result).toBeUndefined();
  });

  it('findByCardId returns the correct instance via card_instance_index', async () => {
    const inst = makeInstance();
    await repo.save(inst);

    const found = await repo.findByCardId(inst.cardId);
    expect(found).toBeDefined();
    expect(found?.id).toBe(inst.id);
  });

  it('findByCardId returns undefined for unknown card', async () => {
    const result = await repo.findByCardId(cardId('no-such-card'));
    expect(result).toBeUndefined();
  });

  it('save performs upsert — second save updates existing row', async () => {
    const inst = makeInstance();
    await repo.save(inst);

    const updated: PipelineInstance = {
      ...inst,
      state: {
        status: 'dispatching',
        dispatchId: dispatchId('d-1'),
        agentId: agentId('agent-rex'),
        dispatchedAt: new Date().toISOString(),
      },
      attempt: 2,
      updatedAt: new Date().toISOString(),
    };
    await repo.save(updated);

    const found = await repo.findById(inst.id);
    expect(found?.state.status).toBe('dispatching');
    expect(found?.attempt).toBe(2);
  });

  it('card_instance_index is updated when card switches to a new instance', async () => {
    const instA = makeInstance({ cardId: cardId('shared-card') });
    await repo.save(instA);

    const instB = makeInstance({ cardId: cardId('shared-card') });
    await repo.save(instB);

    // The index should point to the latest save
    const found = await repo.findByCardId(cardId('shared-card'));
    expect(found?.id).toBe(instB.id);
  });

  it('listByBoard returns instances for a board with cursor pagination', async () => {
    const bid = boardId('board-paginate');
    const instances = Array.from({ length: 5 }, () =>
      makeInstance({ boardId: bid }),
    );

    // Save in order (slight delay to ensure distinct created_at)
    for (const inst of instances) {
      await repo.save(inst);
    }

    const page1 = await repo.listByBoard(bid, undefined, 3);
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await repo.listByBoard(bid, page1.nextCursor, 3);
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeUndefined();

    // No duplicates across pages
    const allIds = [...page1.items, ...page2.items].map((i) => i.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it('listByBoard returns empty page for unknown board', async () => {
    const page = await repo.listByBoard(boardId('no-such-board'));
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeUndefined();
  });

  it('delete removes the instance and cascades to card_instance_index', async () => {
    const inst = makeInstance();
    await repo.save(inst);
    await repo.delete(inst.id);

    const found = await repo.findById(inst.id);
    expect(found).toBeUndefined();

    const byCard = await repo.findByCardId(inst.cardId);
    expect(byCard).toBeUndefined();
  });

  it('findStalledCandidates returns dispatching instances older than cutoff', async () => {
    const pastDate = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    const inst = makeInstance({
      state: {
        status: 'dispatching',
        dispatchId: dispatchId('d-stale'),
        agentId: agentId('agent-stale'),
        dispatchedAt: pastDate.toISOString(),
      },
    });
    await repo.save(inst);

    const cutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    const stalled = await repo.findStalledCandidates(cutoff);
    const ids = stalled.map((i) => i.id);
    expect(ids).toContain(inst.id);
  });

  it('findStalledCandidates returns running instances with old heartbeat', async () => {
    const oldHeartbeat = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const inst = makeInstance({
      state: {
        status: 'running',
        dispatchId: dispatchId('d-run'),
        agentId: agentId('agent-run'),
        dispatchedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
        lastHeartbeatAt: oldHeartbeat,
      },
    });
    await repo.save(inst);

    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    const stalled = await repo.findStalledCandidates(cutoff);
    expect(stalled.map((i) => i.id)).toContain(inst.id);
  });

  it('findStalledCandidates excludes instances with recent heartbeat', async () => {
    const recentHeartbeat = new Date().toISOString();
    const inst = makeInstance({
      state: {
        status: 'running',
        dispatchId: dispatchId('d-fresh'),
        agentId: agentId('agent-fresh'),
        dispatchedAt: new Date(Date.now() - 1000).toISOString(),
        lastHeartbeatAt: recentHeartbeat,
      },
    });
    await repo.save(inst);

    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    const stalled = await repo.findStalledCandidates(cutoff);
    expect(stalled.map((i) => i.id)).not.toContain(inst.id);
  });
});

// ---- Pipeline Event Repository ----

describe.skipIf(!hasDb)('PostgresPipelineEventRepository', () => {
  let pool: Pool;
  let instanceRepo: PostgresPipelineRepository;
  let eventRepo: PostgresPipelineEventRepository;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    instanceRepo = new PostgresPipelineRepository(pool);
    eventRepo = new PostgresPipelineEventRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE pipeline_instances CASCADE');
  });

  it('append and listByInstance round-trip', async () => {
    const inst = makeInstance();
    await instanceRepo.save(inst);

    const record = makeEventRecord(inst.id, 1);
    await eventRepo.append(record);

    const events = await eventRepo.listByInstance(inst.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(record.id);
    expect(events[0]?.sequence).toBe(1);
  });

  it('listByInstance returns events ordered by sequence ascending', async () => {
    const inst = makeInstance();
    await instanceRepo.save(inst);

    const rec3 = makeEventRecord(inst.id, 3);
    const rec1 = makeEventRecord(inst.id, 1);
    const rec2 = makeEventRecord(inst.id, 2);

    await eventRepo.append(rec3);
    await eventRepo.append(rec1);
    await eventRepo.append(rec2);

    const events = await eventRepo.listByInstance(inst.id);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('appendMany inserts all records in a single call', async () => {
    const inst = makeInstance();
    await instanceRepo.save(inst);

    const records = [1, 2, 3, 4].map((seq) => makeEventRecord(inst.id, seq));
    await eventRepo.appendMany(records);

    const events = await eventRepo.listByInstance(inst.id);
    expect(events).toHaveLength(4);
  });

  it('appendMany with empty array is a no-op', async () => {
    await expect(eventRepo.appendMany([])).resolves.not.toThrow();
  });

  it('append with duplicate (instance_id, sequence_number) is silently ignored', async () => {
    const inst = makeInstance();
    await instanceRepo.save(inst);

    const record = makeEventRecord(inst.id, 1);
    await eventRepo.append(record);
    // Second append with same sequence should not throw (ON CONFLICT DO NOTHING)
    await expect(eventRepo.append(record)).resolves.not.toThrow();

    const events = await eventRepo.listByInstance(inst.id);
    expect(events).toHaveLength(1);
  });
});

// ---- Board Config Repository ----

describe.skipIf(!hasDb)('PostgresBoardConfigRepository', () => {
  let pool: Pool;
  let repo: PostgresBoardConfigRepository;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new PostgresBoardConfigRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE board_configs CASCADE');
  });

  it('save and findByBoardId round-trip', async () => {
    const bid = boardId('board-cfg-1');
    const config = makeBoardConfig(bid);
    await repo.save(config);

    const found = await repo.findByBoardId(bid);
    expect(found).toBeDefined();
    expect(found?.boardId).toBe(bid);
    expect(found?.columnMappings).toHaveLength(1);
  });

  it('findByBoardId returns undefined for unknown board', async () => {
    const result = await repo.findByBoardId(boardId('nope'));
    expect(result).toBeUndefined();
  });

  it('save performs upsert — subsequent save replaces existing config', async () => {
    const bid = boardId('board-upsert');
    const config = makeBoardConfig(bid);
    await repo.save(config);

    const updated: PipelineConfig = {
      ...config,
      defaultStallThresholdMs: 600_000,
      autoStartOnAssign: true,
    };
    await repo.save(updated);

    const found = await repo.findByBoardId(bid);
    expect(found?.defaultStallThresholdMs).toBe(600_000);
    expect(found?.autoStartOnAssign).toBe(true);
  });

  it('delete removes the board config', async () => {
    const bid = boardId('board-del');
    await repo.save(makeBoardConfig(bid));
    await repo.delete(bid);

    const found = await repo.findByBoardId(bid);
    expect(found).toBeUndefined();
  });
});

// ---- Deduplication Repository ----

describe.skipIf(!hasDb)('PostgresDeduplicationRepository', () => {
  let pool: Pool;
  let repo: PostgresDeduplicationRepository;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new PostgresDeduplicationRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE webhook_dedup');
  });

  it('isDuplicate returns false for an unseen event', async () => {
    const result = await repo.isDuplicate('evt-fresh-1');
    expect(result).toBe(false);
  });

  it('markProcessed then isDuplicate returns true', async () => {
    await repo.markProcessed('evt-seen-1');
    const result = await repo.isDuplicate('evt-seen-1');
    expect(result).toBe(true);
  });

  it('isDuplicate returns false for expired records', async () => {
    // Mark with 1ms TTL so it expires immediately
    await repo.markProcessed('evt-expired-1', 1);
    // Wait a tick to ensure the DB timestamp has passed
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await repo.isDuplicate('evt-expired-1');
    expect(result).toBe(false);
  });

  it('markProcessed is idempotent — second call updates expiry', async () => {
    await repo.markProcessed('evt-idem-1', 1000);
    await repo.markProcessed('evt-idem-1', 1_000_000);

    const result = await repo.isDuplicate('evt-idem-1');
    expect(result).toBe(true);
  });

  it('purgeExpired deletes expired rows and returns the count', async () => {
    await repo.markProcessed('evt-purge-1', 1);
    await repo.markProcessed('evt-purge-2', 1_000_000);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const count = await repo.purgeExpired();
    expect(count).toBeGreaterThanOrEqual(1);

    // Non-expired row should still be present
    expect(await repo.isDuplicate('evt-purge-2')).toBe(true);
  });
});

// ---- PostgresDatabase transaction ----

describe.skipIf(!hasDb)('PostgresDatabase.transaction', () => {
  let db: PostgresDatabase;
  let pool: Pool;

  beforeAll(() => {
    const created = createDatabase(DATABASE_URL!);
    db = created.db;
    pool = created.pool;
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE pipeline_instances CASCADE');
  });

  it('commits both writes atomically on success', async () => {
    const inst = makeInstance();
    const evt = makeEventRecord(inst.id, 1);

    await db.transaction(async (uow) => {
      await uow.pipelines.save(inst);
      await uow.pipelineEvents.append(evt);
    });

    const found = await db.pipelines.findById(inst.id);
    expect(found?.id).toBe(inst.id);

    const events = await db.pipelineEvents.listByInstance(inst.id);
    expect(events).toHaveLength(1);
  });

  it('rolls back all writes when the callback throws', async () => {
    const inst = makeInstance();

    await expect(
      db.transaction(async (uow) => {
        await uow.pipelines.save(inst);
        throw new Error('simulated failure');
      }),
    ).rejects.toThrow('simulated failure');

    const found = await db.pipelines.findById(inst.id);
    expect(found).toBeUndefined();
  });

  it('ping resolves without error when DB is reachable', async () => {
    await expect(db.ping()).resolves.not.toThrow();
  });
});
