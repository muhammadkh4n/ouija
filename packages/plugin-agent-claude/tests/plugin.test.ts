/**
 * plugin.test.ts
 *
 * Integration-level tests for ClaudeAgentPlugin. All I/O (subprocess, git)
 * is replaced by vi.fn() mocks injected via the plugin's overridable fields.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeAgentPlugin } from '../src/index.js';
import { createMockContext } from '@ouija/plugin-sdk';
import type { WorkOrder } from '@ouija/types';
import { dispatchId } from '@ouija/types';
import type { SubprocessResult } from '../src/subprocess.js';

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

function makeSuccessResult(): SubprocessResult {
  return {
    exitCode: 0,
    stdout: 'Done.',
    stderr: '',
    timedOut: false,
    durationMs: 5_000,
  };
}

function makeFailedResult(exitCode = 1): SubprocessResult {
  return {
    exitCode,
    stdout: '',
    stderr: 'fatal error',
    timedOut: false,
    durationMs: 1_000,
  };
}

function makeTimedOutResult(): SubprocessResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: '',
    timedOut: true,
    durationMs: 60_000,
  };
}

// ---------------------------------------------------------------------------
// Plugin setup helper
// ---------------------------------------------------------------------------

async function makePlugin() {
  const plugin = new ClaudeAgentPlugin();
  const ctx = createMockContext({
    secretRef: 'cred:test',
    defaultModel: 'claude-sonnet-4-20250514',
    maxDurationMs: 60_000,
    repoAccessTokens: {},
  });
  await plugin.init(ctx);

  // Replace all I/O with no-op mocks by default
  plugin._cloneFn = vi.fn().mockResolvedValue(undefined);
  plugin._createBranchFn = vi.fn().mockResolvedValue(undefined);
  plugin._spawnFn = vi.fn().mockResolvedValue(makeSuccessResult());

  return { plugin, ctx };
}

// We also need to mock the HeartbeatReporter so tests don't make real HTTP calls.
// We do this by mocking the heartbeat module.
vi.mock('../src/heartbeat.js', () => {
  const mockReporter = {
    reportProgress: vi.fn().mockResolvedValue(undefined),
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

// Also mock mkdtemp and rm so no real filesystem ops happen
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn().mockResolvedValue('/tmp/ouija-agent-mock'),
  rm: vi.fn().mockResolvedValue(undefined),
}));

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
      expect(['dispatching', 'running', 'completed']).toContain(status.state);
    });

    it('each dispatch gets a unique ID', async () => {
      const { plugin } = await makePlugin();
      const id1 = await plugin.dispatch(baseWorkOrder);
      const id2 = await plugin.dispatch({ ...baseWorkOrder, instanceId: 'inst-2' as WorkOrder['instanceId'] });
      expect(String(id1)).not.toBe(String(id2));
    });

    it('clones the repo as part of agent run', async () => {
      const { plugin } = await makePlugin();
      await plugin.dispatch(baseWorkOrder);
      // Allow microtask queue to drain
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(plugin._cloneFn).toHaveBeenCalledWith(
        baseWorkOrder.repoUrl,
        expect.any(String),
        baseWorkOrder.baseBranch,
      );
    });

    it('spawns the Claude CLI as part of agent run', async () => {
      const { plugin } = await makePlugin();
      await plugin.dispatch(baseWorkOrder);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(plugin._spawnFn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: expect.any(String),
          timeoutMs: baseWorkOrder.maxDurationMs,
        }),
      );
    });
  });

  describe('cancel()', () => {
    it('marks the dispatch as cancelled', async () => {
      const { plugin } = await makePlugin();
      // Make spawn take a while so we can cancel it
      plugin._spawnFn = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(makeSuccessResult()), 5_000)),
      );

      const id = await plugin.dispatch(baseWorkOrder);
      await plugin.cancel(id);

      const status = await plugin.getStatus(id);
      expect(status.state).toBe('cancelled');
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
      const { plugin } = await makePlugin();
      // Make spawn hang so dispatch stays active
      plugin._spawnFn = vi.fn().mockImplementation(
        () => new Promise(() => { /* never resolves */ }),
      );

      await plugin.dispatch(baseWorkOrder);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const health = await plugin.healthCheck();
      expect(typeof health.details?.['activeDispatches']).toBe('number');
    });
  });

  describe('stop()', () => {
    it('cancels all active dispatches and clears the map', async () => {
      const { plugin } = await makePlugin();
      plugin._spawnFn = vi.fn().mockImplementation(
        () => new Promise(() => { /* never resolves */ }),
      );

      await plugin.dispatch(baseWorkOrder);
      await plugin.dispatch({ ...baseWorkOrder, instanceId: 'inst-2' as WorkOrder['instanceId'] });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await plugin.stop();

      const health = await plugin.healthCheck();
      expect(health.details?.['activeDispatches']).toBe(0);
    });
  });
});
