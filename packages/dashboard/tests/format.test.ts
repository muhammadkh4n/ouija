import { describe, it, expect } from 'vitest';
import {
  dwellMs,
  formatDwell,
  isInFlight,
  isOverDwellBudget,
  isZeroTokenAnomaly,
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
