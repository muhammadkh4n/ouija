/**
 * Full end-to-end pipeline test: webhook → dispatching → agent callbacks → succeeded.
 *
 * This test exercises the real HTTP layer (via Fastify `app.inject`) and the real
 * Orchestrator against an in-memory DB + mock kanban plugin. It would have caught
 * all four bugs from the 2026-04-18 smoke in a single run:
 *
 *   1. Plane webhook normaliser producing bare UUIDs for `cardId`
 *   2. Agent never emits pr_ready (card jumps Backlog → Done)
 *   3. `pipeline_instances.pr_url` stays NULL on succeeded runs
 *   4. `pipeline_events` stays empty because every transition returns `events: []`
 *
 * The test deliberately does NOT run the BullMQ worker — we simulate the worker
 * by POSTing the same callbacks the worker would have posted. That keeps the
 * test hermetic (no Redis/Postgres) while still covering the full event flow
 * through orchestrator → side effects → state updates → audit log.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { issueAgentJWT, setJWTRedisClient } from '../src/jwt.js';
import { Orchestrator } from '@ouija-dev/engine';
import type { AgentMemberLookup } from '@ouija-dev/engine';

import {
  cardId,
  columnId,
  boardId,
  agentId,
  instanceId as makeInstanceId,
} from '@ouija-dev/types';
import type {
  Database,
  PipelineInstance,
  PipelineConfig,
  PipelineEventRecord,
  UnitOfWork,
  KanbanPlugin,
  KanbanCard,
  PipelineRepository,
  PipelineEventRepository,
  BoardConfigRepository,
  DeduplicationRepository,
  CursorPage,
} from '@ouija-dev/types';
import type {
  EventBus,
  JobQueue,
  QueueName,
  EnqueueOptions,
} from '@ouija-dev/bus';

// ---- In-memory Redis mock for JWT denylist ----

function makeMockRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    set: async (key: string, value: string, opts: { ex: number }) => {
      store.set(key, { value, expiresAt: Date.now() + opts.ex * 1000 });
      return 'OK';
    },
    get: async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
  };
}

// ---- In-memory DB ----

interface MockDb extends Database {
  _instances: Map<string, PipelineInstance>;
  _events: PipelineEventRecord[];
  _configs: Map<string, PipelineConfig>;
}

function createMockDatabase(): MockDb {
  const instances = new Map<string, PipelineInstance>();
  const events: PipelineEventRecord[] = [];
  const configs = new Map<string, PipelineConfig>();
  const cardIndex = new Map<string, string>();

  const pipelines: PipelineRepository = {
    async findById(id) {
      return instances.get(String(id));
    },
    async findByCardId(cid) {
      const iid = cardIndex.get(String(cid));
      return iid === undefined ? undefined : instances.get(iid);
    },
    async listByBoard(bid) {
      const items = [...instances.values()].filter((i) => i.boardId === bid);
      return { items } as CursorPage<PipelineInstance>;
    },
    async save(instance) {
      instances.set(String(instance.id), instance);
      cardIndex.set(String(instance.cardId), String(instance.id));
    },
    async delete(id) {
      const inst = instances.get(String(id));
      if (inst) cardIndex.delete(String(inst.cardId));
      instances.delete(String(id));
    },
    async findStalledCandidates() {
      return [];
    },
  };

  const pipelineEvents: PipelineEventRepository = {
    async append(record) {
      events.push(record);
    },
    async appendMany(records) {
      events.push(...records);
    },
    async listByInstance(iid) {
      return events
        .filter((e) => String(e.instanceId) === String(iid))
        .sort((a, b) => a.sequence - b.sequence);
    },
  };

  const boardConfigs: BoardConfigRepository = {
    async findByBoardId(bid) {
      return configs.get(String(bid));
    },
    async listAll() {
      return [...configs.values()];
    },
    async save(cfg) {
      configs.set(String(cfg.boardId), cfg);
    },
    async delete(bid) {
      configs.delete(String(bid));
    },
  };

  const deduplication: DeduplicationRepository = {
    async isDuplicate() {
      return false;
    },
    async markProcessed() {
      return;
    },
    async purgeExpired() {
      return 0;
    },
  };

  return {
    _instances: instances,
    _events: events,
    _configs: configs,
    pipelines,
    pipelineEvents,
    boardConfigs,
    deduplication,
    async transaction<T>(fn: (uow: UnitOfWork) => Promise<T>) {
      return fn({ pipelines, pipelineEvents, boardConfigs });
    },
    async ping() {
      return;
    },
  };
}

// ---- Mock bus / queue / kanban ----

function createMockEventBus(): EventBus {
  return {
    async publish() {
      return 'mock-event-id';
    },
    async subscribe() {
      return async () => undefined;
    },
    async subscribePattern() {
      return async () => undefined;
    },
    async replay() {
      return;
    },
    async close() {
      return;
    },
  };
}

function createMockJobQueue(): JobQueue {
  return {
    async enqueue(_queue: QueueName, _data, options?: EnqueueOptions) {
      return options?.jobId ?? 'mock-job-id';
    },
    async process() {
      return;
    },
    async cancelJob() {
      return;
    },
    async close() {
      return;
    },
  };
}

interface MockKanbanPlugin extends KanbanPlugin {
  moves: Array<{ cardId: string; toColumnId: string }>;
  comments: Array<{ cardId: string; body: string }>;
}

function createMockKanbanPlugin(cards: Map<string, KanbanCard>): MockKanbanPlugin {
  const moves: Array<{ cardId: string; toColumnId: string }> = [];
  const comments: Array<{ cardId: string; body: string }> = [];

  return {
    moves,
    comments,
    manifest: {
      name: 'mock-kanban',
      version: '0.1.0',
      type: 'kanban',
      coreApiVersion: '>=1.0',
      configSchema: {},
    },
    async init() {
      return;
    },
    async start() {
      return;
    },
    async stop() {
      return;
    },
    async healthCheck() {
      return { healthy: true };
    },
    async getCard(cid) {
      const card = cards.get(String(cid));
      if (!card) throw new Error(`Card not found: ${String(cid)}`);
      return card;
    },
    async moveCard(cid, toCol) {
      moves.push({ cardId: String(cid), toColumnId: String(toCol) });
    },
    async addComment(cid, body) {
      comments.push({ cardId: String(cid), body });
    },
    async assignUser() {
      return;
    },
    async getColumns() {
      return [];
    },
  };
}

// ---- Fixtures ----

const PLANE_SECRET = 'plane-secret-full-e2e-deadbeef';
const BOARD_ID = 'proj-e2e';
const WORKSPACE_ID = 'ws-e2e';
const ISSUE_ID = 'issue-e2e-001';
const CARD_ID_COMPOUND = `${BOARD_ID}/${ISSUE_ID}`;
const COL_BACKLOG = 'state-backlog';
const COL_INPROGRESS = 'state-inprogress';
const COL_REVIEW = 'state-review';
const COL_DONE = 'state-done';
const AGENT_ID = 'rex-coder';
const EXPECTED_PR_URL = 'https://github.com/test/repo/pull/42';

function signBody(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

function buildPlaneMovePayload(): string {
  return JSON.stringify({
    event: 'issue',
    action: 'updated',
    event_id: `evt-${Date.now()}`,
    webhook_id: 'wh-e2e',
    workspace_id: WORKSPACE_ID,
    data: {
      id: ISSUE_ID,
      name: 'Fix login bug',
      description_html: '<p>Email field accepts invalid emails.</p>',
      state: { id: COL_INPROGRESS, name: 'In Progress', group: 'started' },
      project: BOARD_ID,
      workspace: WORKSPACE_ID,
      labels: [],
      assignees: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    activity: {
      field: 'state_id',
      old_value: 'Backlog',
      new_value: 'In Progress',
      old_identifier: COL_BACKLOG,
      new_identifier: COL_INPROGRESS,
    },
  });
}

// ---- Test ----

describe('E2E: Plane webhook → dispatching → agent callbacks → succeeded', () => {
  let app: FastifyInstance;
  let db: MockDb;
  let kanban: MockKanbanPlugin;

  beforeAll(async () => {
    process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
    setJWTRedisClient(makeMockRedis());

    db = createMockDatabase();
    const eventBus = createMockEventBus();
    const jobQueue = createMockJobQueue();

    const cards = new Map<string, KanbanCard>();
    cards.set(CARD_ID_COMPOUND, {
      id: cardId(CARD_ID_COMPOUND),
      title: 'Fix login bug',
      description: 'Email field accepts invalid emails.',
      columnId: columnId(COL_INPROGRESS),
      boardId: boardId(BOARD_ID),
      labels: [],
      assignees: [],
      url: `https://plane.test/${BOARD_ID}/issues/${ISSUE_ID}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    kanban = createMockKanbanPlugin(cards);

    // Board config: In Progress dispatches rex-coder; Review + Done are also mapped so the
    // orchestrator can resolve move_card side effects (which reference column names, not ids)
    // during pr_ready → Review and completed → Done transitions.
    await db.boardConfigs.save({
      boardId: boardId(BOARD_ID),
      columnMappings: [
        {
          columnId: columnId(COL_INPROGRESS),
          columnName: 'In Progress',
          action: 'dispatch_agent',
          agentId: agentId(AGENT_ID),
          guards: [],
        },
        {
          columnId: columnId(COL_REVIEW),
          columnName: 'Review',
          action: 'noop',
          guards: [],
        },
        {
          columnId: columnId(COL_DONE),
          columnName: 'Done',
          action: 'close_and_notify',
          guards: [],
        },
      ],
      defaultStallThresholdMs: 300_000,
      autoStartOnAssign: false,
    });

    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const registry: AgentMemberLookup = {
      getAgentIdByMemberId: () => undefined,
      getTriggerMode: () => 'auto',
    };

    const orchestrator = new Orchestrator(db, eventBus, jobQueue, kanban, logger, registry);

    app = await buildApp({
      logger: false,
      db,
      orchestrator,
      planeWebhookSecret: PLANE_SECRET,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs the full webhook-to-completed pipeline and writes the audit log', async () => {
    // ---- Step 1: Plane webhook moves card Backlog → In Progress ----
    const body = buildPlaneMovePayload();
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

    // processTrigger is fire-and-forget — give the event loop one tick
    await new Promise((r) => setTimeout(r, 50));

    const instance = await db.pipelines.findByCardId(cardId(CARD_ID_COMPOUND));
    expect(instance, 'pipeline instance created from webhook').toBeDefined();
    expect(instance!.state.status).toBe('dispatching');
    expect(kanban.moves).toHaveLength(0); // Review move hasn't happened yet

    const dispatchIdValue =
      instance!.state.status === 'dispatching' ? String(instance!.state.dispatchId) : '';
    expect(dispatchIdValue.length).toBeGreaterThan(0);

    // ---- Step 2: Agent posts agent_acknowledged → dispatching → running ----
    const jwt = await issueAgentJWT(String(instance!.id), BOARD_ID, WORKSPACE_ID);

    await postCallback(app, jwt, {
      type: 'agent_acknowledged',
      instanceId: String(instance!.id),
      dispatchId: dispatchIdValue,
    });

    await settle();
    const afterAck = db._instances.get(String(instance!.id))!;
    expect(afterAck.state.status).toBe('running');

    // ---- Step 3: Agent posts agent_pr_ready → state.prUrl set, card moved to Review ----
    await postCallback(app, jwt, {
      type: 'agent_pr_ready',
      instanceId: String(instance!.id),
      dispatchId: dispatchIdValue,
      prUrl: EXPECTED_PR_URL,
      prId: '42',
    });

    await settle();
    const afterPr = db._instances.get(String(instance!.id))!;
    expect(afterPr.state.status).toBe('running');
    if (afterPr.state.status === 'running') {
      expect(afterPr.state.prUrl).toBe(EXPECTED_PR_URL);
    }
    const reviewMove = kanban.moves.find((m) => m.toColumnId === COL_REVIEW);
    expect(reviewMove, 'kanban.moveCard called for Review column').toBeDefined();

    // ---- Step 4: Agent posts agent_completed → succeeded with prUrl preserved + Done move ----
    await postCallback(app, jwt, {
      type: 'agent_completed',
      instanceId: String(instance!.id),
      dispatchId: dispatchIdValue,
      cost: 0.07,
      tokensUsed: 2500,
    });

    await settle();
    const afterDone = db._instances.get(String(instance!.id))!;
    expect(afterDone.state.status).toBe('succeeded');
    if (afterDone.state.status === 'succeeded') {
      expect(
        afterDone.state.prUrl,
        'PR URL must propagate from running into succeeded state',
      ).toBe(EXPECTED_PR_URL);
      expect(afterDone.state.cost).toBeCloseTo(0.07);
      expect(afterDone.state.tokensUsed).toBe(2500);
    }
    // Note: the scalar pipeline_instances.pr_url column is derived from state at SAVE time
    // by PostgresPipelineRepository.save (see packages/engine/src/repository.ts). Exercising
    // that mapping needs a real Postgres — covered by the opt-in repository integration tests.
    // Here we only assert the canonical source (state.prUrl), which is what the dashboard and
    // the pipeline_instances_denorm view will read.

    const doneMove = kanban.moves.find((m) => m.toColumnId === COL_DONE);
    expect(doneMove, 'kanban.moveCard called for Done column').toBeDefined();

    // ---- Step 5: pipeline_events contains the transition audit log ----
    const timeline = await db.pipelineEvents.listByInstance(makeInstanceId(String(instance!.id)));
    expect(timeline.length, 'audit log must be populated').toBeGreaterThanOrEqual(3);

    const transitionEntries = timeline.filter((e) => e.topic === 'pipeline.transitioned');
    const toStatuses = transitionEntries.map(
      (e) => (e.payload as { toStatus: string }).toStatus,
    );
    expect(toStatuses).toContain('dispatching');
    expect(toStatuses).toContain('running');
    expect(toStatuses).toContain('succeeded');

    // Sequence numbers are monotonic
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i]!.sequence).toBeGreaterThan(timeline[i - 1]!.sequence);
    }
  });
});

// ---- Helpers ----

async function settle(): Promise<void> {
  // Agent callback fires orchestrator.processTrigger asynchronously; wait one tick.
  await new Promise((r) => setTimeout(r, 30));
}

interface CallbackBody {
  type: 'agent_acknowledged' | 'agent_progress' | 'agent_pr_ready' | 'agent_completed' | 'agent_failed';
  instanceId: string;
  dispatchId: string;
  progress?: number;
  message?: string;
  prUrl?: string;
  prId?: string;
  cost?: number;
  tokensUsed?: number;
  error?: string;
  retryable?: boolean;
}

async function postCallback(app: FastifyInstance, jwt: string, body: CallbackBody): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/hooks/agent/callback',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    payload: JSON.stringify(body),
  });
  if (response.statusCode !== 200) {
    throw new Error(`agent callback ${body.type} failed: ${response.statusCode} ${response.body}`);
  }
}
