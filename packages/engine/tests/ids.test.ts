/**
 * Tests for the BullMQ-safe idempotency key encoder.
 *
 * Phase 1 Task 2 (v0.4.0). Tenet 5 enforcement — every idempotency key in
 * transition.ts flows through encodeJobId so `:` / `#` / `/` / `?` / `&` in
 * ISO timestamps and PR URLs never reach BullMQ unescaped.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeJobId,
  decodeJobId,
  isBullMQSafe,
  BULLMQ_FORBIDDEN_CHARS,
} from '../src/ids.js';

describe('encodeJobId', () => {
  it('round-trips arbitrary string arrays', () => {
    const samples: string[][] = [
      ['simple'],
      ['multiple', 'parts', 'here'],
      ['close-notify', 'card-123', 'column-abc'],
      ['record-pr', 'https://github.com/muhammadkh4n/ouija/pull/54'],
      ['stall-check', 'disp-01', '2026-04-20T12:34:56.789Z'],
      ['unicode', 'αβγ', '🎯 hammer', '中文'],
      ['empty-parts', '', ''],
      ['trailing-whitespace', 'foo ', ' bar'],
    ];
    for (const parts of samples) {
      const encoded = encodeJobId(parts);
      const decoded = decodeJobId(encoded);
      expect(decoded).toEqual(parts);
    }
  });

  it('is deterministic — same input produces same output', () => {
    const a = encodeJobId(['dispatch', 'uuid-abc-123']);
    const b = encodeJobId(['dispatch', 'uuid-abc-123']);
    expect(a).toBe(b);
  });

  it('never emits any BullMQ-forbidden character', () => {
    const trickyInputs: string[][] = [
      ['record-pr', 'https://github.com/muhammadkh4n/ouija/pull/54'],
      ['stall-check', 'disp', '2026-04-20T12:34:56.789Z'],
      ['guard-fail', 'card#abc', 'column?x&y'],
      ['move-review', 'abc:def:ghi'],
      ['collision-case', '//', '::', '&&'],
    ];
    for (const parts of trickyInputs) {
      const encoded = encodeJobId(parts);
      expect(isBullMQSafe(encoded)).toBe(true);
      for (const ch of BULLMQ_FORBIDDEN_CHARS) {
        expect(encoded.includes(ch)).toBe(false);
      }
    }
  });

  it('emits only base64url-safe characters', () => {
    // RFC 4648 §5: [A-Za-z0-9_-]; no padding in base64url.
    const encoded = encodeJobId(['anything', 'even with : and / and #', '?&spaces too']);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('distinct inputs produce distinct outputs (collision resistance)', () => {
    // Adjacent-input collisions are the typical failure for hand-rolled
    // concat schemes: `a-b` vs `a-` + `b` collide under naive `join('-')`.
    // base64url of null-byte-joined should never collide on distinct tuples.
    const cases: string[][] = [
      ['a', 'b'],
      ['a-', 'b'],
      ['a', '-b'],
      ['ab', ''],
      ['', 'ab'],
      ['a', 'b', ''],
      ['a', '', 'b'],
      ['', 'a', 'b'],
    ];
    const seen = new Map<string, string[]>();
    for (const parts of cases) {
      const encoded = encodeJobId(parts);
      const prev = seen.get(encoded);
      if (prev !== undefined) {
        throw new Error(
          `collision: [${prev.join(',')}] and [${parts.join(',')}] both → ${encoded}`,
        );
      }
      seen.set(encoded, parts);
    }
  });

  it('rejects an empty parts array', () => {
    expect(() => encodeJobId([])).toThrow(/non-empty/);
  });

  it('rejects a part containing a null byte', () => {
    expect(() => encodeJobId(['a', 'b\x00c'])).toThrow(/null byte/);
  });

  it('rejects undefined parts (caller type-error regression guard)', () => {
    // `readonly string[]` permits this at JS runtime via a sparse array.
    // The check prevents `[1]` becoming `'undefined'` string conversion.
    const sparse = new Array<string>(2);
    sparse[0] = 'first';
    // index 1 is a hole; TS types say string but runtime is undefined.
    expect(() => encodeJobId(sparse as string[])).toThrow(/undefined/);
  });
});

describe('isBullMQSafe', () => {
  it('accepts clean strings', () => {
    expect(isBullMQSafe('simple')).toBe(true);
    expect(isBullMQSafe('dispatch-abc-123')).toBe(true);
    expect(isBullMQSafe('base64url_output-A-Za-z0-9_-')).toBe(true);
  });

  it('rejects every BullMQ-forbidden character', () => {
    for (const ch of BULLMQ_FORBIDDEN_CHARS) {
      expect(isBullMQSafe(`dispatch${ch}abc`)).toBe(false);
    }
  });

  it('rejects the concrete regression inputs from the v0.3.x smoke', () => {
    // These were the three backtick-template patterns that broke in WS2:
    expect(isBullMQSafe('record-pr-https://github.com/muhammadkh4n/ouija/pull/8')).toBe(false);
    expect(isBullMQSafe('dispatch-review-https://github.com/x/y/pull/1-2')).toBe(false);
    expect(isBullMQSafe('cancel-stall-disp-01-2026-04-20T12:34:56.789Z')).toBe(false);
  });
});
