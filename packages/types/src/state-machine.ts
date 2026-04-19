import type { CardId, InstanceId, DispatchId, AgentId, ColumnId, PrId, BoardId } from './ids.js';
import type { OuijaTopic, OuijaEventMap } from './events.js';

// ---- Pipeline states (discriminated union) ----

export type PipelineState =
  | { status: 'idle' }
  | { status: 'provisioning'; dispatchId: DispatchId; agentId: AgentId; dispatchedAt: string; workspaceId?: string }
  | { status: 'dispatching'; dispatchId: DispatchId; agentId: AgentId; dispatchedAt: string }
  | { status: 'running'; dispatchId: DispatchId; agentId: AgentId; dispatchedAt: string; lastHeartbeatAt: string; prUrl?: string; prId?: PrId }
  | { status: 'succeeded'; dispatchId: DispatchId; agentId: AgentId; completedAt: string; prUrl?: string; cost?: number; tokensUsed?: number }
  | { status: 'failed'; dispatchId: DispatchId; agentId: AgentId; failedAt: string; error: string; retryable: boolean }
  | { status: 'stalled'; dispatchId: DispatchId; agentId: AgentId; stalledAt: string; lastHeartbeatAt: string }
  | { status: 'cancelled'; cancelledAt: string; cancelledBy: string };

export type PipelineStatus = PipelineState['status'];

// ---- Guard results ----

export interface GuardResult {
  guardType: string;
  passed: boolean;
  reason?: string;
}

// ---- Triggers (discriminated union) ----

export type PipelineTrigger =
  | { type: 'card_moved'; cardId: CardId; toColumnId: ColumnId; fromColumnId: ColumnId; guardContext: GuardContext }
  | { type: 'card_assigned'; cardId: CardId; assigneeId: string }
  | { type: 'workspace_provisioned'; dispatchId: DispatchId; workspaceId: string }
  | { type: 'agent_acknowledged'; dispatchId: DispatchId }
  | { type: 'agent_progress'; dispatchId: DispatchId; heartbeatAt: string; message: string }
  | { type: 'agent_pr_ready'; dispatchId: DispatchId; prUrl: string; prId: PrId }
  | { type: 'agent_completed'; dispatchId: DispatchId; cost?: number; tokensUsed?: number }
  | { type: 'agent_failed'; dispatchId: DispatchId; error: string; retryable: boolean }
  | { type: 'stall_detected'; dispatchId: DispatchId; detectedAt: string }
  | { type: 'human_retry'; retriedBy: string }
  | { type: 'human_cancel'; cancelledBy: string }
  | { type: 'pr_merged'; prId: PrId; mergedAt: string };

// Pre-fetched data for guard evaluation (gathered BEFORE calling transition)
export interface GuardContext {
  cardDescription: string;
  cardLabels: string[];
  cardAssignees: string[];
  existingOpenPR?: { prId: PrId; url: string };
}

// ---- Side effects ----

export type SideEffectType =
  | 'move_card'
  | 'add_comment'
  | 'send_notification'
  | 'dispatch_agent'
  | 'cancel_agent'
  | 'enqueue_stall_check'
  | 'cancel_stall_check'
  | 'destroy_workspace';

export interface SideEffect {
  type: SideEffectType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

// ---- Transition result ----

export interface TransitionSuccess {
  rejected: false;
  nextState: PipelineState;
  events: Array<{ topic: OuijaTopic; payload: OuijaEventMap[OuijaTopic] }>;
  sideEffects: SideEffect[];
}

export interface TransitionRejection {
  rejected: true;
  reason: string;
}

export type TransitionOutcome = TransitionSuccess | TransitionRejection;

// ---- Pipeline config ----

export interface Guard {
  type: 'min_description_length' | 'has_label' | 'has_assignee';
  value: string | number;
}

export interface ColumnMapping {
  columnId: ColumnId;
  columnName: string;
  action: 'dispatch_agent' | 'close_and_notify' | 'noop';
  agentId?: AgentId;
  guards: Guard[];
  stallThresholdMs?: number;
}

export interface PipelineConfig {
  boardId: BoardId;
  columnMappings: ColumnMapping[];
  defaultStallThresholdMs: number;
  autoStartOnAssign: boolean;
}

// ---- Pipeline instance (DB row) ----

export interface PipelineInstance {
  id: InstanceId;
  cardId: CardId;
  boardId: BoardId;
  projectId: string;
  state: PipelineState;
  attempt: number;
  /** Agent assigned via card assignment (manual trigger mode). Used to override column mapping agentId on dispatch. */
  assignedAgentId?: string;
  prUrl?: string;
  cost?: number;
  tokensUsed?: number;
  createdAt: string;
  updatedAt: string;
}
