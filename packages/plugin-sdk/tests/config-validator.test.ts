import { describe, it, expect } from 'vitest';
import { validateConfig, validateConfigOrThrow } from '../src/config-validator.js';
import type { JSONSchema } from '@ouija-dev/types';

// ---- Fixtures ----

const strictSchema: JSONSchema = {
  type: 'object',
  required: ['apiToken', 'baseUrl'],
  properties: {
    apiToken: { type: 'string' },
    baseUrl: { type: 'string', format: 'uri' },
    timeout: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
};

describe('validateConfig', () => {
  it('returns valid=true for a fully correct object', () => {
    const result = validateConfig(strictSchema, {
      apiToken: 'tok_abc123',
      baseUrl: 'https://api.example.com',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts optional fields that are present', () => {
    const result = validateConfig(strictSchema, {
      apiToken: 'tok_abc',
      baseUrl: 'https://api.example.com',
      timeout: 3000,
    });
    expect(result.valid).toBe(true);
  });

  it('returns valid=false and names the missing required field', () => {
    const result = validateConfig(strictSchema, {
      baseUrl: 'https://api.example.com',
      // apiToken intentionally omitted
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('apiToken'))).toBe(true);
    expect(result.errors.some((e) => e.includes('required'))).toBe(true);
  });

  it('reports both missing required fields when neither is present', () => {
    const result = validateConfig(strictSchema, {});
    expect(result.valid).toBe(false);
    // allErrors: true — both should be reported
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    const allText = result.errors.join(' ');
    expect(allText).toContain('apiToken');
    expect(allText).toContain('baseUrl');
  });

  it('returns an error when a field has the wrong type', () => {
    const result = validateConfig(strictSchema, {
      apiToken: 42, // should be string
      baseUrl: 'https://api.example.com',
    });
    expect(result.valid).toBe(false);
    const allText = result.errors.join(' ');
    expect(allText).toContain('apiToken');
  });

  it('rejects additional properties when additionalProperties: false', () => {
    const result = validateConfig(strictSchema, {
      apiToken: 'tok_abc',
      baseUrl: 'https://api.example.com',
      unexpectedField: 'oops',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validates format: uri correctly', () => {
    const result = validateConfig(strictSchema, {
      apiToken: 'tok_abc',
      baseUrl: 'not-a-url',
    });
    expect(result.valid).toBe(false);
    const allText = result.errors.join(' ');
    expect(allText).toContain('baseUrl');
  });

  it('returns valid=true for the empty schema (accepts anything)', () => {
    const result = validateConfig({}, { foo: 'bar', anything: 123 });
    expect(result.valid).toBe(true);
  });
});

describe('validateConfigOrThrow', () => {
  it('does not throw for a valid config', () => {
    expect(() =>
      validateConfigOrThrow('@ouija-dev/plugin-plane', strictSchema, {
        apiToken: 'tok_abc',
        baseUrl: 'https://api.example.com',
      }),
    ).not.toThrow();
  });

  it('throws with the plugin name and field in the message', () => {
    expect(() =>
      validateConfigOrThrow('@ouija-dev/plugin-plane', strictSchema, {
        baseUrl: 'https://api.example.com',
        // apiToken missing
      }),
    ).toThrow(/Plugin @ouija-dev\/plugin-plane config error/);
  });

  it('includes the missing field name in the thrown message', () => {
    let message = '';
    try {
      validateConfigOrThrow('@ouija-dev/plugin-plane', strictSchema, {
        baseUrl: 'https://api.example.com',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('apiToken');
    expect(message).toContain('@ouija-dev/plugin-plane');
  });
});
