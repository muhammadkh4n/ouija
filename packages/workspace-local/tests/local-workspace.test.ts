/**
 * local-workspace.test.ts
 *
 * Tests for LocalWorkspaceProvider. Clone and branch operations are replaced
 * with injected mock functions so no real git operations are performed.
 * Temp directories ARE created on disk (we verify real fs behaviour), but
 * always cleaned up after each test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalWorkspaceProvider, type WorktreeFn, type WorktreeRemoveFn } from '../src/local-workspace.js';
import type { WorkspaceSpec } from '@ouija/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpec(overrides: Partial<WorkspaceSpec> = {}): WorkspaceSpec {
  return {
    type: 'local',
    repoUrl: 'https://github.com/org/repo.git',
    baseBranch: 'main',
    featureBranch: 'ouija/inst-abc',
    ...overrides,
  };
}

/** Checks whether a path exists on disk. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

let cloneFn: ReturnType<typeof vi.fn>;
let branchFn: ReturnType<typeof vi.fn>;
let provider: LocalWorkspaceProvider;
const createdDirs: string[] = [];

beforeEach(() => {
  cloneFn = vi.fn().mockResolvedValue(undefined);
  branchFn = vi.fn().mockResolvedValue(undefined);
  provider = new LocalWorkspaceProvider({
    baseDir: os.tmpdir(),
    cloneFn,
    branchFn,
  });
});

afterEach(async () => {
  // Clean up any directories created during the test.
  const { rm } = await import('node:fs/promises');
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  createdDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalWorkspaceProvider', () => {
  it('has type "local"', () => {
    expect(provider.type).toBe('local');
  });

  it('provisions a workspace with git clone and branch', async () => {
    const spec = makeSpec();
    const workspace = await provider.provision(spec);

    // Track for cleanup
    createdDirs.push(workspace.endpoint);

    // Workspace fields
    expect(workspace.type).toBe('local');
    expect(workspace.id).toBeTruthy();
    expect(workspace.endpoint).toBeTruthy();
    expect(path.isAbsolute(workspace.endpoint)).toBe(true);

    // Clone called with correct args
    expect(cloneFn).toHaveBeenCalledOnce();
    expect(cloneFn).toHaveBeenCalledWith(
      'https://github.com/org/repo.git',
      workspace.endpoint,
      'main',
    );

    // Branch called with correct args
    expect(branchFn).toHaveBeenCalledOnce();
    expect(branchFn).toHaveBeenCalledWith(workspace.endpoint, 'ouija/inst-abc');
  });

  it('creates a real temp directory on disk during provision', async () => {
    const workspace = await provider.provision(makeSpec());
    createdDirs.push(workspace.endpoint);

    expect(await pathExists(workspace.endpoint)).toBe(true);
  });

  it('destroys a workspace by removing its directory', async () => {
    const workspace = await provider.provision(makeSpec());

    // Don't add to createdDirs — destroy should handle cleanup.
    expect(await pathExists(workspace.endpoint)).toBe(true);

    await provider.destroy(workspace.id);

    expect(await pathExists(workspace.endpoint)).toBe(false);
  });

  it('destroy is idempotent — double-destroy does not throw', async () => {
    const workspace = await provider.provision(makeSpec());
    // First destroy
    await provider.destroy(workspace.id);
    // Second destroy — must not throw
    await expect(provider.destroy(workspace.id)).resolves.toBeUndefined();
  });

  it('destroy is a no-op for an unknown workspace id', async () => {
    await expect(provider.destroy('nonexistent-id')).resolves.toBeUndefined();
  });

  it('healthCheck returns alive=true for an existing workspace', async () => {
    const workspace = await provider.provision(makeSpec());
    createdDirs.push(workspace.endpoint);

    const health = await provider.healthCheck(workspace.id);
    expect(health.alive).toBe(true);
  });

  it('healthCheck returns alive=false for a destroyed workspace', async () => {
    const workspace = await provider.provision(makeSpec());
    await provider.destroy(workspace.id);

    // After destroy the id is removed from the map — unknown workspace.
    const health = await provider.healthCheck(workspace.id);
    expect(health.alive).toBe(false);
  });

  it('healthCheck returns alive=false for an unknown workspace', async () => {
    const health = await provider.healthCheck('unknown-id-xyz');
    expect(health.alive).toBe(false);
    expect(health.message).toBeTruthy();
  });

  it('cleans up temp dir on provision failure', async () => {
    const failingClone = vi.fn().mockRejectedValue(new Error('git auth failure'));
    const failProvider = new LocalWorkspaceProvider({
      baseDir: os.tmpdir(),
      cloneFn: failingClone,
      branchFn,
    });

    let capturedEndpoint: string | undefined;

    // Intercept mkdtemp to capture the created dir path.
    // We do this by observing what directories exist before vs after.
    // Simpler: provision rejects, and we verify no ouija-ws-* dirs leaked.
    // But we need the actual path to check. Instead, wrap provision and
    // check the error propagates + no workspace is tracked.

    await expect(failProvider.provision(makeSpec())).rejects.toThrow('git auth failure');

    // No workspace should be tracked after failure.
    // We verify this indirectly: healthCheck on any id returns alive=false.
    const health = await failProvider.healthCheck('any-id');
    expect(health.alive).toBe(false);
  });

  it('cleans up temp dir on provision failure (filesystem check)', async () => {
    // Track directories that exist before provisioning.
    const { readdir } = await import('node:fs/promises');
    const tmpDir = os.tmpdir();

    const before = new Set(await readdir(tmpDir));

    const failingClone = vi.fn().mockRejectedValue(new Error('network error'));
    const failProvider = new LocalWorkspaceProvider({
      baseDir: tmpDir,
      cloneFn: failingClone,
      branchFn,
    });

    await expect(failProvider.provision(makeSpec())).rejects.toThrow('network error');

    const after = await readdir(tmpDir);
    // Any ouija-ws-* dirs created during this provision attempt should be gone.
    const leaked = after.filter(
      (name) => name.startsWith('ouija-ws-') && !before.has(name),
    );
    expect(leaked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Worktree mode tests
// ---------------------------------------------------------------------------

describe('LocalWorkspaceProvider (worktree mode)', () => {
  it('provisions via git worktree when repoPath is set', async () => {
    const worktreeFn: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    const mockCloneFn: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    const mockBranchFn: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);

    const wtProvider = new LocalWorkspaceProvider({
      baseDir: os.tmpdir(),
      cloneFn: mockCloneFn,
      branchFn: mockBranchFn,
      worktreeFn,
    });

    const spec = makeSpec({
      repoUrl: undefined,
      repoPath: '/home/user/projects/my-repo',
    });
    const workspace = await wtProvider.provision(spec);
    createdDirs.push(workspace.endpoint);

    // Worktree function was called with correct args.
    expect(worktreeFn).toHaveBeenCalledOnce();
    expect(worktreeFn).toHaveBeenCalledWith(
      '/home/user/projects/my-repo',
      workspace.endpoint,
      'ouija/inst-abc',
    );

    // Clone and branch were NOT called.
    expect(mockCloneFn).not.toHaveBeenCalled();
    expect(mockBranchFn).not.toHaveBeenCalled();

    // Workspace endpoint starts with the ouija-ws- prefix.
    expect(path.basename(workspace.endpoint)).toMatch(/^ouija-ws-/);
  });

  it('destroys worktree workspace via git worktree remove', async () => {
    const worktreeFn: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
    const worktreeRemoveFn: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);

    const wtProvider = new LocalWorkspaceProvider({
      baseDir: os.tmpdir(),
      cloneFn: vi.fn().mockResolvedValue(undefined),
      branchFn: vi.fn().mockResolvedValue(undefined),
      worktreeFn,
      worktreeRemoveFn,
    });

    const spec = makeSpec({
      repoUrl: undefined,
      repoPath: '/home/user/projects/my-repo',
    });
    const workspace = await wtProvider.provision(spec);

    await wtProvider.destroy(workspace.id);

    // worktreeRemoveFn called with source repo path and workspace dir.
    expect(worktreeRemoveFn).toHaveBeenCalledOnce();
    expect(worktreeRemoveFn).toHaveBeenCalledWith(
      '/home/user/projects/my-repo',
      workspace.endpoint,
    );
  });

  it('throws when neither repoUrl nor repoPath is set', async () => {
    const wtProvider = new LocalWorkspaceProvider({
      baseDir: os.tmpdir(),
      cloneFn: vi.fn().mockResolvedValue(undefined),
      branchFn: vi.fn().mockResolvedValue(undefined),
    });

    const spec = makeSpec({ repoUrl: undefined, repoPath: undefined });

    await expect(wtProvider.provision(spec)).rejects.toThrow(
      'WorkspaceSpec must include either repoUrl or repoPath',
    );
  });
});
