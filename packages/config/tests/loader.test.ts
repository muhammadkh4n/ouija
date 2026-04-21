import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig } from '../src/loader.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

describe('loadConfig', () => {
  it('loads and parses valid YAML', async () => {
    const config = await loadConfig(resolve(fixturesDir, 'valid.yaml'));
    expect(config.claudeHome).toBe('/home/ouija/.claude');
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0]!.id).toBe('rex');
    expect(config.agents[0]!.auth.method).toBe('api-key');
  });

  it('defaults claudeHome to null when absent', async () => {
    const config = await loadConfig(resolve(fixturesDir, 'minimal.yaml'));
    expect(config.claudeHome).toBeNull();
  });

  it('throws on non-existent file', async () => {
    await expect(
      loadConfig(resolve(fixturesDir, 'does-not-exist.yaml')),
    ).rejects.toThrow('Config file not found');
  });

  it('throws on invalid config', async () => {
    await expect(
      loadConfig(resolve(fixturesDir, 'invalid-no-agents.yaml')),
    ).rejects.toThrow('Invalid config');
  });

  it('loads a runner: local config without throwing (deprecation warning is not fatal)', async () => {
    // Deprecation is a warning, not an error — the config must still load so
    // self-hosters can migrate on their own schedule. Dedicated assertions
    // for the warning content live in deprecations.test.ts (the pure
    // function is the test-friendly seam; emitWarning is I/O).
    const config = await loadConfig(resolve(fixturesDir, 'local-runner.yaml'));
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0]!.runner).toBe('local');
  });
});
