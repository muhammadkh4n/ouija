import type { CardId, ColumnId, InstanceId, PrId, DispatchId } from './ids.js';
import type { NotificationLevel, NotificationAction } from './notification.js';
import type { DispatchOutcome } from './state-machine.js';

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
  /**
   * Full HTML URL of the PR — the canonical identifier from GitHub's side.
   * Used by the orchestrator to resolve the originating Ouija pipeline via
   * `pr_instance_index`. No `instanceId` here: the webhook fires before the
   * agent's own `agent.work.pr_ready` event populates the index, so the
   * opened event is effectively informational until the index catches up.
   */
  url: string;
  branch: string;
  targetBranch: string;
}

export interface GitPrMergedPayload {
  prId: PrId;
  /**
   * Full HTML URL of the PR. Primary key for orchestrator instance
   * resolution via `pr_instance_index`. Replaces the old `instanceId` field
   * which was fabricated from the PR number by the webhook handler and
   * never matched a real pipeline instance — see Ouija/Build Log session
   * 2e (Phase 1 Task 3).
   */
  url: string;
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

/**
 * A failing CI signal attached to a PR — GitHub Actions (`check_run`,
 * `workflow_run`) plus any third-party CI that pipes through the same
 * webhook. Coalesces into the same bundle as review comments so a burst of
 * (review + failing checks) produces one follow-up dispatch, not many.
 */
export interface GitCiFailedPayload {
  prUrl: string;
  prId: PrId;
  /**
   * Stable ID for dedupe: `{provider}:{runId}:{jobName}` so re-runs of the
   * same job within a workflow replace the entry instead of appending.
   */
  checkId: string;
  provider: 'github-actions' | 'other';
  /** Parent workflow name (e.g. "CI" in `.github/workflows/ci.yml`). */
  workflowName: string;
  /** Individual job or check name within the workflow. */
  jobName: string;
  conclusion: 'failure' | 'timed_out' | 'action_required';
  /** URL to the raw logs the agent can fetch when it has repo read access. */
  logsUrl?: string;
  /** Short human-readable summary pulled from GitHub's `check_run.output.summary`. */
  summary?: string;
  /** Head commit SHA this check ran against — for cross-referencing with git blame. */
  headSha: string;
  completedAt: string;
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
  /**
   * Positive-evidence summary of the run. Populated by runners that can
   * report it (stream-json, sdk); absent for legacy runners. When present
   * and empty, the orchestrator treats the dispatch as failed, not succeeded
   * (Tenet 3). See [[DispatchOutcome]] in state-machine.ts.
   */
  outcome?: DispatchOutcome;
}

/**
 * Emitted by the orchestrator when a pipeline completes (successfully or
 * via zero-progress rejection). Intended for downstream consumers like
 * Phase 4's plugin-engram — subscribe to this topic to ingest dispatch
 * outcomes as memory episodes without touching the engine's internals.
 *
 * Fires once per agent_completed trigger, after state persistence.
 */
export interface DispatchOutcomePayload {
  instanceId: InstanceId;
  dispatchId: DispatchId;
  outcome: DispatchOutcome;
  /** Whether the outcome was accepted as success or rejected as no-progress. */
  accepted: boolean;
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

/**
 * Audit record emitted whenever an operator returns a stuck pipeline to `idle`
 * via the `admin_reset` trigger. Distinct from `pipeline.transitioned` (which
 * the orchestrator also appends for the same hop) so admin-driven resets are
 * trivially queryable without scanning every status hop.
 */
export interface PipelineAdminResetPayload {
  instanceId: InstanceId;
  /** Status the pipeline was in immediately before the reset. */
  fromStatus: string;
  /** Identifier of the operator who issued the reset (session userId or 'api'). */
  requestedBy: string;
  /** ISO-8601 instant the reset side-effect data was generated. */
  resetAt: string;
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
  'git.ci.failed': GitCiFailedPayload;
  'agent.work.progress': AgentWorkProgressPayload;
  'agent.work.pr_ready': AgentWorkPrReadyPayload;
  'agent.work.completed': AgentWorkCompletedPayload;
  'agent.work.failed': AgentWorkFailedPayload;
  'dispatch.outcome': DispatchOutcomePayload;
  'notification.send': NotificationSendPayload;
  'pipeline.transitioned': PipelineTransitionedPayload;
  'pipeline.admin_reset': PipelineAdminResetPayload;
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
