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
});
