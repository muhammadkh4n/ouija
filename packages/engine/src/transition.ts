/**
 * Pure Pipeline Transition Function
 *
 * INVARIANT: This function has ZERO I/O. No database. No network. No filesystem.
 * No async. No side effects executed here.
 *
 * Side effects are DECLARED as data (SideEffect[]) and returned to the caller.
 * The only acceptable non-pure element is randomUUID() for generating new dispatch IDs.
 *
 * If guards need external data, that data MUST be pre-fetched by the caller (Orchestrator)
 * and passed in via the trigger payload (guardContext). Never add I/O inside this function.
 */

import { randomUUID } from 'node:crypto';
import type {
  PipelineState,
  PipelineTrigger,
  PipelineConfig,
  TransitionOutcome,
  SideEffect,
  ColumnMapping,
} from '@ouija-dev/types';
import { dispatchId as makeDispatchId, agentId as makeAgentId, hasPositiveEvidence } from '@ouija-dev/types';
import { evaluateGuards } from './guards.js';
import { encodeJobId } from './ids.js';

// ---- Public API ----

export function transition(
  state: PipelineState,
  trigger: PipelineTrigger,
  config: PipelineConfig,
): TransitionOutcome {
  switch (trigger.type) {
    case 'card_moved':
      return handleCardMoved(state, trigger, config);
    case 'card_assigned':
      return handleCardAssigned(state, trigger, config);
    case 'workspace_provisioned':
      return handleWorkspaceProvisioned(state, trigger);
    case 'agent_acknowledged':
      return handleAgentAcknowledged(state, trigger);
    case 'agent_progress':
      return handleAgentProgress(state, trigger);
    case 'agent_pr_ready':
      return handleAgentPrReady(state, trigger);
    case 'agent_completed':
      return handleAgentCompleted(state, trigger);
    case 'agent_failed':
      return handleAgentFailed(state, trigger);
    case 'stall_detected':
      return handleStallDetected(state, trigger);
    case 'human_retry':
      return handleHumanRetry(state, trigger, config);
    case 'human_cancel':
      return handleHumanCancel(state, trigger);
    case 'admin_reset':
      return handleAdminReset(state, trigger);
    case 'pr_merged':
      return handlePrMerged(state, trigger);
    case 'pr_review_received':
      return handlePrReviewReceived(state, trigger, config);
    default: {
      const _exhaustive: never = trigger;
      return {
        rejected: true,
        reason: `Unknown trigger type: ${JSON.stringify(_exhaustive)}`,
      };
    }
  }
}

// ---- Trigger handlers ----

function handleCardMoved(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'card_moved' }>,
  config: PipelineConfig,
): TransitionOutcome {
  // Reject if pipeline is already active — we do not dispatch a second agent
  if (state.status === 'provisioning' || state.status === 'dispatching' || state.status === 'running') {
    return {
      rejected: true,
      reason: `Pipeline already active (status: ${state.status}), skipping dispatch`,
    };
  }

  const mapping = findColumnMapping(trigger.toColumnId, config);

  if (mapping === undefined) {
    return {
      rejected: true,
      reason: `No column mapping found for column "${trigger.toColumnId}"`,
    };
  }

  if (mapping.action === 'noop') {
    return {
      rejected: true,
      reason: `Column "${mapping.columnName}" is mapped to noop — no action taken`,
    };
  }

  if (mapping.action === 'close_and_notify') {
    const now = new Date().toISOString();
    // close_and_notify: mark succeeded immediately (no agent dispatch)
    const nextState: PipelineState = {
      status: 'succeeded',
      dispatchId: makeDispatchId(''),
      agentId: makeAgentId(''),
      completedAt: now,
    };
    const sideEffects: SideEffect[] = [
      {
        type: 'send_notification',
        payload: { cardId: trigger.cardId, message: `Card moved to "${mapping.columnName}" — pipeline closed` },
        idempotencyKey: encodeJobId(['close-notify', trigger.cardId, trigger.toColumnId]),
      },
    ];
    return {
      rejected: false,
      nextState,
      events: [],
      sideEffects,
    };
  }

  // action === 'dispatch_agent'
  if (mapping.agentId === undefined) {
    return {
      rejected: true,
      reason: `Column "${mapping.columnName}" has action "dispatch_agent" but no agentId configured`,
    };
  }

  // Evaluate guards — guard failure is NOT a hard rejection; it produces a notification
  // and leaves state unchanged (so the card can be fixed and moved again)
  const guardResults = evaluateGuards(mapping.guards, trigger.guardContext);
  const failedGuards = guardResults.filter((g) => !g.passed);

  if (failedGuards.length > 0) {
    return {
      rejected: false,
      nextState: state, // state unchanged — awaiting card fix
      events: [],
      sideEffects: [
        {
          type: 'send_notification',
          payload: {
            cardId: trigger.cardId,
            guardsFailed: failedGuards,
            message: `Guards failed for card "${trigger.cardId}": ${failedGuards.map((g) => g.reason ?? g.guardType).join('; ')}`,
          },
          idempotencyKey: encodeJobId(['guard-fail', trigger.cardId, trigger.toColumnId]),
        },
      ],
    };
  }

  const newDispatchId = makeDispatchId(randomUUID());
  const agentId = mapping.agentId;
  const now = new Date().toISOString();
  const stallMs = mapping.stallThresholdMs ?? config.defaultStallThresholdMs;

  const nextState: PipelineState = {
    status: 'dispatching',
    dispatchId: newDispatchId,
    agentId,
    dispatchedAt: now,
  };

  const sideEffects: SideEffect[] = [
    {
      type: 'dispatch_agent',
      payload: { dispatchId: newDispatchId, agentId },
      idempotencyKey: encodeJobId(['dispatch', newDispatchId]),
    },
    {
      type: 'enqueue_stall_check',
      payload: { dispatchId: newDispatchId, delayMs: stallMs },
      idempotencyKey: encodeJobId(['stall-check', newDispatchId]),
    },
  ];

  return {
    rejected: false,
    nextState,
    events: [],
    sideEffects,
  };
}

function handleCardAssigned(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'card_assigned' }>,
  config: PipelineConfig,
): TransitionOutcome {
  if (!config.autoStartOnAssign) {
    return {
      rejected: true,
      reason: 'Auto-start on assign is disabled for this pipeline',
    };
  }

  if (state.status !== 'idle') {
    return {
      rejected: true,
      reason: `Cannot auto-start: pipeline is already in state "${state.status}"`,
    };
  }

  // When auto-start is enabled, the Orchestrator is responsible for converting this
  // into a card_moved trigger with the appropriate column context and guard data.
  // The transition function intentionally does not replicate card_moved dispatch logic here
  // to avoid dual-maintenance of the same dispatch path.
  return {
    rejected: true,
    reason: 'card_assigned with auto-start enabled must be converted to card_moved by the Orchestrator before calling transition()',
  };
}

function handleWorkspaceProvisioned(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'workspace_provisioned' }>,
): TransitionOutcome {
  if (state.status !== 'provisioning') {
    return {
      rejected: true,
      reason: `Cannot mark workspace provisioned: pipeline is in state "${state.status}", expected "provisioning"`,
    };
  }

  if (state.dispatchId !== trigger.dispatchId) {
    return {
      rejected: true,
      reason: `Dispatch ID mismatch: expected "${state.dispatchId}", got "${trigger.dispatchId}"`,
    };
  }

  const nextState: PipelineState = {
    status: 'dispatching',
    dispatchId: state.dispatchId,
    agentId: state.agentId,
    dispatchedAt: state.dispatchedAt,
  };

  return {
    rejected: false,
    nextState,
    events: [],
    sideEffects: [],
  };
}

function handleAgentAcknowledged(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'agent_acknowledged' }>,
): TransitionOutcome {
  if (state.status !== 'dispatching') {
    return {
      rejected: true,
      reason: `Cannot acknowledge: pipeline is in state "${state.status}", expected "dispatching"`,
    };
  }

  if (state.dispatchId !== trigger.dispatchId) {
    return {
      rejected: true,
      reason: `Dispatch ID mismatch: expected "${state.dispatchId}", got "${trigger.dispatchId}"`,
    };
  }

  // Carry iteration forward through dispatching → running so the review-loop
  // counter survives into awaiting_review on agent_completed.
  const nextState: PipelineState = {
    status: 'running',
    dispatchId: state.dispatchId,
    agentId: state.agentId,
    dispatchedAt: state.dispatchedAt,
    lastHeartbeatAt: new Date().toISOString(),
    ...(state.iteration !== undefined ? { iteration: state.iteration } : {}),
  };

  return {
    rejected: false,
    nextState,
    events: [],
    sideEffects: [],
  };
}

function handleAgentProgress(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'agent_progress' }>,
): TransitionOutcome {
  if (state.status !== 'running') {
    return {
      rejected: true,
      reason: `Cannot record progress: pipeline is in state "${state.status}", expected "running"`,
    };
  }

  const nextState: PipelineState = {
    ...state,
    lastHeartbeatAt: trigger.heartbeatAt,
  };

  const sideEffects: SideEffect[] = [
    {
      type: 'cancel_stall_check',
      payload: { dispatchId: state.dispatchId },
      idempotencyKey: encodeJobId(['cancel-stall', state.dispatchId, trigger.heartbeatAt]),
    },
    {
      type: 'enqueue_stall_check',
      payload: { dispatchId: state.dispatchId },
      idempotencyKey: encodeJobId(['stall-check', state.dispatchId, trigger.heartbeatAt]),
    },
  ];

  return {
    rejected: false,
    nextState,
    events: [],
    sideEffects,
  };
}

function handleAgentPrReady(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'agent_pr_ready' }>,
): TransitionOutcome {
  if (state.status !== 'running') {
    return {
      rejected: true,
      reason: `Cannot mark PR ready: pipeline is in state "${state.status}", expected "running"`,
    };
  }

  // State stays running — the PR has been opened but agent work continues until
  // completed. We also emit a record_pr_mapping side effect so a later review
  // webhook carrying just a PR URL can resolve back to this instance.
  const sideEffects: SideEffect[] = [
    {
      type: 'move_card',
      payload: { columnName: 'Review', prUrl: trigger.prUrl, prId: trigger.prId },
      idempotencyKey: encodeJobId(['move-review', trigger.dispatchId]),
    },
    {
      type: 'add_comment',
      payload: { body: `PR ready for review: ${trigger.prUrl}`, prId: trigger.prId },
      idempotencyKey: encodeJobId(['comment-pr-ready', trigger.dispatchId]),
    },
    {
      type: 'send_notification',
      payload: { prUrl: trigger.prUrl, prId: trigger.prId },
      idempotencyKey: encodeJobId(['notify-pr-ready', trigger.dispatchId]),
    },
    {
      type: 'record_pr_mapping',
      payload: { prUrl: trigger.prUrl },
      idempotencyKey: encodeJobId(['record-pr', trigger.prUrl]),
    },
  ];

  return {
    rejected: false,
    nextState: {
      ...state,
      prUrl: trigger.prUrl,
      prId: trigger.prId,
      // Carry the iteration counter through so handleAgentCompleted can preserve
      // it when transitioning to awaiting_review. Default 1 on the first PR.
      iteration: state.iteration ?? 1,
    },
    events: [],
    sideEffects,
  };
}

function handleAgentCompleted(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'agent_completed' }>,
): TransitionOutcome {
  if (state.status !== 'running') {
    return {
      rejected: true,
      reason: `Cannot complete: pipeline is in state "${state.status}", expected "running"`,
    };
  }

  const now = new Date().toISOString();

  // Tenet 3 — positive evidence. If the runner reported an outcome AND that
  // outcome shows no observable progress (no PR, no commits pushed, no tool
  // calls), reject the "completed" signal and transition to `failed`. This
  // is the defence-in-depth sibling of the runner-level check in
  // plugin-agent-claude: a runner that forgets to pre-reject is still caught
  // here. Legacy runners that don't report an outcome keep the old behaviour
  // (outcome === undefined → trust the subprocess exit).
  //
  // Also emits `dispatch.outcome` so Phase 4's plugin-engram can ingest the
  // outcome as a memory episode without subscribing to the richer
  // `agent.work.completed` topic (which carries the original payload).
  const outcome = trigger.outcome;
  const hasOutcome = outcome !== undefined;
  const outcomeRejected = hasOutcome && !hasPositiveEvidence(outcome);

  if (outcomeRejected) {
    const nextState: PipelineState = {
      status: 'failed',
      dispatchId: state.dispatchId,
      agentId: state.agentId,
      failedAt: now,
      error: 'no observable progress',
      retryable: false,
    };
    const sideEffects: SideEffect[] = [
      {
        type: 'cancel_stall_check',
        payload: { dispatchId: state.dispatchId },
        idempotencyKey: encodeJobId(['cancel-stall-complete', trigger.dispatchId]),
      },
    ];
    return {
      rejected: false,
      nextState,
      events: [
        {
          topic: 'dispatch.outcome',
          payload: {
            instanceId: '' as never,
            dispatchId: state.dispatchId,
            outcome,
            accepted: false,
          },
        },
      ],
      sideEffects,
    };
  }

  // If the agent opened a PR, transition to awaiting_review and wait for
  // reviewer feedback. The card stays in Review; a later pr_review_received
  // trigger (from the review bundler) re-dispatches with iteration++.
  //
  // If no PR was opened (rare — most paths that reach running → completed do
  // open one) we fall through to the legacy succeeded transition so nothing
  // hangs indefinitely.
  if (state.prUrl !== undefined && state.prId !== undefined) {
    const nextState: PipelineState = {
      status: 'awaiting_review',
      dispatchId: state.dispatchId,
      agentId: state.agentId,
      prUrl: state.prUrl,
      prId: state.prId,
      iteration: state.iteration ?? 1,
      enteredAt: now,
    };
    const sideEffects: SideEffect[] = [
      {
        type: 'cancel_stall_check',
        payload: { dispatchId: state.dispatchId },
        idempotencyKey: encodeJobId(['cancel-stall-complete', trigger.dispatchId]),
      },
    ];
    const events = hasOutcome
      ? [
          {
            topic: 'dispatch.outcome' as const,
            payload: {
              instanceId: '' as never,
              dispatchId: state.dispatchId,
              outcome,
              accepted: true,
            },
          },
        ]
      : [];
    return { rejected: false, nextState, events, sideEffects };
  }

  // No PR — treat as legacy completion. Preserves the close_and_notify and
  // any "agent did work without opening a PR" paths.
  const nextState: PipelineState = {
    status: 'succeeded',
    dispatchId: state.dispatchId,
    agentId: state.agentId,
    completedAt: now,
    ...(trigger.cost !== undefined ? { cost: trigger.cost } : {}),
    ...(trigger.tokensUsed !== undefined ? { tokensUsed: trigger.tokensUsed } : {}),
  };

  const sideEffects: SideEffect[] = [
    {
      type: 'cancel_stall_check',
      payload: { dispatchId: state.dispatchId },
      idempotencyKey: encodeJobId(['cancel-stall-complete', trigger.dispatchId]),
    },
    {
      type: 'move_card',
      payload: { columnName: 'Done' },
      idempotencyKey: encodeJobId(['move-done', trigger.dispatchId]),
    },
  ];

  const events = hasOutcome
    ? [
        {
          topic: 'dispatch.outcome' as const,
          payload: {
            instanceId: '' as never,
            dispatchId: state.dispatchId,
            outcome,
            accepted: true,
          },
        },
      ]
    : [];

  return {
    rejected: false,
    nextState,
    events,
    sideEffects,
  };
}

function handleAgentFailed(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'agent_failed' }>,
): TransitionOutcome {
  if (state.status !== 'running' && state.status !== 'dispatching' && state.status !== 'provisioning') {
    return {
      rejected: true,
      reason: `Cannot fail: pipeline is in state "${state.status}", expected "running", "dispatching", or "provisioning"`,
    };
  }

  const now = new Date().toISOString();

  const nextState: PipelineState = {
    status: 'failed',
    dispatchId: state.dispatchId,
    agentId: state.agentId,
    failedAt: now,
    error: trigger.error,
    retryable: trigger.retryable,
  };

  const sideEffects: SideEffect[] = [
    {
      type: 'cancel_stall_check',
      payload: { dispatchId: trigger.dispatchId },
      idempotencyKey: encodeJobId(['cancel-stall-fail', trigger.dispatchId]),
    },
    {
      type: 'move_card',
      payload: { columnName: 'Failed' },
      idempotencyKey: encodeJobId(['move-failed', trigger.dispatchId]),
    },
    {
      type: 'send_notification',
      payload: { error: trigger.error, retryable: trigger.retryable },
      idempotencyKey: encodeJobId(['notify-fail', trigger.dispatchId]),
    },
  ];

  return {
    rejected: false,
    nextState,
    events: [],
    sideEffects,
  };
}

function handleStallDetected(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'stall_detected' }>,
): TransitionOutcome {
  if (state.status !== 'running' && state.status !== 'dispatching' && state.status !== 'provisioning') {
    return {
      rejected: true,
      reason: `Cannot mark stalled: pipeline is in state "${state.status}", expected "running", "dispatching", or "provisioning"`,
    };
  }

  const lastHeartbeatAt =
    state.status === 'running' ? state.lastHeartbeatAt : trigger.detectedAt;

  const nextState: PipelineState = {
    status: 'stalled',
    dispatchId: state.dispatchId,
    agentId: state.agentId,
    stalledAt: trigger.detectedAt,
    lastHeartbeatAt,
  };

  const sideEffects: SideEffect[] = [
    {
      type: 'send_notification',
      payload: { dispatchId: trigger.dispatchId, detectedAt: trigger.detectedAt, message: 'Agent has stalled — no heartbeat received' },
      idempotencyKey: encodeJobId(['notify-stall', trigger.dispatchId]),
    },
  ];

  return {
    rejected: false,
    nextState,
    events: [],
    sideEffects,
  };
}

function handleHumanRetry(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'human_retry' }>,
  config: PipelineConfig,
): TransitionOutcome {
  if (state.status !== 'failed' && state.status !== 'stalled') {
    return {
      rejected: true,
      reason: `Cannot retry: pipeline is in state "${state.status}", must be "failed" or "stalled"`,
    };
  }

  const newDispatchId = makeDispatchId(randomUUID());
  const now = new Date().toISOString();

  const nextState: PipelineState = {
    status: 'dispatching',
    dispatchId: newDispatchId,
    agentId: state.agentId,
    dispatchedAt: now,
  };

  const sideEffects: SideEffect[] = [
    {
      type: 'dispatch_agent',
      payload: { dispatchId: newDispatchId, agentId: state.agentId, retriedBy: trigger.retriedBy },
      idempotencyKey: encodeJobId(['dispatch-retry', newDispatchId]),
    },
    {
      type: 'enqueue_stall_check',
      payload: { dispatchId: newDispatchId, delayMs: config.defaultStallThresholdMs },
      idempotencyKey: encodeJobId(['stall-check-retry', newDispatchId]),
    },
  ];

  return {
    rejected: false,
    nextState,
    events: [],
    sideEffects,
  };
}

function handleHumanCancel(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'human_cancel' }>,
): TransitionOutcome {
  // Cannot cancel terminal or inactive states
  if (
    state.status === 'idle' ||
    state.status === 'succeeded' ||
    state.status === 'cancelled'
  ) {
    return {
      rejected: true,
      reason: `Cannot cancel: pipeline is in state "${state.status}"`,
    };
  }

  const now = new Date().toISOString();

  const sideEffects: SideEffect[] = [
    {
      type: 'send_notification',
      payload: { cancelledBy: trigger.cancelledBy, message: 'Pipeline cancelled by human' },
      idempotencyKey: encodeJobId(['notify-cancel', trigger.cancelledBy, now]),
    },
  ];

  // Only active states have an agent that needs cancelling
  if (state.status === 'provisioning' || state.status === 'dispatching' || state.status === 'running') {
    if (state.status === 'provisioning' && 'workspaceId' in state && state.workspaceId) {
      sideEffects.push({
        type: 'destroy_workspace',
        payload: { workspaceId: state.workspaceId },
        idempotencyKey: encodeJobId(['destroy-ws', state.dispatchId]),
      });
    }
    sideEffects.push(
      {
        type: 'cancel_agent',
        payload: { dispatchId: state.dispatchId },
        idempotencyKey: encodeJobId(['cancel-agent', state.dispatchId]),
      },
      {
        type: 'cancel_stall_check',
        payload: { dispatchId: state.dispatchId },
        idempotencyKey: encodeJobId(['cancel-stall-cancel', state.dispatchId]),
      },
    );
  }

  const nextState: PipelineState = {
    status: 'cancelled',
    cancelledAt: now,
    cancelledBy: trigger.cancelledBy,
  };

  return {
    rejected: false,
    nextState,
    events: [],
    sideEffects,
  };
}

function handleAdminReset(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'admin_reset' }>,
): TransitionOutcome {
  // Stuck-state recovery only. `idle` is a no-op (already there). `succeeded`
  // and `cancelled` are terminal by intent — undoing them would falsify the
  // audit log. `failed` has its own retry vocabulary (`human_retry`); routing
  // it through reset would discard the dispatch context retry needs.
  if (
    state.status === 'idle' ||
    state.status === 'succeeded' ||
    state.status === 'cancelled' ||
    state.status === 'failed'
  ) {
    return {
      rejected: true,
      reason: `Cannot reset: pipeline is in state "${state.status}"`,
    };
  }

  const now = new Date().toISOString();
  const fromStatus = state.status;
  const sideEffects: SideEffect[] = [
    {
      type: 'send_notification',
      payload: {
        requestedBy: trigger.requestedBy,
        message: `Pipeline reset by admin (was in "${fromStatus}")`,
      },
      idempotencyKey: encodeJobId(['notify-reset', trigger.requestedBy, now]),
    },
  ];

  // Tear down any in-flight dispatch the prior state owns. `awaiting_review`
  // and `stalled` carry a dispatchId but no live process — the cancel side
  // effects are idempotent no-ops in those cases, so issuing them keeps the
  // path uniform without risking double-cancellation.
  if (
    state.status === 'provisioning' ||
    state.status === 'dispatching' ||
    state.status === 'running'
  ) {
    if (state.status === 'provisioning' && 'workspaceId' in state && state.workspaceId) {
      sideEffects.push({
        type: 'destroy_workspace',
        payload: { workspaceId: state.workspaceId },
        idempotencyKey: encodeJobId(['destroy-ws-reset', state.dispatchId]),
      });
    }
    sideEffects.push(
      {
        type: 'cancel_agent',
        payload: { dispatchId: state.dispatchId },
        idempotencyKey: encodeJobId(['cancel-agent-reset', state.dispatchId]),
      },
      {
        type: 'cancel_stall_check',
        payload: { dispatchId: state.dispatchId },
        idempotencyKey: encodeJobId(['cancel-stall-reset', state.dispatchId]),
      },
    );
  } else if (state.status === 'awaiting_review' || state.status === 'stalled') {
    sideEffects.push({
      type: 'cancel_stall_check',
      payload: { dispatchId: state.dispatchId },
      idempotencyKey: encodeJobId(['cancel-stall-reset', state.dispatchId]),
    });
  }

  const nextState: PipelineState = { status: 'idle' };

  return {
    rejected: false,
    nextState,
    // instanceId is filled in by Orchestrator.applyTrigger via stampInstanceId
    // — the pure transition has no instance context. resetAt seeds the audit
    // event with the same `now` used by the side-effect idempotency keys.
    events: [
      {
        topic: 'pipeline.admin_reset',
        payload: {
          fromStatus,
          requestedBy: trigger.requestedBy,
          resetAt: now,
        } as unknown as import('@ouija-dev/types').OuijaEventMap['pipeline.admin_reset'],
      },
    ],
    sideEffects,
  };
}

function handlePrMerged(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'pr_merged' }>,
): TransitionOutcome {
  // PR merged is valid from running / awaiting_review / succeeded. In the
  // review-loop flow, awaiting_review is the usual terminator: human merges
  // the PR → we transition to succeeded.
  if (
    state.status !== 'running' &&
    state.status !== 'awaiting_review' &&
    state.status !== 'succeeded'
  ) {
    return {
      rejected: true,
      reason: `Cannot process PR merge: pipeline is in state "${state.status}", expected "running", "awaiting_review", or "succeeded"`,
    };
  }

  // Preserve cost/tokens from the existing succeeded state if present
  const cost = state.status === 'succeeded' ? state.cost : undefined;
  const tokensUsed = state.status === 'succeeded' ? state.tokensUsed : undefined;
  // Carry the PR URL forward into the succeeded state so the dashboard + denorm
  // projection keep it visible post-merge. awaiting_review always has it;
  // running may or may not; succeeded passes through its own.
  const prUrl =
    state.status === 'awaiting_review'
      ? state.prUrl
      : state.status === 'running'
      ? state.prUrl
      : state.prUrl;

  const nextState: PipelineState = {
    status: 'succeeded',
    dispatchId: state.dispatchId,
    agentId: state.agentId,
    completedAt: trigger.mergedAt,
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
  };

  const sideEffects: SideEffect[] = [
    {
      type: 'move_card',
      payload: { columnName: 'Done', prId: trigger.prId },
      idempotencyKey: encodeJobId(['move-done-merged', trigger.prId]),
    },
    {
      type: 'cancel_stall_check',
      payload: { prId: trigger.prId },
      idempotencyKey: encodeJobId(['cancel-stall-merged', trigger.prId]),
    },
  ];

  return {
    rejected: false,
    nextState,
    events: [],
    sideEffects,
  };
}

/**
 * Default cap when PipelineConfig.maxReviewIterations is not set. 5 is plenty
 * for the common "CodeRabbit complains → agent fixes → approval" flow without
 * running up the Claude subscription bill on a runaway loop.
 */
export const DEFAULT_MAX_REVIEW_ITERATIONS = 5;

function handlePrReviewReceived(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'pr_review_received' }>,
  config: PipelineConfig,
): TransitionOutcome {
  if (state.status !== 'awaiting_review') {
    return {
      rejected: true,
      reason: `Cannot process PR review: pipeline is in state "${state.status}", expected "awaiting_review"`,
    };
  }

  // Sanity check — reviews for a different PR than the one this pipeline
  // opened. Can happen if pr_instance_index gets out of sync; we silently
  // drop rather than re-dispatching on the wrong branch.
  if (state.prUrl !== trigger.prUrl) {
    return {
      rejected: true,
      reason: `PR review targets "${trigger.prUrl}" but pipeline owns "${state.prUrl}"`,
    };
  }

  const now = new Date().toISOString();
  const nextIteration = state.iteration + 1;
  const maxIterations = config.maxReviewIterations ?? DEFAULT_MAX_REVIEW_ITERATIONS;

  // Max-iteration guard — runaway loop protection. Transitions to stalled with
  // a notification so a human can take over.
  if (nextIteration > maxIterations) {
    const stalledState: PipelineState = {
      status: 'stalled',
      dispatchId: state.dispatchId,
      agentId: state.agentId,
      stalledAt: now,
      lastHeartbeatAt: state.enteredAt,
      reason: `max_review_iterations_exceeded (${maxIterations})`,
    };
    return {
      rejected: false,
      nextState: stalledState,
      events: [],
      sideEffects: [
        {
          type: 'send_notification',
          payload: {
            prUrl: state.prUrl,
            prId: state.prId,
            iteration: state.iteration,
            message: `Review loop exceeded ${maxIterations} iterations — human attention required on ${state.prUrl}`,
          },
          idempotencyKey: encodeJobId(['max-iter', state.prUrl, String(state.iteration)]),
        },
      ],
    };
  }

  // Fresh dispatchId for the follow-up dispatch so stall-check, heartbeats,
  // and idempotency keys don't collide with the previous iteration.
  const newDispatchId = makeDispatchId(randomUUID());

  const nextState: PipelineState = {
    status: 'dispatching',
    dispatchId: newDispatchId,
    agentId: state.agentId,
    dispatchedAt: now,
    iteration: nextIteration,
  };

  return {
    rejected: false,
    nextState,
    events: [],
    sideEffects: [
      {
        type: 'dispatch_agent',
        payload: {
          dispatchId: String(newDispatchId),
          agentId: String(state.agentId),
          iteration: nextIteration,
          // The orchestrator forwards reviewContext into AgentDispatchJobData
          // so the work-order assembler can render the review comments into
          // the agent's prompt.
          reviewContext: {
            iteration: nextIteration,
            prUrl: trigger.prUrl,
            prId: trigger.prId,
            bundle: trigger.bundle,
          },
        },
        idempotencyKey: encodeJobId(['dispatch-review', state.prUrl, String(nextIteration)]),
      },
      {
        type: 'enqueue_stall_check',
        payload: { dispatchId: String(newDispatchId) },
        idempotencyKey: encodeJobId(['stall-review', String(newDispatchId)]),
      },
    ],
  };
}

// ---- Helpers ----

function findColumnMapping(colId: string, config: PipelineConfig): ColumnMapping | undefined {
  return config.columnMappings.find((m) => m.columnId === colId);
}
