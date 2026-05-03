import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CredentialFileProvider,
  defaultCredentialFilePath,
} from '../../src/identity/credential-file-provider.js';

describe('CredentialFileProvider', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ouija-cred-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults the path to <home>/.claude/.credentials.json', () => {
    const path = defaultCredentialFilePath('/Users/test');
    expect(path).toBe('/Users/test/.claude/.credentials.json');
  });

  it('isAvailable returns true when the file exists', async () => {
    const path = join(dir, 'creds.json');
    await fs.writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
    const p = new CredentialFileProvider({ kind: 'credential-file', path });
    expect(await p.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when the file does not exist', async () => {
    const p = new CredentialFileProvider({ kind: 'credential-file', path: join(dir, 'nope.json') });
    expect(await p.isAvailable()).toBe(false);
  });

  it('isAvailable returns false when the path is a directory, not a file', async () => {
    const p = new CredentialFileProvider({ kind: 'credential-file', path: dir });
    expect(await p.isAvailable()).toBe(false);
  });

  it('resolve parses the file and returns the credentials JSON', async () => {
    const path = join(dir, 'creds.json');
    const payload = {
      claudeAiOauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: 123,
        scopes: ['user:inference'],
      },
    };
    await fs.writeFile(path, JSON.stringify(payload));
    const p = new CredentialFileProvider({ kind: 'credential-file', path });
    const resolved = await p.resolve();
    expect(resolved).toEqual({
      credentials: payload,
      envOverrides: {},
      source: 'credential-file',
    });
  });

  it('resolve throws when the file is unreadable / missing', async () => {
    const p = new CredentialFileProvider({ kind: 'credential-file', path: join(dir, 'missing.json') });
    await expect(p.resolve()).rejects.toThrow(/cannot read/);
  });

  it('resolve throws on invalid JSON', async () => {
    const path = join(dir, 'broken.json');
    await fs.writeFile(path, 'not-json{');
    const p = new CredentialFileProvider({ kind: 'credential-file', path });
    await expect(p.resolve()).rejects.toThrow(/not valid JSON/);
  });

  it('resolve throws on an empty-object payload', async () => {
    const path = join(dir, 'empty.json');
    await fs.writeFile(path, '{}');
    const p = new CredentialFileProvider({ kind: 'credential-file', path });
    await expect(p.resolve()).rejects.toThrow(/not recognisable/);
  });

  it('preserves forward-compat unknown keys', async () => {
    const path = join(dir, 'creds.json');
    const payload = { claudeAiOauth: { accessToken: 'at' }, futureField: 'ok' };
    await fs.writeFile(path, JSON.stringify(payload));
    const p = new CredentialFileProvider({ kind: 'credential-file', path });
    const resolved = await p.resolve();
    expect(resolved.credentials).toEqual(payload);
  });

  it('kind is "credential-file"', () => {
    const p = new CredentialFileProvider({ kind: 'credential-file', path: '/x' });
    expect(p.kind).toBe('credential-file');
  });
});
