/**
 * ClaudeAgentPlugin — AgentPlugin implementation that dispatches work orders
 * to the Claude Code CLI via composable WorkspaceProvider and AgentRunner
 * abstractions.
 *
 * Lifecycle for each dispatch:
 *   1. Provision workspace (clone repo + create feature branch).
 *   2. Build the prompt and run the agent via AgentRunner.
 *   3. Run a 30-second heartbeat loop while the agent works.
 *   4. On exit: report completed/failed/timed-out back to the callback URL.
 *   5. Always destroy the workspace regardless of outcome.
 *
 * Active dispatches are tracked in an in-memory Map. The Map is intentionally
 * not persisted — if the process restarts mid-run the engine's stall monitor
 * will detect silence and re-queue the job.
 */

import { randomUUID } from 'node:crypto';
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
  WorkspaceProvider,
  AgentRunner,
  Workspace,
} from '@ouija-dev/types';

/**
 * Runner selection. Duplicated from @ouija-dev/config's RunnerType to avoid
 * a package dep from plugin-agent-claude to config. Keep in sync.
 */
type RunnerType = 'local' | 'stream-json' | 'sdk';

function parseRunnerType(raw: string | undefined): RunnerType | undefined {
  if (raw === 'local' || raw === 'stream-json' || raw === 'sdk') {
    return raw;
  }
  return undefined;
}
import { dispatchId as makeDispatchId } from '@ouija-dev/types';
import type { ClaudeAgentConfig } from './config.js';
import { claudeAgentConfigSchema } from './config.js';
import { buildPrompt } from './work-order-builder.js';
import { HeartbeatReporter } from './heartbeat.js';
import { buildAuthEnv } from './auth-env.js';

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
  workspace?: Workspace;
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

export class ClaudeAgentPlugin implements AgentPlugin<ClaudeAgentConfig> {
  readonly manifest: PluginManifest = {
    name: '@ouija-dev/plugin-agent-claude',
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

  /** Workspace lifecycle provider. Injected at init or set externally for testing. */
  workspaceProvider!: WorkspaceProvider;

  /**
   * Lazy runner cache. One instance per runner type is constructed on first
   * use and reused across dispatches. Exposed for tests so they can seed
   * the cache with a fake runner before calling dispatch.
   */
  readonly runnerCache = new Map<RunnerType, AgentRunner>();

  /**
   * Legacy injection point — when set externally (e.g. by tests), this
   * runner is used for ALL dispatches regardless of the work order's
   * runner metadata. Production code should not set this; it should let
   * `runnerCache` drive selection.
   */
  agentRunner?: AgentRunner;

  /** Default runner when the work order has no explicit choice. */
  private static readonly DEFAULT_RUNNER: RunnerType = 'stream-json';

  // ---- BasePlugin lifecycle ----

  async init(context: PluginContext<ClaudeAgentConfig>): Promise<void> {
    this.config = context.config;
    this.logger = context.logger;

    // Default: local filesystem workspace. Tests override by setting
    // workspaceProvider before init().
    if (!this.workspaceProvider) {
      const { LocalWorkspaceProvider } = await import('@ouija-dev/workspace-local');
      this.workspaceProvider = new LocalWorkspaceProvider(
        this.config.workDir !== undefined ? { baseDir: this.config.workDir } : {},
      );
    }
    // Runners are constructed lazily in getRunner(). No pre-building here —
    // this avoids paying import costs for runners that may never be used
    // (e.g. the SDK when all agents are configured for stream-json).
    this.logger.info('Claude agent plugin ready — runner selection is per-dispatch', {
      defaultRunner: ClaudeAgentPlugin.DEFAULT_RUNNER,
    });
  }

  /**
   * Resolve a runner by type, constructing and caching on first use.
   * Called by _runAgent() for each dispatch.
   */
  private async getRunner(type: RunnerType): Promise<AgentRunner> {
    // Test override: if agentRunner was explicitly set, use it unconditionally.
    if (this.agentRunner !== undefined) {
      return this.agentRunner;
    }

    const cached = this.runnerCache.get(type);
    if (cached !== undefined) return cached;

    let runner: AgentRunner;
    if (type === 'local') {
      const { LocalAgentRunner } = await import('@ouija-dev/workspace-local');
      runner = new LocalAgentRunner(
        this.config.claudeBinaryPath !== undefined
          ? { binaryPath: this.config.claudeBinaryPath }
          : {},
      );
      this.logger.info('Runner constructed: local (text-mode subprocess)');
    } else if (type === 'stream-json') {
      const { StreamJsonAgentRunner } = await import('@ouija-dev/workspace-local');
      runner = new StreamJsonAgentRunner(
        this.config.claudeBinaryPath !== undefined
          ? { binaryPath: this.config.claudeBinaryPath }
          : {},
      );
      this.logger.info(
        'Runner constructed: stream-json (structured events + subscription auth)',
      );
    } else if (type === 'sdk') {
      try {
        const { SdkAgentRunner } = await import('@ouija-dev/workspace-local');
        const { createRequire } = await import('node:module');
        const require = createRequire(process.cwd() + '/package.json');
        const cliPath = require.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
        runner = new SdkAgentRunner({
          model: this.config.defaultModel,
          executablePath: cliPath,
        });
        this.logger.info('Runner constructed: sdk (Claude Agent SDK)', { cliPath });
      } catch (err) {
        throw new Error(
          `runner: 'sdk' was requested but @anthropic-ai/claude-agent-sdk ` +
            `is not installed. Install the package or switch to runner: 'stream-json'. ` +
            `Details: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      throw new Error(
        `Unknown runner type: ${String(type)} — expected 'local', 'stream-json', or 'sdk'`,
      );
    }

    this.runnerCache.set(type, runner);
    return runner;
  }

  async start(): Promise<void> {
    this.logger.info('Claude agent plugin started', {
      defaultModel: this.config.defaultModel,
    });
  }

  async stop(): Promise<void> {
    // Abort all in-flight agents and destroy their workspaces.
    for (const [, dispatch] of this.activeDispatches) {
      dispatch.abortController.abort();
      if (dispatch.workspace) {
        await this.workspaceProvider.destroy(dispatch.workspace.id).catch(() => {});
      }
    }
    this.activeDispatches.clear();
    this.runnerCache.clear();
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
      if (dispatch.workspace) {
        await this.workspaceProvider.destroy(dispatch.workspace.id).catch(() => {});
      }
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

    // Use the pipeline's dispatch ID (from transition function) for callbacks,
    // NOT the plugin's internal dispatch ID. The orchestrator matches on this.
    const pipelineDispatchId = workOrder.metadata['pipelineDispatchId'] ?? String(dispatch.dispatchId);

    const reporter = new HeartbeatReporter(
      workOrder.callbackUrl,
      workOrder.callbackToken,
      String(workOrder.instanceId),
      pipelineDispatchId,
    );

    try {
      // 1. Provision workspace
      dispatch.state = 'provisioning';
      await reporter.reportProgress('Provisioning workspace...');

      const repoPath = workOrder.metadata['repoPath'] as string | undefined;
      const workspace = await this.workspaceProvider.provision({
        type: this.workspaceProvider.type,
        ...(repoPath ? { repoPath } : { repoUrl: workOrder.repoUrl }),
        baseBranch: workOrder.baseBranch,
        featureBranch: workOrder.branch,
      });
      dispatch.workspace = workspace;

      // 2. Assemble workspace config (agent .claude/ + task context)
      const { assembleWorkspaceConfig } = await import('./workspace-config.js');
      await assembleWorkspaceConfig({
        workspaceDir: workspace.endpoint,
        systemPrompt: workOrder.systemPrompt || undefined,
        configDir: workOrder.metadata['configDir'] || undefined,
        title: workOrder.title,
        description: workOrder.description,
        acceptanceCriteria: workOrder.acceptanceCriteria,
        branch: workOrder.branch,
        baseBranch: workOrder.baseBranch,
      });

      // 3. Acknowledge — transitions pipeline dispatching → running
      await reporter.reportAcknowledged();

      // 4. Run agent
      dispatch.state = 'running';
      await reporter.reportProgress('Running Claude Code...');
      reporter.startInterval(30_000);

      const prompt = buildPrompt(workOrder);

      // Translate auth method + secretRef into the correct env vars
      // (api-key, bedrock, vertex, foundry, proxy, api-key-helper).
      const authEnv = buildAuthEnv(
        workOrder.metadata['authMethod'],
        workOrder.secretRef,
      );
      const agentEnv: Record<string, string> = { ...authEnv };

      // Override HOME if claudeHome is configured (controls where ~/.claude/ resolves)
      const claudeHome = workOrder.metadata['claudeHome'];
      if (claudeHome) {
        agentEnv['HOME'] = claudeHome;
      }

      // Runner selection per dispatch from the work order's metadata.
      // Falls back to the plugin default (stream-json) when unset.
      const runnerType =
        parseRunnerType(workOrder.metadata['runner']) ??
        ClaudeAgentPlugin.DEFAULT_RUNNER;
      const runner = await this.getRunner(runnerType);

      const result = await runner.run(
        workspace,
        prompt,
        agentEnv,
        workOrder.maxDurationMs,
        {
          signal: dispatch.abortController.signal,
          onOutput: (chunk) => {
            dispatch.message = chunk.slice(0, 200);
          },
        },
      );

      reporter.stopInterval();

      // 5. Report result
      if (result.timedOut) {
        await reporter.reportFailed(
          `Agent timed out after ${Math.round(result.durationMs / 1_000)}s`,
          true,
        );
        dispatch.state = 'failed';
        return;
      }

      if (result.exitCode !== 0) {
        await reporter.reportFailed(
          `Claude CLI exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
          true,
        );
        dispatch.state = 'failed';
        return;
      }

      await reporter.reportCompleted();
      dispatch.state = 'completed';
    } catch (err: unknown) {
      reporter.stopInterval();
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('Agent execution error', {
        dispatchId: String(dispatch.dispatchId),
        error: errorMsg,
      });

      try {
        await reporter.reportFailed(errorMsg, true);
      } catch {
        // Swallow — stall monitor handles this case.
      }
      dispatch.state = 'failed';
    } finally {
      // 6. Always destroy workspace
      if (dispatch.workspace) {
        try {
          await this.workspaceProvider.destroy(dispatch.workspace.id);
        } catch {
          this.logger.warn('Failed to destroy workspace', {
            workspaceId: dispatch.workspace.id,
          });
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
