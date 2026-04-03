import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildAuthEnv } from '../src/auth-env.js';

describe('buildAuthEnv', () => {
  const saved: Record<string, string | undefined> = {};

  function stubEnv(key: string, value: string) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    // Clear saved for next test
    for (const key of Object.keys(saved)) delete saved[key];
  });

  it('api-key method resolves env: prefix and sets ANTHROPIC_API_KEY', () => {
    stubEnv('MY_API_KEY', 'sk-test-123');
    const env = buildAuthEnv('api-key', 'env:MY_API_KEY');
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-test-123' });
  });

  it('api-key method returns empty when env var not set', () => {
    delete process.env['NONEXISTENT_KEY'];
    const env = buildAuthEnv('api-key', 'env:NONEXISTENT_KEY');
    expect(env).toEqual({});
  });

  it('bedrock sets CLAUDE_CODE_USE_BEDROCK=1 and forwards AWS vars', () => {
    stubEnv('AWS_ACCESS_KEY_ID', 'AKIA...');
    stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    stubEnv('AWS_REGION', 'us-east-1');

    const env = buildAuthEnv('bedrock', 'env:unused');
    expect(env['CLAUDE_CODE_USE_BEDROCK']).toBe('1');
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIA...');
    expect(env['AWS_SECRET_ACCESS_KEY']).toBe('secret');
    expect(env['AWS_REGION']).toBe('us-east-1');
    // Vars not in process.env should not appear
    expect(env).not.toHaveProperty('AWS_SESSION_TOKEN');
  });

  it('vertex sets CLAUDE_CODE_USE_VERTEX=1 and forwards GCP vars', () => {
    stubEnv('CLOUD_ML_REGION', 'us-central1');
    stubEnv('ANTHROPIC_VERTEX_PROJECT_ID', 'my-project');

    const env = buildAuthEnv('vertex', 'env:unused');
    expect(env['CLAUDE_CODE_USE_VERTEX']).toBe('1');
    expect(env['CLOUD_ML_REGION']).toBe('us-central1');
    expect(env['ANTHROPIC_VERTEX_PROJECT_ID']).toBe('my-project');
    expect(env).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
  });

  it('foundry sets CLAUDE_CODE_USE_FOUNDRY=1 and forwards Azure vars', () => {
    stubEnv('AZURE_CLIENT_ID', 'client-id');
    stubEnv('AZURE_TENANT_ID', 'tenant-id');

    const env = buildAuthEnv('foundry', 'env:unused');
    expect(env['CLAUDE_CODE_USE_FOUNDRY']).toBe('1');
    expect(env['AZURE_CLIENT_ID']).toBe('client-id');
    expect(env['AZURE_TENANT_ID']).toBe('tenant-id');
    expect(env).not.toHaveProperty('AZURE_CLIENT_SECRET');
  });

  it('proxy sets ANTHROPIC_AUTH_TOKEN from secretRef', () => {
    stubEnv('PROXY_TOKEN', 'bearer-abc');
    const env = buildAuthEnv('proxy', 'env:PROXY_TOKEN');
    expect(env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'bearer-abc' });
  });

  it('defaults to api-key when authMethod is undefined', () => {
    stubEnv('DEFAULT_KEY', 'sk-default');
    const env = buildAuthEnv(undefined, 'env:DEFAULT_KEY');
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-default' });
  });

  it('unknown method returns empty env', () => {
    const env = buildAuthEnv('unknown-method', 'env:WHATEVER');
    expect(env).toEqual({});
  });
});
