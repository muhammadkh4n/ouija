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
