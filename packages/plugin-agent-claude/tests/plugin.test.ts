/**
 * plugin.test.ts
 *
 * Integration-level tests for ClaudeAgentPlugin. All I/O (workspace provisioning,
 * agent execution) is replaced by injected mock WorkspaceProvider and AgentRunner.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeAgentPlugin } from '../src/index.js';
import { createMockContext } from '@ouija/plugin-sdk';
import type { WorkOrder, WorkspaceProvider, AgentRunner, WorkspaceSpec, Workspace, WorkspaceHealth, AgentRunResult } from '@ouija/types';
import { dispatchId } from '@ouija/types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const baseWorkOrder: WorkOrder = {
  instanceId: 'inst-test' as WorkOrder['instanceId'],
  cardId: 'card-test',
  title: 'Test task',
  description: 'Do something.',
  acceptanceCriteria: [],
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'ouija/inst-test',
  baseBranch: 'main',
  agentProfileId: 'test-agent',
  systemPrompt: '',
  secretRef: 'cred:test',
  callbackUrl: 'http://localhost:4000/hooks/agent/callback',
  callbackToken: 'jwt-test',
  maxDurationMs: 60_000,
  metadata: {},
};

function makeSuccessResult(): AgentRunResult {
  return {
    exitCode: 0,
    stdout: 'Done.',
    stderr: '',
    timedOut: false,
    durationMs: 5_000,
  };
}

function makeFailedResult(exitCode = 1): AgentRunResult {
  return {
    exitCode,
    stdout: '',
    stderr: 'fatal error',
    timedOut: false,
    durationMs: 1_000,
  };
}

function makeTimedOutResult(): AgentRunResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: '',
    timedOut: true,
    durationMs: 60_000,
  };
}

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeMockWorkspaceProvider(): WorkspaceProvider & { provisionCalls: WorkspaceSpec[]; destroyCalls: string[] } {
  const provisionCalls: WorkspaceSpec[] = [];
  const destroyCalls: string[] = [];
  return {
    type: 'local',
    provisionCalls,
    destroyCalls,
    async provision(spec: WorkspaceSpec): Promise<Workspace> {
      provisionCalls.push(spec);
      return { id: 'ws-mock-1', type: 'local', endpoint: '/tmp/mock-workspace' };
    },
    async destroy(id: string): Promise<void> { destroyCalls.push(id); },
    async healthCheck(): Promise<WorkspaceHealth> { return { alive: true }; },
  };
}

function makeMockAgentRunner(result: AgentRunResult): AgentRunner & { runCalls: unknown[] } {
  const runCalls: unknown[] = [];
  return {
    runCalls,
    async run(workspace, prompt, env, timeoutMs, options?): Promise<AgentRunResult> {
      runCalls.push({ workspace, prompt, env, timeoutMs });
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin setup helper
// ---------------------------------------------------------------------------

async function makePlugin(runnerResult: AgentRunResult = makeSuccessResult()) {
  const plugin = new ClaudeAgentPlugin();
  const ctx = createMockContext({
    secretRef: 'cred:test',
    defaultModel: 'claude-sonnet-4-20250514',
    maxDurationMs: 60_000,
    repoAccessTokens: {},
  });

  // Inject mocks BEFORE init so init() does not install real providers
  const wsProvider = makeMockWorkspaceProvider();
  const agentRunner = makeMockAgentRunner(runnerResult);
  plugin.workspaceProvider = wsProvider;
  plugin.agentRunner = agentRunner;

  await plugin.init(ctx);

  return { plugin, ctx, wsProvider, agentRunner };
}

// Mock workspace-config so _runAgent doesn't hit the filesystem
vi.mock('../src/workspace-config.js', () => ({
  assembleWorkspaceConfig: vi.fn().mockResolvedValue(undefined),
}));

// We also need to mock the HeartbeatReporter so tests don't make real HTTP calls.
vi.mock('../src/heartbeat.js', () => {
  const mockReporter = {
    reportProgress: vi.fn().mockResolvedValue(undefined),
    reportAcknowledged: vi.fn().mockResolvedValue(undefined),
    reportPrReady: vi.fn().mockResolvedValue(undefined),
    reportCompleted: vi.fn().mockResolvedValue(undefined),
    reportFailed: vi.fn().mockResolvedValue(undefined),
    startInterval: vi.fn(),
    stopInterval: vi.fn(),
    token: 'jwt-test',
  };

  return {
    HeartbeatReporter: vi.fn(() => mockReporter),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeAgentPlugin', () => {
  describe('manifest', () => {
    it('declares type as agent', () => {
      const plugin = new ClaudeAgentPlugin();
      expect(plugin.manifest.type).toBe('agent');
    });

    it('produces expected event types', () => {
      const plugin = new ClaudeAgentPlugin();
      expect(plugin.manifest.events?.produces).toContain('agent.work.completed');
      expect(plugin.manifest.events?.produces).toContain('agent.work.failed');
    });
  });

  describe('dispatch()', () => {
    it('returns a non-empty DispatchId immediately', async () => {
      const { plugin } = await makePlugin();
      const id = await plugin.dispatch(baseWorkOrder);
      expect(String(id)).toBeTruthy();
      expect(String(id).length).toBeGreaterThan(0);
    });

    it('starts in dispatching or running state', async () => {
      const { plugin } = await makePlugin();
      const id = await plugin.dispatch(baseWorkOrder);
      const status = await plugin.getStatus(id);
      expect(['dispatching', 'provisioning', 'running', 'completed']).toContain(status.state);
    });

    it('each dispatch gets a unique ID', async () => {
      const { plugin } = await makePlugin();
      const id1 = await plugin.dispatch(baseWorkOrder);
      const id2 = await plugin.dispatch({ ...baseWorkOrder, instanceId: 'inst-2' as WorkOrder['instanceId'] });
      expect(String(id1)).not.toBe(String(id2));
    });

    it('provisions a workspace as part of agent run', async () => {
      const { plugin, wsProvider } = await makePlugin();
      await plugin.dispatch(baseWorkOrder);
      // Allow microtask queue to drain
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(wsProvider.provisionCalls).toHaveLength(1);
      expect(wsProvider.provisionCalls[0]).toMatchObject({
        repoUrl: baseWorkOrder.repoUrl,
        baseBranch: baseWorkOrder.baseBranch,
        featureBranch: baseWorkOrder.branch,
      });
    });

    it('runs the agent via AgentRunner as part of agent run', async () => {
      const { plugin, agentRunner } = await makePlugin();
      await plugin.dispatch(baseWorkOrder);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(agentRunner.runCalls).toHaveLength(1);
      expect(agentRunner.runCalls[0]).toMatchObject({
        workspace: { id: 'ws-mock-1', type: 'local' },
        timeoutMs: baseWorkOrder.maxDurationMs,
      });
    });

    it('destroys workspace after successful run', async () => {
      const { plugin, wsProvider } = await makePlugin();
      await plugin.dispatch(baseWorkOrder);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(wsProvider.destroyCalls).toContain('ws-mock-1');
    });

    it('destroys workspace after failed run', async () => {
      const { plugin, wsProvider } = await makePlugin(makeFailedResult());
      await plugin.dispatch(baseWorkOrder);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(wsProvider.destroyCalls).toContain('ws-mock-1');
    });

    it('destroys workspace after timed out run', async () => {
      const { plugin, wsProvider } = await makePlugin(makeTimedOutResult());
      await plugin.dispatch(baseWorkOrder);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(wsProvider.destroyCalls).toContain('ws-mock-1');
    });
  });

  describe('cancel()', () => {
    it('marks the dispatch as cancelled', async () => {
      const plugin = new ClaudeAgentPlugin();
      const ctx = createMockContext({
        secretRef: 'cred:test',
        defaultModel: 'claude-sonnet-4-20250514',
        maxDurationMs: 60_000,
        repoAccessTokens: {},
      });

      // Make the runner hang so we can cancel mid-flight
      const wsProvider = makeMockWorkspaceProvider();
      let resolveRun!: (r: AgentRunResult) => void;
      const hangingRunner: AgentRunner & { runCalls: unknown[] } = {
        runCalls: [],
        async run(workspace, prompt, env, timeoutMs): Promise<AgentRunResult> {
          return new Promise((resolve) => { resolveRun = resolve; });
        },
      };
      plugin.workspaceProvider = wsProvider;
      plugin.agentRunner = hangingRunner;

      await plugin.init(ctx);

      const id = await plugin.dispatch(baseWorkOrder);
      // Wait for provisioning to complete so workspace is set
      await new Promise((resolve) => setTimeout(resolve, 50));
      await plugin.cancel(id);

      const status = await plugin.getStatus(id);
      expect(status.state).toBe('cancelled');

      // Unblock the hanging runner to avoid open handles
      resolveRun(makeSuccessResult());
    });

    it('destroys workspace on cancel', async () => {
      const plugin = new ClaudeAgentPlugin();
      const ctx = createMockContext({
        secretRef: 'cred:test',
        defaultModel: 'claude-sonnet-4-20250514',
        maxDurationMs: 60_000,
        repoAccessTokens: {},
      });

      const wsProvider = makeMockWorkspaceProvider();
      let resolveRun!: (r: AgentRunResult) => void;
      const hangingRunner: AgentRunner & { runCalls: unknown[] } = {
        runCalls: [],
        async run(): Promise<AgentRunResult> {
          return new Promise((resolve) => { resolveRun = resolve; });
        },
      };
      plugin.workspaceProvider = wsProvider;
      plugin.agentRunner = hangingRunner;

      await plugin.init(ctx);

      const id = await plugin.dispatch(baseWorkOrder);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await plugin.cancel(id);

      expect(wsProvider.destroyCalls).toContain('ws-mock-1');

      resolveRun(makeSuccessResult());
    });

    it('is a no-op for unknown dispatch IDs', async () => {
      const { plugin } = await makePlugin();
      // Should not throw
      await expect(plugin.cancel(dispatchId('nonexistent'))).resolves.toBeUndefined();
    });
  });

  describe('getStatus()', () => {
    it('returns idle state for unknown IDs', async () => {
      const { plugin } = await makePlugin();
      const status = await plugin.getStatus(dispatchId('unknown-id'));
      expect(status.state).toBe('idle');
    });

    it('returns the instanceId from the work order', async () => {
      const { plugin } = await makePlugin();
      const id = await plugin.dispatch(baseWorkOrder);
      const status = await plugin.getStatus(id);
      expect(String(status.instanceId)).toBe(String(baseWorkOrder.instanceId));
    });
  });

  describe('healthCheck()', () => {
    it('returns healthy: true', async () => {
      const { plugin } = await makePlugin();
      const health = await plugin.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('reports active dispatch count', async () => {
      const plugin = new ClaudeAgentPlugin();
      const ctx = createMockContext({
        secretRef: 'cred:test',
        defaultModel: 'claude-sonnet-4-20250514',
        maxDurationMs: 60_000,
        repoAccessTokens: {},
      });

      const wsProvider = makeMockWorkspaceProvider();
      // Never-resolving runner keeps dispatch active
      const hangingRunner: AgentRunner & { runCalls: unknown[] } = {
        runCalls: [],
        async run(): Promise<AgentRunResult> {
          return new Promise(() => { /* never resolves */ });
        },
      };
      plugin.workspaceProvider = wsProvider;
      plugin.agentRunner = hangingRunner;

      await plugin.init(ctx);
      await plugin.dispatch(baseWorkOrder);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const health = await plugin.healthCheck();
      expect(typeof health.details?.['activeDispatches']).toBe('number');
    });
  });

  describe('stop()', () => {
    it('cancels all active dispatches and clears the map', async () => {
      const plugin = new ClaudeAgentPlugin();
      const ctx = createMockContext({
        secretRef: 'cred:test',
        defaultModel: 'claude-sonnet-4-20250514',
        maxDurationMs: 60_000,
        repoAccessTokens: {},
      });

      const wsProvider = makeMockWorkspaceProvider();
      const hangingRunner: AgentRunner & { runCalls: unknown[] } = {
        runCalls: [],
        async run(): Promise<AgentRunResult> {
          return new Promise(() => { /* never resolves */ });
        },
      };
      plugin.workspaceProvider = wsProvider;
      plugin.agentRunner = hangingRunner;

      await plugin.init(ctx);
      await plugin.dispatch(baseWorkOrder);
      await plugin.dispatch({ ...baseWorkOrder, instanceId: 'inst-2' as WorkOrder['instanceId'] });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await plugin.stop();

      const health = await plugin.healthCheck();
      expect(health.details?.['activeDispatches']).toBe(0);
    });
  });
});
