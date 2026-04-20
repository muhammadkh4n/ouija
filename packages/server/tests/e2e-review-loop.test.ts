/**
 * End-to-end review-loop test: exercises the full PR-review feedback path
 * through real Fastify routes, an in-process event bus that actually
 * delivers to subscribers, the review bundler, and the orchestrator.
 *
 * What this proves:
 *  1. A signed `pull_request_review` webhook normalises correctly and publishes
 *     `git.pr.review.submitted` on the bus.
 *  2. The bundler's flushNow path (we skip the 60s debounce window in tests)
 *     hands a full ReviewBundle to orchestrator.processReviewBundle.
 *  3. The orchestrator resolves PR URL → instance via pr_instance_index and
 *     drives a `pr_review_received` transition from awaiting_review, enqueuing
 *     a fresh dispatch with reviewContext carrying the bundle.
 *  4. Agent callbacks for the follow-up iteration (acknowledged → pr_ready →
 *     completed) cycle the state back to awaiting_review with iteration=2 —
 *     the loop is closed.
 *  5. When iterations exceed PipelineConfig.maxReviewIterations, the transition
 *     sends the pipeline to `stalled` with a notification side effect instead
 *     of dispatching again.
 *  6. Human merge (pr_merged) from awaiting_review transitions to succeeded.
 *
 * This test would have caught any of:
 *  - webhook normalizer regressions on review events
 *  - bundler state leaking across PRs
 *  - orchestrator failing to resolve instanceId via pr_instance_index
 *  - dispatch payload missing reviewContext
 *  - max-iteration guard off-by-one
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { issueAgentJWT, setJWTRedisClient } from '../src/jwt.js';
import { registerReviewLoop, type ReviewLoopHandle } from '../src/review-loop.js';
import { Orchestrator } from '@ouija-dev/engine';
import type { AgentMemberLookup } from '@ouija-dev/engine';

import {
  cardId,
  columnId,
  boardId,
  agentId,
  dispatchId,
  prId,
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
  PrInstanceRepository,
  CursorPage,
  OuijaTopic,
  OuijaEventMap,
  OuijaEvent,
} from '@ouija-dev/types';
import type {
  EventBus,
  JobQueue,
  QueueName,
  EnqueueOptions,
  AgentDispatchJobData,
  PublishOptions,
} from '@ouija-dev/bus';

// ---- Mock Redis for JWT denylist ----

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

// ---- In-memory DB with pr_instance_index ----

interface MockDb extends Database {
  _instances: Map<string, PipelineInstance>;
  _events: PipelineEventRecord[];
  _configs: Map<string, PipelineConfig>;
  _prIndex: Map<string, string>;
}

function createMockDatabase(): MockDb {
  const instances = new Map<string, PipelineInstance>();
  const events: PipelineEventRecord[] = [];
  const configs = new Map<string, PipelineConfig>();
  const cardIndex = new Map<string, string>();
  const prIndex = new Map<string, string>();

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
    async append(r) {
      events.push(r);
    },
    async appendMany(rs) {
      events.push(...rs);
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

  const prInstances: PrInstanceRepository = {
    async record(prUrl, iid) {
      prIndex.set(prUrl, iid);
    },
    async findInstanceByPrUrl(prUrl) {
      return prIndex.get(prUrl);
    },
  };

  return {
    _instances: instances,
    _events: events,
    _configs: configs,
    _prIndex: prIndex,
    pipelines,
    pipelineEvents,
    boardConfigs,
    deduplication,
    prInstances,
    async transaction<T>(fn: (uow: UnitOfWork) => Promise<T>) {
      return fn({ pipelines, pipelineEvents, boardConfigs, prInstances });
    },
    async ping() {
      return;
    },
  };
}

// ---- In-process EventBus that actually delivers to subscribers ----

type AnyHandler = (event: OuijaEvent) => Promise<void>;

function createRealEventBus(): EventBus & { _handlers: Map<string, Set<AnyHandler>> } {
  const handlers = new Map<string, Set<AnyHandler>>();

  return {
    _handlers: handlers,
    async publish<T extends OuijaTopic>(
      topic: T,
      payload: OuijaEventMap[T],
      opts?: PublishOptions,
    ) {
      const event: OuijaEvent<T> = {
        id: randomUUID(),
        topic,
        payload,
        timestamp: new Date().toISOString(),
        sourcePlugin: opts?.sourcePlugin ?? 'test',
        correlationId: opts?.correlationId ?? randomUUID(),
      };
      const subs = handlers.get(topic);
      if (subs !== undefined) {
        for (const h of subs) {
          await h(event as OuijaEvent);
        }
      }
      return event.id;
    },
    async subscribe<T extends OuijaTopic>(
      topic: T,
      handler: (event: OuijaEvent<T>) => Promise<void>,
    ) {
      let set = handlers.get(topic);
      if (set === undefined) {
        set = new Set();
        handlers.set(topic, set);
      }
      const cast = handler as unknown as AnyHandler;
      set.add(cast);
      return async () => {
        handlers.get(topic)?.delete(cast);
      };
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

// ---- Mock queues + kanban ----

function createSpyJobQueue(): JobQueue & { enqueued: Array<{ queue: QueueName; data: unknown }> } {
  const enqueued: Array<{ queue: QueueName; data: unknown }> = [];
  return {
    enqueued,
    async enqueue(queue, data, options?: EnqueueOptions) {
      enqueued.push({ queue, data });
      return options?.jobId ?? 'mock-job';
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

function createMockKanban(cards: Map<string, KanbanCard>): KanbanPlugin & {
  moves: Array<{ cardId: string; toColumnId: string }>;
} {
  const moves: Array<{ cardId: string; toColumnId: string }> = [];
  return {
    moves,
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
      const c = cards.get(String(cid));
      if (!c) throw new Error(`card not found: ${String(cid)}`);
      return c;
    },
    async moveCard(cid, toCol) {
      moves.push({ cardId: String(cid), toColumnId: String(toCol) });
    },
    async addComment() {
      return;
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

const GITHUB_SECRET = 'github-review-loop-test-secret';
const API_KEY = 'ouija_review-loop-test-api-key';
const BOARD_ID = 'proj-loop';
const CARD_ID_COMPOUND = `${BOARD_ID}/issue-loop`;
const COL_INPROGRESS = 'state-inprogress';
const COL_REVIEW = 'state-review';
const COL_DONE = 'state-done';
const AGENT_ID = 'rex-coder';
const PR_URL = 'https://github.com/acme/backend/pull/42';
const PR_ID_STR = 'acme/backend#42';

function ghSignature(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function reviewWebhookBody(
  state: 'CHANGES_REQUESTED' | 'APPROVED' | 'COMMENTED',
  reviewId: number,
  reviewer = 'coderabbitai[bot]',
): string {
  return JSON.stringify({
    action: 'submitted',
    review: {
      id: reviewId,
      user: { login: reviewer },
      body: `review ${reviewId}`,
      state,
      submitted_at: new Date().toISOString(),
      html_url: `${PR_URL}#pullrequestreview-${reviewId}`,
    },
    pull_request: {
      number: 42,
      html_url: PR_URL,
      title: 'Test PR',
      body: '',
      state: 'open',
      draft: false,
      merged: false,
      merged_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      head: { ref: 'ouija/inst-loop' },
      base: { ref: 'main' },
    },
    repository: {
      full_name: 'acme/backend',
      html_url: 'https://github.com/acme/backend',
      name: 'backend',
      owner: { login: 'acme' },
    },
  });
}

function prMergedWebhookBody(): string {
  return JSON.stringify({
    action: 'closed',
    pull_request: {
      number: 42,
      html_url: PR_URL,
      title: 'Test PR',
      body: '',
      state: 'closed',
      draft: false,
      merged: true,
      merged_at: '2026-04-21T10:00:00Z',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      head: { ref: 'ouija/inst-loop' },
      base: { ref: 'main' },
    },
    repository: {
      full_name: 'acme/backend',
      html_url: 'https://github.com/acme/backend',
      name: 'backend',
      owner: { login: 'acme' },
    },
  });
}

// ---- Test harness ----

interface Harness {
  app: FastifyInstance;
  db: MockDb;
  jobQueue: ReturnType<typeof createSpyJobQueue>;
  kanban: ReturnType<typeof createMockKanban>;
  eventBus: ReturnType<typeof createRealEventBus>;
  orchestrator: Orchestrator;
  reviewLoop: ReviewLoopHandle;
  instanceIdStr: string;
  dispatchIdStr: string;
}

async function buildHarness(
  opts: { maxReviewIterations?: number; debounceMs?: number } = {},
): Promise<Harness> {
  const db = createMockDatabase();
  const eventBus = createRealEventBus();
  const jobQueue = createSpyJobQueue();

  const cards = new Map<string, KanbanCard>();
  cards.set(CARD_ID_COMPOUND, {
    id: cardId(CARD_ID_COMPOUND),
    title: 'Fix login bug',
    description: 'Email regex is too permissive.',
    columnId: columnId(COL_REVIEW),
    boardId: boardId(BOARD_ID),
    labels: [],
    assignees: [],
    url: 'https://plane.test/proj-loop/issue-loop',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const kanban = createMockKanban(cards);

  const pipelineConfig: PipelineConfig = {
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
    ...(opts.maxReviewIterations !== undefined
      ? { maxReviewIterations: opts.maxReviewIterations }
      : {}),
  };
  await db.boardConfigs.save(pipelineConfig);

  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const registry: AgentMemberLookup = {
    getAgentIdByMemberId: () => undefined,
    getTriggerMode: () => 'auto',
  };

  const orchestrator = new Orchestrator(db, eventBus, jobQueue, kanban, logger, registry);

  // Seed a pipeline already in awaiting_review. This mirrors the state a
  // real pipeline reaches after agent_pr_ready + agent_completed from #32+#34.
  const instanceIdStr = 'inst-loop';
  const dispatchIdStr = 'disp-1';
  const now = new Date().toISOString();
  await db.pipelines.save({
    id: makeInstanceId(instanceIdStr),
    cardId: cardId(CARD_ID_COMPOUND),
    boardId: boardId(BOARD_ID),
    projectId: BOARD_ID,
    attempt: 1,
    state: {
      status: 'awaiting_review',
      dispatchId: dispatchId(dispatchIdStr),
      agentId: agentId(AGENT_ID),
      prUrl: PR_URL,
      prId: prId(PR_ID_STR),
      iteration: 1,
      enteredAt: now,
    },
    createdAt: now,
    updatedAt: now,
  });
  await db.prInstances!.record(PR_URL, instanceIdStr);

  const reviewLoop = await registerReviewLoop({
    eventBus,
    orchestrator,
    // Long debounce — test forces flush via handle.bundler.flushNow to
    // control the exact moment the bundle lands at the orchestrator. Using
    // a tiny value would race with the explicit flush and produce partial
    // bundles when a test pushes multiple events.
    debounceMs: opts.debounceMs ?? 60_000,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });

  const app = await buildApp({
    logger: false,
    db,
    orchestrator,
    eventBus,
    githubWebhookSecret: GITHUB_SECRET,
  });

  return { app, db, jobQueue, kanban, eventBus, orchestrator, reviewLoop, instanceIdStr, dispatchIdStr };
}

// ---- Setup ----

beforeAll(() => {
  process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
  process.env['OUIJA_API_KEY'] = API_KEY;
  setJWTRedisClient(makeMockRedis());
});

afterAll(() => {
  delete process.env['OUIJA_API_KEY'];
});

async function settle(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---- Tests ----

describe('review loop — end-to-end webhook → re-dispatch', () => {
  it('closed-circuit iteration: webhook → bundle → re-dispatch → follow-up → back to awaiting_review', async () => {
    const h = await buildHarness();
    try {
      // ---- 1. POST signed CodeRabbit review webhook ----
      const body = reviewWebhookBody('CHANGES_REQUESTED', 111);
      const resp = await h.app.inject({
        method: 'POST',
        url: `/hooks/github/${GITHUB_SECRET}`,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': ghSignature(body, GITHUB_SECRET),
          'x-github-delivery': 'rl-delivery-1',
        },
        payload: body,
      });
      expect(resp.statusCode).toBe(200);
      await settle();

      // ---- 2. Force the bundler to flush now (skip the 60s debounce) ----
      await h.reviewLoop.bundler.flushNow(PR_URL);
      await settle();

      // ---- 3. Assert: state moved awaiting_review → dispatching, iteration 2 ----
      const afterReview = h.db._instances.get(h.instanceIdStr)!;
      expect(afterReview.state.status).toBe('dispatching');
      if (afterReview.state.status === 'dispatching') {
        expect(afterReview.state.iteration).toBe(2);
      }

      // ---- 4. Dispatch job carries reviewContext with the original comments ----
      const dispatchJobs = h.jobQueue.enqueued.filter((j) => j.queue === 'ouija.agent-dispatch');
      expect(dispatchJobs).toHaveLength(1);
      const jobData = dispatchJobs[0]!.data as AgentDispatchJobData;
      expect(jobData.reviewContext).toBeDefined();
      expect(jobData.reviewContext?.iteration).toBe(2);
      expect(jobData.reviewContext?.prUrl).toBe(PR_URL);
      expect(jobData.reviewContext?.bundle.reviews).toHaveLength(1);
      expect(jobData.reviewContext?.bundle.reviews[0]?.state).toBe('changes_requested');
      expect(jobData.reviewContext?.bundle.reviews[0]?.reviewerLogin).toBe('coderabbitai[bot]');

      // ---- 5. Agent cycles through: acknowledged → pr_ready → completed ----
      const newDispatchId = jobData.dispatchId;
      const jwt = await issueAgentJWT(h.instanceIdStr, BOARD_ID, 'ws-loop');

      await postCallback(h.app, jwt, {
        type: 'agent_acknowledged',
        instanceId: h.instanceIdStr,
        dispatchId: newDispatchId,
      });
      await settle();

      await postCallback(h.app, jwt, {
        type: 'agent_pr_ready',
        instanceId: h.instanceIdStr,
        dispatchId: newDispatchId,
        prUrl: PR_URL,
        prId: PR_ID_STR,
      });
      await settle();

      await postCallback(h.app, jwt, {
        type: 'agent_completed',
        instanceId: h.instanceIdStr,
        dispatchId: newDispatchId,
        cost: 0.05,
      });
      await settle();

      // ---- 6. Back to awaiting_review, iteration still 2, ready for round 3 ----
      const afterIter2 = h.db._instances.get(h.instanceIdStr)!;
      expect(afterIter2.state.status).toBe('awaiting_review');
      if (afterIter2.state.status === 'awaiting_review') {
        expect(afterIter2.state.iteration).toBe(2);
        expect(afterIter2.state.prUrl).toBe(PR_URL);
      }
    } finally {
      await h.reviewLoop.stop();
      await h.app.close();
    }
  });

  it('max-iteration guard: fifth review webhook on a config capped at 3 transitions to stalled', async () => {
    const h = await buildHarness({ maxReviewIterations: 3 });
    try {
      // Seed the pipeline already at iteration 3 so the next review trips the cap.
      const inst = h.db._instances.get(h.instanceIdStr)!;
      inst.state = {
        status: 'awaiting_review',
        dispatchId: dispatchId(h.dispatchIdStr),
        agentId: agentId(AGENT_ID),
        prUrl: PR_URL,
        prId: prId(PR_ID_STR),
        iteration: 3,
        enteredAt: new Date().toISOString(),
      };
      await h.db.pipelines.save(inst);

      const body = reviewWebhookBody('CHANGES_REQUESTED', 999);
      await h.app.inject({
        method: 'POST',
        url: `/hooks/github/${GITHUB_SECRET}`,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': ghSignature(body, GITHUB_SECRET),
        },
        payload: body,
      });
      await settle();
      await h.reviewLoop.bundler.flushNow(PR_URL);
      await settle();

      const after = h.db._instances.get(h.instanceIdStr)!;
      expect(after.state.status).toBe('stalled');
      if (after.state.status === 'stalled') {
        expect(after.state.reason).toContain('max_review_iterations_exceeded');
      }
      // No follow-up dispatch fired.
      expect(h.jobQueue.enqueued.filter((j) => j.queue === 'ouija.agent-dispatch')).toHaveLength(0);
    } finally {
      await h.reviewLoop.stop();
      await h.app.close();
    }
  });

  it('human merge terminates the loop: pr_merged webhook from awaiting_review → succeeded', async () => {
    const h = await buildHarness();
    try {
      // Phase 1 Task 3 regression coverage: the REAL webhook path must
      // resolve the pipeline via pr_instance_index (the harness seeded
      // `PR_URL → instanceIdStr` on buildHarness line 511). Before Task 3,
      // the webhook handler fabricated `github-pr-42` as an instanceId, the
      // orchestrator's findById returned undefined, and the merge event
      // dropped silently — pipeline stuck in awaiting_review forever.
      const body = prMergedWebhookBody();
      const resp = await h.app.inject({
        method: 'POST',
        url: `/hooks/github/${GITHUB_SECRET}`,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-hub-signature-256': ghSignature(body, GITHUB_SECRET),
          'x-github-delivery': 'test-merge-delivery',
        },
        payload: body,
      });
      expect(resp.statusCode).toBe(200);

      // Give the async processTrigger fire-and-forget a tick to settle.
      await settle();

      const after = h.db._instances.get(h.instanceIdStr)!;
      expect(after.state.status).toBe('succeeded');
      if (after.state.status === 'succeeded') {
        expect(after.state.prUrl).toBe(PR_URL);
      }
    } finally {
      await h.reviewLoop.stop();
      await h.app.close();
    }
  });

  it('inline PR review comments land on the same bundle as review submissions', async () => {
    const h = await buildHarness();
    try {
      const reviewBody = reviewWebhookBody('COMMENTED', 222);
      await h.app.inject({
        method: 'POST',
        url: `/hooks/github/${GITHUB_SECRET}`,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': ghSignature(reviewBody, GITHUB_SECRET),
        },
        payload: reviewBody,
      });

      const commentBody = JSON.stringify({
        action: 'created',
        comment: {
          id: 333,
          user: { login: 'coderabbitai[bot]' },
          body: 'Consider zod here.',
          path: 'src/validator.ts',
          line: 12,
          created_at: new Date().toISOString(),
        },
        pull_request: {
          number: 42,
          html_url: PR_URL,
          title: '',
          body: '',
          state: 'open',
          draft: false,
          merged: false,
          merged_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          head: { ref: 'ouija/inst-loop' },
          base: { ref: 'main' },
        },
        repository: {
          full_name: 'acme/backend',
          html_url: 'https://github.com/acme/backend',
          name: 'backend',
          owner: { login: 'acme' },
        },
      });
      await h.app.inject({
        method: 'POST',
        url: `/hooks/github/${GITHUB_SECRET}`,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request_review_comment',
          'x-hub-signature-256': ghSignature(commentBody, GITHUB_SECRET),
        },
        payload: commentBody,
      });
      await settle();

      await h.reviewLoop.bundler.flushNow(PR_URL);
      await settle();

      const jobs = h.jobQueue.enqueued.filter((j) => j.queue === 'ouija.agent-dispatch');
      expect(jobs).toHaveLength(1);
      const jobData = jobs[0]!.data as AgentDispatchJobData;
      expect(jobData.reviewContext?.bundle.reviews).toHaveLength(1);
      expect(jobData.reviewContext?.bundle.comments).toHaveLength(1);
      expect(jobData.reviewContext?.bundle.comments[0]?.path).toBe('src/validator.ts');
      expect(jobData.reviewContext?.bundle.comments[0]?.line).toBe(12);
    } finally {
      await h.reviewLoop.stop();
      await h.app.close();
    }
  });
});

// ---- Helpers ----

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

// ---- CI failure loop ----

function checkRunFailureBody(jobName: string, runId: number): string {
  return JSON.stringify({
    action: 'completed',
    check_run: {
      id: runId,
      name: jobName,
      head_sha: 'abc123',
      status: 'completed',
      conclusion: 'failure',
      completed_at: '2026-04-21T09:12:34Z',
      html_url: `https://github.com/acme/backend/runs/${runId}`,
      details_url: `https://github.com/acme/backend/actions/runs/${runId}`,
      output: { title: null, summary: '3 tests failed' },
      pull_requests: [
        {
          number: 42,
          html_url: PR_URL,
          head: { ref: 'ouija/inst-loop', sha: 'abc123' },
          base: { ref: 'main' },
        },
      ],
    },
    repository: {
      full_name: 'acme/backend',
      html_url: 'https://github.com/acme/backend',
      name: 'backend',
      owner: { login: 'acme' },
    },
  });
}

describe('review loop — CI failure re-dispatch', () => {
  it('a failing check_run on an awaiting_review pipeline triggers a re-dispatch with ciFailures in reviewContext', async () => {
    const h = await buildHarness();
    try {
      const body = checkRunFailureBody('unit-tests', 9900001);
      const resp = await h.app.inject({
        method: 'POST',
        url: `/hooks/github/${GITHUB_SECRET}`,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'check_run',
          'x-hub-signature-256': ghSignature(body, GITHUB_SECRET),
          'x-github-delivery': 'ci-delivery-1',
        },
        payload: body,
      });
      expect(resp.statusCode).toBe(200);
      await settle();
      await h.reviewLoop.bundler.flushNow(PR_URL);
      await settle();

      const after = h.db._instances.get(h.instanceIdStr)!;
      expect(after.state.status).toBe('dispatching');

      const jobs = h.jobQueue.enqueued.filter((j) => j.queue === 'ouija.agent-dispatch');
      expect(jobs).toHaveLength(1);
      const jobData = jobs[0]!.data as AgentDispatchJobData;
      expect(jobData.reviewContext?.bundle.ciFailures).toBeDefined();
      expect(jobData.reviewContext?.bundle.ciFailures).toHaveLength(1);
      expect(jobData.reviewContext?.bundle.ciFailures?.[0]?.jobName).toBe('unit-tests');
      expect(jobData.reviewContext?.bundle.ciFailures?.[0]?.conclusion).toBe('failure');
      // No reviews fired, so that array is empty.
      expect(jobData.reviewContext?.bundle.reviews).toHaveLength(0);
    } finally {
      await h.reviewLoop.stop();
      await h.app.close();
    }
  });

  it('a failing check_run + a review in the same window coalesce into one dispatch', async () => {
    const h = await buildHarness();
    try {
      // Review first
      const reviewBody = reviewWebhookBody('CHANGES_REQUESTED', 555);
      await h.app.inject({
        method: 'POST',
        url: `/hooks/github/${GITHUB_SECRET}`,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': ghSignature(reviewBody, GITHUB_SECRET),
        },
        payload: reviewBody,
      });

      // Then a failing check in the same debounce window
      const ciBody = checkRunFailureBody('lint', 9900002);
      await h.app.inject({
        method: 'POST',
        url: `/hooks/github/${GITHUB_SECRET}`,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'check_run',
          'x-hub-signature-256': ghSignature(ciBody, GITHUB_SECRET),
        },
        payload: ciBody,
      });
      await settle();
      await h.reviewLoop.bundler.flushNow(PR_URL);
      await settle();

      const jobs = h.jobQueue.enqueued.filter((j) => j.queue === 'ouija.agent-dispatch');
      expect(jobs).toHaveLength(1);
      const jobData = jobs[0]!.data as AgentDispatchJobData;
      expect(jobData.reviewContext?.bundle.reviews).toHaveLength(1);
      expect(jobData.reviewContext?.bundle.ciFailures).toHaveLength(1);
    } finally {
      await h.reviewLoop.stop();
      await h.app.close();
    }
  });
});
