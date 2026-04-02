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
} from '@ouija/types';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Injectable clone function — allows tests to avoid real git operations. */
export type CloneFn = (repoUrl: string, targetDir: string, baseBranch: string) => Promise<void>;

/** Injectable branch creation function — allows tests to avoid real git operations. */
export type BranchFn = (dir: string, branchName: string) => Promise<void>;

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
    { cwd: dir },
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

  /** Maps workspace id → absolute path of the temp dir. */
  private readonly workspacePaths = new Map<string, string>();

  constructor(options: LocalWorkspaceOptions = {}) {
    this.baseDir = options.baseDir ?? os.tmpdir();
    this.cloneFn = options.cloneFn ?? defaultCloneFn;
    this.branchFn = options.branchFn ?? defaultBranchFn;
  }

  /**
   * Provisions a workspace by creating a temp dir, cloning the repo, and
   * creating the feature branch. Cleans up the temp dir on any failure.
   */
  async provision(spec: WorkspaceSpec): Promise<Workspace> {
    const prefix = path.join(this.baseDir, 'ouija-ws-');
    const tempDir = await mkdtemp(prefix);
    const id = path.basename(tempDir);

    try {
      await this.cloneFn(spec.repoUrl, tempDir, spec.baseBranch);
      await this.branchFn(tempDir, spec.featureBranch);
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
    await rm(dir, { recursive: true, force: true });
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
