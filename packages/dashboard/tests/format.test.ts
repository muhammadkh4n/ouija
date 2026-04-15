import { describe, it, expect } from 'vitest';
import { relativeTime, shortId, isInFlight } from '../src/lib/format.js';

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
