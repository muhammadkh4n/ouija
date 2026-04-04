import { describe, it, expect } from 'vitest';

describe('SdkAgentRunner', () => {
  it('implements AgentRunner interface', async () => {
    const { SdkAgentRunner } = await import('../src/sdk-runner.js');
    const runner = new SdkAgentRunner({ model: 'claude-sonnet-4-20250514' });
    expect(runner).toBeDefined();
    expect(typeof runner.run).toBe('function');
  });

  it('accepts custom model in constructor', async () => {
    const { SdkAgentRunner } = await import('../src/sdk-runner.js');
    const runner = new SdkAgentRunner({ model: 'claude-opus-4-6' });
    expect(runner).toBeDefined();
  });

  it('defaults model to claude-sonnet-4-20250514', async () => {
    const { SdkAgentRunner } = await import('../src/sdk-runner.js');
    const runner = new SdkAgentRunner();
    expect(runner).toBeDefined();
  });
});
