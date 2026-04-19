/**
 * Secrets vault — AES-256-GCM encryption for per-agent credentials stored in
 * the `agents.secrets_vault` JSONB column.
 *
 * Design notes:
 *  - Key material: derived from OUIJA_SECRET_KEY via SHA-256, so any key length
 *    ≥ 32 bytes works (matches the JWT signer). Rotating OUIJA_SECRET_KEY
 *    requires re-encryption — documented in SECURITY.md (WS3).
 *  - Per-encryption random IV (12 bytes, NIST-recommended for GCM).
 *  - Authentication tag is stored alongside the ciphertext so tampered rows
 *    surface as decryption failures instead of silent garbage.
 *  - Serialized as a JSON object so the column stays inspectable and we never
 *    hand-roll a binary framing format. All blobs are base64.
 *  - `fields` lists which keys the vault contains — lets the dashboard render
 *    "ANTHROPIC_API_KEY is set" without ever decrypting.
 *
 * NOT in scope here:
 *  - Key rotation tooling (one-off script when we need it).
 *  - HSM / KMS backends (self-hoster tool — a local secret is plenty for now).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface EncryptedVault {
  /** base64-encoded 12-byte IV */
  iv: string;
  /** base64-encoded 16-byte auth tag */
  tag: string;
  /** base64-encoded ciphertext */
  ciphertext: string;
  /** Plaintext list of secret field names present in the vault (no values). */
  fields: string[];
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function deriveKey(secret: string): Buffer {
  if (secret.length < 32) {
    throw new Error('OUIJA_SECRET_KEY must be at least 32 characters for secure secret storage');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Encrypt a key-value map. Returns null if the map is empty (no vault needed). */
export function encryptSecrets(
  secrets: Record<string, string>,
  masterKey: string,
): EncryptedVault | null {
  const keys = Object.keys(secrets);
  if (keys.length === 0) return null;

  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    fields: keys.sort(),
  };
}

/** Decrypt a vault. Throws on tampered ciphertext or wrong key. */
export function decryptSecrets(
  vault: EncryptedVault,
  masterKey: string,
): Record<string, string> {
  const key = deriveKey(masterKey);
  const iv = Buffer.from(vault.iv, 'base64');
  const tag = Buffer.from(vault.tag, 'base64');
  const ciphertext = Buffer.from(vault.ciphertext, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Decrypted vault is not an object');
  }
  return parsed as Record<string, string>;
}

/** Shape-check a JSONB value loaded from the agents.secrets_vault column. */
export function isEncryptedVault(value: unknown): value is EncryptedVault {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['iv'] === 'string' &&
    typeof v['tag'] === 'string' &&
    typeof v['ciphertext'] === 'string' &&
    Array.isArray(v['fields'])
  );
}
