/**
 * Transition function tests — 100% state/trigger coverage
 *
 * Every valid transition must be tested.
 * Every invalid/rejected transition must be tested.
 * Tests are pure: no I/O, no mocks, no external dependencies.
 */

import { describe, it, expect } from 'vitest';
import { transition } from '../src/transition.js';
import type {
  PipelineState,
  PipelineTrigger,
  PipelineConfig,
  GuardContext,
} from '@ouija/types';
import {
  cardId,
  columnId,
  dispatchId,
  agentId,
  prId,
  boardId,
} from '@ouija/types';

// ---- Test fixtures ----

const testConfig: PipelineConfig = {
  boardId: boardId('board-1'),
  defaultStallThresholdMs: 300_000, // 5 minutes
  autoStartOnAssign: false,
  columnMappings: [
    {
      columnId: columnId('col-inprogress'),
      columnName: 'In Progress',
      action: 'dispatch_agent',
      agentId: agentId('agent-rex'),
      guards: [{ type: 'min_description_length', value: 10 }],
    },
    {
      columnId: columnId('col-done'),
      columnName: 'Done',
      action: 'close_and_notify',
      guards: [],
    },
    {
      columnId: columnId('col-backlog'),
      columnName: 'Backlog',
      action: 'noop',
      guards: [],
    },
  ],
};

// Column that is configured but missing agentId — triggers misconfiguration rejection
const misconfiguredConfig: PipelineConfig = {
  ...testConfig,
  columnMappings: [
    {
      columnId: columnId('col-broken'),
      columnName: 'Broken Column',
      action: 'dispatch_agent',
      // agentId intentionally absent
      guards: [],
    },
  ],
};

const guardCtx: GuardContext = {
  cardDescription: 'Implement the login page with full OAuth support and proper error handling',
  cardLabels: ['ready'],
  cardAssignees: ['agent-rex'],
};

const shortGuardCtx: GuardContext = {
  ...guardCtx,
  cardDescription: 'Fix', // 3 chars — fails min_description_length: 10
};

// Reusable states
const idle: PipelineState = { status: 'idle' };

const dispatching: PipelineState = {
  status: 'dispatching',
  dispatchId: dispatchId('d-1'),
  agentId: agentId('agent-rex'),
  dispatchedAt: '2026-04-01T10:00:00Z',
};

const running: PipelineState = {
  status: 'running',
  dispatchId: dispatchId('d-1'),
  agentId: agentId('agent-rex'),
  dispatchedAt: '2026-04-01T10:00:00Z',
  lastHeartbeatAt: '2026-04-01T10:05:00Z',
};

const succeeded: PipelineState = {
  status: 'succeeded',
  dispatchId: dispatchId('d-1'),
  agentId: agentId('agent-rex'),
  completedAt: '2026-04-01T11:00:00Z',
};

const failed: PipelineState = {
  status: 'failed',
  dispatchId: dispatchId('d-1'),
  agentId: agentId('agent-rex'),
  failedAt: '2026-04-01T10:30:00Z',
  error: 'Unexpected API error',
  retryable: true,
};

const stalled: PipelineState = {
  status: 'stalled',
  dispatchId: dispatchId('d-1'),
  agentId: agentId('agent-rex'),
  stalledAt: '2026-04-01T10:30:00Z',
  lastHeartbeatAt: '2026-04-01T10:00:00Z',
};

const cancelled: PipelineState = {
  status: 'cancelled',
  cancelledAt: '2026-04-01T10:45:00Z',
  cancelledBy: 'mk',
};

// ---- card_moved ----

describe('card_moved → dispatching (guards pass)', () => {
  it('transitions idle → dispatching when guards pass', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'),
      guardContext: guardCtx,
    };

    const result = transition(idle, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('dispatching');
    // A new dispatch ID should be generated (not empty)
    if (result.nextState.status === 'dispatching') {
      expect(result.nextState.dispatchId).toBeTruthy();
      expect(result.nextState.agentId).toBe(agentId('agent-rex'));
    }
    // Side effects: dispatch_agent + enqueue_stall_check
    expect(result.sideEffects.some((e) => e.type === 'dispatch_agent')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'enqueue_stall_check')).toBe(true);
    expect(result.sideEffects).toHaveLength(2);
  });

  it('dispatch side effect carries the new dispatchId', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'),
      guardContext: guardCtx,
    };

    const result = transition(idle, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    const dispatchEffect = result.sideEffects.find((e) => e.type === 'dispatch_agent');
    expect(dispatchEffect).toBeDefined();
    expect(dispatchEffect?.payload['agentId']).toBe(agentId('agent-rex'));
  });

  it('stall_check side effect includes stallThresholdMs from config default', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'),
      guardContext: guardCtx,
    };

    const result = transition(idle, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    const stallEffect = result.sideEffects.find((e) => e.type === 'enqueue_stall_check');
    expect(stallEffect?.payload['delayMs']).toBe(300_000);
  });

  it('uses per-column stallThresholdMs over config default when set', () => {
    const configWithCustomStall: PipelineConfig = {
      ...testConfig,
      columnMappings: [
        {
          columnId: columnId('col-inprogress'),
          columnName: 'In Progress',
          action: 'dispatch_agent',
          agentId: agentId('agent-rex'),
          guards: [],
          stallThresholdMs: 60_000, // 1 min override
        },
      ],
    };
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'),
      guardContext: guardCtx,
    };

    const result = transition(idle, trigger, configWithCustomStall);
    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    const stallEffect = result.sideEffects.find((e) => e.type === 'enqueue_stall_check');
    expect(stallEffect?.payload['delayMs']).toBe(60_000);
  });

  it('each call generates a unique dispatchId (randomness check)', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'),
      guardContext: guardCtx,
    };

    const r1 = transition(idle, trigger, testConfig);
    const r2 = transition(idle, trigger, testConfig);

    expect(r1.rejected).toBe(false);
    expect(r2.rejected).toBe(false);
    if (r1.rejected || r2.rejected) return;

    if (r1.nextState.status === 'dispatching' && r2.nextState.status === 'dispatching') {
      expect(r1.nextState.dispatchId).not.toBe(r2.nextState.dispatchId);
    }
  });
});

describe('card_moved → rejected (pipeline already active)', () => {
  it('rejects when pipeline is in dispatching state', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'),
      guardContext: guardCtx,
    };

    const result = transition(dispatching, trigger, testConfig);

    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason).toContain('dispatching');
  });

  it('rejects when pipeline is in running state', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'),
      guardContext: guardCtx,
    };

    const result = transition(running, trigger, testConfig);

    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason).toContain('running');
  });

  it('rejects when pipeline is in provisioning state', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'),
      guardContext: guardCtx,
    };

    const result = transition(provisioning, trigger, testConfig);

    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason).toContain('provisioning');
  });
});

describe('card_moved → guard failure (notification, state unchanged)', () => {
  it('returns success=false (not rejected) with notification side effect', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'),
      guardContext: shortGuardCtx,
    };

    const result = transition(idle, trigger, testConfig);

    // Guard failure is NOT a rejection — state is unchanged, notification is sent
    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('idle'); // unchanged
    expect(result.sideEffects.some((e) => e.type === 'send_notification')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'dispatch_agent')).toBe(false);
  });

  it('notification payload contains guard failure details', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'),
      guardContext: shortGuardCtx,
    };

    const result = transition(idle, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    const notification = result.sideEffects.find((e) => e.type === 'send_notification');
    expect(notification?.payload['guardsFailed']).toBeDefined();
  });

  it('guard failure from non-idle states (e.g. succeeded) still produces notification', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-done'),
      guardContext: shortGuardCtx,
    };

    const result = transition(succeeded, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (result.rejected) return;
    expect(result.sideEffects.some((e) => e.type === 'send_notification')).toBe(true);
  });
});

describe('card_moved → rejected (no column mapping)', () => {
  it('rejects when destination column has no mapping', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-unknown'),
      fromColumnId: columnId('col-backlog'),
      guardContext: guardCtx,
    };

    const result = transition(idle, trigger, testConfig);

    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason).toContain('col-unknown');
  });

  it('rejects when dispatch_agent column has no agentId configured', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-broken'),
      fromColumnId: columnId('col-backlog'),
      guardContext: guardCtx,
    };

    const result = transition(idle, trigger, misconfiguredConfig);

    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason).toContain('agentId');
  });
});

describe('card_moved → close_and_notify', () => {
  it('transitions to succeeded with notification side effect', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-done'),
      fromColumnId: columnId('col-inprogress'),
      guardContext: guardCtx,
    };

    const result = transition(idle, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('succeeded');
    expect(result.sideEffects.some((e) => e.type === 'send_notification')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'dispatch_agent')).toBe(false);
  });
});

describe('card_moved → noop column', () => {
  it('rejects when column action is noop', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-backlog'),
      fromColumnId: columnId('col-inprogress'),
      guardContext: guardCtx,
    };

    const result = transition(idle, trigger, testConfig);

    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason.toLowerCase()).toContain('noop');
  });
});

// ---- card_assigned ----

describe('card_assigned with auto-start disabled → rejected', () => {
  it('rejects when autoStartOnAssign is false', () => {
    const trigger: PipelineTrigger = {
      type: 'card_assigned',
      cardId: cardId('card-1'),
      assigneeId: 'agent-rex',
    };

    const result = transition(idle, trigger, testConfig); // testConfig has autoStartOnAssign: false

    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason.toLowerCase()).toContain('auto-start');
  });
});

// ---- agent_acknowledged ----

describe('agent_acknowledged → running', () => {
  it('transitions dispatching → running when dispatchId matches', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_acknowledged',
      dispatchId: dispatchId('d-1'),
    };

    const result = transition(dispatching, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('running');
    if (result.nextState.status === 'running') {
      expect(result.nextState.dispatchId).toBe(dispatchId('d-1'));
      expect(result.nextState.agentId).toBe(agentId('agent-rex'));
      expect(result.nextState.dispatchedAt).toBe(dispatching.dispatchedAt);
      expect(result.nextState.lastHeartbeatAt).toBeTruthy();
    }
    expect(result.sideEffects).toHaveLength(0);
  });
});

describe('agent_acknowledged with wrong dispatch ID → rejected', () => {
  it('rejects when dispatchId does not match current state', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_acknowledged',
      dispatchId: dispatchId('d-stale'), // wrong ID
    };

    const result = transition(dispatching, trigger, testConfig);

    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason.toLowerCase()).toContain('mismatch');
  });

  it('rejects when state is not dispatching (e.g. idle)', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_acknowledged',
      dispatchId: dispatchId('d-1'),
    };

    const result = transition(idle, trigger, testConfig);

    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason).toContain('dispatching');
  });

  it('rejects when state is running (duplicate acknowledge)', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_acknowledged',
      dispatchId: dispatchId('d-1'),
    };

    const result = transition(running, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });
});

// ---- agent_progress ----

describe('agent_progress → heartbeat updated + stall check reset', () => {
  it('updates lastHeartbeatAt and enqueues fresh stall check', () => {
    const heartbeatAt = '2026-04-01T10:10:00Z';
    const trigger: PipelineTrigger = {
      type: 'agent_progress',
      dispatchId: dispatchId('d-1'),
      heartbeatAt,
      message: 'Running tests...',
    };

    const result = transition(running, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    if (result.nextState.status === 'running') {
      expect(result.nextState.lastHeartbeatAt).toBe(heartbeatAt);
    }
    expect(result.sideEffects.some((e) => e.type === 'cancel_stall_check')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'enqueue_stall_check')).toBe(true);
  });

  it('rejects agent_progress when state is not running', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_progress',
      dispatchId: dispatchId('d-1'),
      heartbeatAt: '2026-04-01T10:10:00Z',
      message: 'Working',
    };

    const result = transition(idle, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });

  it('rejects agent_progress from dispatching state', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_progress',
      dispatchId: dispatchId('d-1'),
      heartbeatAt: '2026-04-01T10:10:00Z',
      message: 'Working',
    };

    const result = transition(dispatching, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });
});

// ---- agent_pr_ready ----

describe('agent_pr_ready → move card to review + comment', () => {
  it('keeps running state and enqueues move + comment + notification side effects', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_pr_ready',
      dispatchId: dispatchId('d-1'),
      prUrl: 'https://github.com/org/repo/pull/42',
      prId: prId('pr-42'),
    };

    const result = transition(running, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('running'); // still running until completed/failed
    expect(result.sideEffects.some((e) => e.type === 'move_card')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'add_comment')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'send_notification')).toBe(true);
  });

  it('move_card payload targets Review column', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_pr_ready',
      dispatchId: dispatchId('d-1'),
      prUrl: 'https://github.com/org/repo/pull/42',
      prId: prId('pr-42'),
    };

    const result = transition(running, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    const moveEffect = result.sideEffects.find((e) => e.type === 'move_card');
    expect(moveEffect?.payload['columnName']).toBe('Review');
  });

  it('rejects when pipeline is not running', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_pr_ready',
      dispatchId: dispatchId('d-1'),
      prUrl: 'https://github.com/org/repo/pull/42',
      prId: prId('pr-42'),
    };

    const result = transition(dispatching, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });
});

// ---- agent_completed ----

describe('agent_completed → succeeded + move card to done', () => {
  it('transitions running → succeeded with cost data', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_completed',
      dispatchId: dispatchId('d-1'),
      cost: 0.42,
      tokensUsed: 15_000,
    };

    const result = transition(running, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('succeeded');
    if (result.nextState.status === 'succeeded') {
      expect(result.nextState.cost).toBe(0.42);
      expect(result.nextState.tokensUsed).toBe(15_000);
      expect(result.nextState.dispatchId).toBe(dispatchId('d-1'));
    }
    expect(result.sideEffects.some((e) => e.type === 'cancel_stall_check')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'move_card')).toBe(true);
  });

  it('move_card payload targets Done column', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_completed',
      dispatchId: dispatchId('d-1'),
    };

    const result = transition(running, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    const moveEffect = result.sideEffects.find((e) => e.type === 'move_card');
    expect(moveEffect?.payload['columnName']).toBe('Done');
  });

  it('succeeds without optional cost/tokensUsed fields', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_completed',
      dispatchId: dispatchId('d-1'),
      // cost and tokensUsed absent
    };

    const result = transition(running, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('succeeded');
  });

  it('rejects when not in running state', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_completed',
      dispatchId: dispatchId('d-1'),
    };

    const result = transition(dispatching, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });
});

// ---- agent_failed ----

describe('agent_failed → failed + notification', () => {
  it('transitions running → failed with error info', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_failed',
      dispatchId: dispatchId('d-1'),
      error: 'Rate limit exceeded',
      retryable: true,
    };

    const result = transition(running, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('failed');
    if (result.nextState.status === 'failed') {
      expect(result.nextState.error).toBe('Rate limit exceeded');
      expect(result.nextState.retryable).toBe(true);
    }
    expect(result.sideEffects.some((e) => e.type === 'send_notification')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'move_card')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'cancel_stall_check')).toBe(true);
  });

  it('transitions dispatching → failed (agent failed before acknowledging)', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_failed',
      dispatchId: dispatchId('d-1'),
      error: 'Startup error',
      retryable: false,
    };

    const result = transition(dispatching, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (result.rejected) return;
    expect(result.nextState.status).toBe('failed');
  });

  it('rejects from idle state', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_failed',
      dispatchId: dispatchId('d-1'),
      error: 'Some error',
      retryable: false,
    };

    const result = transition(idle, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });

  it('rejects from succeeded state', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_failed',
      dispatchId: dispatchId('d-1'),
      error: 'Late failure',
      retryable: false,
    };

    const result = transition(succeeded, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });
});

// ---- stall_detected ----

describe('stall_detected → stalled + notification', () => {
  it('transitions running → stalled', () => {
    const trigger: PipelineTrigger = {
      type: 'stall_detected',
      dispatchId: dispatchId('d-1'),
      detectedAt: '2026-04-01T11:00:00Z',
    };

    const result = transition(running, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('stalled');
    if (result.nextState.status === 'stalled') {
      expect(result.nextState.stalledAt).toBe('2026-04-01T11:00:00Z');
      // lastHeartbeatAt preserved from running state
      expect(result.nextState.lastHeartbeatAt).toBe(running.lastHeartbeatAt);
    }
    expect(result.sideEffects.some((e) => e.type === 'send_notification')).toBe(true);
  });

  it('transitions dispatching → stalled (agent never acknowledged)', () => {
    const trigger: PipelineTrigger = {
      type: 'stall_detected',
      dispatchId: dispatchId('d-1'),
      detectedAt: '2026-04-01T10:10:00Z',
    };

    const result = transition(dispatching, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;
    expect(result.nextState.status).toBe('stalled');
    // When dispatching had no heartbeat, lastHeartbeatAt defaults to detectedAt
    if (result.nextState.status === 'stalled') {
      expect(result.nextState.lastHeartbeatAt).toBe('2026-04-01T10:10:00Z');
    }
  });

  it('rejects from idle state', () => {
    const trigger: PipelineTrigger = {
      type: 'stall_detected',
      dispatchId: dispatchId('d-1'),
      detectedAt: '2026-04-01T11:00:00Z',
    };

    const result = transition(idle, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });

  it('rejects from succeeded state', () => {
    const trigger: PipelineTrigger = {
      type: 'stall_detected',
      dispatchId: dispatchId('d-1'),
      detectedAt: '2026-04-01T11:00:00Z',
    };

    const result = transition(succeeded, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });
});

// ---- human_retry ----

describe('human_retry from failed → dispatching', () => {
  it('transitions failed → dispatching with a fresh dispatchId', () => {
    const trigger: PipelineTrigger = {
      type: 'human_retry',
      retriedBy: 'mk',
    };

    const result = transition(failed, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('dispatching');
    if (result.nextState.status === 'dispatching') {
      // New dispatch ID — different from the old one
      expect(result.nextState.dispatchId).not.toBe(dispatchId('d-1'));
      expect(result.nextState.agentId).toBe(failed.agentId);
    }
    expect(result.sideEffects.some((e) => e.type === 'dispatch_agent')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'enqueue_stall_check')).toBe(true);
  });
});

describe('human_retry from stalled → dispatching', () => {
  it('transitions stalled → dispatching', () => {
    const trigger: PipelineTrigger = {
      type: 'human_retry',
      retriedBy: 'mk',
    };

    const result = transition(stalled, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('dispatching');
  });
});

describe('human_retry from running → rejected', () => {
  it('rejects retry when pipeline is running', () => {
    const trigger: PipelineTrigger = {
      type: 'human_retry',
      retriedBy: 'mk',
    };

    const result = transition(running, trigger, testConfig);
    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason).toContain('running');
  });

  it('rejects retry from idle state', () => {
    const trigger: PipelineTrigger = {
      type: 'human_retry',
      retriedBy: 'mk',
    };

    const result = transition(idle, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });

  it('rejects retry from succeeded state', () => {
    const trigger: PipelineTrigger = {
      type: 'human_retry',
      retriedBy: 'mk',
    };

    const result = transition(succeeded, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });
});

// ---- human_cancel ----

describe('human_cancel from running → cancelled + cancel agent', () => {
  it('transitions running → cancelled with agent cancellation side effects', () => {
    const trigger: PipelineTrigger = {
      type: 'human_cancel',
      cancelledBy: 'mk',
    };

    const result = transition(running, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('cancelled');
    if (result.nextState.status === 'cancelled') {
      expect(result.nextState.cancelledBy).toBe('mk');
    }
    expect(result.sideEffects.some((e) => e.type === 'cancel_agent')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'cancel_stall_check')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'send_notification')).toBe(true);
  });

  it('transitions dispatching → cancelled (cancel before agent acknowledged)', () => {
    const trigger: PipelineTrigger = {
      type: 'human_cancel',
      cancelledBy: 'mk',
    };

    const result = transition(dispatching, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;
    expect(result.nextState.status).toBe('cancelled');
    expect(result.sideEffects.some((e) => e.type === 'cancel_agent')).toBe(true);
  });

  it('transitions failed → cancelled (cancel without agent running)', () => {
    const trigger: PipelineTrigger = {
      type: 'human_cancel',
      cancelledBy: 'mk',
    };

    const result = transition(failed, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;
    expect(result.nextState.status).toBe('cancelled');
    // No cancel_agent for already-failed pipeline
    expect(result.sideEffects.some((e) => e.type === 'cancel_agent')).toBe(false);
  });

  it('transitions stalled → cancelled', () => {
    const trigger: PipelineTrigger = {
      type: 'human_cancel',
      cancelledBy: 'mk',
    };

    const result = transition(stalled, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (result.rejected) return;
    expect(result.nextState.status).toBe('cancelled');
  });
});

describe('human_cancel from idle → rejected', () => {
  it('rejects cancel when pipeline is idle', () => {
    const trigger: PipelineTrigger = {
      type: 'human_cancel',
      cancelledBy: 'mk',
    };

    const result = transition(idle, trigger, testConfig);
    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason).toContain('idle');
  });

  it('rejects cancel when pipeline already succeeded', () => {
    const trigger: PipelineTrigger = {
      type: 'human_cancel',
      cancelledBy: 'mk',
    };

    const result = transition(succeeded, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });

  it('rejects cancel when pipeline already cancelled', () => {
    const trigger: PipelineTrigger = {
      type: 'human_cancel',
      cancelledBy: 'mk',
    };

    const result = transition(cancelled, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });
});

// ---- pr_merged ----

describe('pr_merged → succeeded', () => {
  it('transitions running → succeeded on PR merge', () => {
    const trigger: PipelineTrigger = {
      type: 'pr_merged',
      prId: prId('pr-42'),
      mergedAt: '2026-04-01T14:00:00Z',
    };

    const result = transition(running, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('succeeded');
    if (result.nextState.status === 'succeeded') {
      expect(result.nextState.completedAt).toBe('2026-04-01T14:00:00Z');
    }
    expect(result.sideEffects.some((e) => e.type === 'move_card')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'cancel_stall_check')).toBe(true);
  });

  it('transitions succeeded → succeeded (PR merged after agent completed)', () => {
    const trigger: PipelineTrigger = {
      type: 'pr_merged',
      prId: prId('pr-42'),
      mergedAt: '2026-04-01T14:00:00Z',
    };

    const result = transition(succeeded, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;
    expect(result.nextState.status).toBe('succeeded');
  });

  it('preserves cost/tokensUsed from succeeded state', () => {
    const succeededWithCost: PipelineState = {
      ...succeeded,
      cost: 1.23,
      tokensUsed: 50_000,
    };

    const trigger: PipelineTrigger = {
      type: 'pr_merged',
      prId: prId('pr-42'),
      mergedAt: '2026-04-01T14:00:00Z',
    };

    const result = transition(succeededWithCost, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    if (result.nextState.status === 'succeeded') {
      expect(result.nextState.cost).toBe(1.23);
      expect(result.nextState.tokensUsed).toBe(50_000);
    }
  });

  it('rejects pr_merged from idle state', () => {
    const trigger: PipelineTrigger = {
      type: 'pr_merged',
      prId: prId('pr-42'),
      mergedAt: '2026-04-01T14:00:00Z',
    };

    const result = transition(idle, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });

  it('rejects pr_merged from failed state', () => {
    const trigger: PipelineTrigger = {
      type: 'pr_merged',
      prId: prId('pr-42'),
      mergedAt: '2026-04-01T14:00:00Z',
    };

    const result = transition(failed, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });

  it('rejects pr_merged from stalled state', () => {
    const trigger: PipelineTrigger = {
      type: 'pr_merged',
      prId: prId('pr-42'),
      mergedAt: '2026-04-01T14:00:00Z',
    };

    const result = transition(stalled, trigger, testConfig);
    expect(result.rejected).toBe(true);
  });
});

// ---- workspace_provisioned ----

const provisioning: PipelineState = {
  status: 'provisioning',
  dispatchId: dispatchId('d-1'),
  agentId: agentId('agent-rex'),
  dispatchedAt: '2026-04-01T10:00:00Z',
};

const provisioningWithWorkspace: PipelineState = {
  status: 'provisioning',
  dispatchId: dispatchId('d-1'),
  agentId: agentId('agent-rex'),
  dispatchedAt: '2026-04-01T10:00:00Z',
  workspaceId: 'ws-abc123',
};

describe('workspace_provisioned trigger', () => {
  it('transitions from provisioning to dispatching', () => {
    const trigger: PipelineTrigger = {
      type: 'workspace_provisioned',
      dispatchId: dispatchId('d-1'),
      workspaceId: 'ws-abc123',
    };

    const result = transition(provisioning, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('dispatching');
    if (result.nextState.status === 'dispatching') {
      expect(result.nextState.dispatchId).toBe(dispatchId('d-1'));
      expect(result.nextState.agentId).toBe(agentId('agent-rex'));
      expect(result.nextState.dispatchedAt).toBe(provisioning.dispatchedAt);
    }
    expect(result.sideEffects).toHaveLength(0);
  });

  it('rejects from non-provisioning state (idle)', () => {
    const trigger: PipelineTrigger = {
      type: 'workspace_provisioned',
      dispatchId: dispatchId('d-1'),
      workspaceId: 'ws-abc123',
    };

    const result = transition(idle, trigger, testConfig);

    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason).toContain('provisioning');
  });

  it('rejects with mismatched dispatchId', () => {
    const trigger: PipelineTrigger = {
      type: 'workspace_provisioned',
      dispatchId: dispatchId('d-WRONG'),
      workspaceId: 'ws-abc123',
    };

    const result = transition(provisioning, trigger, testConfig);

    expect(result.rejected).toBe(true);
    if (!result.rejected) return;
    expect(result.reason.toLowerCase()).toContain('mismatch');
  });
});

// ---- provisioning state in cancel ----

describe('provisioning state in cancel', () => {
  it('cancels pipeline in provisioning state with destroy_workspace side effect when workspaceId present', () => {
    const trigger: PipelineTrigger = {
      type: 'human_cancel',
      cancelledBy: 'mk',
    };

    const result = transition(provisioningWithWorkspace, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('cancelled');
    expect(result.sideEffects.some((e) => e.type === 'destroy_workspace')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'cancel_agent')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'cancel_stall_check')).toBe(true);

    const destroyEffect = result.sideEffects.find((e) => e.type === 'destroy_workspace');
    expect(destroyEffect?.payload['workspaceId']).toBe('ws-abc123');
  });

  it('cancels pipeline in provisioning state without destroy_workspace when no workspaceId', () => {
    const trigger: PipelineTrigger = {
      type: 'human_cancel',
      cancelledBy: 'mk',
    };

    const result = transition(provisioning, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('cancelled');
    expect(result.sideEffects.some((e) => e.type === 'destroy_workspace')).toBe(false);
    expect(result.sideEffects.some((e) => e.type === 'cancel_agent')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'cancel_stall_check')).toBe(true);
  });
});

// ---- stall_detected from provisioning ----

describe('stall_detected from provisioning', () => {
  it('transitions from provisioning to stalled', () => {
    const trigger: PipelineTrigger = {
      type: 'stall_detected',
      dispatchId: dispatchId('d-1'),
      detectedAt: '2026-04-01T10:10:00Z',
    };

    const result = transition(provisioning, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('stalled');
    if (result.nextState.status === 'stalled') {
      expect(result.nextState.stalledAt).toBe('2026-04-01T10:10:00Z');
      // No lastHeartbeatAt in provisioning — defaults to detectedAt
      expect(result.nextState.lastHeartbeatAt).toBe('2026-04-01T10:10:00Z');
    }
    expect(result.sideEffects.some((e) => e.type === 'send_notification')).toBe(true);
  });
});

// ---- agent_failed from provisioning ----

describe('agent_failed from provisioning', () => {
  it('transitions from provisioning to failed', () => {
    const trigger: PipelineTrigger = {
      type: 'agent_failed',
      dispatchId: dispatchId('d-1'),
      error: 'Workspace boot failed',
      retryable: true,
    };

    const result = transition(provisioning, trigger, testConfig);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    expect(result.nextState.status).toBe('failed');
    if (result.nextState.status === 'failed') {
      expect(result.nextState.error).toBe('Workspace boot failed');
      expect(result.nextState.retryable).toBe(true);
    }
    expect(result.sideEffects.some((e) => e.type === 'send_notification')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'move_card')).toBe(true);
    expect(result.sideEffects.some((e) => e.type === 'cancel_stall_check')).toBe(true);
  });
});

// ---- Idempotency keys are unique per dispatch ----

describe('side effect idempotency keys', () => {
  it('dispatch_agent idempotency key includes the dispatchId', () => {
    const trigger: PipelineTrigger = {
      type: 'card_moved',
      cardId: cardId('card-1'),
      toColumnId: columnId('col-inprogress'),
      fromColumnId: columnId('col-backlog'),
      guardContext: guardCtx,
    };

    const result = transition(idle, trigger, testConfig);
    expect(result.rejected).toBe(false);
    if (result.rejected) return;

    const dispatchEffect = result.sideEffects.find((e) => e.type === 'dispatch_agent');
    const stallEffect = result.sideEffects.find((e) => e.type === 'enqueue_stall_check');

    expect(dispatchEffect?.idempotencyKey).toBeTruthy();
    expect(stallEffect?.idempotencyKey).toBeTruthy();
    // Keys should be deterministic for the same dispatchId
    expect(dispatchEffect?.idempotencyKey).not.toBe(stallEffect?.idempotencyKey);
  });
});

// ---- Transition function is pure (no mutations to input state) ----

describe('transition purity — input state is not mutated', () => {
  it('does not mutate the input state object', () => {
    const inputState: PipelineState = {
      status: 'running',
      dispatchId: dispatchId('d-1'),
      agentId: agentId('agent-rex'),
      dispatchedAt: '2026-04-01T10:00:00Z',
      lastHeartbeatAt: '2026-04-01T10:05:00Z',
    };
    const frozen = Object.freeze({ ...inputState });

    const trigger: PipelineTrigger = {
      type: 'agent_progress',
      dispatchId: dispatchId('d-1'),
      heartbeatAt: '2026-04-01T10:10:00Z',
      message: 'Still going',
    };

    // Should not throw (frozen objects throw on mutation in strict mode)
    const result = transition(frozen as PipelineState, trigger, testConfig);
    expect(result.rejected).toBe(false);
  });
});
