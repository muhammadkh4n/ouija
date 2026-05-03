import { describe, expect, it } from 'vitest';
import {
  KeychainProvider,
  buildKeychainArgs,
  diagnoseKeychainExit,
} from '../../src/identity/keychain-provider.js';
import type { KeychainRunner } from '../../src/identity/keychain-provider.js';

const okJson = JSON.stringify({ claudeAiOauth: { accessToken: 'kc-at' } });

function fakeRunner(impl: KeychainRunner): KeychainRunner {
  return impl;
}

describe('buildKeychainArgs', () => {
  it('builds the default arg list (no -a)', () => {
    expect(buildKeychainArgs({ service: 'Claude Code-credentials' })).toEqual([
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w',
    ]);
  });

  it('adds -a <account> when provided', () => {
    expect(
      buildKeychainArgs({ service: 'Claude Code-credentials', account: 'me@example.com' }),
    ).toEqual([
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-a',
      'me@example.com',
      '-w',
    ]);
  });

  it('omits -a when account is empty string', () => {
    const args = buildKeychainArgs({ service: 'Claude Code-credentials', account: '' });
    expect(args).not.toContain('-a');
  });
});

describe('diagnoseKeychainExit', () => {
  it('maps exit 44 to a "not found / never logged in" message', () => {
    expect(diagnoseKeychainExit(44, '')).toMatch(/not found/);
    expect(diagnoseKeychainExit(44, '')).toMatch(/claude \/login/);
  });

  it('maps exit 51 to an ACL / GUI-prompt diagnosis', () => {
    expect(diagnoseKeychainExit(51, '')).toMatch(/ACL/);
    expect(diagnoseKeychainExit(51, '')).toMatch(/Keychain Access\.app/);
  });

  it('maps exit 36 to a locked-keychain message', () => {
    expect(diagnoseKeychainExit(36, '')).toMatch(/locked/);
    expect(diagnoseKeychainExit(36, '')).toMatch(/unlock-keychain/);
  });

  it('falls back to a generic exit + stderr-tail message for unknown codes', () => {
    expect(diagnoseKeychainExit(7, 'something weird happened')).toMatch(/exited with code 7/);
    expect(diagnoseKeychainExit(7, 'something weird happened')).toMatch(/something weird happened/);
  });

  it('truncates very long stderr to 400 chars', () => {
    const long = 'x'.repeat(2000);
    const out = diagnoseKeychainExit(7, long);
    // Slice of last 400 chars: still all `x`s, but capped.
    const stderrSection = out.split('stderr: ')[1] ?? '';
    expect(stderrSection.length).toBeLessThanOrEqual(400);
  });
});

describe('KeychainProvider', () => {
  it('isAvailable returns false on non-darwin', async () => {
    const p = new KeychainProvider({ kind: 'keychain' }, { platform: 'linux' });
    expect(await p.isAvailable()).toBe(false);
  });

  it('isAvailable returns true on darwin', async () => {
    const p = new KeychainProvider({ kind: 'keychain' }, { platform: 'darwin' });
    expect(await p.isAvailable()).toBe(true);
  });

  it('resolve throws on non-darwin without spawning anything', async () => {
    let runnerCalled = false;
    const runner = fakeRunner(async () => {
      runnerCalled = true;
      return { stdout: okJson, stderr: '', exitCode: 0, timedOut: false };
    });
    const p = new KeychainProvider({ kind: 'keychain' }, { runner, platform: 'linux' });
    await expect(p.resolve()).rejects.toThrow(/only available on macOS/);
    expect(runnerCalled).toBe(false);
  });

  it('resolve returns the parsed payload on exit 0', async () => {
    const runner = fakeRunner(async () => ({
      stdout: okJson,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
    const p = new KeychainProvider({ kind: 'keychain' }, { runner, platform: 'darwin' });
    const resolved = await p.resolve();
    expect(resolved).toEqual({
      credentials: { claudeAiOauth: { accessToken: 'kc-at' } },
      envOverrides: {},
      source: 'keychain',
    });
  });

  it('resolve uses the configured service and binary', async () => {
    const seen: { bin: string; args: readonly string[] }[] = [];
    const runner = fakeRunner(async (bin, args) => {
      seen.push({ bin, args });
      return { stdout: okJson, stderr: '', exitCode: 0, timedOut: false };
    });
    const p = new KeychainProvider(
      { kind: 'keychain', service: 'Custom-svc', securityBin: '/opt/security' },
      { runner, platform: 'darwin' },
    );
    await p.resolve();
    expect(seen[0]).toEqual({
      bin: '/opt/security',
      args: ['find-generic-password', '-s', 'Custom-svc', '-w'],
    });
  });

  it('resolve throws on timeout with the GUI-prompt hint', async () => {
    const runner = fakeRunner(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: true,
    }));
    const p = new KeychainProvider(
      { kind: 'keychain', timeoutMs: 250 },
      { runner, platform: 'darwin' },
    );
    await expect(p.resolve()).rejects.toThrow(/timed out after 250ms/);
    await expect(p.resolve()).rejects.toThrow(/Keychain GUI prompt/);
  });

  it('resolve throws with diagnosed exit code on non-zero', async () => {
    const runner = fakeRunner(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 44,
      timedOut: false,
    }));
    const p = new KeychainProvider({ kind: 'keychain' }, { runner, platform: 'darwin' });
    await expect(p.resolve()).rejects.toThrow(/not found/);
  });

  it('resolve throws when stdout is empty even with exit 0', async () => {
    const runner = fakeRunner(async () => ({
      stdout: '   \n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
    const p = new KeychainProvider({ kind: 'keychain' }, { runner, platform: 'darwin' });
    await expect(p.resolve()).rejects.toThrow(/empty stdout/);
  });

  it('resolve throws on invalid JSON in stdout', async () => {
    const runner = fakeRunner(async () => ({
      stdout: 'not-json{',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
    const p = new KeychainProvider({ kind: 'keychain' }, { runner, platform: 'darwin' });
    await expect(p.resolve()).rejects.toThrow(/not valid JSON/);
  });

  it('resolve throws on empty-object JSON', async () => {
    const runner = fakeRunner(async () => ({
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
    const p = new KeychainProvider({ kind: 'keychain' }, { runner, platform: 'darwin' });
    await expect(p.resolve()).rejects.toThrow(/empty or not an object/);
  });

  it('kind is "keychain"', () => {
    const p = new KeychainProvider({ kind: 'keychain' }, { platform: 'darwin' });
    expect(p.kind).toBe('keychain');
  });
});
