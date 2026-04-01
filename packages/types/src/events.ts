import type { CardId, ColumnId, InstanceId, PrId, DispatchId } from './ids.js';
import type { NotificationLevel, NotificationAction } from './notification.js';

// ---- Event payloads ----

export interface KanbanCardMovedPayload {
  cardId: CardId;
  fromColumnId: ColumnId;
  toColumnId: ColumnId;
  movedBy: string;
}

export interface KanbanCardAssignedPayload {
  cardId: CardId;
  assigneeId: string;
  assignedBy: string;
}

export interface GitPrOpenedPayload {
  prId: PrId;
  url: string;
  instanceId: InstanceId;
  branch: string;
  targetBranch: string;
}

export interface GitPrMergedPayload {
  prId: PrId;
  instanceId: InstanceId;
  mergedAt: string;
}

export interface AgentWorkProgressPayload {
  instanceId: InstanceId;
  dispatchId: DispatchId;
  progress: number;
  message: string;
}

export interface AgentWorkPrReadyPayload {
  instanceId: InstanceId;
  dispatchId: DispatchId;
  prUrl: string;
  prId: PrId;
}

export interface AgentWorkCompletedPayload {
  instanceId: InstanceId;
  dispatchId: DispatchId;
  cost?: number;
  tokensUsed?: number;
}

export interface AgentWorkFailedPayload {
  instanceId: InstanceId;
  dispatchId: DispatchId;
  error: string;
  retryable: boolean;
}

export interface NotificationSendPayload {
  /** Short notification heading */
  title: string;
  /** Notification body text */
  body: string;
  level: NotificationLevel;
  /** Optional action buttons (deep links) */
  actions?: NotificationAction[];
  /** Opaque idempotency key — prevents duplicate sends on retry */
  idempotencyKey: string;
  /** Pipeline instance ID that originated this notification */
  instanceId: string;
}

// ---- Event map: topic → payload type ----

export interface OuijaEventMap {
  'kanban.card.moved': KanbanCardMovedPayload;
  'kanban.card.assigned': KanbanCardAssignedPayload;
  'git.pr.opened': GitPrOpenedPayload;
  'git.pr.merged': GitPrMergedPayload;
  'agent.work.progress': AgentWorkProgressPayload;
  'agent.work.pr_ready': AgentWorkPrReadyPayload;
  'agent.work.completed': AgentWorkCompletedPayload;
  'agent.work.failed': AgentWorkFailedPayload;
  'notification.send': NotificationSendPayload;
}

export type OuijaTopic = keyof OuijaEventMap;

// ---- Event envelope ----

export interface OuijaEvent<TTopic extends OuijaTopic = OuijaTopic> {
  id: string;
  topic: TTopic;
  payload: OuijaEventMap[TTopic];
  timestamp: string;
  sourcePlugin: string;
  correlationId: string;
}
