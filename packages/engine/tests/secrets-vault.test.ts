import { describe, it, expect } from 'vitest';
import {
  encryptSecrets,
  decryptSecrets,
  isEncryptedVault,
} from '../src/crypto/secrets-vault.js';

const KEY = 'test-master-key-at-least-32-chars-long!';

describe('encryptSecrets / decryptSecrets', () => {
  it('roundtrips an ANTHROPIC_API_KEY value', () => {
    const vault = encryptSecrets({ ANTHROPIC_API_KEY: 'sk-ant-abc123' }, KEY)!;
    expect(vault).not.toBeNull();
    expect(vault.fields).toEqual(['ANTHROPIC_API_KEY']);

    const decrypted = decryptSecrets(vault, KEY);
    expect(decrypted['ANTHROPIC_API_KEY']).toBe('sk-ant-abc123');
  });

  it('returns null for an empty secret map (no vault row needed)', () => {
    expect(encryptSecrets({}, KEY)).toBeNull();
  });

  it('produces a different ciphertext on each call (random IV)', () => {
    const a = encryptSecrets({ FOO: 'bar' }, KEY)!;
    const b = encryptSecrets({ FOO: 'bar' }, KEY)!;
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it('lists field names without leaking values', () => {
    const vault = encryptSecrets(
      { ANTHROPIC_API_KEY: 'secret', AWS_ACCESS_KEY_ID: 'another' },
      KEY,
    )!;
    expect(vault.fields).toEqual(['ANTHROPIC_API_KEY', 'AWS_ACCESS_KEY_ID']);
    // ciphertext bytes must not contain plaintext
    expect(Buffer.from(vault.ciphertext, 'base64').toString('utf8')).not.toContain('secret');
    expect(Buffer.from(vault.ciphertext, 'base64').toString('utf8')).not.toContain('another');
  });

  it('fails decryption with a wrong master key', () => {
    const vault = encryptSecrets({ FOO: 'bar' }, KEY)!;
    expect(() =>
      decryptSecrets(vault, 'wrong-master-key-that-is-also-32-chars!'),
    ).toThrow();
  });

  it('fails decryption when ciphertext has been tampered with', () => {
    const vault = encryptSecrets({ FOO: 'bar' }, KEY)!;
    const tampered = {
      ...vault,
      ciphertext: Buffer.from(
        Buffer.from(vault.ciphertext, 'base64').map((b, i) => (i === 0 ? b ^ 0xff : b)),
      ).toString('base64'),
    };
    expect(() => decryptSecrets(tampered, KEY)).toThrow();
  });

  it('rejects master keys shorter than 32 chars at encrypt time', () => {
    expect(() => encryptSecrets({ FOO: 'bar' }, 'short-key')).toThrow(/at least 32/);
  });
});

describe('isEncryptedVault', () => {
  it('accepts well-formed vault objects', () => {
    const vault = encryptSecrets({ FOO: 'bar' }, KEY)!;
    expect(isEncryptedVault(vault)).toBe(true);
  });

  it('rejects nulls, arrays, and partial shapes', () => {
    expect(isEncryptedVault(null)).toBe(false);
    expect(isEncryptedVault(undefined)).toBe(false);
    expect(isEncryptedVault({})).toBe(false);
    expect(isEncryptedVault({ iv: 'x', tag: 'y', ciphertext: 'z' })).toBe(false); // missing fields
  });
});
