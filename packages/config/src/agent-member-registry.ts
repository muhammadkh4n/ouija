import type { AgentProfileConfig, TriggerMode } from './types.js';

export interface PlaneClient {
  getMembers(workspaceSlug: string): Promise<Array<{ id: string; email: string; display_name: string; role: number }>>;
  inviteMember(workspaceSlug: string, email: string, role: number): Promise<{ id: string; email: string; role: number }>;
}

export interface RegistryLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export class AgentMemberRegistry {
  private readonly agents: Map<string, AgentProfileConfig>;
  private readonly memberToAgent = new Map<string, string>();
  private readonly planeClient: PlaneClient;
  private readonly workspaceSlug: string;
  private readonly logger: RegistryLogger;

  constructor(
    agents: AgentProfileConfig[],
    planeClient: PlaneClient,
    workspaceSlug: string,
    logger: RegistryLogger,
  ) {
    this.agents = new Map(agents.map((a) => [a.id, a]));
    this.planeClient = planeClient;
    this.workspaceSlug = workspaceSlug;
    this.logger = logger;
  }

  async provision(): Promise<void> {
    const existing = await this.planeClient.getMembers(this.workspaceSlug);
    const membersByEmail = new Map(existing.map((m) => [m.email, m]));

    for (const agent of this.agents.values()) {
      const found = membersByEmail.get(agent.email);
      if (found) {
        this.memberToAgent.set(found.id, agent.id);
        this.logger.info('Reused existing Plane member', { agentId: agent.id, memberId: found.id });
      } else {
        const created = await this.planeClient.inviteMember(this.workspaceSlug, agent.email, 15);
        this.memberToAgent.set(created.id, agent.id);
        this.logger.info('Provisioned new Plane member', { agentId: agent.id, memberId: created.id });
      }
    }
  }

  getAgentIdByMemberId(memberId: string): string | undefined {
    return this.memberToAgent.get(memberId);
  }

  isAgentMember(memberId: string): boolean {
    return this.memberToAgent.has(memberId);
  }

  getProfile(agentId: string): AgentProfileConfig | undefined {
    return this.agents.get(agentId);
  }

  getTriggerMode(agentId: string): TriggerMode | undefined {
    return this.agents.get(agentId)?.triggerMode;
  }
}
