/**
 * End-to-end pipeline integration test.
 *
 * Proves the full ouija pipeline works from config loading through to agent
 * execution setup. Uses real implementations where possible and mocks only
 * at external boundaries (no Postgres, no Redis, no Plane API, no Claude binary).
 *
 * Flow:
 *   1. Load a real YAML config file
 *   2. Provision agent members via AgentMemberRegistry (mock Plane client)
 *   3. Create Orchestrator with mocked DB, EventBus, JobQueue, KanbanPlugin
 *   4. Fire kanban events and verify pipeline state transitions
 *   5. Assemble work orders using config-driven profiles
 *   6. Verify workspace config assembly (real filesystem)
 *   7. Verify auth env resolution
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

// Config
import { loadConfig, AgentMemberRegistry } from '@ouija-dev/config';
import type { PlaneClient, RegistryLogger } from '@ouija-dev/config';

// Engine
import { Orchestrator } from '@ouija-dev/engine';
import type { AgentMemberLookup } from '@ouija-dev/engine';

// Types
import {
  cardId, columnId, instanceId, boardId, agentId, dispatchId,
} from '@ouija-dev/types';
import type {
  Database,
  PipelineInstance,
  PipelineConfig,
  PipelineEventRecord,
  UnitOfWork,
  KanbanPlugin,
  KanbanCard,
  KanbanColumn,
  OuijaEvent,
  PipelineRepository,
  PipelineEventRepository,
  BoardConfigRepository,
  DeduplicationRepository,
  CursorPage,
} from '@ouija-dev/types';

// Bus
import type { EventBus, PublishOptions, Unsubscribe, JobQueue, QueueName, QueueDataMap, EnqueueOptions } from '@ouija-dev/bus';

// Agent worker
import { assembleWorkOrder } from '../../agent-worker/src/work-order-assembler.js';
import type { AssemblerDeps, AgentProfile } from '../../agent-worker/src/work-order-assembler.js';

// Plugin agent claude (not re-exported from package index)
import { assembleWorkspaceConfig } from '../../plugin-agent-claude/src/workspace-config.js';
import { buildAuthEnv } from '../../plugin-agent-claude/src/auth-env.js';

// ---- In-memory mock database ----

function createMockDatabase(): Database & {
  _instances: Map<string, PipelineInstance>;
  _events: PipelineEventRecord[];
  _configs: Map<string, PipelineConfig>;
} {
  const instances = new Map<string, PipelineInstance>();
  const events: PipelineEventRecord[] = [];
  const configs = new Map<string, PipelineConfig>();

  const pipelines: PipelineRepository = {
    async findById(id) {
      return instances.get(String(id));
    },
    async findByCardId(cid) {
      for (const inst of instances.values()) {
        if (inst.cardId === cid) return inst;
      }
      return undefined;
    },
    async listByBoard(_boardId, _cursor, _limit) {
      const items = [...instances.values()].filter((i) => i.boardId === _boardId);
      return { items } as CursorPage<PipelineInstance>;
    },
    async save(instance) {
      instances.set(String(instance.id), instance);
    },
    async delete(id) {
      instances.delete(String(id));
    },
    async findStalledCandidates(_cutoff) {
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
      return events.filter((e) => e.instanceId === iid);
    },
  };

  const boardConfigs: BoardConfigRepository = {
    async findByBoardId(bid) {
      return configs.get(String(bid));
    },
    async listAll() {
      return Array.from(configs.values());
    },
    async save(config) {
      configs.set(String(config.boardId), config);
    },
    async delete(bid) {
      configs.delete(String(bid));
    },
  };

  const deduplication: DeduplicationRepository = {
    async isDuplicate() { return false; },
    async markProcessed() { return; },
    async purgeExpired() { return 0; },
  };

  return {
    _instances: instances,
    _events: events,
    _configs: configs,
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

// ---- In-memory mock event bus ----

function createMockEventBus(): EventBus & { published: Array<{ topic: string; payload: unknown }> } {
  const published: Array<{ topic: string; payload: unknown }> = [];
  return {
    published,
    async publish(topic, payload, _opts) {
      published.push({ topic, payload });
      return 'mock-event-id';
    },
    async subscribe(_topic, _handler) {
      return async () => undefined;
    },
    async subscribePattern(_pattern, _handler) {
      return async () => undefined;
    },
    async replay(_topic, _from, _to, _handler) { return; },
    async close() { return; },
  };
}

// ---- In-memory mock job queue ----

interface EnqueuedJob {
  queue: QueueName;
  data: unknown;
  options?: EnqueueOptions;
}

function createMockJobQueue(): JobQueue & {
  enqueued: EnqueuedJob[];
  cancelled: Array<{ queue: QueueName; jobId: string }>;
} {
  const enqueued: EnqueuedJob[] = [];
  const cancelled: Array<{ queue: QueueName; jobId: string }> = [];

  return {
    enqueued,
    cancelled,
    async enqueue(queue, data, options) {
      enqueued.push({ queue, data, options });
      return options?.jobId ?? 'mock-job-id';
    },
    async process(_queue, _handler, _concurrency) { return; },
    async cancelJob(queue, jobId) {
      cancelled.push({ queue, jobId });
    },
    async close() { return; },
  };
}

// ---- Mock kanban plugin ----

function createMockKanbanPlugin(cards: Map<string, KanbanCard>): KanbanPlugin & {
  moves: Array<{ cardId: string; toColumnId: string }>;
  comments: Array<{ cardId: string; body: string }>;
} {
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
    async init() { return; },
    async start() { return; },
    async stop() { return; },
    async healthCheck() { return { healthy: true }; },
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
    async assignUser() { return; },
    async getColumns(_bid): Promise<KanbanColumn[]> { return []; },
  };
}

// ---- Test config YAML ----

const CONFIG_YAML = `
claudeHome: null

agents:
  - id: rex-coder
    name: Rex Coder
    email: rex@ouija.local
    triggerMode: auto
    model: claude-sonnet-4-20250514
    systemPrompt: |
      You are Rex. Fix bugs and write tests.
    auth:
      method: api-key
      secretRef: env:ANTHROPIC_API_KEY
    repos:
      - url: https://github.com/test/repo.git
        baseBranch: main
        default: true
    limits:
      maxDurationMs: 1800000
      stallThresholdMs: 300000

  - id: frontend-bot
    name: Frontend Bot
    email: frontend@ouija.local
    triggerMode: manual
    model: claude-sonnet-4-20250514
    auth:
      method: bedrock
      secretRef: env:AWS_ACCESS_KEY_ID
    repos:
      - url: https://github.com/test/frontend.git
        baseBranch: develop
        default: true
    limits:
      maxDurationMs: 900000
`;

// ---- Test suite ----

describe('End-to-end pipeline', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(os.tmpdir(), 'ouija-e2e-'));
    configPath = join(tmpDir, 'ouija.config.yaml');
    await writeFile(configPath, CONFIG_YAML);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('auto-trigger: config -> assign -> dispatch -> work order -> workspace config -> auth env', async () => {
    // ---- Phase 1: Load config ----
    const config = await loadConfig(configPath);
    expect(config.agents).toHaveLength(2);
    expect(config.agents[0].id).toBe('rex-coder');
    expect(config.agents[0].triggerMode).toBe('auto');
    expect(config.agents[1].id).toBe('frontend-bot');
    expect(config.agents[1].triggerMode).toBe('manual');

    // ---- Phase 2: Provision agent members ----
    const mockPlaneClient: PlaneClient = {
      getMembers: vi.fn().mockResolvedValue([]),
      inviteMember: vi.fn().mockImplementation(async (_ws: string, email: string) => ({
        id: `member-${email.split('@')[0]}`,
        email,
        role: 10,
      })),
    };

    const registryLogger: RegistryLogger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    };

    const registry = new AgentMemberRegistry(
      config.agents,
      mockPlaneClient,
      'test-workspace',
      registryLogger,
    );
    await registry.provision();

    expect(registry.getAgentIdByMemberId('member-rex')).toBe('rex-coder');
    expect(registry.getTriggerMode('rex-coder')).toBe('auto');
    expect(registry.getAgentIdByMemberId('member-frontend')).toBe('frontend-bot');
    expect(registry.getTriggerMode('frontend-bot')).toBe('manual');

    // ---- Phase 3: Set up orchestrator with mocks ----
    const db = createMockDatabase();
    const eventBus = createMockEventBus();
    const jobQueue = createMockJobQueue();

    const testCard: KanbanCard = {
      id: cardId('proj-1/issue-42'),
      title: 'Fix login validation bug',
      description: 'Email field accepts invalid emails. Add regex validation.',
      columnId: columnId('col-todo'),
      boardId: boardId('proj-1'),
      labels: ['bug', 'frontend'],
      assignees: [],
      url: 'https://plane.test/proj-1/issues/issue-42',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const cards = new Map<string, KanbanCard>();
    cards.set('proj-1/issue-42', testCard);
    const kanbanPlugin = createMockKanbanPlugin(cards);

    const boardConfig: PipelineConfig = {
      boardId: boardId('proj-1'),
      columnMappings: [
        {
          columnId: columnId('col-inprogress'),
          columnName: 'In Progress',
          action: 'dispatch_agent',
          agentId: agentId('rex-coder'),
          guards: [],
        },
        {
          columnId: columnId('col-done'),
          columnName: 'Done',
          action: 'close_and_notify',
          guards: [],
        },
      ],
      defaultStallThresholdMs: 300_000,
      autoStartOnAssign: true,
    };
    await db.boardConfigs.save(boardConfig);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const orchestrator = new Orchestrator(db, eventBus, jobQueue, kanbanPlugin, logger, registry);

    // ---- Phase 4: Fire card_assigned event (auto-trigger agent) ----
    const assignEvent: OuijaEvent<'kanban.card.assigned'> = {
      id: 'evt-assign-1',
      topic: 'kanban.card.assigned',
      payload: {
        cardId: cardId('proj-1/issue-42'),
        assigneeId: 'member-rex',
        assignedBy: 'human@example.com',
      },
      timestamp: new Date().toISOString(),
      sourcePlugin: '@ouija-dev/plugin-plane',
      correlationId: 'corr-1',
    };

    await orchestrator.processTrigger(assignEvent);

    // Verify: pipeline created and transitioned to dispatching
    const instance = await db.pipelines.findByCardId(cardId('proj-1/issue-42'));
    expect(instance).toBeDefined();
    expect(instance!.state.status).toBe('dispatching');

    // Verify: dispatch job enqueued with correct data
    const dispatchJobs = jobQueue.enqueued.filter(j => j.queue === 'ouija.agent-dispatch');
    expect(dispatchJobs).toHaveLength(1);
    const dispatchJobData = dispatchJobs[0].data as {
      instanceId: string;
      dispatchId: string;
      agentId: string;
      cardId: string;
      projectId: string;
    };
    expect(dispatchJobData.agentId).toBe('rex-coder');
    expect(dispatchJobData.cardId).toBe('proj-1/issue-42');

    // ---- Phase 5: Simulate work order assembly ----
    const agentProfile: AgentProfile = {
      id: 'rex-coder',
      name: 'Rex Coder',
      systemPrompt: 'You are Rex. Fix bugs and write tests.\n',
      secretRef: 'env:ANTHROPIC_API_KEY',
      model: 'claude-sonnet-4-20250514',
      maxDurationMs: 1800000,
      repoUrl: 'https://github.com/test/repo.git',
      baseBranch: 'main',
      triggerMode: 'auto',
      authMethod: 'api-key',
    };

    const assemblerDeps: AssemblerDeps = {
      getAgentProfile: async () => agentProfile,
      getCardDetails: async () => ({
        title: 'Fix login validation bug',
        description: 'Email field accepts invalid emails. Add regex validation.',
        acceptanceCriteria: ['Email regex validates correctly', 'Inline error shown'],
        labels: ['bug', 'frontend'],
      }),
      serverBaseUrl: 'http://localhost:4000',
      issueJwt: async () => 'test-jwt-token',
    };

    const workOrder = await assembleWorkOrder(
      {
        instanceId: dispatchJobData.instanceId,
        dispatchId: dispatchJobData.dispatchId,
        agentId: dispatchJobData.agentId,
        cardId: dispatchJobData.cardId,
        projectId: dispatchJobData.projectId ?? 'proj-1',
        workOrderDescription: '',
        dispatchedAt: new Date().toISOString(),
      },
      assemblerDeps,
    );

    expect(workOrder.title).toBe('Fix login validation bug');
    expect(workOrder.repoUrl).toBe('https://github.com/test/repo.git');
    expect(workOrder.branch).toContain('ouija/');
    expect(workOrder.agentProfileId).toBe('rex-coder');
    expect(workOrder.callbackUrl).toBe('http://localhost:4000/hooks/agent/callback');

    // ---- Phase 6: Workspace config assembly (real filesystem) ----
    const workspaceDir = await mkdtemp(join(tmpDir, 'workspace-'));

    await assembleWorkspaceConfig({
      workspaceDir,
      systemPrompt: workOrder.systemPrompt,
      title: workOrder.title,
      description: workOrder.description,
      acceptanceCriteria: workOrder.acceptanceCriteria,
      branch: workOrder.branch,
      baseBranch: workOrder.baseBranch,
    });

    const claudeMd = await readFile(join(workspaceDir, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('You are Rex');
    expect(claudeMd).toContain('Fix login validation bug');
    expect(claudeMd).toContain('Email regex validates correctly');
    expect(claudeMd).toContain(workOrder.branch);

    // ---- Phase 7: Auth env verification ----
    const originalKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
    try {
      const authEnv = buildAuthEnv('api-key', 'env:ANTHROPIC_API_KEY');
      expect(authEnv['ANTHROPIC_API_KEY']).toBe('sk-ant-test-key');
    } finally {
      if (originalKey !== undefined) {
        process.env['ANTHROPIC_API_KEY'] = originalKey;
      } else {
        delete process.env['ANTHROPIC_API_KEY'];
      }
    }

    // Verify bedrock auth env
    const bedrockEnv = buildAuthEnv('bedrock', 'env:unused');
    expect(bedrockEnv['CLAUDE_CODE_USE_BEDROCK']).toBe('1');
  });

  it('manual-trigger: assign stores agent, card move dispatches with assigned agent', async () => {
    const config = await loadConfig(configPath);

    const mockPlaneClient: PlaneClient = {
      getMembers: vi.fn().mockResolvedValue([]),
      inviteMember: vi.fn().mockImplementation(async (_ws: string, email: string) => ({
        id: `member-${email.split('@')[0]}`,
        email,
        role: 10,
      })),
    };

    const registry = new AgentMemberRegistry(
      config.agents,
      mockPlaneClient,
      'test-workspace',
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    await registry.provision();

    const db = createMockDatabase();
    const eventBus = createMockEventBus();
    const jobQueue = createMockJobQueue();

    const testCard: KanbanCard = {
      id: cardId('proj-1/issue-99'),
      title: 'Redesign header component',
      description: 'Update the header with new design system.',
      columnId: columnId('col-todo'),
      boardId: boardId('proj-1'),
      labels: ['feature'],
      assignees: [],
      url: 'https://plane.test/proj-1/issues/issue-99',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const cards = new Map<string, KanbanCard>();
    cards.set('proj-1/issue-99', testCard);
    const kanbanPlugin = createMockKanbanPlugin(cards);

    // Board config -- In Progress column dispatches frontend-bot
    const boardConfig: PipelineConfig = {
      boardId: boardId('proj-1'),
      columnMappings: [
        {
          columnId: columnId('col-inprogress'),
          columnName: 'In Progress',
          action: 'dispatch_agent',
          agentId: agentId('frontend-bot'),
          guards: [],
        },
      ],
      defaultStallThresholdMs: 300_000,
      autoStartOnAssign: true,
    };
    await db.boardConfigs.save(boardConfig);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const orchestrator = new Orchestrator(db, eventBus, jobQueue, kanbanPlugin, logger, registry);

    // ---- Step 1: Assign card to frontend-bot (manual mode) ----
    const assignEvent: OuijaEvent<'kanban.card.assigned'> = {
      id: 'evt-assign-manual',
      topic: 'kanban.card.assigned',
      payload: {
        cardId: cardId('proj-1/issue-99'),
        assigneeId: 'member-frontend',
        assignedBy: 'human@example.com',
      },
      timestamp: new Date().toISOString(),
      sourcePlugin: '@ouija-dev/plugin-plane',
      correlationId: 'corr-manual',
    };

    await orchestrator.processTrigger(assignEvent);

    // Verify: instance created, agent assigned, but NOT dispatched
    const instance = await db.pipelines.findByCardId(cardId('proj-1/issue-99'));
    expect(instance).toBeDefined();
    expect(instance!.state.status).toBe('idle');
    expect(instance!.assignedAgentId).toBe('frontend-bot');

    // Verify: NO dispatch job enqueued
    const dispatchJobsAfterAssign = jobQueue.enqueued.filter(j => j.queue === 'ouija.agent-dispatch');
    expect(dispatchJobsAfterAssign).toHaveLength(0);

    // ---- Step 2: Move card to In Progress column ----
    const moveEvent: OuijaEvent<'kanban.card.moved'> = {
      id: 'evt-move-manual',
      topic: 'kanban.card.moved',
      payload: {
        cardId: cardId('proj-1/issue-99'),
        fromColumnId: columnId('col-todo'),
        toColumnId: columnId('col-inprogress'),
        movedBy: 'human@example.com',
      },
      timestamp: new Date().toISOString(),
      sourcePlugin: '@ouija-dev/plugin-plane',
      correlationId: 'corr-move-manual',
    };

    await orchestrator.processTrigger(moveEvent);

    // Verify: pipeline transitions to dispatching
    const updatedInstance = await db.pipelines.findByCardId(cardId('proj-1/issue-99'));
    expect(updatedInstance).toBeDefined();
    expect(updatedInstance!.state.status).toBe('dispatching');

    // Verify: dispatch job uses the assigned agent (frontend-bot)
    const dispatchJobsAfterMove = jobQueue.enqueued.filter(j => j.queue === 'ouija.agent-dispatch');
    expect(dispatchJobsAfterMove).toHaveLength(1);
    expect((dispatchJobsAfterMove[0].data as { agentId: string }).agentId).toBe('frontend-bot');
  });
});
