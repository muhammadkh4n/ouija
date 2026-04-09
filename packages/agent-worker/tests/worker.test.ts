import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentDispatchWorker } from '../src/worker.js';
import type { AgentDispatchJobData, JobQueue } from '@ouija-dev/bus';
import type { AgentPlugin, WorkOrder } from '@ouija-dev/types';
import { dispatchId as makeDispatchId } from '@ouija-dev/types';
import type { AssemblerDeps, AgentProfile } from '../src/work-order-assembler.js';

// ---- Mock job queue ----

function makeMockJobQueue() {
  // Store the registered handler so tests can trigger it directly.
  let registeredHandler: ((data: AgentDispatchJobData, jobId: string) => Promise<void>) | null =
    null;

  const mock = {
    enqueue: vi.fn<() => Promise<string>>().mockResolvedValue('job-id-1'),
    process: vi.fn().mockImplementation(
      async (
        _queue: string,
        fn: (data: AgentDispatchJobData, jobId: string) => Promise<void>,
      ) => {
        registeredHandler = fn;
      },
    ),
    cancelJob: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),

    /** Simulate a BullMQ job arriving. */
    async simulateJob(data: AgentDispatchJobData, jobId = 'job-sim-1'): Promise<void> {
      if (!registeredHandler) {
        throw new Error('Worker not started — no handler registered');
      }
      await registeredHandler(data, jobId);
    },
  };

  return mock;
}

// ---- Mock agent plugin ----

function makeMockAgentPlugin(): AgentPlugin {
  return {
    manifest: {
      name: '@ouija-dev/mock-agent',
      version: '0.1.0',
      type: 'agent',
      coreApiVersion: '>=1.0.0',
      configSchema: {},
    },
    init: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    dispatch: vi.fn().mockResolvedValue(makeDispatchId('mock-dispatch-1')),
    cancel: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({
      dispatchId: makeDispatchId('mock-dispatch-1'),
      instanceId: 'inst-1',
      state: 'running' as const,
      updatedAt: new Date().toISOString(),
    }),
  };
}

// ---- Shared fixtures ----

const baseJobData: AgentDispatchJobData = {
  instanceId: 'inst-123',
  dispatchId: 'disp-456',
  agentId: 'rex-coder',
  cardId: 'card-789',
  projectId: 'proj-1',
  workOrderDescription: 'Do something',
  dispatchedAt: new Date().toISOString(),
};

const baseProfile: AgentProfile = {
  id: 'rex-coder',
  name: 'Rex Coder',
  systemPrompt: '',
  secretRef: 'cred:test',
  model: 'claude-sonnet-4-20250514',
  maxDurationMs: 60_000,
  repoUrl: 'https://github.com/org/repo.git',
  baseBranch: 'main',
};

function makeAssemblerDeps(overrides: Partial<AssemblerDeps> = {}): AssemblerDeps {
  return {
    getAgentProfile: vi.fn().mockResolvedValue(baseProfile),
    getCardDetails: vi.fn().mockResolvedValue({
      title: 'Test task',
      description: 'Description.',
      acceptanceCriteria: [],
      labels: [],
    }),
    serverBaseUrl: 'http://localhost:4000',
    issueJwt: vi.fn().mockResolvedValue('jwt-test-token'),
    ...overrides,
  };
}

// ---- Tests ----

describe('AgentDispatchWorker', () => {
  let mockQueue: ReturnType<typeof makeMockJobQueue>;
  let mockPlugin: AgentPlugin;

  beforeEach(() => {
    mockQueue = makeMockJobQueue();
    mockPlugin = makeMockAgentPlugin();
  });

  it('registers as a BullMQ processor when started', async () => {
    const worker = new AgentDispatchWorker({
      jobQueue: mockQueue as unknown as JobQueue,
      agentPlugin: mockPlugin,
      assemblerDeps: makeAssemblerDeps(),
    });

    await worker.start();
    expect(mockQueue.process).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — calling start() twice registers only once', async () => {
    const worker = new AgentDispatchWorker({
      jobQueue: mockQueue as unknown as JobQueue,
      agentPlugin: mockPlugin,
      assemblerDeps: makeAssemblerDeps(),
    });

    await worker.start();
    await worker.start();
    expect(mockQueue.process).toHaveBeenCalledTimes(1);
  });

  it('dispatches to the agent plugin when a job arrives', async () => {
    const worker = new AgentDispatchWorker({
      jobQueue: mockQueue as unknown as JobQueue,
      agentPlugin: mockPlugin,
      assemblerDeps: makeAssemblerDeps(),
    });

    await worker.start();
    await mockQueue.simulateJob(baseJobData);

    expect(mockPlugin.dispatch).toHaveBeenCalledTimes(1);
    const workOrder = (mockPlugin.dispatch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as WorkOrder;
    expect(workOrder.cardId).toBe('card-789');
    expect(workOrder.branch).toBe('ouija/inst-123');
    expect(workOrder.callbackUrl).toBe('http://localhost:4000/hooks/agent/callback');
  });

  it('uses the concurrency from options', async () => {
    const worker = new AgentDispatchWorker({
      jobQueue: mockQueue as unknown as JobQueue,
      agentPlugin: mockPlugin,
      assemblerDeps: makeAssemblerDeps(),
      concurrency: 3,
    });

    await worker.start();
    // process() should have been called with concurrency=3
    expect(mockQueue.process).toHaveBeenCalledWith(
      'ouija.agent-dispatch',
      expect.any(Function),
      3,
    );
  });

  it('re-throws errors so BullMQ can retry', async () => {
    const failingDeps = makeAssemblerDeps({
      getAgentProfile: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    });

    const worker = new AgentDispatchWorker({
      jobQueue: mockQueue as unknown as JobQueue,
      agentPlugin: mockPlugin,
      assemblerDeps: failingDeps,
    });

    await worker.start();
    await expect(mockQueue.simulateJob(baseJobData)).rejects.toThrow('DB connection lost');
    // Plugin should NOT have been called
    expect(mockPlugin.dispatch).not.toHaveBeenCalled();
  });

  it('re-throws plugin dispatch errors so BullMQ can retry', async () => {
    (mockPlugin.dispatch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Plugin init failed'),
    );

    const worker = new AgentDispatchWorker({
      jobQueue: mockQueue as unknown as JobQueue,
      agentPlugin: mockPlugin,
      assemblerDeps: makeAssemblerDeps(),
    });

    await worker.start();
    await expect(mockQueue.simulateJob(baseJobData)).rejects.toThrow('Plugin init failed');
  });

  it('passes the default concurrency of 1 when not specified', async () => {
    const worker = new AgentDispatchWorker({
      jobQueue: mockQueue as unknown as JobQueue,
      agentPlugin: mockPlugin,
      assemblerDeps: makeAssemblerDeps(),
    });

    await worker.start();
    expect(mockQueue.process).toHaveBeenCalledWith(
      'ouija.agent-dispatch',
      expect.any(Function),
      1,
    );
  });
});
