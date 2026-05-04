import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  IdentityResolver,
  DEFAULT_CLAUDE_HOME_ROOT,
} from '../src/identity-resolver.js';
import type {
  AuthProvider,
  ResolvedIdentity,
} from '@ouija-dev/plugin-agent-claude';

class FakeProvider implements AuthProvider {
  public readonly kind = 'env' as const;
  public resolveCallCount = 0;

  constructor(private readonly result: ResolvedIdentity) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async resolve(): Promise<ResolvedIdentity> {
    this.resolveCallCount += 1;
    return this.result;
  }
}

describe('IdentityResolver', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ouija-identity-resolver-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exports the canonical compose path as the default root', () => {
    expect(DEFAULT_CLAUDE_HOME_ROOT).toBe('/run/ouija/claude-home');
  });

  it('materialises a per-dispatch home dir', async () => {
    const provider = new FakeProvider({
      credentials: { claudeAiOauth: { accessToken: 'at' } },
      envOverrides: {},
      source: 'env',
    });
    const resolver = new IdentityResolver(provider, { rootDir: dir });

    const result = await resolver.resolve('dispatch-123');

    expect(result.claudeHome).toBe(join(dir, 'dispatch-123'));
    expect(result.source).toBe('env');
    expect(result.ephemeral).toBe(true);

    const credsRaw = await fs.readFile(join(result.claudeHome, '.credentials.json'), 'utf8');
    expect(JSON.parse(credsRaw)).toEqual({ claudeAiOauth: { accessToken: 'at' } });
    const settingsRaw = await fs.readFile(join(result.claudeHome, 'settings.json'), 'utf8');
    expect(JSON.parse(settingsRaw)).toMatchObject({ hooks: {}, mcpServers: {} });
  });

  it('skips .credentials.json when provider returns null credentials (EnvProvider path)', async () => {
    const provider = new FakeProvider({
      credentials: null,
      envOverrides: { ANTHROPIC_API_KEY: 'sk-ant-x' },
      source: 'env',
    });
    const resolver = new IdentityResolver(provider, { rootDir: dir });

    const result = await resolver.resolve('dispatch-x');

    await expect(
      fs.stat(join(result.claudeHome, '.credentials.json')),
    ).rejects.toThrow();
    // Settings + .claude.json still written
    await fs.stat(join(result.claudeHome, 'settings.json'));
    await fs.stat(join(result.claudeHome, '.claude.json'));
  });

  it('caches the provider.resolve() result across dispatches', async () => {
    const provider = new FakeProvider({
      credentials: { claudeAiOauth: { accessToken: 'at' } },
      envOverrides: {},
      source: 'env',
    });
    const resolver = new IdentityResolver(provider, { rootDir: dir });

    await resolver.resolve('a');
    await resolver.resolve('b');
    await resolver.resolve('c');

    expect(provider.resolveCallCount).toBe(1);
  });

  it('produces distinct dirs per dispatch even with the same credentials', async () => {
    const provider = new FakeProvider({
      credentials: { claudeAiOauth: { accessToken: 'at' } },
      envOverrides: {},
      source: 'env',
    });
    const resolver = new IdentityResolver(provider, { rootDir: dir });

    const a = await resolver.resolve('dispatch-1');
    const b = await resolver.resolve('dispatch-2');

    expect(a.claudeHome).not.toBe(b.claudeHome);
    expect(a.claudeHome.endsWith('/dispatch-1')).toBe(true);
    expect(b.claudeHome.endsWith('/dispatch-2')).toBe(true);
  });

  it('rejects path-traversal dispatchIds', async () => {
    const provider = new FakeProvider({
      credentials: null,
      envOverrides: {},
      source: 'env',
    });
    const resolver = new IdentityResolver(provider, { rootDir: dir });

    await expect(resolver.resolve('../escape')).rejects.toThrow(/filesystem-safe/);
    await expect(resolver.resolve('a/b')).rejects.toThrow(/filesystem-safe/);
    await expect(resolver.resolve('')).rejects.toThrow(/filesystem-safe/);
  });

  it('getEnvOverrides returns the cached overlay', async () => {
    const provider = new FakeProvider({
      credentials: null,
      envOverrides: { ANTHROPIC_API_KEY: 'sk-ant-x' },
      source: 'env',
    });
    const resolver = new IdentityResolver(provider, { rootDir: dir });

    await resolver.resolve('d');
    expect(resolver.getEnvOverrides()).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-x' });
  });

  it('getEnvOverrides + getSource throw before any resolve()', () => {
    const provider = new FakeProvider({
      credentials: null,
      envOverrides: {},
      source: 'env',
    });
    const resolver = new IdentityResolver(provider, { rootDir: dir });

    expect(() => resolver.getEnvOverrides()).toThrow(/before any resolve/);
    expect(() => resolver.getSource()).toThrow(/before any resolve/);
  });

  it('getSource returns the cached source kind after resolve', async () => {
    const provider = new FakeProvider({
      credentials: { claudeAiOauth: { accessToken: 'at' } },
      envOverrides: {},
      source: 'keychain',
    });
    const resolver = new IdentityResolver(provider, { rootDir: dir });

    await resolver.resolve('d');
    expect(resolver.getSource()).toBe('keychain');
  });

  it('returns a fresh copy of envOverrides (mutation-safe)', async () => {
    const provider = new FakeProvider({
      credentials: null,
      envOverrides: { ANTHROPIC_API_KEY: 'sk-ant-x' },
      source: 'env',
    });
    const resolver = new IdentityResolver(provider, { rootDir: dir });

    await resolver.resolve('d');
    const first = resolver.getEnvOverrides();
    first['ANTHROPIC_API_KEY'] = 'mutated';

    const second = resolver.getEnvOverrides();
    expect(second['ANTHROPIC_API_KEY']).toBe('sk-ant-x');
  });
});
