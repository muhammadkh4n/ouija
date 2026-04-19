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

/** A PR review submission — approve / request-changes / plain comment. */
export interface GitPrReviewSubmittedPayload {
  /** Full HTML URL of the PR; the server uses this to resolve instanceId via pr_instance_index. */
  prUrl: string;
  prId: PrId;
  /** Stable id for dedupe across webhook retries. */
  reviewId: string;
  /**
   * GitHub review state. `pending` is filtered out at the webhook layer — only
   * submitted reviews reach this event.
   */
  state: 'approved' | 'changes_requested' | 'commented';
  reviewerLogin: string;
  /** Top-level review body (may be empty when the reviewer only left inline comments). */
  body: string;
  submittedAt: string;
}

/**
 * Any PR-attached comment other than a formal review: top-level issue comments
 * (`issue_comment` on a PR) and inline review comments (`pull_request_review_comment`).
 * Both are coalesced into a single topic because downstream consumers (the
 * review bundler) treat them identically.
 */
export interface GitPrCommentPostedPayload {
  prUrl: string;
  prId: PrId;
  commentId: string;
  reviewerLogin: string;
  body: string;
  /** Present for inline comments; absent for top-level `issue_comment` replies. */
  path?: string;
  /** 1-based line number in the new file; present only for inline comments. */
  line?: number;
  postedAt: string;
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

export interface PipelineTransitionedPayload {
  instanceId: InstanceId;
  fromStatus: string;
  toStatus: string;
  trigger: string;
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
  'git.pr.review.submitted': GitPrReviewSubmittedPayload;
  'git.pr.comment.posted': GitPrCommentPostedPayload;
  'agent.work.progress': AgentWorkProgressPayload;
  'agent.work.pr_ready': AgentWorkPrReadyPayload;
  'agent.work.completed': AgentWorkCompletedPayload;
  'agent.work.failed': AgentWorkFailedPayload;
  'notification.send': NotificationSendPayload;
  'pipeline.transitioned': PipelineTransitionedPayload;
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
