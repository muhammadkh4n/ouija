/**
 * Response shapes exposed by the Ouija server REST API.
 *
 * Kept in sync with packages/server/src/routes/*.ts. When the server changes,
 * update here too — we don't share types across the package boundary
 * because the dashboard is a separate build surface and we want this layer
 * to be explicit.
 */

export type PipelineStatus =
  | 'idle'
  | 'provisioning'
  | 'dispatching'
  | 'running'
  | 'awaiting_review'
  | 'succeeded'
  | 'failed'
  | 'stalled'
  | 'cancelled';

export type PipelineAction = 'retry' | 'cancel';

export interface PipelineSummary {
  id: string;
  cardId: string;
  boardId: string;
  projectId?: string;
  status: PipelineStatus;
  attempt: number;
  prUrl?: string | null;
  cost?: number | null;
  tokensUsed?: number | null;
  /** Review-loop iteration counter — present on dispatching/running/awaiting_review post-PR-1. */
  iteration?: number | null;
  createdAt: string;
  updatedAt: string;
  allowedActions: PipelineAction[];
}

export interface PipelineListResponse {
  items: PipelineSummary[];
  nextCursor?: string | null;
}

export interface TimelineEvent {
  id: string;
  topic: string;
  occurredAt: string;
  sequence: number;
}

export interface PipelineDetailResponse {
  pipeline: PipelineSummary;
  timeline: TimelineEvent[];
}

export interface BoardColumnMapping {
  columnId: string;
  columnName: string;
  action: 'dispatch_agent' | 'close_and_notify' | 'noop';
  agentId?: string;
  guards?: Array<{ type: string; value: string | number }>;
  stallThresholdMs?: number;
}

export interface BoardSummary {
  boardId: string;
  columnMappings: BoardColumnMapping[];
  defaultStallThresholdMs?: number;
  autoStartOnAssign?: boolean;
}

export interface BoardListResponse {
  items: BoardSummary[];
  total: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ---- Agents ----

export type TriggerMode = 'auto' | 'manual';
export type RunnerType = 'local' | 'stream-json' | 'sdk';
export type AuthMethod = 'api-key' | 'bedrock' | 'vertex' | 'foundry' | 'api-key-helper' | 'proxy';

export interface AgentRepoConfig {
  url?: string;
  path?: string;
  baseBranch: string;
  default?: boolean;
  projectId?: string;
}

export interface AgentLimitsConfig {
  maxDurationMs: number;
  stallThresholdMs?: number;
}

export interface ReviewLoopConfig {
  enabled?: boolean;
  ignoreReviewers?: string[];
  triggerReviewers?: string[];
  ignoreWorkflows?: string[];
  maxIterations?: number;
}

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
  runner?: RunnerType;
  auth: { method: AuthMethod; secretRef: string };
  repos: AgentRepoConfig[];
  limits: AgentLimitsConfig;
  reviewLoop?: ReviewLoopConfig;
}

export interface AgentRecord {
  id: string;
  config: AgentProfileConfig;
  secretFields: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentListResponse {
  items: AgentRecord[];
  total: number;
}

// ---- Webhook activity indicator ----

export interface WebhookActivitySnapshot {
  last: { source: 'plane' | 'github' | 'fizzy'; receivedAt: string } | null;
  perSource: Record<string, string>;
}
