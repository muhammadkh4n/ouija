import { randomBytes } from 'node:crypto';

/**
 * Generate a cryptographically-secure hex secret.
 *
 * @param bytes - Number of random bytes. Default 32 → 64 hex chars.
 */
export function generateHexSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
