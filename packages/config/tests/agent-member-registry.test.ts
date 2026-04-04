import { describe, it, expect, vi } from 'vitest';
import type { AgentProfileConfig } from '../src/types.js';
import { AgentMemberRegistry } from '../src/agent-member-registry.js';
import type { PlaneClient, RegistryLogger } from '../src/agent-member-registry.js';

const rexProfile: AgentProfileConfig = {
  id: 'rex-coder',
  name: 'Rex Coder',
  email: 'rex@ouija.local',
  model: 'claude-sonnet-4-20250514',
  triggerMode: 'auto',
  auth: { method: 'api-key', secretRef: 'env:ANTHROPIC_API_KEY' },
  repos: [{ url: 'https://github.com/x/y.git', baseBranch: 'main', default: true }],
  limits: { maxDurationMs: 1800000 },
};

const ghostProfile: AgentProfileConfig = {
  id: 'ghost-writer',
  name: 'Ghost Writer',
  email: 'ghost@ouija.local',
  model: 'claude-sonnet-4-20250514',
  triggerMode: 'manual',
  auth: { method: 'api-key', secretRef: 'env:ANTHROPIC_API_KEY' },
  repos: [{ url: 'https://github.com/x/z.git', baseBranch: 'main', default: true }],
  limits: { maxDurationMs: 1200000 },
};

function makePlaneClient(overrides: Partial<PlaneClient> = {}): PlaneClient {
  return {
    getMembers: vi.fn().mockResolvedValue([]),
    inviteMember: vi.fn().mockResolvedValue({ id: 'new-member-1', email: '', role: 10 }),
    ...overrides,
  };
}

function makeLogger(): RegistryLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('AgentMemberRegistry', () => {
  it('provisions a new Plane member when none exists', async () => {
    const client = makePlaneClient({
      getMembers: vi.fn().mockResolvedValue([]),
      inviteMember: vi.fn().mockResolvedValue({ id: 'plane-m1', email: 'rex@ouija.local', role: 10 }),
    });
    const registry = new AgentMemberRegistry([rexProfile], client, 'ws-slug', makeLogger());

    await registry.provision();

    expect(client.inviteMember).toHaveBeenCalledWith('ws-slug', 'rex@ouija.local', 15);
    expect(registry.getAgentIdByMemberId('plane-m1')).toBe('rex-coder');
  });

  it('reuses existing Plane member by email match', async () => {
    const client = makePlaneClient({
      getMembers: vi.fn().mockResolvedValue([
        { id: 'existing-m1', email: 'rex@ouija.local', display_name: 'Rex', role: 10 },
      ]),
    });
    const registry = new AgentMemberRegistry([rexProfile], client, 'ws-slug', makeLogger());

    await registry.provision();

    expect(client.inviteMember).not.toHaveBeenCalled();
    expect(registry.getAgentIdByMemberId('existing-m1')).toBe('rex-coder');
  });

  it('returns undefined for unknown member IDs', async () => {
    const client = makePlaneClient();
    const registry = new AgentMemberRegistry([rexProfile], client, 'ws-slug', makeLogger());

    await registry.provision();

    expect(registry.getAgentIdByMemberId('unknown-id')).toBeUndefined();
  });

  it('provisions multiple agents', async () => {
    let callCount = 0;
    const client = makePlaneClient({
      getMembers: vi.fn().mockResolvedValue([]),
      inviteMember: vi.fn().mockImplementation(async (_ws: string, email: string) => {
        callCount++;
        return { id: `plane-m${callCount}`, email, role: 10 };
      }),
    });
    const registry = new AgentMemberRegistry([rexProfile, ghostProfile], client, 'ws-slug', makeLogger());

    await registry.provision();

    expect(client.inviteMember).toHaveBeenCalledTimes(2);
    expect(registry.getAgentIdByMemberId('plane-m1')).toBe('rex-coder');
    expect(registry.getAgentIdByMemberId('plane-m2')).toBe('ghost-writer');
  });

  it('isAgentMember returns true for known agent member IDs', async () => {
    const client = makePlaneClient({
      getMembers: vi.fn().mockResolvedValue([
        { id: 'existing-m1', email: 'rex@ouija.local', display_name: 'Rex', role: 10 },
      ]),
    });
    const registry = new AgentMemberRegistry([rexProfile], client, 'ws-slug', makeLogger());

    await registry.provision();

    expect(registry.isAgentMember('existing-m1')).toBe(true);
    expect(registry.isAgentMember('unknown-id')).toBe(false);
  });

  it('getProfile returns the agent profile by ID', () => {
    const client = makePlaneClient();
    const registry = new AgentMemberRegistry([rexProfile, ghostProfile], client, 'ws-slug', makeLogger());

    expect(registry.getProfile('rex-coder')).toEqual(rexProfile);
    expect(registry.getProfile('ghost-writer')).toEqual(ghostProfile);
    expect(registry.getProfile('nonexistent')).toBeUndefined();
  });

  it('getTriggerMode returns the agent trigger mode', () => {
    const client = makePlaneClient();
    const registry = new AgentMemberRegistry([rexProfile, ghostProfile], client, 'ws-slug', makeLogger());

    expect(registry.getTriggerMode('rex-coder')).toBe('auto');
    expect(registry.getTriggerMode('ghost-writer')).toBe('manual');
    expect(registry.getTriggerMode('nonexistent')).toBeUndefined();
  });
});
