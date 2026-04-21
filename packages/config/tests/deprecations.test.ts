import { describe, it, expect } from 'vitest';
import {
  collectDeprecationWarnings,
  emitDeprecationWarnings,
} from '../src/deprecations.js';
import type { OuijaConfig, AgentProfileConfig, RunnerType } from '../src/types.js';

function agent(id: string, runner?: RunnerType): AgentProfileConfig {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    model: 'claude-sonnet-4-20250514',
    triggerMode: 'auto',
    ...(runner !== undefined ? { runner } : {}),
    auth: { method: 'api-key', secretRef: 'env:ANTHROPIC_API_KEY' },
    repos: [
      {
        url: 'https://github.com/example/repo',
        baseBranch: 'main',
        default: true,
      },
    ],
    limits: { maxDurationMs: 1_200_000 },
  };
}

function config(agents: AgentProfileConfig[]): OuijaConfig {
  return { claudeHome: null, agents };
}

describe('collectDeprecationWarnings', () => {
  it('emits a warning for an agent with runner: local', () => {
    const warnings = collectDeprecationWarnings(config([agent('rex', 'local')]), {});
    expect(warnings).toHaveLength(1);
    const w = warnings[0]!;
    expect(w.code).toBe('OUIJA_LOCAL_RUNNER_DEPRECATED');
    expect(w.agentId).toBe('rex');
    expect(w.message).toContain('deprecated');
    expect(w.message).toContain('v0.5.0');
    expect(w.message).toContain('stream-json');
    expect(w.message).toContain('OUIJA_ALLOW_LOCAL_RUNNER=1');
  });

  it('does NOT warn when runner is stream-json', () => {
    const warnings = collectDeprecationWarnings(
      config([agent('rex', 'stream-json')]),
      {},
    );
    expect(warnings).toEqual([]);
  });

  it('does NOT warn when runner is sdk', () => {
    const warnings = collectDeprecationWarnings(config([agent('rex', 'sdk')]), {});
    expect(warnings).toEqual([]);
  });

  it('does NOT warn when runner is unset (defaults to stream-json)', () => {
    const warnings = collectDeprecationWarnings(config([agent('rex')]), {});
    expect(warnings).toEqual([]);
  });

  it('suppresses the warning when OUIJA_ALLOW_LOCAL_RUNNER=1', () => {
    const warnings = collectDeprecationWarnings(config([agent('rex', 'local')]), {
      OUIJA_ALLOW_LOCAL_RUNNER: '1',
    });
    expect(warnings).toEqual([]);
  });

  it('does NOT accept truthy-but-not-"1" values as suppression', () => {
    for (const value of ['true', 'yes', 'on', 'TRUE', 'enabled', '2', '']) {
      const warnings = collectDeprecationWarnings(config([agent('rex', 'local')]), {
        OUIJA_ALLOW_LOCAL_RUNNER: value,
      });
      expect(warnings).toHaveLength(1);
    }
  });

  it('emits one warning per deprecated agent when multiple exist', () => {
    const warnings = collectDeprecationWarnings(
      config([
        agent('rex', 'local'),
        agent('daisy', 'stream-json'),
        agent('ghost', 'local'),
      ]),
      {},
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.agentId)).toEqual(['rex', 'ghost']);
  });
});

describe('emitDeprecationWarnings', () => {
  it('routes each warning through process.emitWarning with the right code', async () => {
    // Use a unique code per test run — Node dedupes DeprecationWarnings by
    // `code` at process scope, so a fixed string would make the suite
    // order-dependent. `process.emitWarning` fires asynchronously via
    // `process.nextTick`, so the listener must be detached AFTER we yield.
    const uniqueCode = `OUIJA_TEST_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const seen: Array<{ name: string; code?: string; message: string }> = [];
    const listener = (w: Error & { code?: string }): void => {
      if (w.code !== uniqueCode) return;
      seen.push({ name: w.name, code: w.code, message: w.message });
    };
    process.on('warning', listener);
    try {
      emitDeprecationWarnings([
        { code: uniqueCode, agentId: 'rex', message: 'test message' },
      ]);
      // Flush pending warning emissions.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', listener);
    }
    expect(seen).toHaveLength(1);
    const warn = seen[0]!;
    expect(warn.name).toBe('DeprecationWarning');
    expect(warn.code).toBe(uniqueCode);
    expect(warn.message).toBe('test message');
  });

  it('is a noop for an empty warning list', () => {
    // Should not throw.
    expect(() => emitDeprecationWarnings([])).not.toThrow();
  });
});
