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
} from '@ouija/types';
import { dispatchId as makeDispatchId, agentId as makeAgentId } from '@ouija/types';
import { evaluateGuards } from './guards.js';

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
    case 'pr_merged':
      return handlePrMerged(state, trigger);
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
        idempotencyKey: `close-notify-${trigger.cardId}-${trigger.toColumnId}`,
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
          idempotencyKey: `guard-fail-${trigger.cardId}-${trigger.toColumnId}`,
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
      idempotencyKey: `dispatch-${newDispatchId}`,
    },
    {
      type: 'enqueue_stall_check',
      payload: { dispatchId: newDispatchId, delayMs: stallMs },
      idempotencyKey: `stall-check-${newDispatchId}`,
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

  const nextState: PipelineState = {
    status: 'running',
    dispatchId: state.dispatchId,
    agentId: state.agentId,
    dispatchedAt: state.dispatchedAt,
    lastHeartbeatAt: new Date().toISOString(),
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
      idempotencyKey: `cancel-stall-${state.dispatchId}-${trigger.heartbeatAt}`,
    },
    {
      type: 'enqueue_stall_check',
      payload: { dispatchId: state.dispatchId },
      idempotencyKey: `stall-check-${state.dispatchId}-${trigger.heartbeatAt}`,
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

  // State stays running — the PR has been opened but agent work continues until completed
  const sideEffects: SideEffect[] = [
    {
      type: 'move_card',
      payload: { columnName: 'Review', prUrl: trigger.prUrl, prId: trigger.prId },
      idempotencyKey: `move-review-${trigger.dispatchId}`,
    },
    {
      type: 'add_comment',
      payload: { body: `PR ready for review: ${trigger.prUrl}`, prId: trigger.prId },
      idempotencyKey: `comment-pr-ready-${trigger.dispatchId}`,
    },
    {
      type: 'send_notification',
      payload: { prUrl: trigger.prUrl, prId: trigger.prId },
      idempotencyKey: `notify-pr-ready-${trigger.dispatchId}`,
    },
  ];

  return {
    rejected: false,
    nextState: { ...state },
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

  // Build succeeded state — optional fields only set when present to satisfy exactOptionalPropertyTypes
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
      idempotencyKey: `cancel-stall-complete-${trigger.dispatchId}`,
    },
    {
      type: 'move_card',
      payload: { columnName: 'Done' },
      idempotencyKey: `move-done-${trigger.dispatchId}`,
    },
  ];

  return {
    rejected: false,
    nextState,
    events: [],
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
      idempotencyKey: `cancel-stall-fail-${trigger.dispatchId}`,
    },
    {
      type: 'move_card',
      payload: { columnName: 'Failed' },
      idempotencyKey: `move-failed-${trigger.dispatchId}`,
    },
    {
      type: 'send_notification',
      payload: { error: trigger.error, retryable: trigger.retryable },
      idempotencyKey: `notify-fail-${trigger.dispatchId}`,
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
      idempotencyKey: `notify-stall-${trigger.dispatchId}`,
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
      idempotencyKey: `dispatch-retry-${newDispatchId}`,
    },
    {
      type: 'enqueue_stall_check',
      payload: { dispatchId: newDispatchId, delayMs: config.defaultStallThresholdMs },
      idempotencyKey: `stall-check-retry-${newDispatchId}`,
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
      idempotencyKey: `notify-cancel-${trigger.cancelledBy}-${now}`,
    },
  ];

  // Only active states have an agent that needs cancelling
  if (state.status === 'provisioning' || state.status === 'dispatching' || state.status === 'running') {
    if (state.status === 'provisioning' && 'workspaceId' in state && state.workspaceId) {
      sideEffects.push({
        type: 'destroy_workspace',
        payload: { workspaceId: state.workspaceId },
        idempotencyKey: `destroy-ws-${state.dispatchId}`,
      });
    }
    sideEffects.push(
      {
        type: 'cancel_agent',
        payload: { dispatchId: state.dispatchId },
        idempotencyKey: `cancel-agent-${state.dispatchId}`,
      },
      {
        type: 'cancel_stall_check',
        payload: { dispatchId: state.dispatchId },
        idempotencyKey: `cancel-stall-cancel-${state.dispatchId}`,
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

function handlePrMerged(
  state: PipelineState,
  trigger: Extract<PipelineTrigger, { type: 'pr_merged' }>,
): TransitionOutcome {
  // PR merged is valid from running (agent still active) or succeeded (agent finished, PR was pending merge)
  if (state.status !== 'running' && state.status !== 'succeeded') {
    return {
      rejected: true,
      reason: `Cannot process PR merge: pipeline is in state "${state.status}", expected "running" or "succeeded"`,
    };
  }

  // Preserve cost/tokens from the existing succeeded state if present
  const cost = state.status === 'succeeded' ? state.cost : undefined;
  const tokensUsed = state.status === 'succeeded' ? state.tokensUsed : undefined;

  const nextState: PipelineState = {
    status: 'succeeded',
    dispatchId: state.dispatchId,
    agentId: state.agentId,
    completedAt: trigger.mergedAt,
    ...(cost !== undefined ? { cost } : {}),
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
  };

  const sideEffects: SideEffect[] = [
    {
      type: 'move_card',
      payload: { columnName: 'Done', prId: trigger.prId },
      idempotencyKey: `move-done-merged-${trigger.prId}`,
    },
    {
      type: 'cancel_stall_check',
      payload: { prId: trigger.prId },
      idempotencyKey: `cancel-stall-merged-${trigger.prId}`,
    },
  ];

  return {
    rejected: false,
    nextState,
    events: [],
    sideEffects,
  };
}

// ---- Helpers ----

function findColumnMapping(colId: string, config: PipelineConfig): ColumnMapping | undefined {
  return config.columnMappings.find((m) => m.columnId === colId);
}
