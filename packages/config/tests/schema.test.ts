import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { validateConfig } from '../src/schema.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

async function loadFixture(name: string): Promise<unknown> {
  const raw = await readFile(resolve(fixturesDir, name), 'utf-8');
  return parse(raw) as unknown;
}

describe('validateConfig', () => {
  it('accepts a valid config', async () => {
    const data = await loadFixture('valid.yaml');
    const result = validateConfig(data);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.config.claudeHome).toBe('/home/ouija/.claude');
      expect(result.config.agents).toHaveLength(1);
      expect(result.config.agents[0]!.id).toBe('rex');
    }
  });

  it('accepts a minimal config and defaults claudeHome to null', async () => {
    const data = await loadFixture('minimal.yaml');
    const result = validateConfig(data);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.config.claudeHome).toBeNull();
    }
  });

  it('rejects missing agents', async () => {
    const data = await loadFixture('invalid-no-agents.yaml');
    const result = validateConfig(data);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('agents'))).toBe(true);
    }
  });

  it('rejects invalid auth method', async () => {
    const data = await loadFixture('invalid-bad-auth.yaml');
    const result = validateConfig(data);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('method'))).toBe(true);
    }
  });

  it('rejects repo with both url and path', () => {
    const data = {
      agents: [
        {
          id: 'test-agent',
          name: 'Test',
          email: 'test@example.com',
          model: 'claude-sonnet-4-20250514',
          triggerMode: 'auto',
          auth: { method: 'api-key', secretRef: 'KEY' },
          repos: [
            {
              url: 'https://github.com/x/y.git',
              path: '/local/repo',
              baseBranch: 'main',
              default: true,
            },
          ],
          limits: { maxDurationMs: 120000 },
        },
      ],
    };
    const result = validateConfig(data);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('not both'))).toBe(true);
    }
  });

  it('rejects agent with no default repo', () => {
    const data = {
      agents: [
        {
          id: 'test-agent',
          name: 'Test',
          email: 'test@example.com',
          model: 'claude-sonnet-4-20250514',
          triggerMode: 'auto',
          auth: { method: 'api-key', secretRef: 'KEY' },
          repos: [
            {
              url: 'https://github.com/x/y.git',
              baseBranch: 'main',
            },
          ],
          limits: { maxDurationMs: 120000 },
        },
      ],
    };
    const result = validateConfig(data);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('default'))).toBe(true);
    }
  });

  it('rejects duplicate agent IDs', () => {
    const agent = {
      id: 'dupe',
      name: 'Dupe',
      email: 'dupe@example.com',
      model: 'claude-sonnet-4-20250514',
      triggerMode: 'auto' as const,
      auth: { method: 'api-key' as const, secretRef: 'KEY' },
      repos: [
        {
          url: 'https://github.com/x/y.git',
          baseBranch: 'main',
          default: true,
        },
      ],
      limits: { maxDurationMs: 120000 },
    };
    const data = { agents: [agent, { ...agent, name: 'Dupe 2' }] };
    const result = validateConfig(data);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('Duplicate agent ID'))).toBe(true);
    }
  });
});
