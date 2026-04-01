/**
 * ClaudeAgentPlugin — AgentPlugin implementation that dispatches work orders
 * to the Claude Code CLI as managed subprocesses.
 *
 * Lifecycle for each dispatch:
 *   1. Clone the target repo into a temp directory.
 *   2. Create the feature branch (ouija/<instanceId>).
 *   3. Build the prompt and spawn the Claude Code CLI.
 *   4. Run a 30-second heartbeat loop while the agent works.
 *   5. On exit: report completed/failed/timed-out back to the callback URL.
 *   6. Always clean up the temp directory regardless of outcome.
 *
 * Active dispatches are tracked in an in-memory Map. The Map is intentionally
 * not persisted — if the process restarts mid-run the engine's stall monitor
 * will detect silence and re-queue the job.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentPlugin,
  WorkOrder,
  AgentStatus,
  AgentStatusState,
  PluginManifest,
  PluginContext,
  PluginHealth,
  DispatchId,
  InstanceId,
} from '@ouija/types';
import { dispatchId as makeDispatchId } from '@ouija/types';
import type { ClaudeAgentConfig } from './config.js';
import { claudeAgentConfigSchema } from './config.js';
import { buildCliArgs } from './work-order-builder.js';
import { spawnClaude } from './subprocess.js';
import type { SpawnClaudeOptions, SubprocessResult } from './subprocess.js';
import { HeartbeatReporter } from './heartbeat.js';
import { cloneRepo, createBranch } from './repo-manager.js';

// ---------------------------------------------------------------------------
// Internal state shape per dispatch
// ---------------------------------------------------------------------------

interface ActiveDispatch {
  dispatchId: DispatchId;
  workOrder: WorkOrder;
  state: AgentStatusState;
  startedAt: string;
  message?: string;
  abortController: AbortController;
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

export class ClaudeAgentPlugin implements AgentPlugin<ClaudeAgentConfig> {
  readonly manifest: PluginManifest = {
    name: '@ouija/plugin-agent-claude',
    version: '0.1.0',
    type: 'agent',
    coreApiVersion: '>=1.0.0 <2.0.0',
    configSchema: claudeAgentConfigSchema as unknown as Record<string, unknown>,
    events: {
      produces: [
        'agent.work.progress',
        'agent.work.pr_ready',
        'agent.work.completed',
        'agent.work.failed',
      ],
      consumes: [],
    },
  };

  private config!: ClaudeAgentConfig;
  private logger!: PluginContext['logger'];

  /**
   * Active dispatches keyed by dispatchId string.
   * Completed/failed/cancelled dispatches are removed on stop().
   */
  private activeDispatches = new Map<string, ActiveDispatch>();

  // ---- Overridable for testing ----

  /** Override to inject a mock subprocess runner. */
  _spawnFn: (options: SpawnClaudeOptions) => Promise<SubprocessResult> = spawnClaude;

  /** Override to inject a mock git clone. */
  _cloneFn: (url: string, targetDir: string, baseBranch: string) => Promise<void> =
    async (url, targetDir, baseBranch) => {
      await cloneRepo({ repoUrl: url, branch: baseBranch, targetDir });
    };

  /** Override to inject a mock branch creation. */
  _createBranchFn: (cwd: string, branch: string) => Promise<void> =
    async (cwd, branch) => {
      await createBranch(cwd, branch);
    };

  // ---- BasePlugin lifecycle ----

  async init(context: PluginContext<ClaudeAgentConfig>): Promise<void> {
    this.config = context.config;
    this.logger = context.logger;
  }

  async start(): Promise<void> {
    this.logger.info('Claude agent plugin started', {
      defaultModel: this.config.defaultModel,
    });
  }

  async stop(): Promise<void> {
    // Abort all in-flight agents. Each _runAgent will clean up its own temp
    // directory in its finally block.
    for (const [, dispatch] of this.activeDispatches) {
      dispatch.abortController.abort();
    }
    this.activeDispatches.clear();
    this.logger.info('Claude agent plugin stopped');
  }

  async healthCheck(): Promise<PluginHealth> {
    return {
      healthy: true,
      message: `${this.activeDispatches.size} active dispatch(es)`,
      details: {
        activeDispatches: this.activeDispatches.size,
      },
    };
  }

  // ---- AgentPlugin methods ----

  /**
   * Dispatch a work order. Returns a DispatchId immediately; agent execution
   * is asynchronous. The caller should poll getStatus() or wait for callbacks.
   */
  async dispatch(workOrder: WorkOrder): Promise<DispatchId> {
    const id = makeDispatchId(randomUUID());
    const abortController = new AbortController();

    const activeDispatch: ActiveDispatch = {
      dispatchId: id,
      workOrder,
      state: 'dispatching',
      startedAt: new Date().toISOString(),
      abortController,
    };

    this.activeDispatches.set(String(id), activeDispatch);

    // Fire-and-forget: run the agent in the background so dispatch() returns
    // immediately with the ID.
    this._runAgent(activeDispatch).catch((err: unknown) => {
      this.logger.error('Unexpected error in agent run', {
        dispatchId: String(id),
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return id;
  }

  /**
   * Cancel an in-flight dispatch. Best-effort — the subprocess may have already
   * exited or the AbortSignal may be ignored by the binary.
   */
  async cancel(id: DispatchId): Promise<void> {
    const dispatch = this.activeDispatches.get(String(id));
    if (dispatch) {
      dispatch.abortController.abort();
      dispatch.state = 'cancelled';
      this.logger.info('Dispatch cancelled', { dispatchId: String(id) });
    }
  }

  /**
   * Get the current status of a dispatch. Returns `idle` state for unknown IDs.
   */
  async getStatus(id: DispatchId): Promise<AgentStatus> {
    const dispatch = this.activeDispatches.get(String(id));
    if (!dispatch) {
      return {
        dispatchId: id,
        instanceId: '' as InstanceId,
        state: 'idle',
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      dispatchId: dispatch.dispatchId,
      instanceId: dispatch.workOrder.instanceId as unknown as InstanceId,
      state: dispatch.state,
      ...(dispatch.message !== undefined ? { message: dispatch.message } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  // ---- Internal agent execution ----

  private async _runAgent(dispatch: ActiveDispatch): Promise<void> {
    const { workOrder } = dispatch;
    let cloneDir: string | undefined;

    const reporter = new HeartbeatReporter(
      workOrder.callbackUrl,
      workOrder.callbackToken,
      String(workOrder.instanceId),
      String(dispatch.dispatchId),
    );

    try {
      dispatch.state = 'running';
      await reporter.reportProgress('Agent acknowledged work order');

      // 1. Create temp directory for the repo clone.
      const workDirBase = this.config.workDir ?? tmpdir();
      cloneDir = await mkdtemp(join(workDirBase, 'ouija-agent-'));

      // 2. Clone the repo (checking out baseBranch).
      await reporter.reportProgress('Cloning repository...');
      await this._cloneFn(workOrder.repoUrl, cloneDir, workOrder.baseBranch);

      // 3. Create the feature branch.
      await this._createBranchFn(cloneDir, workOrder.branch);
      await reporter.reportProgress(`Created branch ${workOrder.branch}`);

      // 4. Resolve API key.
      // In production this would call a credential store using workOrder.secretRef.
      // For now we read from the process environment as a fallback.
      const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
      const cliArgs = buildCliArgs(workOrder, cloneDir, apiKey);

      // 5. Start periodic heartbeat (every 30 s).
      reporter.startInterval(30_000);

      // 6. Spawn Claude Code CLI.
      await reporter.reportProgress('Running Claude Code...');
      const result = await this._spawnFn({
        prompt: cliArgs.prompt,
        cwd: cliArgs.cwd,
        env: cliArgs.env,
        timeoutMs: cliArgs.timeoutMs,
        ...(this.config.claudeBinaryPath !== undefined
          ? { binaryPath: this.config.claudeBinaryPath }
          : {}),
        signal: dispatch.abortController.signal,
        onOutput: (chunk) => {
          // Track the last output chunk for status reporting.
          dispatch.message = chunk.slice(0, 200);
        },
      });

      // 7. Stop heartbeat before reporting final state.
      reporter.stopInterval();

      if (result.timedOut) {
        await reporter.reportFailed(
          `Agent timed out after ${Math.round(result.durationMs / 1_000)}s`,
          /* retryable */ true,
        );
        dispatch.state = 'failed';
        return;
      }

      if (result.exitCode !== 0) {
        await reporter.reportFailed(
          `Claude CLI exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
          /* retryable */ true,
        );
        dispatch.state = 'failed';
        return;
      }

      // 8. Success.
      await reporter.reportCompleted();
      dispatch.state = 'completed';
    } catch (err: unknown) {
      reporter.stopInterval();
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('Agent execution error', {
        dispatchId: String(dispatch.dispatchId),
        error: errorMsg,
      });

      // Best-effort failure report — if the callback itself fails (network
      // outage, expired JWT), the stall monitor will detect the silence.
      try {
        await reporter.reportFailed(errorMsg, /* retryable */ true);
      } catch {
        // Swallow — stall monitor handles this case.
      }
      dispatch.state = 'failed';
    } finally {
      // Always remove the temp directory regardless of outcome.
      if (cloneDir) {
        try {
          await rm(cloneDir, { recursive: true, force: true });
        } catch {
          this.logger.warn('Failed to remove clone directory', { cloneDir });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin factory (required by PluginLoader)
// ---------------------------------------------------------------------------

export const PluginFactory = {
  manifest: new ClaudeAgentPlugin().manifest,
  create: (): ClaudeAgentPlugin => new ClaudeAgentPlugin(),
};

export default PluginFactory;
