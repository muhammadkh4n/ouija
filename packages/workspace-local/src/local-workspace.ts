/**
 * LocalWorkspaceProvider — WorkspaceProvider implementation for self-hosted execution.
 *
 * Provisions isolated workspaces by:
 *  1. Creating a temp directory under baseDir (mkdtemp).
 *  2. Cloning the requested repo via `git clone --depth 1 --single-branch`.
 *  3. Creating the feature branch via `git checkout -b`.
 *
 * Security invariants:
 *  - All git CLI calls use execFile (not exec) to prevent shell injection.
 *  - The git environment uses an allowlist — only PATH, HOME, SSH_AUTH_SOCK,
 *    LANG, LC_ALL, TMPDIR are forwarded. GIT_TERMINAL_PROMPT=0 is always set.
 *  - If provisioning fails, the temp dir is cleaned up before the error propagates.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  WorkspaceProvider,
  WorkspaceSpec,
  Workspace,
  WorkspaceHealth,
} from '@ouija-dev/types';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Injectable clone function — allows tests to avoid real git operations. */
export type CloneFn = (repoUrl: string, targetDir: string, baseBranch: string) => Promise<void>;

/** Injectable branch creation function — allows tests to avoid real git operations. */
export type BranchFn = (dir: string, branchName: string) => Promise<void>;

/**
 * Injectable branch-reuse function. Distinct from BranchFn because "check out
 * an existing remote branch" and "create a new local branch" use different
 * git command sequences and we want tests to differentiate.
 */
export type ReuseBranchFn = (dir: string, branchName: string) => Promise<void>;

/** Injectable worktree creation function — allows tests to avoid real git operations. */
export type WorktreeFn = (repoPath: string, worktreeDir: string, branchName: string) => Promise<void>;

/** Injectable worktree removal function — allows tests to avoid real git operations. */
export type WorktreeRemoveFn = (repoPath: string, worktreeDir: string) => Promise<void>;

export interface LocalWorkspaceOptions {
  /** Base directory for temp workspace dirs. Defaults to os.tmpdir(). */
  baseDir?: string;
  /**
   * Custom clone implementation — useful for testing.
   * Defaults to `git clone --depth 1 --single-branch`.
   */
  cloneFn?: CloneFn;
  /**
   * Custom branch creation implementation — useful for testing.
   * Defaults to `git checkout -b`.
   */
  branchFn?: BranchFn;
  /**
   * Custom branch-reuse implementation — checks out an existing branch from
   * the remote. Defaults to `git fetch` + `git checkout -B <branch> origin/<branch>`.
   */
  reuseBranchFn?: ReuseBranchFn;
  /**
   * Custom worktree creation implementation — useful for testing.
   * Defaults to `git worktree add`.
   */
  worktreeFn?: WorktreeFn;
  /**
   * Custom worktree removal implementation — useful for testing.
   * Defaults to `git worktree remove --force`.
   */
  worktreeRemoveFn?: WorktreeRemoveFn;
}

// ---------------------------------------------------------------------------
// Default git helpers (production implementations)
// ---------------------------------------------------------------------------

/** Env keys forwarded to git — everything else is stripped. */
const GIT_ENV_ALLOWLIST = ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

function buildGitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  // Never prompt for credentials — fail fast on auth errors.
  env['GIT_TERMINAL_PROMPT'] = '0';
  return env;
}

async function defaultCloneFn(repoUrl: string, targetDir: string, baseBranch: string): Promise<void> {
  await execFileAsync(
    'git',
    [
      'clone',
      '--branch', baseBranch,
      '--single-branch',
      '--depth', '1',
      repoUrl,
      targetDir,
    ],
    { env: buildGitEnv() as NodeJS.ProcessEnv },
  );
}

async function defaultBranchFn(dir: string, branchName: string): Promise<void> {
  await execFileAsync(
    'git',
    ['checkout', '-b', branchName],
    { cwd: dir, env: buildGitEnv() as NodeJS.ProcessEnv },
  );
}

/**
 * Check out an existing remote branch in a workspace that was cloned on
 * baseBranch. Used by the review loop to re-enter an open PR.
 *
 * Sequence: fetch the single branch shallowly, then check it out tracking the
 * fetched ref. A subsequent `git push` on the agent side updates the PR.
 * If the fetch fails (branch doesn't exist on remote, auth error, etc.) the
 * caller logs and falls back to fresh-branch behaviour so the pipeline still
 * makes progress.
 */
async function defaultReuseBranchFn(dir: string, branchName: string): Promise<void> {
  // Fetch only the branch we want at depth 1 — keeps the operation fast even
  // on monorepos.
  await execFileAsync(
    'git',
    ['fetch', '--depth', '1', 'origin', branchName],
    { cwd: dir, env: buildGitEnv() as NodeJS.ProcessEnv },
  );
  await execFileAsync(
    'git',
    ['checkout', '-B', branchName, `origin/${branchName}`],
    { cwd: dir, env: buildGitEnv() as NodeJS.ProcessEnv },
  );
}

async function defaultWorktreeFn(repoPath: string, worktreeDir: string, branchName: string): Promise<void> {
  await execFileAsync(
    'git',
    ['worktree', 'add', worktreeDir, '-b', branchName],
    { cwd: repoPath, env: buildGitEnv() as NodeJS.ProcessEnv },
  );
}

async function defaultWorktreeRemoveFn(repoPath: string, worktreeDir: string): Promise<void> {
  await execFileAsync(
    'git',
    ['worktree', 'remove', worktreeDir, '--force'],
    { cwd: repoPath, env: buildGitEnv() as NodeJS.ProcessEnv },
  );
}

// ---------------------------------------------------------------------------
// LocalWorkspaceProvider
// ---------------------------------------------------------------------------

export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly type = 'local' as const;

  private readonly baseDir: string;
  private readonly cloneFn: CloneFn;
  private readonly branchFn: BranchFn;
  private readonly reuseBranchFn: ReuseBranchFn;
  private readonly worktreeFn: WorktreeFn;
  private readonly worktreeRemoveFn: WorktreeRemoveFn;

  /** Maps workspace id → absolute path of the temp dir. */
  private readonly workspacePaths = new Map<string, string>();

  /** Maps workspace id → source repo path for worktree-based workspaces. */
  private readonly worktreeSources = new Map<string, string>();

  constructor(options: LocalWorkspaceOptions = {}) {
    this.baseDir = options.baseDir ?? os.tmpdir();
    this.cloneFn = options.cloneFn ?? defaultCloneFn;
    this.branchFn = options.branchFn ?? defaultBranchFn;
    this.reuseBranchFn = options.reuseBranchFn ?? defaultReuseBranchFn;
    this.worktreeFn = options.worktreeFn ?? defaultWorktreeFn;
    this.worktreeRemoveFn = options.worktreeRemoveFn ?? defaultWorktreeRemoveFn;
  }

  /**
   * Provisions a workspace by creating a temp dir, cloning the repo, and
   * creating the feature branch. Cleans up the temp dir on any failure.
   */
  async provision(spec: WorkspaceSpec): Promise<Workspace> {
    if (!spec.repoUrl && !spec.repoPath) {
      throw new Error('WorkspaceSpec must include either repoUrl or repoPath');
    }

    const prefix = path.join(this.baseDir, 'ouija-ws-');
    const tempDir = await mkdtemp(prefix);
    const id = path.basename(tempDir);

    try {
      if (spec.repoPath) {
        // Worktree mode — create an isolated worktree from an existing local repo.
        await this.worktreeFn(spec.repoPath, tempDir, spec.featureBranch);
        this.worktreeSources.set(id, spec.repoPath);
      } else {
        // Clone mode — shallow clone from a remote URL.
        await this.cloneFn(spec.repoUrl!, tempDir, spec.baseBranch);
        if (spec.reuseFeatureBranch === true) {
          // Review-loop iteration: the featureBranch already exists on the
          // remote (the agent pushed to it last time). Check it out so
          // follow-up commits land on the same PR.
          try {
            await this.reuseBranchFn(tempDir, spec.featureBranch);
          } catch {
            // Fall back to creating the branch fresh if reuse fails — better
            // to dispatch a new branch than stall the pipeline. The PR won't
            // auto-update but the agent can still push a new branch.
            await this.branchFn(tempDir, spec.featureBranch);
          }
        } else {
          await this.branchFn(tempDir, spec.featureBranch);
        }
      }
    } catch (err) {
      // Cleanup on failure — leave no dangling directories.
      await rm(tempDir, { recursive: true, force: true });
      throw err;
    }

    this.workspacePaths.set(id, tempDir);

    return {
      id,
      type: 'local',
      endpoint: tempDir,
    };
  }

  /**
   * Destroys a workspace by removing its directory.
   * Idempotent — calling with an unknown or already-destroyed id is a no-op.
   */
  async destroy(workspaceId: string): Promise<void> {
    const dir = this.workspacePaths.get(workspaceId);
    if (dir === undefined) {
      // Unknown id — idempotent no-op.
      return;
    }

    const sourceRepo = this.worktreeSources.get(workspaceId);
    if (sourceRepo) {
      // Worktree-based workspace — detach worktree before removing.
      await this.worktreeRemoveFn(sourceRepo, dir);
      this.worktreeSources.delete(workspaceId);
    } else {
      // Clone-based workspace — rm -rf the directory.
      await rm(dir, { recursive: true, force: true });
    }

    this.workspacePaths.delete(workspaceId);
  }

  /** Returns alive=true only if the workspace directory still exists on disk. */
  async healthCheck(workspaceId: string): Promise<WorkspaceHealth> {
    const dir = this.workspacePaths.get(workspaceId);
    if (dir === undefined) {
      return { alive: false, message: `Unknown workspace: ${workspaceId}` };
    }
    try {
      await stat(dir);
      return { alive: true };
    } catch {
      return { alive: false, message: `Workspace directory does not exist: ${dir}` };
    }
  }
}
