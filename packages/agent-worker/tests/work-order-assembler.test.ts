import { describe, it, expect, vi } from 'vitest';
import { assembleWorkOrder } from '../src/work-order-assembler.js';
import type { AssemblerDeps, AgentProfile } from '../src/work-order-assembler.js';
import type { AgentDispatchJobData } from '@ouija/bus';

// ---- Fixtures ----

const baseJobData: AgentDispatchJobData = {
  instanceId: 'inst-123',
  dispatchId: 'disp-456',
  agentId: 'rex-coder',
  cardId: 'card-789',
  projectId: 'proj-1',
  workOrderDescription: 'Implement feature X',
  dispatchedAt: new Date().toISOString(),
};

const baseProfile: AgentProfile = {
  id: 'rex-coder',
  name: 'Rex Coder',
  systemPrompt: 'You are an expert engineer.',
  secretRef: 'cred:anthropic',
  model: 'claude-sonnet-4-20250514',
  maxDurationMs: 1_800_000,
  repoUrl: 'https://github.com/org/repo.git',
  baseBranch: 'main',
  triggerMode: 'auto',
};

function makeDeps(overrides: Partial<AssemblerDeps> = {}): AssemblerDeps {
  return {
    getAgentProfile: vi.fn().mockResolvedValue(baseProfile),
    getCardDetails: vi.fn().mockResolvedValue({
      title: 'Implement feature X',
      description: 'Build feature X with tests.',
      acceptanceCriteria: ['It works', 'Tests pass'],
      labels: ['ready'],
    }),
    serverBaseUrl: 'http://localhost:4000',
    issueJwt: vi.fn().mockResolvedValue('jwt-token-test'),
    ...overrides,
  };
}

// ---- Tests ----

describe('assembleWorkOrder', () => {
  it('produces a valid WorkOrder from job data', async () => {
    const deps = makeDeps();
    const wo = await assembleWorkOrder(baseJobData, deps);

    expect(String(wo.instanceId)).toBe('inst-123');
    expect(wo.cardId).toBe('card-789');
    expect(wo.title).toBe('Implement feature X');
    expect(wo.description).toBe('Build feature X with tests.');
    expect(wo.acceptanceCriteria).toEqual(['It works', 'Tests pass']);
    expect(wo.repoUrl).toBe('https://github.com/org/repo.git');
    expect(wo.branch).toBe('ouija/inst-123');
    expect(wo.baseBranch).toBe('main');
    expect(wo.agentProfileId).toBe('rex-coder');
    expect(wo.systemPrompt).toBe('You are an expert engineer.');
    expect(wo.secretRef).toBe('cred:anthropic');
    expect(wo.callbackUrl).toBe('http://localhost:4000/hooks/agent/callback');
    expect(wo.callbackToken).toBe('jwt-token-test');
    expect(wo.maxDurationMs).toBe(1_800_000);
    expect(wo.metadata).toEqual({ pipelineDispatchId: 'disp-456' });
  });

  it('throws when agent profile not found', async () => {
    const deps = makeDeps({
      getAgentProfile: vi.fn().mockResolvedValue(undefined),
    });

    await expect(assembleWorkOrder(baseJobData, deps)).rejects.toThrow(
      'Agent profile not found: rex-coder',
    );
  });

  it('calls issueJwt with the instanceId', async () => {
    const deps = makeDeps();
    await assembleWorkOrder(baseJobData, deps);
    expect(deps.issueJwt).toHaveBeenCalledWith('inst-123', '', '');
  });

  it('calls getCardDetails with the cardId', async () => {
    const deps = makeDeps();
    await assembleWorkOrder(baseJobData, deps);
    expect(deps.getCardDetails).toHaveBeenCalledWith('card-789');
  });

  it('calls getAgentProfile with the agentId', async () => {
    const deps = makeDeps();
    await assembleWorkOrder(baseJobData, deps);
    expect(deps.getAgentProfile).toHaveBeenCalledWith('rex-coder');
  });

  it('does not call getCardDetails when profile lookup fails', async () => {
    const getCardDetails = vi.fn().mockResolvedValue({
      title: '',
      description: '',
      acceptanceCriteria: [],
      labels: [],
    });
    const deps = makeDeps({
      getAgentProfile: vi.fn().mockResolvedValue(undefined),
      getCardDetails,
    });

    await expect(assembleWorkOrder(baseJobData, deps)).rejects.toThrow();
    // getCardDetails should not be called if profile lookup fails first
    expect(getCardDetails).not.toHaveBeenCalled();
  });

  it('builds branch name from instanceId', async () => {
    const deps = makeDeps();
    const jobData: AgentDispatchJobData = {
      ...baseJobData,
      instanceId: 'abc-def-ghi',
    };
    const wo = await assembleWorkOrder(jobData, deps);
    expect(wo.branch).toBe('ouija/abc-def-ghi');
  });

  it('includes repoPath in metadata when profile has repoPath', async () => {
    const deps = makeDeps({
      getAgentProfile: vi.fn().mockResolvedValue({
        ...baseProfile,
        repoUrl: undefined,
        repoPath: '/home/mk/Projects/my-app',
      }),
    });
    const wo = await assembleWorkOrder(baseJobData, deps);
    expect(wo.metadata['repoPath']).toBe('/home/mk/Projects/my-app');
    expect(wo.repoUrl).toBe('');
  });

  it('appends /hooks/agent/callback to serverBaseUrl', async () => {
    const deps = makeDeps({ serverBaseUrl: 'http://ouija:4000' });
    const wo = await assembleWorkOrder(baseJobData, deps);
    expect(wo.callbackUrl).toBe('http://ouija:4000/hooks/agent/callback');
  });
});
