# Workspace Abstraction Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `WorkspaceProvider` and `AgentRunner` abstractions so the agent execution pipeline supports both local (self-hosted) and remote (E2B/SaaS) execution through the same interfaces, without changing observable behavior.

**Architecture:** Extract the monolithic `ClaudeAgentPlugin._runAgent()` method into two pluggable interfaces: `WorkspaceProvider` (provisions where the agent runs) and `AgentRunner` (executes the agent inside the workspace). The current local subprocess flow is reimplemented as `LocalWorkspaceProvider` + `LocalAgentRunner`. The pipeline state machine gains a `provisioning` state. A `destroy_workspace` side effect is added for cleanup. All existing tests continue to pass unchanged.

**Tech Stack:** TypeScript 5.5+, Vitest, existing Ouija monorepo conventions

**Spec:** `docs/superpowers/specs/2026-04-02-remote-execution-research.md`

---

## File Structure

```
packages/
  types/src/
    workspace.ts              (NEW)  — WorkspaceProvider, AgentRunner, Workspace, WorkspaceSpec interfaces
    agent.ts                  (MOD)  — Add 'provisioning' to AgentStatusState, extend WorkOrder with optional workspaceSpec
    state-machine.ts          (MOD)  — Add 'provisioning' to PipelineState union, 'destroy_workspace' to SideEffectType
    index.ts                  (MOD)  — Export workspace.ts
  types/tests/
    workspace.test.ts         (NEW)  — Type-level tests (compile-time checks)

  engine/src/
    transition.ts             (MOD)  — Handle provisioning state transitions
    stall-monitor.ts          (MOD)  — Account for provisioning time in stall threshold
  engine/tests/
    transition.test.ts        (MOD)  — Tests for new provisioning transitions

  workspace-local/            (NEW PACKAGE)
    package.json
    tsconfig.json
    src/
      index.ts                (NEW)  — Barrel exports
      local-workspace.ts      (NEW)  — LocalWorkspaceProvider (extracted from _runAgent clone/branch/cleanup)
      local-runner.ts         (NEW)  — LocalAgentRunner (extracted from _runAgent spawnClaude)
    tests/
      local-workspace.test.ts (NEW)  — Unit tests for provision/destroy
      local-runner.test.ts    (NEW)  — Unit tests for run/cancel

  plugin-agent-claude/src/
    index.ts                  (MOD)  — Refactor _runAgent to use WorkspaceProvider + AgentRunner
    config.ts                 (MOD)  — Add executionMode field

  agent-worker/src/
    work-order-assembler.ts   (MOD)  — Pass workspaceSpec through from agent profile
```

---

### Task 1: Define WorkspaceProvider and AgentRunner interfaces

**Files:**
- Create: `packages/types/src/workspace.ts`
- Modify: `packages/types/src/index.ts`

- [ ] **Step 1: Create workspace.ts with interfaces**

```typescript
// packages/types/src/workspace.ts

/**
 * Workspace abstraction layer — decouples WHERE an agent runs from HOW it runs.
 *
 * Local: tmpdir + git clone + cleanup (self-hosted)
 * Remote: E2B sandbox / Codespace / VM (SaaS)
 *
 * Both implementations share the same interfaces so the plugin doesn't care.
 */

// ---- Workspace lifecycle ----

export type WorkspaceType = 'local' | 'e2b' | 'codespace' | 'actions';

export interface WorkspaceSpec {
  /** Type of workspace to provision. */
  type: WorkspaceType;
  /** Git clone URL for the repo. */
  repoUrl: string;
  /** Branch to check out after cloning. */
  baseBranch: string;
  /** Feature branch the agent will create. */
  featureBranch: string;
  /** Resource hints — ignored by local, used by remote providers. */
  resources?: {
    cpu?: number;
    memoryMb?: number;
    diskGb?: number;
  };
  /** Container image or template name. Ignored by local provider. */
  image?: string;
  /** Max time to wait for provisioning (ms). Default: 120_000 (2 min). */
  provisionTimeoutMs?: number;
}

export interface Workspace {
  /** Unique identifier for this workspace instance. */
  id: string;
  /** Which provider created this workspace. */
  type: WorkspaceType;
  /**
   * For local: absolute filesystem path to the cloned repo.
   * For remote: an opaque handle the AgentRunner uses (sandbox ID, SSH target, etc).
   */
  endpoint: string;
  /** ISO timestamp when the workspace should auto-destroy. Undefined = no auto-expiry. */
  expiresAt?: string;
}

export interface WorkspaceHealth {
  alive: boolean;
  message?: string;
}

/**
 * Provisions and tears down execution environments.
 *
 * Implementations:
 *  - LocalWorkspaceProvider: tmpdir + git clone (packages/workspace-local)
 *  - E2BWorkspaceProvider: Firecracker microVM (packages/workspace-e2b, future)
 */
export interface WorkspaceProvider {
  /** Which workspace type this provider handles. */
  readonly type: WorkspaceType;

  /**
   * Provision a workspace: create directory/VM, clone repo, checkout base branch,
   * create feature branch.
   *
   * Throws on failure (timeout, git auth error, resource exhaustion, etc).
   */
  provision(spec: WorkspaceSpec): Promise<Workspace>;

  /**
   * Tear down a workspace. MUST be idempotent — calling destroy on an already-
   * destroyed workspace is a no-op (no throw).
   */
  destroy(workspaceId: string): Promise<void>;

  /**
   * Check if a workspace is still alive and responsive.
   * For local: checks if the directory exists.
   * For remote: pings the sandbox/VM API.
   */
  healthCheck(workspaceId: string): Promise<WorkspaceHealth>;
}

// ---- Agent runner ----

export interface AgentRunOptions {
  /** External cancellation signal. */
  signal?: AbortSignal;
  /** Called with each output chunk from the agent. */
  onOutput?: (chunk: string) => void;
}

export interface AgentRunResult {
  /** Process exit code. */
  exitCode: number;
  /** Accumulated stdout. */
  stdout: string;
  /** Accumulated stderr. */
  stderr: string;
  /** Whether the agent was killed due to timeout. */
  timedOut: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/**
 * Executes an agent inside an already-provisioned workspace.
 *
 * Implementations:
 *  - LocalAgentRunner: spawns Claude Code CLI as child process (packages/workspace-local)
 *  - RemoteAgentRunner: runs commands via E2B SDK (packages/workspace-e2b, future)
 */
export interface AgentRunner {
  /**
   * Execute the agent in the given workspace.
   *
   * @param workspace  Provisioned workspace from WorkspaceProvider.provision()
   * @param prompt     Full prompt text to send to the agent.
   * @param env        Environment variables (ANTHROPIC_API_KEY, etc).
   * @param timeoutMs  Kill the agent after this many milliseconds.
   * @param options    Cancellation signal and output callback.
   */
  run(
    workspace: Workspace,
    prompt: string,
    env: Record<string, string>,
    timeoutMs: number,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult>;
}
```

- [ ] **Step 2: Export from index.ts**

Add to `packages/types/src/index.ts`:

```typescript
export * from './workspace.js';
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/ouija && npx turbo run build --filter=@ouija-dev/types`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/workspace.ts packages/types/src/index.ts
git commit -m "feat(types): add WorkspaceProvider and AgentRunner interfaces"
```

---

### Task 2: Add `provisioning` state to the pipeline state machine

**Files:**
- Modify: `packages/types/src/state-machine.ts`
- Modify: `packages/types/src/agent.ts`
- Modify: `packages/engine/src/transition.ts`
- Modify: `packages/engine/tests/transition.test.ts`

- [ ] **Step 1: Add `provisioning` to PipelineState union**

In `packages/types/src/state-machine.ts`, add a new union member after the `idle` line (line 7):

```typescript
export type PipelineState =
  | { status: 'idle' }
  | { status: 'provisioning'; dispatchId: DispatchId; agentId: AgentId; dispatchedAt: string; workspaceId?: string }
  | { status: 'dispatching'; dispatchId: DispatchId; agentId: AgentId; dispatchedAt: string }
  | { status: 'running'; dispatchId: DispatchId; agentId: AgentId; dispatchedAt: string; lastHeartbeatAt: string }
  | { status: 'succeeded'; dispatchId: DispatchId; agentId: AgentId; completedAt: string; prUrl?: string; cost?: number; tokensUsed?: number }
  | { status: 'failed'; dispatchId: DispatchId; agentId: AgentId; failedAt: string; error: string; retryable: boolean }
  | { status: 'stalled'; dispatchId: DispatchId; agentId: AgentId; stalledAt: string; lastHeartbeatAt: string }
  | { status: 'cancelled'; cancelledAt: string; cancelledBy: string };
```

- [ ] **Step 2: Add `provisioning` to AgentStatusState**

In `packages/types/src/agent.ts`, update the union (line 47):

```typescript
export type AgentStatusState =
  | 'idle'
  | 'provisioning'
  | 'dispatching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

- [ ] **Step 3: Add `destroy_workspace` and `provision_workspace` to SideEffectType**

In `packages/types/src/state-machine.ts`, update SideEffectType (line 50):

```typescript
export type SideEffectType =
  | 'move_card'
  | 'add_comment'
  | 'send_notification'
  | 'dispatch_agent'
  | 'cancel_agent'
  | 'destroy_workspace'
  | 'enqueue_stall_check'
  | 'cancel_stall_check';
```

- [ ] **Step 4: Add `workspace_provisioned` trigger**

In `packages/types/src/state-machine.ts`, add to the PipelineTrigger union (after line 30):

```typescript
export type PipelineTrigger =
  | { type: 'card_moved'; cardId: CardId; toColumnId: ColumnId; fromColumnId: ColumnId; guardContext: GuardContext }
  | { type: 'card_assigned'; cardId: CardId; assigneeId: string }
  | { type: 'workspace_provisioned'; dispatchId: DispatchId; workspaceId: string }
  | { type: 'agent_acknowledged'; dispatchId: DispatchId }
  | { type: 'agent_progress'; dispatchId: DispatchId; heartbeatAt: string; message: string }
  | { type: 'agent_pr_ready'; dispatchId: DispatchId; prUrl: string; prId: PrId }
  | { type: 'agent_completed'; dispatchId: DispatchId; cost?: number; tokensUsed?: number }
  | { type: 'agent_failed'; dispatchId: DispatchId; error: string; retryable: boolean }
  | { type: 'stall_detected'; dispatchId: DispatchId; detectedAt: string }
  | { type: 'human_retry'; retriedBy: string }
  | { type: 'human_cancel'; cancelledBy: string }
  | { type: 'pr_merged'; prId: PrId; mergedAt: string };
```

- [ ] **Step 5: Write failing tests for new transitions**

Add to `packages/engine/tests/transition.test.ts`:

```typescript
describe('workspace_provisioned trigger', () => {
  it('transitions from provisioning to dispatching', () => {
    const state: PipelineState = {
      status: 'provisioning',
      dispatchId: makeDispatchId('d-1'),
      agentId: makeAgentId('a-1'),
      dispatchedAt: '2026-04-02T00:00:00Z',
      workspaceId: 'ws-local-abc',
    };
    const trigger: PipelineTrigger = {
      type: 'workspace_provisioned',
      dispatchId: makeDispatchId('d-1'),
      workspaceId: 'ws-local-abc',
    };
    const result = transition(state, trigger, defaultConfig);

    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.nextState.status).toBe('dispatching');
    }
  });

  it('rejects workspace_provisioned from non-provisioning state', () => {
    const state: PipelineState = { status: 'idle' };
    const trigger: PipelineTrigger = {
      type: 'workspace_provisioned',
      dispatchId: makeDispatchId('d-1'),
      workspaceId: 'ws-local-abc',
    };
    const result = transition(state, trigger, defaultConfig);
    expect(result.rejected).toBe(true);
  });

  it('rejects workspace_provisioned with mismatched dispatchId', () => {
    const state: PipelineState = {
      status: 'provisioning',
      dispatchId: makeDispatchId('d-1'),
      agentId: makeAgentId('a-1'),
      dispatchedAt: '2026-04-02T00:00:00Z',
    };
    const trigger: PipelineTrigger = {
      type: 'workspace_provisioned',
      dispatchId: makeDispatchId('d-WRONG'),
      workspaceId: 'ws-local-abc',
    };
    const result = transition(state, trigger, defaultConfig);
    expect(result.rejected).toBe(true);
  });
});

describe('provisioning state in cancel', () => {
  it('cancels pipeline in provisioning state with destroy_workspace side effect', () => {
    const state: PipelineState = {
      status: 'provisioning',
      dispatchId: makeDispatchId('d-1'),
      agentId: makeAgentId('a-1'),
      dispatchedAt: '2026-04-02T00:00:00Z',
      workspaceId: 'ws-local-abc',
    };
    const trigger: PipelineTrigger = {
      type: 'human_cancel',
      cancelledBy: 'user-1',
    };
    const result = transition(state, trigger, defaultConfig);

    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.nextState.status).toBe('cancelled');
      const types = result.sideEffects.map((e) => e.type);
      expect(types).toContain('destroy_workspace');
      expect(types).toContain('cancel_stall_check');
    }
  });
});

describe('stall_detected from provisioning', () => {
  it('transitions from provisioning to stalled', () => {
    const state: PipelineState = {
      status: 'provisioning',
      dispatchId: makeDispatchId('d-1'),
      agentId: makeAgentId('a-1'),
      dispatchedAt: '2026-04-02T00:00:00Z',
    };
    const trigger: PipelineTrigger = {
      type: 'stall_detected',
      dispatchId: makeDispatchId('d-1'),
      detectedAt: '2026-04-02T00:10:00Z',
    };
    const result = transition(state, trigger, defaultConfig);

    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.nextState.status).toBe('stalled');
    }
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/ouija && npx vitest run packages/engine/tests/transition.test.ts`
Expected: New tests FAIL (workspace_provisioned handler not yet implemented).

- [ ] **Step 7: Implement transition handlers for new states**

In `packages/engine/src/transition.ts`, add the `workspace_provisioned` case to the switch statement (after line 40):

```typescript
    case 'workspace_provisioned':
      return handleWorkspaceProvisioned(state, trigger);
```

Add the handler function:

```typescript
function handleWorkspaceProvisioned(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'workspace_provisioned' }>,
): TransitionOutcome {
  if (state.status !== 'provisioning') {
    return {
      rejected: true,
      reason: `Cannot mark workspace provisioned: pipeline is in state "${state.status}", expected "provisioning"`,
    };
  }

  if (state.dispatchId !== trigger.dispatchId) {
    return {
      rejected: true,
      reason: `Dispatch ID mismatch: expected "${state.dispatchId}", got "${trigger.dispatchId}"`,
    };
  }

  const nextState: PipelineState = {
    status: 'dispatching',
    dispatchId: state.dispatchId,
    agentId: state.agentId,
    dispatchedAt: state.dispatchedAt,
  };

  return {
    rejected: false,
    nextState,
    events: [],
    sideEffects: [],
  };
}
```

Update `handleStallDetected` to accept `provisioning` state (line 420 — change the condition):

```typescript
  if (state.status !== 'running' && state.status !== 'dispatching' && state.status !== 'provisioning') {
    return {
      rejected: true,
      reason: `Cannot mark stalled: pipeline is in state "${state.status}", expected "running", "dispatching", or "provisioning"`,
    };
  }
```

Update `handleHumanCancel` to emit `destroy_workspace` for provisioning state. In the block starting at line 524, add `provisioning`:

```typescript
  // Active states have an agent/workspace that needs cancelling
  if (state.status === 'provisioning' || state.status === 'dispatching' || state.status === 'running') {
    if (state.status === 'provisioning' && 'workspaceId' in state && state.workspaceId) {
      sideEffects.push({
        type: 'destroy_workspace',
        payload: { workspaceId: state.workspaceId },
        idempotencyKey: `destroy-ws-${state.dispatchId}`,
      });
    }
    sideEffects.push(
      {
        type: 'cancel_agent',
        payload: { dispatchId: state.dispatchId },
        idempotencyKey: `cancel-agent-${state.dispatchId}`,
      },
      {
        type: 'cancel_stall_check',
        payload: { dispatchId: state.dispatchId },
        idempotencyKey: `cancel-stall-cancel-${state.dispatchId}`,
      },
    );
  }
```

- [ ] **Step 8: Run all engine tests**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/ouija && npx vitest run packages/engine/`
Expected: ALL tests pass (new and existing).

- [ ] **Step 9: Commit**

```bash
git add packages/types/src/state-machine.ts packages/types/src/agent.ts \
       packages/engine/src/transition.ts packages/engine/tests/transition.test.ts
git commit -m "feat(engine): add provisioning state and workspace_provisioned trigger"
```

---

### Task 3: Create `workspace-local` package — LocalWorkspaceProvider

**Files:**
- Create: `packages/workspace-local/package.json`
- Create: `packages/workspace-local/tsconfig.json`
- Create: `packages/workspace-local/src/index.ts`
- Create: `packages/workspace-local/src/local-workspace.ts`
- Create: `packages/workspace-local/tests/local-workspace.test.ts`

- [ ] **Step 1: Scaffold package**

```json
// packages/workspace-local/package.json
{
  "name": "@ouija-dev/workspace-local",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@ouija-dev/types": "workspace:*"
  }
}
```

```json
// packages/workspace-local/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "references": [
    { "path": "../types" }
  ]
}
```

- [ ] **Step 2: Write failing tests for LocalWorkspaceProvider**

```typescript
// packages/workspace-local/tests/local-workspace.test.ts

import { describe, it, expect, vi, afterEach } from 'vitest';
import { LocalWorkspaceProvider } from '../src/local-workspace.js';
import type { WorkspaceSpec } from '@ouija-dev/types';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseSpec: WorkspaceSpec = {
  type: 'local',
  repoUrl: 'https://github.com/test/repo.git',
  baseBranch: 'main',
  featureBranch: 'ouija/test-123',
};

describe('LocalWorkspaceProvider', () => {
  const destroyed: string[] = [];

  afterEach(async () => {
    // Clean up any workspaces that weren't destroyed in the test
    const provider = new LocalWorkspaceProvider();
    for (const id of destroyed) {
      await provider.destroy(id).catch(() => {});
    }
    destroyed.length = 0;
  });

  it('has type "local"', () => {
    const provider = new LocalWorkspaceProvider();
    expect(provider.type).toBe('local');
  });

  it('provisions a workspace with git clone and branch', async () => {
    const cloneFn = vi.fn<[string, string, string], Promise<void>>().mockResolvedValue(undefined);
    const branchFn = vi.fn<[string, string], Promise<void>>().mockResolvedValue(undefined);

    const provider = new LocalWorkspaceProvider({ cloneFn, branchFn });
    const workspace = await provider.provision(baseSpec);

    expect(workspace.type).toBe('local');
    expect(workspace.id).toMatch(/^ws-local-/);
    expect(workspace.endpoint).toBeTruthy();

    // Verify clone was called with correct args
    expect(cloneFn).toHaveBeenCalledOnce();
    expect(cloneFn.mock.calls[0][0]).toBe(baseSpec.repoUrl);
    expect(cloneFn.mock.calls[0][1]).toMatch(/ouija-ws-/); // temp dir
    expect(cloneFn.mock.calls[0][2]).toBe('main');

    // Verify branch was created
    expect(branchFn).toHaveBeenCalledOnce();
    expect(branchFn.mock.calls[0][1]).toBe('ouija/test-123');

    destroyed.push(workspace.id);
    await provider.destroy(workspace.id);
  });

  it('destroys a workspace by removing its directory', async () => {
    const cloneFn = vi.fn().mockResolvedValue(undefined);
    const branchFn = vi.fn().mockResolvedValue(undefined);

    const provider = new LocalWorkspaceProvider({ cloneFn, branchFn });
    const workspace = await provider.provision(baseSpec);

    // Directory should exist after provision
    const dirExists = await stat(workspace.endpoint).then(() => true).catch(() => false);
    expect(dirExists).toBe(true);

    await provider.destroy(workspace.id);

    // Directory should be gone after destroy
    const dirExistsAfter = await stat(workspace.endpoint).then(() => true).catch(() => false);
    expect(dirExistsAfter).toBe(false);
  });

  it('destroy is idempotent — double-destroy does not throw', async () => {
    const cloneFn = vi.fn().mockResolvedValue(undefined);
    const branchFn = vi.fn().mockResolvedValue(undefined);

    const provider = new LocalWorkspaceProvider({ cloneFn, branchFn });
    const workspace = await provider.provision(baseSpec);

    await provider.destroy(workspace.id);
    await provider.destroy(workspace.id); // should not throw
  });

  it('healthCheck returns alive=true for existing workspace', async () => {
    const cloneFn = vi.fn().mockResolvedValue(undefined);
    const branchFn = vi.fn().mockResolvedValue(undefined);

    const provider = new LocalWorkspaceProvider({ cloneFn, branchFn });
    const workspace = await provider.provision(baseSpec);

    const health = await provider.healthCheck(workspace.id);
    expect(health.alive).toBe(true);

    await provider.destroy(workspace.id);
  });

  it('healthCheck returns alive=false for destroyed workspace', async () => {
    const cloneFn = vi.fn().mockResolvedValue(undefined);
    const branchFn = vi.fn().mockResolvedValue(undefined);

    const provider = new LocalWorkspaceProvider({ cloneFn, branchFn });
    const workspace = await provider.provision(baseSpec);
    await provider.destroy(workspace.id);

    const health = await provider.healthCheck(workspace.id);
    expect(health.alive).toBe(false);
  });

  it('healthCheck returns alive=false for unknown workspace', async () => {
    const provider = new LocalWorkspaceProvider();
    const health = await provider.healthCheck('ws-local-nonexistent');
    expect(health.alive).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/ouija && npx vitest run packages/workspace-local/`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement LocalWorkspaceProvider**

```typescript
// packages/workspace-local/src/local-workspace.ts

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceProvider, WorkspaceSpec, Workspace, WorkspaceHealth } from '@ouija-dev/types';

// ---- Injectable git operations (for testing) ----

export type CloneFn = (repoUrl: string, targetDir: string, baseBranch: string) => Promise<void>;
export type BranchFn = (dir: string, branchName: string) => Promise<void>;

export interface LocalWorkspaceOptions {
  /** Base directory for temp workspace dirs. Defaults to os.tmpdir(). */
  baseDir?: string;
  /** Override git clone — inject a mock for testing. */
  cloneFn?: CloneFn;
  /** Override branch creation — inject a mock for testing. */
  branchFn?: BranchFn;
}

// Default implementations delegate to git CLI (same as repo-manager.ts)
async function defaultClone(repoUrl: string, targetDir: string, baseBranch: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const GIT_ENV_ALLOWLIST = ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'LANG', 'LC_ALL', 'TMPDIR'];
  const env: Record<string, string | undefined> = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env['GIT_TERMINAL_PROMPT'] = '0';

  await execFileAsync('git', ['clone', '--branch', baseBranch, '--single-branch', '--depth', '1', repoUrl, targetDir], {
    env: env as NodeJS.ProcessEnv,
  });
}

async function defaultBranch(dir: string, branchName: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  await execFileAsync('git', ['checkout', '-b', branchName], { cwd: dir });
}

// ---- LocalWorkspaceProvider ----

export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly type = 'local' as const;

  private readonly baseDir: string;
  private readonly cloneFn: CloneFn;
  private readonly branchFn: BranchFn;

  /** Tracks provisioned workspaces: id → filesystem path. */
  private readonly workspaces = new Map<string, string>();

  constructor(options?: LocalWorkspaceOptions) {
    this.baseDir = options?.baseDir ?? tmpdir();
    this.cloneFn = options?.cloneFn ?? defaultClone;
    this.branchFn = options?.branchFn ?? defaultBranch;
  }

  async provision(spec: WorkspaceSpec): Promise<Workspace> {
    const id = `ws-local-${randomUUID()}`;
    const dir = await mkdtemp(join(this.baseDir, 'ouija-ws-'));

    try {
      await this.cloneFn(spec.repoUrl, dir, spec.baseBranch);
      await this.branchFn(dir, spec.featureBranch);
    } catch (err) {
      // Cleanup on failed provision
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    this.workspaces.set(id, dir);

    return {
      id,
      type: 'local',
      endpoint: dir,
    };
  }

  async destroy(workspaceId: string): Promise<void> {
    const dir = this.workspaces.get(workspaceId);
    if (dir === undefined) return; // idempotent — already destroyed or unknown

    await rm(dir, { recursive: true, force: true });
    this.workspaces.delete(workspaceId);
  }

  async healthCheck(workspaceId: string): Promise<WorkspaceHealth> {
    const dir = this.workspaces.get(workspaceId);
    if (dir === undefined) {
      return { alive: false, message: 'Workspace not found' };
    }

    const exists = await stat(dir).then(() => true).catch(() => false);
    return exists
      ? { alive: true }
      : { alive: false, message: 'Workspace directory missing' };
  }
}
```

- [ ] **Step 5: Create barrel export**

```typescript
// packages/workspace-local/src/index.ts
export { LocalWorkspaceProvider } from './local-workspace.js';
export type { LocalWorkspaceOptions, CloneFn, BranchFn } from './local-workspace.js';
export { LocalAgentRunner } from './local-runner.js';
export type { LocalAgentRunnerOptions } from './local-runner.js';
```

- [ ] **Step 6: Run workspace tests**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/ouija && npm install && npx vitest run packages/workspace-local/tests/local-workspace.test.ts`
Expected: ALL local-workspace tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/workspace-local/
git commit -m "feat(workspace-local): add LocalWorkspaceProvider with tests"
```

---

### Task 4: Create `workspace-local` package — LocalAgentRunner

**Files:**
- Create: `packages/workspace-local/src/local-runner.ts`
- Create: `packages/workspace-local/tests/local-runner.test.ts`

- [ ] **Step 1: Write failing tests for LocalAgentRunner**

```typescript
// packages/workspace-local/tests/local-runner.test.ts

import { describe, it, expect, vi } from 'vitest';
import { LocalAgentRunner } from '../src/local-runner.js';
import type { Workspace, AgentRunResult } from '@ouija-dev/types';

const testWorkspace: Workspace = {
  id: 'ws-local-test',
  type: 'local',
  endpoint: '/tmp/test-workspace',
};

describe('LocalAgentRunner', () => {
  it('delegates to spawnFn with correct args', async () => {
    const mockResult: AgentRunResult = {
      exitCode: 0,
      stdout: 'done',
      stderr: '',
      timedOut: false,
      durationMs: 5000,
    };
    const spawnFn = vi.fn().mockResolvedValue(mockResult);

    const runner = new LocalAgentRunner({ spawnFn });
    const result = await runner.run(
      testWorkspace,
      'implement feature X',
      { ANTHROPIC_API_KEY: 'test-key' },
      60_000,
    );

    expect(spawnFn).toHaveBeenCalledOnce();
    const call = spawnFn.mock.calls[0][0];
    expect(call.prompt).toBe('implement feature X');
    expect(call.cwd).toBe('/tmp/test-workspace');
    expect(call.env.ANTHROPIC_API_KEY).toBe('test-key');
    expect(call.timeoutMs).toBe(60_000);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done');
  });

  it('passes abort signal through to spawnFn', async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 100,
    });
    const controller = new AbortController();

    const runner = new LocalAgentRunner({ spawnFn });
    await runner.run(
      testWorkspace,
      'test',
      {},
      60_000,
      { signal: controller.signal },
    );

    expect(spawnFn.mock.calls[0][0].signal).toBe(controller.signal);
  });

  it('passes onOutput through to spawnFn', async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 100,
    });
    const onOutput = vi.fn();

    const runner = new LocalAgentRunner({ spawnFn });
    await runner.run(
      testWorkspace,
      'test',
      {},
      60_000,
      { onOutput },
    );

    expect(spawnFn.mock.calls[0][0].onOutput).toBe(onOutput);
  });

  it('uses default binary path "claude"', async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 100,
    });

    const runner = new LocalAgentRunner({ spawnFn });
    await runner.run(testWorkspace, 'test', {}, 60_000);

    // Default: no binaryPath in options means spawnClaude uses 'claude'
    expect(spawnFn.mock.calls[0][0].binaryPath).toBeUndefined();
  });

  it('passes custom binaryPath when configured', async () => {
    const spawnFn = vi.fn().mockResolvedValue({
      exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 100,
    });

    const runner = new LocalAgentRunner({ spawnFn, binaryPath: '/usr/local/bin/claude' });
    await runner.run(testWorkspace, 'test', {}, 60_000);

    expect(spawnFn.mock.calls[0][0].binaryPath).toBe('/usr/local/bin/claude');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/ouija && npx vitest run packages/workspace-local/tests/local-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement LocalAgentRunner**

```typescript
// packages/workspace-local/src/local-runner.ts

import type { AgentRunner, Workspace, AgentRunOptions, AgentRunResult } from '@ouija-dev/types';
import type { SpawnClaudeOptions, SubprocessResult } from '@ouija-dev/plugin-agent-claude/src/subprocess.js';

// Re-export the spawnClaude function type for DI
export type SpawnFn = (options: SpawnClaudeOptions) => Promise<SubprocessResult>;

export interface LocalAgentRunnerOptions {
  /** Override the Claude subprocess spawner — inject a mock for testing. */
  spawnFn?: SpawnFn;
  /** Path to the claude binary. Defaults to "claude" (PATH lookup). */
  binaryPath?: string;
}

/**
 * Runs Claude Code CLI as a local child process inside a workspace directory.
 *
 * This is a thin adapter: it maps (Workspace, prompt, env, timeout) →
 * SpawnClaudeOptions and delegates to the existing spawnClaude() function.
 */
export class LocalAgentRunner implements AgentRunner {
  private readonly spawnFn: SpawnFn;
  private readonly binaryPath?: string;

  constructor(options?: LocalAgentRunnerOptions) {
    // Default: lazy-load spawnClaude to avoid circular dependency at import time
    this.spawnFn = options?.spawnFn ?? (async (opts) => {
      const { spawnClaude } = await import('@ouija-dev/plugin-agent-claude/src/subprocess.js');
      return spawnClaude(opts);
    });
    this.binaryPath = options?.binaryPath;
  }

  async run(
    workspace: Workspace,
    prompt: string,
    env: Record<string, string>,
    timeoutMs: number,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const spawnOptions: SpawnClaudeOptions = {
      prompt,
      cwd: workspace.endpoint,
      env,
      timeoutMs,
      ...(this.binaryPath !== undefined ? { binaryPath: this.binaryPath } : {}),
      signal: options?.signal,
      onOutput: options?.onOutput,
    };

    const result = await this.spawnFn(spawnOptions);

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/ouija && npx vitest run packages/workspace-local/`
Expected: ALL workspace-local tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace-local/src/local-runner.ts packages/workspace-local/tests/local-runner.test.ts \
       packages/workspace-local/src/index.ts
git commit -m "feat(workspace-local): add LocalAgentRunner with tests"
```

---

### Task 5: Refactor ClaudeAgentPlugin to use WorkspaceProvider + AgentRunner

**Files:**
- Modify: `packages/plugin-agent-claude/src/index.ts`
- Modify: `packages/plugin-agent-claude/src/config.ts`
- Modify: `packages/plugin-agent-claude/tests/plugin.test.ts`

This is the critical refactor. The monolithic `_runAgent()` method is decomposed into:
1. Provision workspace (via `WorkspaceProvider`)
2. Run agent (via `AgentRunner`)
3. Report result (via `HeartbeatReporter`)
4. Destroy workspace (via `WorkspaceProvider`)

- [ ] **Step 1: Add executionMode to config**

In `packages/plugin-agent-claude/src/config.ts`, add to `ClaudeAgentConfig` (after line 46):

```typescript
  /**
   * Execution mode: 'local' for subprocess, 'remote' for future SaaS providers.
   * Defaults to 'local'.
   */
  executionMode?: 'local' | 'remote';
```

Add to `claudeAgentConfigSchema.properties` (after the claudeBinaryPath property):

```typescript
    executionMode: {
      type: 'string',
      enum: ['local', 'remote'],
      description: 'Execution mode: local subprocess or remote sandbox',
    },
```

- [ ] **Step 2: Refactor ClaudeAgentPlugin to accept providers**

Replace the `_spawnFn`, `_cloneFn`, `_createBranchFn` pattern with `WorkspaceProvider` and `AgentRunner`. In `packages/plugin-agent-claude/src/index.ts`:

Replace lines 89-101 (the three overridable functions) with:

```typescript
  // ---- Pluggable execution strategy ----

  /** Workspace lifecycle provider. Set before start() or via config. */
  workspaceProvider!: WorkspaceProvider;

  /** Agent execution runner. Set before start() or via config. */
  agentRunner!: AgentRunner;
```

Update the imports at the top of the file to add:

```typescript
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
```

Update `init()` to set up providers:

```typescript
  async init(context: PluginContext<ClaudeAgentConfig>): Promise<void> {
    this.config = context.config;
    this.logger = context.logger;

    // Default: local execution (set externally for remote)
    if (!this.workspaceProvider) {
      const { LocalWorkspaceProvider } = await import('@ouija-dev/workspace-local');
      this.workspaceProvider = new LocalWorkspaceProvider({
        baseDir: this.config.workDir,
      });
    }
    if (!this.agentRunner) {
      const { LocalAgentRunner } = await import('@ouija-dev/workspace-local');
      this.agentRunner = new LocalAgentRunner({
        binaryPath: this.config.claudeBinaryPath,
      });
    }
  }
```

Update `ActiveDispatch` interface to track the workspace:

```typescript
interface ActiveDispatch {
  dispatchId: DispatchId;
  workOrder: WorkOrder;
  state: AgentStatusState;
  startedAt: string;
  message?: string;
  abortController: AbortController;
  workspace?: Workspace;
}
```

Replace the entire `_runAgent` method with:

```typescript
  private async _runAgent(dispatch: ActiveDispatch): Promise<void> {
    const { workOrder } = dispatch;

    const reporter = new HeartbeatReporter(
      workOrder.callbackUrl,
      workOrder.callbackToken,
      String(workOrder.instanceId),
      String(dispatch.dispatchId),
    );

    try {
      // 1. Provision workspace
      dispatch.state = 'provisioning';
      await reporter.reportProgress('Provisioning workspace...');

      const workspace = await this.workspaceProvider.provision({
        type: this.workspaceProvider.type,
        repoUrl: workOrder.repoUrl,
        baseBranch: workOrder.baseBranch,
        featureBranch: workOrder.branch,
      });
      dispatch.workspace = workspace;

      // 2. Run agent
      dispatch.state = 'running';
      await reporter.reportProgress('Running Claude Code...');
      reporter.startInterval(30_000);

      const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
      const prompt = buildPrompt(workOrder);

      const result = await this.agentRunner.run(
        workspace,
        prompt,
        { ANTHROPIC_API_KEY: apiKey },
        workOrder.maxDurationMs,
        {
          signal: dispatch.abortController.signal,
          onOutput: (chunk) => {
            dispatch.message = chunk.slice(0, 200);
          },
        },
      );

      reporter.stopInterval();

      // 3. Report result
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
      // 4. Always destroy workspace
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
```

Add the import for `buildPrompt`:

```typescript
import { buildPrompt } from './work-order-builder.js';
```

Remove the now-unused imports:

```typescript
// REMOVE these:
// import { buildCliArgs } from './work-order-builder.js';
// import { spawnClaude } from './subprocess.js';
// import type { SpawnClaudeOptions, SubprocessResult } from './subprocess.js';
// import { cloneRepo, createBranch } from './repo-manager.js';
```

Update `cancel()` to also destroy the workspace:

```typescript
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
```

- [ ] **Step 3: Update plugin tests**

In `packages/plugin-agent-claude/tests/plugin.test.ts`, update the `makePlugin()` helper to inject mock providers instead of mock functions:

```typescript
import type { WorkspaceProvider, AgentRunner, Workspace, WorkspaceSpec, WorkspaceHealth, AgentRunResult, AgentRunOptions } from '@ouija-dev/types';

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
    async destroy(id: string): Promise<void> {
      destroyCalls.push(id);
    },
    async healthCheck(): Promise<WorkspaceHealth> {
      return { alive: true };
    },
  };
}

function makeMockAgentRunner(result: AgentRunResult): AgentRunner & { runCalls: unknown[] } {
  const runCalls: unknown[] = [];
  return {
    runCalls,
    async run(workspace: Workspace, prompt: string, env: Record<string, string>, timeoutMs: number, options?: AgentRunOptions): Promise<AgentRunResult> {
      runCalls.push({ workspace, prompt, env, timeoutMs });
      return result;
    },
  };
}

async function makePlugin(runResult?: AgentRunResult) {
  const plugin = new ClaudeAgentPlugin();
  const ctx = createMockContext({
    secretRef: 'cred:test',
    defaultModel: 'claude-sonnet-4-20250514',
    maxDurationMs: 60_000,
    repoAccessTokens: {},
  });
  await plugin.init(ctx);

  const wsProvider = makeMockWorkspaceProvider();
  const agentRunner = makeMockAgentRunner(runResult ?? makeSuccessResult());

  plugin.workspaceProvider = wsProvider;
  plugin.agentRunner = agentRunner;

  return { plugin, wsProvider, agentRunner };
}
```

Update each test to use the new `makePlugin()` signature and verify provider calls instead of `_spawnFn`/`_cloneFn` calls. The test assertions should check:
- `wsProvider.provisionCalls` instead of `_cloneFn` calls
- `wsProvider.destroyCalls` instead of checking rm was called
- `agentRunner.runCalls` instead of `_spawnFn` calls

- [ ] **Step 4: Run all tests**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/ouija && npx vitest run`
Expected: ALL tests across all packages PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-agent-claude/ packages/workspace-local/
git commit -m "refactor(plugin-agent-claude): use WorkspaceProvider + AgentRunner abstractions"
```

---

### Task 6: Update stall monitor for provisioning-aware thresholds

**Files:**
- Modify: `packages/engine/src/stall-monitor.ts`
- Modify: `packages/engine/tests/stall-monitor.test.ts` (if exists, else engine tests)

- [ ] **Step 1: Update stall monitor to include provisioning state**

The `findStalledCandidates` query already searches for `dispatching` and `running` states. We need it to also catch `provisioning` state, but with a longer threshold to account for workspace cold-start time.

In `packages/engine/src/stall-monitor.ts`, update the `scan()` method to pass a separate provisioning threshold:

```typescript
  async scan(): Promise<void> {
    const cutoff = new Date(Date.now() - this.defaultStallThresholdMs);
    // Provisioning gets extra grace time (2x the default) for VM cold starts
    const provisioningCutoff = new Date(Date.now() - this.defaultStallThresholdMs * 2);

    this.logger.info('StallMonitor.scan running', {
      cutoff: cutoff.toISOString(),
      provisioningCutoff: provisioningCutoff.toISOString(),
    });

    let candidates: PipelineInstance[];
    try {
      candidates = await this.db.pipelines.findStalledCandidates(cutoff, provisioningCutoff);
    } catch (err) {
      this.logger.error('StallMonitor.scan: DB query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (candidates.length === 0) {
      this.logger.info('StallMonitor.scan: no stalled candidates found');
      return;
    }

    this.logger.warn('StallMonitor.scan: stalled candidates detected', {
      count: candidates.length,
      instanceIds: candidates.map((c) => String(c.id)),
    });

    await Promise.all(
      candidates.map((instance) =>
        this._triggerStall(instance).catch((err) => {
          this.logger.error('StallMonitor: failed to trigger stall for instance', {
            instanceId: String(instance.id),
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    );
  }
```

Update `_triggerStall` to also accept `provisioning`:

```typescript
  private async _triggerStall(instance: PipelineInstance): Promise<void> {
    const state = instance.state as PipelineState;

    if (state.status !== 'dispatching' && state.status !== 'running' && state.status !== 'provisioning') {
      this.logger.warn('StallMonitor._triggerStall: unexpected state, skipping', {
        instanceId: String(instance.id),
        status: state.status,
      });
      return;
    }

    const now = new Date().toISOString();
    const dispatchIdVal = makeDispatchId(state.dispatchId);

    await this.orchestrator.processStallDetected(String(instance.id), dispatchIdVal, now);
  }
```

- [ ] **Step 2: Run engine tests**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/ouija && npx vitest run packages/engine/`
Expected: ALL engine tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/stall-monitor.ts
git commit -m "fix(engine): stall monitor accounts for provisioning state with extended threshold"
```

---

### Task 7: Run full test suite and verify nothing is broken

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/ouija && npx vitest run`
Expected: ALL tests pass. No regressions.

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/ouija && npx turbo run build`
Expected: Build succeeds for all packages.

- [ ] **Step 3: Docker build smoke test**

Run: `cd /Users/muhammadkh4n/Projects/github/muhammadkh4n/ouija && docker compose -f docker/docker-compose.ouija.yml build ouija`
Expected: Docker image builds successfully.

---

## Summary of Changes

| What | Before | After |
|------|--------|-------|
| Agent execution | Monolithic `_runAgent()` | `WorkspaceProvider.provision()` → `AgentRunner.run()` → `WorkspaceProvider.destroy()` |
| Where agent runs | Local subprocess only | Pluggable: local (now), E2B/remote (future) |
| Pipeline states | 7 states | 8 states (+`provisioning`) |
| Side effects | 7 types | 8 types (+`destroy_workspace`) |
| Triggers | 11 types | 12 types (+`workspace_provisioned`) |
| New package | — | `packages/workspace-local` |

**What did NOT change:**
- The pure transition function contract
- The EventBus/JobQueue interfaces
- The WorkOrder type (extended, not modified — new fields are optional)
- The HeartbeatReporter
- The server routes
- The dashboard
- Any existing test assertions (new tests added, none modified)

**What's now possible that wasn't before:**
- Implement `E2BWorkspaceProvider` in a new `packages/workspace-e2b` package
- Swap it in via config: `executionMode: 'remote'`
- The engine, orchestrator, stall monitor, and dashboard all work unchanged
