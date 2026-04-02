/**
 * Workspace abstraction layer — decouples WHERE an agent runs from HOW it runs.
 *
 * Local: tmpdir + git clone + cleanup (self-hosted)
 * Remote: E2B sandbox / Codespace / VM (SaaS)
 */

// ---- Workspace domain types ----

/** Identifies which execution environment backs the workspace. */
export type WorkspaceType = 'local' | 'e2b' | 'codespace' | 'actions';

/** Declarative spec passed to a provider at provision time. */
export interface WorkspaceSpec {
  type: WorkspaceType;
  /** Git remote URL — the repo to clone into the workspace. */
  repoUrl: string;
  /** Branch to clone from (e.g. "main"). */
  baseBranch: string;
  /** Pre-created feature branch the agent will commit to. */
  featureBranch: string;
  /** Optional resource hints — providers may ignore if unsupported. */
  resources?: {
    cpu?: number;
    memoryMb?: number;
    diskGb?: number;
  };
  /** Container image or VM image identifier, provider-specific. */
  image?: string;
  /** How long to wait for the workspace to become ready before failing. */
  provisionTimeoutMs?: number;
}

/** A live workspace returned by a provider after provisioning. */
export interface Workspace {
  /** Opaque identifier assigned by the provider. */
  id: string;
  type: WorkspaceType;
  /**
   * For local: absolute filesystem path to the cloned repo.
   * For remote: an opaque handle the AgentRunner uses (sandbox ID, SSH target, etc).
   */
  endpoint: string;
  /** ISO-8601 timestamp — absent if the workspace has no TTL. */
  expiresAt?: string;
}

/** Result of a liveness check against a provisioned workspace. */
export interface WorkspaceHealth {
  alive: boolean;
  /** Human-readable detail when alive is false. */
  message?: string;
}

// ---- WorkspaceProvider interface ----

/**
 * Manages the lifecycle of execution environments.
 * One implementation per WorkspaceType (local, e2b, etc.).
 */
export interface WorkspaceProvider {
  /** Must match the WorkspaceType this provider handles. */
  readonly type: WorkspaceType;

  /**
   * Allocate and ready a workspace from the given spec.
   * Throws on failure (timeout, git auth error, resource exhaustion, etc).
   */
  provision(spec: WorkspaceSpec): Promise<Workspace>;

  /**
   * Tear down and release all resources for the given workspace.
   * MUST be idempotent — calling destroy on an already-destroyed or
   * unknown workspace MUST be a no-op (must not throw).
   */
  destroy(workspaceId: string): Promise<void>;

  /** Returns the current liveness of a provisioned workspace. */
  healthCheck(workspaceId: string): Promise<WorkspaceHealth>;
}

// ---- AgentRunner types ----

/** Per-run options that callers can attach to a run invocation. */
export interface AgentRunOptions {
  /** Cancellation signal — runner should abort cleanly on trigger. */
  signal?: AbortSignal;
  /** Called incrementally with stdout/stderr as the agent produces output. */
  onOutput?: (chunk: string) => void;
}

/** Terminal result produced when an agent run completes or times out. */
export interface AgentRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the run was stopped because timeoutMs was exceeded. */
  timedOut: boolean;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
}

// ---- AgentRunner interface ----

/**
 * Executes an agent inside a provisioned workspace.
 * Decoupled from how the workspace was provisioned.
 */
export interface AgentRunner {
  /**
   * Run the agent with the given prompt and environment.
   *
   * @param workspace  - Target workspace returned by a WorkspaceProvider.
   * @param prompt     - Full prompt / instructions for the agent.
   * @param env        - Environment variables injected into the agent process.
   * @param timeoutMs  - Hard wall-clock limit; runner must set timedOut=true if exceeded.
   * @param options    - Optional streaming and cancellation hooks.
   */
  run(
    workspace: Workspace,
    prompt: string,
    env: Record<string, string>,
    timeoutMs: number,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult>;
}
