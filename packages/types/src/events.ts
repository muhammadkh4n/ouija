import type { CardId, ColumnId, InstanceId, PrId, DispatchId } from './ids.js';

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
