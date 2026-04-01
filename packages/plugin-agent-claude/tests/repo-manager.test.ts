/**
 * repo-manager.test.ts
 *
 * Tests git command construction and behaviour by mocking execFile via
 * vi.mock('node:child_process'). No real git operations are performed.
 *
 * What we verify:
 *  - The correct git subcommands and flags are assembled.
 *  - Credentials are never embedded in command arguments (only in env).
 *  - GIT_ASKPASS is threaded through when provided.
 *  - GIT_TERMINAL_PROMPT=0 is always set to prevent interactive prompts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cloneRepo, createBranch, pushBranch, configureGitIdentity } from '../src/repo-manager.js';

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------

// We need to capture calls to execFile. Because repo-manager uses
// `promisify(execFile)`, we mock the entire module and inspect what
// execFileAsync receives.

const mockExecFile = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    options: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    // Record the call so tests can inspect it
    mockExecFile(file, args, options);
    // Immediately resolve with empty stdout/stderr
    if (typeof options === 'function') {
      // overload: execFile(file, callback)
      (options as (err: Error | null, stdout: string, stderr: string) => void)(null, '', '');
    } else {
      callback(null, '', '');
    }
    // Return a dummy ChildProcess-like object
    return { on: vi.fn(), stdout: null, stderr: null, stdin: null };
  },
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => {
    // Return a promisified version that delegates to mockExecFile
    return (...args: unknown[]) => {
      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        mockExecFile(...args);
        resolve({ stdout: '', stderr: '' });
      });
    };
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lastCall(): { file: string; args: string[]; options: Record<string, unknown> } {
  const calls = mockExecFile.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('No calls recorded');
  return { file: last[0] as string, args: last[1] as string[], options: (last[2] ?? {}) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockExecFile.mockClear();
});

describe('cloneRepo', () => {
  it('calls git clone with correct arguments', async () => {
    await cloneRepo({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'main',
      targetDir: '/tmp/clone-abc',
    });

    const { file, args } = lastCall();
    expect(file).toBe('git');
    expect(args).toContain('clone');
    expect(args).toContain('--branch');
    expect(args).toContain('main');
    expect(args).toContain('--single-branch');
    expect(args).toContain('--depth');
    expect(args).toContain('1');
    expect(args).toContain('https://github.com/org/repo.git');
    expect(args).toContain('/tmp/clone-abc');
  });

  it('sets GIT_TERMINAL_PROMPT=0 to disable interactive prompts', async () => {
    await cloneRepo({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'main',
      targetDir: '/tmp/clone-abc',
    });

    const { options } = lastCall();
    const env = options['env'] as Record<string, string>;
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
  });

  it('does NOT embed access tokens in the git command arguments', async () => {
    await cloneRepo({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'main',
      targetDir: '/tmp/clone-abc',
    });

    const { args } = lastCall();
    // No arg should contain a token-like string
    const combined = args.join(' ');
    expect(combined).not.toMatch(/ghp_|Bearer |token=/i);
  });

  it('sets GIT_ASKPASS when gitAskPassScript is provided', async () => {
    await cloneRepo({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'main',
      targetDir: '/tmp/clone-abc',
      gitAskPassScript: '/usr/local/bin/ask-pass.sh',
    });

    const { options } = lastCall();
    const env = options['env'] as Record<string, string>;
    expect(env['GIT_ASKPASS']).toBe('/usr/local/bin/ask-pass.sh');
  });

  it('omits GIT_ASKPASS when no gitAskPassScript is provided', async () => {
    await cloneRepo({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'main',
      targetDir: '/tmp/clone-abc',
    });

    const { options } = lastCall();
    const env = options['env'] as Record<string, string>;
    expect(env['GIT_ASKPASS']).toBeUndefined();
  });
});

describe('createBranch', () => {
  it('calls git checkout -b with the branch name', async () => {
    await createBranch('/repo/dir', 'ouija/inst-abc');

    const { file, args, options } = lastCall();
    expect(file).toBe('git');
    expect(args).toEqual(['checkout', '-b', 'ouija/inst-abc']);
    expect(options['cwd']).toBe('/repo/dir');
  });

  it('uses the provided cwd', async () => {
    await createBranch('/workspace/my-repo', 'feature/xyz');

    const { options } = lastCall();
    expect(options['cwd']).toBe('/workspace/my-repo');
  });
});

describe('pushBranch', () => {
  it('calls git push with --set-upstream, remote, and branch', async () => {
    await pushBranch('/repo/dir', 'origin', 'ouija/inst-abc');

    const { file, args, options } = lastCall();
    expect(file).toBe('git');
    expect(args).toContain('push');
    expect(args).toContain('--set-upstream');
    expect(args).toContain('origin');
    expect(args).toContain('ouija/inst-abc');
    expect(options['cwd']).toBe('/repo/dir');
  });
});

describe('configureGitIdentity', () => {
  it('sets user.name first, then user.email', async () => {
    await configureGitIdentity('/repo/dir', 'Test Bot', 'bot@noreply.local');

    // Two calls expected: git config user.name, git config user.email
    const calls = mockExecFile.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const nameCall = calls[calls.length - 2];
    const emailCall = calls[calls.length - 1];

    expect(nameCall?.[1]).toEqual(['config', 'user.name', 'Test Bot']);
    expect(emailCall?.[1]).toEqual(['config', 'user.email', 'bot@noreply.local']);
  });

  it('uses default identity when no args are passed', async () => {
    await configureGitIdentity('/repo/dir');

    const calls = mockExecFile.mock.calls;
    const nameCall = calls[calls.length - 2];
    const emailCall = calls[calls.length - 1];

    expect(nameCall?.[1]).toContain('Ouija Agent');
    expect(emailCall?.[1]).toContain('ouija-agent@noreply.local');
  });
});
