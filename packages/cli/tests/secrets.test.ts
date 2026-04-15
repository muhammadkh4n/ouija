import { describe, it, expect } from 'vitest';
import { generateHexSecret } from '../src/lib/secrets.js';

describe('generateHexSecret', () => {
  it('returns a hex string of the default length (64 chars for 32 bytes)', () => {
    const secret = generateHexSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('respects the byte count parameter', () => {
    expect(generateHexSecret(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(generateHexSecret(8)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces distinct secrets on consecutive calls', () => {
    const a = generateHexSecret();
    const b = generateHexSecret();
    expect(a).not.toBe(b);
  });

  it('produces uniformly-distributed bytes (sanity check)', () => {
    const secret = generateHexSecret(128);
    // Count unique hex chars — should be 16 (0-9, a-f) in a 256-char string
    // barring extreme bad luck.
    const unique = new Set(secret).size;
    expect(unique).toBeGreaterThanOrEqual(12);
  });
});
