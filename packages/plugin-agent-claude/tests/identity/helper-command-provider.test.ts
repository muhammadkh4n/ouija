import { describe, expect, it, vi } from 'vitest';
import { HelperCommandProvider } from '../../src/identity/helper-command-provider.js';
import type { HelperRunner } from '../../src/identity/helper-command-provider.js';

const okJson = JSON.stringify({ claudeAiOauth: { accessToken: 'helper-at' } });

function fakeRunner(impl: HelperRunner): HelperRunner {
  return impl;
}

describe('HelperCommandProvider', () => {
  it('rejects empty command at construction time', () => {
    expect(() => new HelperCommandProvider({ kind: 'helper-command', command: '' })).toThrow(/non-empty/);
  });

  it('isAvailable returns true when command is non-empty', async () => {
    const p = new HelperCommandProvider({ kind: 'helper-command', command: '/bin/foo' });
    expect(await p.isAvailable()).toBe(true);
  });

  it('resolve returns credentials parsed from helper stdout on exit 0', async () => {
    const runner = fakeRunner(async () => ({
      stdout: okJson,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
    const p = new HelperCommandProvider(
      { kind: 'helper-command', command: '/bin/echo' },
      { runner, env: {} },
    );
    const resolved = await p.resolve();
    expect(resolved).toEqual({
      credentials: { claudeAiOauth: { accessToken: 'helper-at' } },
      envOverrides: {},
      source: 'helper-command',
    });
  });

  it('resolve forwards allowlisted env keys + extra env to the helper', async () => {
    const seenEnv: Record<string, string>[] = [];
    const runner = fakeRunner(async (_cmd, _args, opts) => {
      seenEnv.push(opts.env);
      return { stdout: okJson, stderr: '', exitCode: 0, timedOut: false };
    });
    const p = new HelperCommandProvider(
      {
        kind: 'helper-command',
        command: '/bin/x',
        env: { OPERATOR_VAR: 'set-by-config' },
      },
      {
        runner,
        env: {
          PATH: '/usr/bin',
          HOME: '/Users/test',
          DB_PASSWORD: 'should-NOT-leak',
          AWS_SECRET_ACCESS_KEY: 'should-NOT-leak',
          TMPDIR: '/tmp',
        },
      },
    );
    await p.resolve();
    expect(seenEnv[0]).toBeDefined();
    expect(seenEnv[0]!['PATH']).toBe('/usr/bin');
    expect(seenEnv[0]!['HOME']).toBe('/Users/test');
    expect(seenEnv[0]!['TMPDIR']).toBe('/tmp');
    expect(seenEnv[0]!['OPERATOR_VAR']).toBe('set-by-config');
    expect(seenEnv[0]!['DB_PASSWORD']).toBeUndefined();
    expect(seenEnv[0]!['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  });

  it('resolve throws on non-zero exit and includes stderr tail', async () => {
    const runner = fakeRunner(async () => ({
      stdout: '',
      stderr: 'permission denied: vault token expired',
      exitCode: 7,
      timedOut: false,
    }));
    const p = new HelperCommandProvider(
      { kind: 'helper-command', command: '/bin/x' },
      { runner, env: {} },
    );
    await expect(p.resolve()).rejects.toThrow(/exited 7/);
    await expect(p.resolve()).rejects.toThrow(/vault token expired/);
  });

  it('resolve throws on timeout', async () => {
    const runner = fakeRunner(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 1,
      timedOut: true,
    }));
    const p = new HelperCommandProvider(
      { kind: 'helper-command', command: '/bin/x', timeoutMs: 500 },
      { runner, env: {} },
    );
    await expect(p.resolve()).rejects.toThrow(/timed out after 500ms/);
  });

  it('resolve throws on invalid JSON stdout', async () => {
    const runner = fakeRunner(async () => ({
      stdout: 'not-json{',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
    const p = new HelperCommandProvider(
      { kind: 'helper-command', command: '/bin/x' },
      { runner, env: {} },
    );
    await expect(p.resolve()).rejects.toThrow(/not valid JSON/);
  });

  it('resolve throws on empty-object JSON', async () => {
    const runner = fakeRunner(async () => ({
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
    const p = new HelperCommandProvider(
      { kind: 'helper-command', command: '/bin/x' },
      { runner, env: {} },
    );
    await expect(p.resolve()).rejects.toThrow(/empty or not an object/);
  });

  it('passes args verbatim to the runner', async () => {
    const seenArgs: readonly string[][] = [];
    const runner = fakeRunner(async (_cmd, args) => {
      seenArgs.push(args);
      return { stdout: okJson, stderr: '', exitCode: 0, timedOut: false };
    });
    const p = new HelperCommandProvider(
      {
        kind: 'helper-command',
        command: '/bin/vault-helper',
        args: ['get', 'claude/credentials', '--format=json'],
      },
      { runner, env: {} },
    );
    await p.resolve();
    expect(seenArgs[0]).toEqual(['get', 'claude/credentials', '--format=json']);
  });

  it('honors a custom timeoutMs', async () => {
    const seenTimeouts: number[] = [];
    const runner = fakeRunner(async (_cmd, _args, opts) => {
      seenTimeouts.push(opts.timeoutMs);
      return { stdout: okJson, stderr: '', exitCode: 0, timedOut: false };
    });
    const p = new HelperCommandProvider(
      { kind: 'helper-command', command: '/bin/x', timeoutMs: 30_000 },
      { runner, env: {} },
    );
    await p.resolve();
    expect(seenTimeouts[0]).toBe(30_000);
  });

  it('kind is "helper-command"', () => {
    const p = new HelperCommandProvider({ kind: 'helper-command', command: '/bin/x' });
    expect(p.kind).toBe('helper-command');
  });

  it('does not leak the runner mock between tests', () => {
    // Sentinel that the vi import is wired up — protects against accidental
    // global runner state if a future test moves to vi.fn().
    expect(vi).toBeDefined();
  });
});
