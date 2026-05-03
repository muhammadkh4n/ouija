import { describe, it, expect } from 'vitest';
import { EnvProvider } from '../../src/identity/env-provider.js';

describe('EnvProvider', () => {
  it('isAvailable returns true when the default env var is set', async () => {
    const p = new EnvProvider({ kind: 'env' }, { ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(await p.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when the env var is unset', async () => {
    const p = new EnvProvider({ kind: 'env' }, {});
    expect(await p.isAvailable()).toBe(false);
  });

  it('isAvailable returns false on empty string', async () => {
    const p = new EnvProvider({ kind: 'env' }, { ANTHROPIC_API_KEY: '' });
    expect(await p.isAvailable()).toBe(false);
  });

  it('resolve returns the env var value as ANTHROPIC_API_KEY', async () => {
    const p = new EnvProvider({ kind: 'env' }, { ANTHROPIC_API_KEY: 'sk-ant-abc' });
    const resolved = await p.resolve();
    expect(resolved).toEqual({
      credentials: null,
      envOverrides: { ANTHROPIC_API_KEY: 'sk-ant-abc' },
      source: 'env',
    });
  });

  it('honors a custom envVar config', async () => {
    const p = new EnvProvider(
      { kind: 'env', envVar: 'CUSTOM_KEY' },
      { CUSTOM_KEY: 'sk-ant-custom' },
    );
    const resolved = await p.resolve();
    expect(resolved.envOverrides).toEqual({ CUSTOM_KEY: 'sk-ant-custom' });
  });

  it('resolve throws when the env var is unset', async () => {
    const p = new EnvProvider({ kind: 'env' }, {});
    await expect(p.resolve()).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it('kind is "env"', () => {
    const p = new EnvProvider({ kind: 'env' }, {});
    expect(p.kind).toBe('env');
  });
});
