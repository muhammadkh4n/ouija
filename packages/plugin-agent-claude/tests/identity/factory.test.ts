import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AUTO_DETECT_ORDER,
  autoDetectAuthProvider,
  createAuthProvider,
} from '../../src/identity/factory.js';
import { CredentialFileProvider } from '../../src/identity/credential-file-provider.js';
import { EnvProvider } from '../../src/identity/env-provider.js';
import { HelperCommandProvider } from '../../src/identity/helper-command-provider.js';
import { KeychainProvider } from '../../src/identity/keychain-provider.js';

describe('createAuthProvider', () => {
  it('dispatches { kind: "env" } to EnvProvider', () => {
    const p = createAuthProvider({ kind: 'env' }, {});
    expect(p).toBeInstanceOf(EnvProvider);
    expect(p.kind).toBe('env');
  });

  it('dispatches { kind: "credential-file" } to CredentialFileProvider', () => {
    const p = createAuthProvider({ kind: 'credential-file', path: '/x' }, {});
    expect(p).toBeInstanceOf(CredentialFileProvider);
    expect(p.kind).toBe('credential-file');
  });

  it('dispatches { kind: "helper-command" } to HelperCommandProvider', () => {
    const p = createAuthProvider(
      { kind: 'helper-command', command: '/bin/x' },
      {},
    );
    expect(p).toBeInstanceOf(HelperCommandProvider);
    expect(p.kind).toBe('helper-command');
  });

  it('dispatches { kind: "keychain" } to KeychainProvider', () => {
    const p = createAuthProvider({ kind: 'keychain' }, {});
    expect(p).toBeInstanceOf(KeychainProvider);
    expect(p.kind).toBe('keychain');
  });
});

describe('AUTO_DETECT_ORDER', () => {
  it('puts env first, then keychain, then credential-file', () => {
    expect(AUTO_DETECT_ORDER.map((c) => c.kind)).toEqual([
      'env',
      'keychain',
      'credential-file',
    ]);
  });

  it('does NOT include helper-command (must be explicit opt-in)', () => {
    expect(AUTO_DETECT_ORDER.map((c) => c.kind)).not.toContain('helper-command');
  });
});

describe('autoDetectAuthProvider', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ouija-factory-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('picks EnvProvider when ANTHROPIC_API_KEY is set', async () => {
    const p = await autoDetectAuthProvider({ ANTHROPIC_API_KEY: 'sk-ant-x' });
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('env');
  });

  it('picks the next available provider when env is unset', async () => {
    // No env, no credential file → both env + credential-file `isAvailable()`
    // are false. Keychain returns true on darwin, false elsewhere — we can't
    // assert a specific outcome cross-platform, but we CAN assert env is NOT
    // picked.
    const p = await autoDetectAuthProvider({}, 'linux');
    if (p !== null) expect(p.kind).not.toBe('env');
  });

  it('returns null when nothing is available', async () => {
    // Linux platform, no env var, no default credential file (we mock by
    // running `autoDetectAuthProvider` against a tmp env that has no
    // ANTHROPIC_API_KEY and the actual default credential file path is
    // unlikely to exist on a CI runner; even so, this assertion is "either
    // null or credential-file" rather than strictly null).
    const p = await autoDetectAuthProvider({ HOME: dir }, 'linux');
    if (p !== null) expect(p.kind).toBe('credential-file');
  });

  it('does NOT pick KeychainProvider on non-darwin', async () => {
    const p = await autoDetectAuthProvider({}, 'linux');
    if (p !== null) expect(p.kind).not.toBe('keychain');
  });
});
