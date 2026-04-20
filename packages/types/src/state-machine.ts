import type { CardId, InstanceId, DispatchId, AgentId, ColumnId, PrId, BoardId } from './ids.js';
import type { OuijaTopic, OuijaEventMap } from './events.js';

/**
 * Runtime list of all pipeline statuses — the single source of truth for the
 * `pipeline_instances.status` check constraint. Migration 006 is generated
 * from this array by `scripts/gen-status-migration.mjs`.
 *
 * Tenet 4: TypeScript generates SQL. Regenerate with `npm run gen:migrations`.
 * CI fails on drift. Never hand-edit migration 006; it is a generated file.
 *
 * Kept alphabetically sorted so the generated SQL body is stable regardless of
 * how the PipelineState discriminated union below is reorganised.
 */
export const PIPELINE_STATUSES = [
  'awaiting_review',
  'cancelled',
  'dispatching',
  'failed',
  'idle',
  'provisioning',
  'running',
  'stalled',
  'succeeded',
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

// ---- Pipeline states (discriminated union) ----
// Each arm's `status` tag MUST appear in PIPELINE_STATUSES above. The
// compile-time assertion after the union enforces both directions.

export type PipelineState =
  | { status: 'idle' }
  | { status: 'provisioning'; dispatchId: DispatchId; agentId: AgentId; dispatchedAt: string; workspaceId?: string }
  | { status: 'dispatching'; dispatchId: DispatchId; agentId: AgentId; dispatchedAt: string; iteration?: number }
  | { status: 'running'; dispatchId: DispatchId; agentId: AgentId; dispatchedAt: string; lastHeartbeatAt: string; prUrl?: string; prId?: PrId; iteration?: number }
  /**
   * PR is open and the agent has finished an iteration. Pipeline is idle at the
   * state-machine level but still "live" from the user's perspective — waiting
   * for reviewer comments (CodeRabbit, Copilot, human) which will arrive as a
   * `pr_review_received` trigger that re-enters `dispatching` with iteration+1.
   */
  | { status: 'awaiting_review'; dispatchId: DispatchId; agentId: AgentId; prUrl: string; prId: PrId; iteration: number; enteredAt: string }
  | { status: 'succeeded'; dispatchId: DispatchId; agentId: AgentId; completedAt: string; prUrl?: string; cost?: number; tokensUsed?: number }
  | { status: 'failed'; dispatchId: DispatchId; agentId: AgentId; failedAt: string; error: string; retryable: boolean }
  | { status: 'stalled'; dispatchId: DispatchId; agentId: AgentId; stalledAt: string; lastHeartbeatAt: string; reason?: string }
  | { status: 'cancelled'; cancelledAt: string; cancelledBy: string };

// Compile-time exhaustiveness: PIPELINE_STATUSES and PipelineState['status']
// must be mutually assignable. If this line fails to type-check, the two have
// diverged — add or remove the tag in PIPELINE_STATUSES, then run
// `npm run gen:migrations`.
type _PipelineStatusExhaustive = PipelineStatus extends PipelineState['status']
  ? PipelineState['status'] extends PipelineStatus
    ? true
    : 'ERROR: PipelineState union has a status not present in PIPELINE_STATUSES'
  : 'ERROR: PIPELINE_STATUSES contains a value not present in the PipelineState union';
const _pipelineStatusExhaustive: _PipelineStatusExhaustive = true;
void _pipelineStatusExhaustive;

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
  | { type: 'pr_merged'; prId: PrId; mergedAt: string }
  | { type: 'pr_review_received'; prUrl: string; prId: PrId; bundle: ReviewBundle };

/**
 * Aggregated PR feedback — reviews + comments + CI failures — flushed from the
 * review bundler after a quiet window. Every signal that landed during the
 * window is here, deduped by its GitHub id. Named ReviewBundle for historical
 * compatibility; carries CI failures too (see #PR 2.5) so a burst of
 * "reviewer comments + failing checks" coalesces into a single re-dispatch.
 */
export interface ReviewBundle {
  prUrl: string;
  prId: PrId;
  /** Reviewer-level submissions (approve / changes_requested / commented). */
  reviews: Array<{
    reviewId: string;
    reviewerLogin: string;
    state: 'approved' | 'changes_requested' | 'commented';
    body: string;
    submittedAt: string;
  }>;
  /** Inline review comments + top-level issue comments on the PR. */
  comments: Array<{
    commentId: string;
    reviewerLogin: string;
    body: string;
    path?: string;
    line?: number;
    postedAt: string;
  }>;
  /**
   * Failing CI runs against the PR's head commit (GitHub Actions + third-party
   * check providers). Optional so pre-PR-2.5 consumers keep working; undefined
   * is treated as an empty array by everything downstream.
   */
  ciFailures?: Array<BundleCiFailure>;
  /** When the bundler finished draining the window and emitted this trigger. */
  flushedAt: string;
}

export interface BundleCiFailure {
  checkId: string;
  provider: 'github-actions' | 'other';
  workflowName: string;
  jobName: string;
  conclusion: 'failure' | 'timed_out' | 'action_required';
  logsUrl?: string;
  summary?: string;
  headSha: string;
  completedAt: string;
}

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
  | 'destroy_workspace'
  /**
   * Persist the pr_url → instance_id mapping in pr_instance_index so that an
   * incoming PR review webhook (which only carries a PR URL) can resolve the
   * originating pipeline. Emitted alongside move_card / add_comment when
   * agent_pr_ready fires.
   */
  | 'record_pr_mapping';

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
  /**
   * Cap on review-loop iterations before the pipeline transitions to stalled.
   * Unset → engine default (5). Set per-board (or indirectly via the agent
   * profile in the future) to tune cost/quality tradeoff.
   */
  maxReviewIterations?: number;
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
