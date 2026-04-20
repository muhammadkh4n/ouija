/**
 * BullMQ-safe idempotency key encoder.
 *
 * BullMQ 5.74+ rejects job IDs containing any of `:`, `#`, `/`, `?`, `&`
 * (Redis-key delimiters it reserves). transition.ts historically concatenated
 * raw strings into idempotency keys — when those strings were ISO timestamps
 * (contain `:`) or GitHub PR URLs (contain `:` and `/`), the resulting key
 * was rejected at enqueue time with "Custom Id cannot contain :" and the
 * pipeline transitioned to `dispatching` but never actually dispatched.
 *
 * This module exposes a pure encoder that:
 *   - joins parts with a null-byte separator (guaranteed absent in normal
 *     strings — callers are rejected if they slip one through)
 *   - base64url-encodes the joined bytes
 *
 * Output is [A-Za-z0-9_-] only, which is a strict subset of characters
 * accepted by BullMQ, Redis, and every LRU/map key consumer in the project.
 *
 * Tenet 5 ([[Details — Architectural Tenets]]): encoded idempotency keys
 * over raw string concatenation. Never use backtick templates for job IDs.
 */

const SEPARATOR = '\x00';

/**
 * Characters BullMQ 5.74+ rejects in custom job IDs.
 *
 * Not exhaustive (BullMQ's rules evolve) but covers every delimiter we've
 * encountered in production. The encoder's base64url output contains none
 * of them; callers that emit raw strings can use `isBullMQSafe` as a
 * pre-enqueue assertion.
 */
export const BULLMQ_FORBIDDEN_CHARS: readonly string[] = [
  ':',
  '#',
  '/',
  '?',
  '&',
  ' ',
];

/**
 * Encode an ordered array of strings into a BullMQ-safe job ID.
 *
 * Round-trips via `decodeJobId`. Deterministic: same input → same output.
 *
 * @throws if `parts` is empty or any part contains a null byte.
 */
export function encodeJobId(parts: readonly string[]): string {
  if (parts.length === 0) {
    throw new Error('encodeJobId: parts array must be non-empty');
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === undefined) {
      throw new Error(`encodeJobId: part at index ${i} is undefined`);
    }
    if (p.includes(SEPARATOR)) {
      throw new Error(
        `encodeJobId: part at index ${i} contains a null byte — not representable`,
      );
    }
  }
  const joined = parts.join(SEPARATOR);
  return Buffer.from(joined, 'utf8').toString('base64url');
}

/**
 * Recover the original parts from an encoded job ID. For tests + debugging only;
 * production code should keep the encoded form opaque.
 */
export function decodeJobId(encoded: string): string[] {
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  return decoded.split(SEPARATOR);
}

/**
 * True iff `jobId` contains none of `BULLMQ_FORBIDDEN_CHARS`. Useful as a
 * pre-enqueue assertion in callers that construct IDs without the encoder
 * (tests, debug tooling, externally-sourced IDs).
 */
export function isBullMQSafe(jobId: string): boolean {
  for (const ch of BULLMQ_FORBIDDEN_CHARS) {
    if (jobId.includes(ch)) return false;
  }
  return true;
}
