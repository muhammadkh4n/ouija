import { describe, it, expect } from 'vitest';
import {
  relativeTime,
  shortId,
  isInFlight,
  isZeroTokenAnomaly,
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
