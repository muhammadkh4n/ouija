import type { BasePlugin } from './plugin.js';
import type { InstanceId, DispatchId } from './ids.js';

// ---- WorkOrder contract (§4.8) ----
// This is the most critical interface in the system — it defines
// how the engine communicates with every agent plugin.

export interface WorkOrder {
  /** Pipeline instance ID */
  instanceId: InstanceId;
  /** Kanban card ID */
  cardId: string;
  /** Card title */
  title: string;
  /** Card description (sanitized — see §4.10) */
  description: string;
  /** Extracted from card if present */
  acceptanceCriteria: string[];
  /** Git clone URL */
  repoUrl: string;
  /** Branch naming convention: ouija/<instanceId> */
  branch: string;
  /** e.g. "main" */
  baseBranch: string;
  /** Which agent profile to use */
  agentProfileId: string;
  /** From agent profile */
  systemPrompt: string;
  /** Reference to AI API key (never the raw key) */
  secretRef: string;
  /** POST /hooks/agent/callback (fixed path) */
  callbackUrl: string;
  /** JWT for authenticating callbacks */
  callbackToken: string;
  /** Optional: files the card references */
  filePathHints?: string[];
  /** Optional: detected languages in repo */
  languageHints?: string[];
  /** Stall threshold — agent should self-terminate after this */
  maxDurationMs: number;
  /** Pass-through for plugin-specific data */
  metadata: Record<string, string>;
}

// ---- Agent status ----

export type AgentStatusState =
  | 'idle'
  | 'provisioning'
  | 'dispatching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentStatus {
  dispatchId: DispatchId;
  instanceId: InstanceId;
  state: AgentStatusState;
  progress?: number;
  message?: string;
  updatedAt: string;
}

// ---- Agent plugin interface ----

export interface AgentPlugin<TConfig = unknown> extends BasePlugin<TConfig> {
  /** Dispatch a work order to the agent */
  dispatch(workOrder: WorkOrder): Promise<DispatchId>;

  /** Cancel an in-flight dispatch — best-effort, external agents may continue */
  cancel(dispatchId: DispatchId): Promise<void>;

  /** Get the current status of a dispatch */
  getStatus(dispatchId: DispatchId): Promise<AgentStatus>;
}
