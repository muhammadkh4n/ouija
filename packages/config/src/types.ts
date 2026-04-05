export type AuthMethod = 'api-key' | 'bedrock' | 'vertex' | 'foundry' | 'api-key-helper' | 'proxy';

export interface AuthConfig {
  method: AuthMethod;
  secretRef: string;
}

export interface RepoConfig {
  url?: string | undefined;
  path?: string | undefined;
  baseBranch: string;
  default?: boolean | undefined;
  /** Optional: Plane project UUID this repo maps to. */
  projectId?: string | undefined;
}

export type TriggerMode = 'auto' | 'manual';

export interface AgentProfileConfig {
  id: string;
  name: string;
  email: string;
  kanbanUserId?: string;
  avatar?: string;
  systemPrompt?: string;
  configDir?: string;
  model: string;
  triggerMode: TriggerMode;
  auth: AuthConfig;
  repos: RepoConfig[];
  limits: {
    maxDurationMs: number;
    stallThresholdMs?: number;
  };
}

export interface BoardColumnConfig {
  /** Plane state name (e.g. "In Progress", "Done"). Matched case-insensitively. */
  name: string;
  /** What happens when a card enters this column. */
  action: 'dispatch_agent' | 'close_and_notify' | 'noop';
  /** Which agent handles dispatch for this column. Required when action is dispatch_agent. */
  agentId?: string;
}

export interface BoardConfig {
  boardId?: string;
  /** Plane project UUID or slug. */
  projectId?: string;
  /** Column → action mappings. Columns not listed default to 'noop'. */
  columns: BoardColumnConfig[];
  defaultStallThresholdMs?: number;
  autoStartOnAssign?: boolean;
}

export interface OuijaConfig {
  claudeHome: string | null;
  agents: AgentProfileConfig[];
  /** Board configurations. If empty, a default config is auto-generated. */
  boards?: BoardConfig[];
}
