export type AuthMethod = 'api-key' | 'bedrock' | 'vertex' | 'foundry' | 'api-key-helper' | 'proxy';

export interface AuthConfig {
  method: AuthMethod;
  secretRef: string;
}

export interface RepoConfig {
  url?: string;
  path?: string;
  baseBranch: string;
  default?: boolean;
}

export type TriggerMode = 'auto' | 'manual';

export interface AgentProfileConfig {
  id: string;
  name: string;
  email: string;
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

export interface OuijaConfig {
  claudeHome: string | null;
  agents: AgentProfileConfig[];
}
