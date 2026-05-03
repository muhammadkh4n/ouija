import { describe, it, expect } from 'vitest';
import {
  dwellMs,
  formatCostUsd,
  formatDwell,
  formatTokens,
  isInFlight,
  isOverDwellBudget,
  isZeroTokenAnomaly,
  readDispatchOutcomeMetrics,
  relativeTime,
  shortId,
} from '../src/lib/format.js';

describe('relativeTime', () => {
  const now = new Date('2026-04-16T12:00:00.000Z');

  it('formats seconds ago', () => {
    const iso = new Date(now.getTime() - 30_000).toISOString();
    expect(relativeTime(iso, now)).toMatch(/30 seconds? ago|just now/);
  });

  it('formats minutes ago', () => {
    const iso = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(relativeTime(iso, now)).toContain('5 minutes ago');
  });

  it('formats hours ago', () => {
    const iso = new Date(now.getTime() - 3 * 3_600_000).toISOString();
    expect(relativeTime(iso, now)).toContain('3 hours ago');
  });

  it('formats days ago', () => {
    const iso = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    expect(relativeTime(iso, now)).toContain('2 days ago');
  });

  it('falls back to a date string for >30 days', () => {
    const iso = new Date(now.getTime() - 45 * 86_400_000).toISOString();
    const result = relativeTime(iso, now);
    expect(result).not.toContain('ago');
    // Locale date string contains a digit (year or day).
    expect(result).toMatch(/\d/);
  });
});

describe('shortId', () => {
  it('returns the last 7 chars for long IDs', () => {
    expect(shortId('abcdef1234567890')).toBe('4567890');
  });

  it('returns the full ID when <=8 chars', () => {
    expect(shortId('abc')).toBe('abc');
    expect(shortId('12345678')).toBe('12345678');
  });

  it('always returns 7 chars for IDs longer than 8 chars', () => {
    expect(shortId('inst_abcdef1234567890')).toBe('4567890');
    expect(shortId('x'.repeat(100))).toHaveLength(7);
  });
});

describe('isInFlight', () => {
  it('returns true for provisioning/dispatching/running', () => {
    expect(isInFlight('provisioning')).toBe(true);
    expect(isInFlight('dispatching')).toBe(true);
    expect(isInFlight('running')).toBe(true);
  });

  it('returns false for terminal and idle states', () => {
    expect(isInFlight('idle')).toBe(false);
    expect(isInFlight('succeeded')).toBe(false);
    expect(isInFlight('failed')).toBe(false);
    expect(isInFlight('stalled')).toBe(false);
    expect(isInFlight('cancelled')).toBe(false);
  });

  it('returns false for unknown strings', () => {
    expect(isInFlight('pending')).toBe(false);
    expect(isInFlight('')).toBe(false);
  });
});

describe('isZeroTokenAnomaly', () => {
  it('flags succeeded pipelines with zero tokens and no PR', () => {
    expect(
      isZeroTokenAnomaly({ status: 'succeeded', tokensUsed: 0, prUrl: null }),
    ).toBe(true);
  });

  it('flags succeeded pipelines with null tokens and null prUrl (pre-v0.4.0 historical rows)', () => {
    expect(
      isZeroTokenAnomaly({
        status: 'succeeded',
        tokensUsed: null,
        prUrl: null,
      }),
    ).toBe(true);
  });

  it('flags succeeded pipelines with undefined tokens and undefined prUrl', () => {
    expect(isZeroTokenAnomaly({ status: 'succeeded' })).toBe(true);
  });

  it('flags succeeded pipelines with empty-string prUrl', () => {
    expect(
      isZeroTokenAnomaly({ status: 'succeeded', tokensUsed: 0, prUrl: '' }),
    ).toBe(true);
  });

  it('does NOT flag when tokens are positive', () => {
    expect(
      isZeroTokenAnomaly({
        status: 'succeeded',
        tokensUsed: 1,
        prUrl: null,
      }),
    ).toBe(false);
    expect(
      isZeroTokenAnomaly({
        status: 'succeeded',
        tokensUsed: 12_345,
        prUrl: null,
      }),
    ).toBe(false);
  });

  it('does NOT flag when a PR URL is present (even without tokens)', () => {
    expect(
      isZeroTokenAnomaly({
        status: 'succeeded',
        tokensUsed: 0,
        prUrl: 'https://github.com/owner/repo/pull/1',
      }),
    ).toBe(false);
    expect(
      isZeroTokenAnomaly({
        status: 'succeeded',
        tokensUsed: null,
        prUrl: 'https://github.com/owner/repo/pull/1',
      }),
    ).toBe(false);
  });

  it('does NOT flag non-succeeded pipelines regardless of tokens/prUrl', () => {
    for (const status of [
      'idle',
      'provisioning',
      'dispatching',
      'running',
      'awaiting_review',
      'failed',
      'stalled',
      'cancelled',
    ]) {
      expect(
        isZeroTokenAnomaly({ status, tokensUsed: 0, prUrl: null }),
      ).toBe(false);
    }
  });

  it('does NOT flag when both tokens and PR are present', () => {
    expect(
      isZeroTokenAnomaly({
        status: 'succeeded',
        tokensUsed: 42,
        prUrl: 'https://github.com/x/y/pull/1',
      }),
    ).toBe(false);
  });
});

describe('dwellMs', () => {
  const now = new Date('2026-05-03T17:00:00.000Z');

  it('returns the elapsed milliseconds since stateEnteredAt', () => {
    const entered = new Date(now.getTime() - 137_000).toISOString();
    expect(
      dwellMs({ status: 'dispatching', stateEnteredAt: entered }, now),
    ).toBe(137_000);
  });

  it('clamps to 0 when stateEnteredAt is in the future (clock skew)', () => {
    const future = new Date(now.getTime() + 5_000).toISOString();
    expect(
      dwellMs({ status: 'dispatching', stateEnteredAt: future }, now),
    ).toBe(0);
  });

  it('returns 0 when stateEnteredAt cannot be parsed', () => {
    expect(
      dwellMs({ status: 'dispatching', stateEnteredAt: 'not-a-date' }, now),
    ).toBe(0);
  });
});

describe('formatDwell', () => {
  it('renders <60s as "Ns"', () => {
    expect(formatDwell(0)).toBe('0s');
    expect(formatDwell(900)).toBe('0s');
    expect(formatDwell(45_000)).toBe('45s');
  });

  it('renders minutes with leftover seconds', () => {
    expect(formatDwell(60_000)).toBe('1m');
    expect(formatDwell(90_000)).toBe('1m 30s');
    expect(formatDwell(137_000)).toBe('2m 17s');
  });

  it('renders hours with leftover minutes', () => {
    expect(formatDwell(3_600_000)).toBe('1h');
    expect(formatDwell(2 * 3_600_000 + 15 * 60_000)).toBe('2h 15m');
  });

  it('renders days with leftover hours', () => {
    expect(formatDwell(86_400_000)).toBe('1d');
    expect(formatDwell(86_400_000 + 5 * 3_600_000)).toBe('1d 5h');
    expect(formatDwell(14 * 86_400_000)).toBe('14d');
  });

  it('handles invalid input by returning "0s"', () => {
    expect(formatDwell(-1)).toBe('0s');
    expect(formatDwell(Number.NaN)).toBe('0s');
    expect(formatDwell(Number.POSITIVE_INFINITY)).toBe('0s');
  });
});

describe('isOverDwellBudget', () => {
  const now = new Date('2026-05-03T17:00:00.000Z');

  it('returns true when dwell exceeds the budget', () => {
    const entered = new Date(now.getTime() - 65_000).toISOString();
    expect(
      isOverDwellBudget(
        { status: 'dispatching', stateEnteredAt: entered, dwellBudgetMs: 60_000 },
        now,
      ),
    ).toBe(true);
  });

  it('returns false when dwell is at or below the budget', () => {
    const atBudget = new Date(now.getTime() - 60_000).toISOString();
    expect(
      isOverDwellBudget(
        { status: 'dispatching', stateEnteredAt: atBudget, dwellBudgetMs: 60_000 },
        now,
      ),
    ).toBe(false);

    const underBudget = new Date(now.getTime() - 30_000).toISOString();
    expect(
      isOverDwellBudget(
        { status: 'dispatching', stateEnteredAt: underBudget, dwellBudgetMs: 60_000 },
        now,
      ),
    ).toBe(false);
  });

  it('returns false when budget is null/undefined (no budget enforced)', () => {
    const entered = new Date(now.getTime() - 14 * 86_400_000).toISOString();
    expect(
      isOverDwellBudget(
        { status: 'idle', stateEnteredAt: entered, dwellBudgetMs: null },
        now,
      ),
    ).toBe(false);
    expect(
      isOverDwellBudget(
        { status: 'idle', stateEnteredAt: entered },
        now,
      ),
    ).toBe(false);
  });
});

describe('formatCostUsd', () => {
  it('renders <1¢ as "<$0.01" so the chip never shows "$0.0000"', () => {
    expect(formatCostUsd(0.0042)).toBe('<$0.01');
    expect(formatCostUsd(0.001)).toBe('<$0.01');
  });

  it('renders three decimals for cents', () => {
    expect(formatCostUsd(0.123)).toBe('$0.123');
    expect(formatCostUsd(0.99)).toBe('$0.990');
  });

  it('renders two decimals for dollars+', () => {
    expect(formatCostUsd(1)).toBe('$1.00');
    expect(formatCostUsd(12.345)).toBe('$12.35');
  });

  it('renders zero / negative / NaN / null / undefined as null or "$0"', () => {
    expect(formatCostUsd(0)).toBe('$0');
    expect(formatCostUsd(-1)).toBe('$0');
    expect(formatCostUsd(Number.NaN)).toBeNull();
    expect(formatCostUsd(null)).toBeNull();
    expect(formatCostUsd(undefined)).toBeNull();
  });
});

describe('formatTokens', () => {
  it('renders <1k as locale-formatted integers', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('renders thousands as "Nk" with one decimal', () => {
    expect(formatTokens(1_000)).toBe('1.0k');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(999_999)).toBe('1000.0k');
  });

  it('renders millions as "N.NNM"', () => {
    expect(formatTokens(1_000_000)).toBe('1.00M');
    expect(formatTokens(1_234_567)).toBe('1.23M');
  });

  it('returns null for null/undefined/NaN', () => {
    expect(formatTokens(null)).toBeNull();
    expect(formatTokens(undefined)).toBeNull();
    expect(formatTokens(Number.NaN)).toBeNull();
  });
});

describe('readDispatchOutcomeMetrics', () => {
  it('extracts every reported metric from a full payload', () => {
    const payload = {
      outcome: {
        tokensIn: 1200,
        tokensOut: 800,
        costUsd: 0.42,
        commitsPushed: 3,
        toolCallsMade: 18,
        durationMs: 45_000,
        prUrl: 'https://github.com/x/y/pull/1',
      },
      accepted: true,
    };
    const metrics = readDispatchOutcomeMetrics(payload);
    expect(metrics).not.toBeNull();
    expect(metrics?.tokensIn).toBe(1200);
    expect(metrics?.tokensOut).toBe(800);
    expect(metrics?.costUsd).toBe(0.42);
    expect(metrics?.commitsPushed).toBe(3);
    expect(metrics?.toolCallsMade).toBe(18);
    expect(metrics?.durationMs).toBe(45_000);
    expect(metrics?.prUrl).toBe('https://github.com/x/y/pull/1');
    expect(metrics?.accepted).toBe(true);
  });

  it('returns null for non-object payloads', () => {
    expect(readDispatchOutcomeMetrics(null)).toBeNull();
    expect(readDispatchOutcomeMetrics(undefined)).toBeNull();
    expect(readDispatchOutcomeMetrics('a string')).toBeNull();
    expect(readDispatchOutcomeMetrics(42)).toBeNull();
  });

  it('returns null when the outcome wrapper is absent', () => {
    expect(readDispatchOutcomeMetrics({ accepted: true })).toBeNull();
    expect(readDispatchOutcomeMetrics({ outcome: null })).toBeNull();
    expect(readDispatchOutcomeMetrics({ outcome: 'string' })).toBeNull();
  });

  it('returns null fields when the outcome has them at wrong types', () => {
    const metrics = readDispatchOutcomeMetrics({
      outcome: {
        tokensIn: 'not a number',
        prUrl: 42,
      },
      accepted: 'truthy',
    });
    expect(metrics).not.toBeNull();
    expect(metrics?.tokensIn).toBeNull();
    expect(metrics?.prUrl).toBeNull();
    expect(metrics?.accepted).toBeNull();
  });

  it('treats empty-string prUrl as no URL', () => {
    const metrics = readDispatchOutcomeMetrics({ outcome: { prUrl: '' } });
    expect(metrics?.prUrl).toBeNull();
  });
});
