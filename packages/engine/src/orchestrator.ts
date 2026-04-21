/**
 * Orchestrator — glue layer between EventBus and Pipeline Engine.
 *
 * Responsibilities:
 *  1. Load pipeline instance from DB (by cardId for card events, instanceId for callbacks)
 *  2. Create a new instance in idle state when none exists (card_moved webhook)
 *  3. Fetch guard context from kanban plugin (card description, labels, assignees)
 *  4. Run input sanitization on card description
 *  5. Call the pure transition() function
 *  6. Persist result in a single transaction (upsert instance + append events)
 *  7. Execute side effects via Promise.all() AFTER db commit
 *
 * Side effect failures are logged and swallowed — they do NOT roll back the
 * transition. All side effects must be idempotent (keyed on instanceId +
 * transition sequence number per spec §4.6).
 *
 * Config cache: 30-second TTL per boardId to avoid hammering the DB on every
 * webhook burst.
 */

import { randomUUID } from 'node:crypto';
import type {
  Database,
  PipelineInstance,
  PipelineConfig,
  PipelineState,
  PipelineTrigger,
  SideEffect,
  OuijaEvent,
  KanbanPlugin,
  GuardContext,
  CardId,
  BoardId,
  ColumnId,
  DispatchId,
  ReviewBundle,
} from '@ouija-dev/types';
import {
  instanceId as makeInstanceId,
  columnId as makeColumnId,
  dispatchId as makeDispatchId,
  prId as makePrId,
  agentId as makeAgentId,
} from '@ouija-dev/types';
import type { EventBus } from '@ouija-dev/bus';
import type { JobQueue, AgentDispatchJobData, StallCheckJobData } from '@ouija-dev/bus';
import { QUEUE_NAMES } from '@ouija-dev/bus';
import { transition } from './transition.js';
import { sanitize } from './sanitizer.js';

// ---- Logger interface (minimal — consumers inject a real logger) ----

export interface OrchestratorLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: OrchestratorLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---- Agent member lookup (injected by server) ----

/** Injected by the server — maps Plane member IDs to agent IDs. */
export interface AgentMemberLookup {
  getAgentIdByMemberId(memberId: string): string | undefined;
  getTriggerMode(agentId: string): 'auto' | 'manual' | undefined;
}

export const nullAgentMemberLookup: AgentMemberLookup = {
  getAgentIdByMemberId: () => undefined,
  getTriggerMode: () => undefined,
};

// ---- Config cache entry ----

interface ConfigCacheEntry {
  config: PipelineConfig;
  cachedAt: number;
}

export const CONFIG_CACHE_TTL_MS = 30_000;

/**
 * Thrown by _fetchGuardContext when the card description fails sanitizer
 * category checks (e.g. shell metacharacters, workflow-file references, secret
 * file paths, suspicious URLs). Caught by _processTrigger which logs and drops
 * the event — the pipeline is NOT created. This is the final enforcement point
 * for the defense-in-depth layer against prompt injection.
 */
/**
 * Stamp the orchestrator's instanceId onto event payloads that carry one but
 * are emitted by the pure transition (which has no instance context). Today
 * this is only `dispatch.outcome`; other payloads either already carry
 * instanceId through the trigger chain (`agent.work.*`) or are
 * instance-free. Any future instance-aware event emitted from the pure
 * transition should be added here.
 */
function stampInstanceId<T>(
  topic: string,
  payload: T,
  id: import('@ouija-dev/types').InstanceId,
): T {
  if (topic === 'dispatch.outcome') {
    return { ...(payload as unknown as object), instanceId: id } as unknown as T;
  }
  return payload;
}

export class SanitizerBlockedError extends Error {
  constructor(
    public readonly cardId: string,
    public readonly categories: string[],
  ) {
    super(
      `Card description for ${cardId} blocked by sanitizer (categories: ${categories.join(', ')})`,
    );
    this.name = 'SanitizerBlockedError';
  }
}

// ---- applyTrigger return shape ----

/**
 * Summary of what {@link Orchestrator.applyTrigger} did. Returned to
 * callers so they can produce entry-point-specific log lines (each caller
 * cares about a different set of fields — e.g. the review-loop path wants
 * reviewer + comment counts while the stall path wants the dispatch id).
 */
interface ApplyTriggerResult {
  accepted: boolean;
  reason?: string;
  /** Status the pipeline was in before the transition (unset when rejected). */
  prevStatus?: PipelineState['status'];
  /** Status the pipeline moved into (unset when rejected or a no-op). */
  nextStatus?: PipelineState['status'];
  /** Number of side effects the transition produced. */
  sideEffectCount?: number;
}

// ---- Orchestrator ----

export class Orchestrator {
  /** Exposed for testing only — do not mutate externally. */
  readonly _configCache = new Map<string, ConfigCacheEntry>();

  constructor(
    private readonly db: Database,
    private readonly eventBus: EventBus,
    private readonly jobQueue: JobQueue,
    private readonly kanbanPlugin: KanbanPlugin,
    private readonly logger: OrchestratorLogger = noopLogger,
    private readonly agentMemberLookup: AgentMemberLookup = nullAgentMemberLookup,
  ) {}

  /**
   * Main entry point. Called for every pipeline-relevant event from the event bus.
   *
   * Events routed here:
   *  - kanban.card.moved  → load/create instance, build card_moved trigger
   *  - kanban.card.assigned → load/create instance, build card_assigned trigger
   *  - agent.work.progress / agent.work.completed / agent.work.failed / agent.work.pr_ready
   *    → load instance by instanceId from payload
   *  - git.pr.merged → load instance by resolving payload.url via pr_instance_index
   *    (Phase 1 Task 3 — the webhook no longer fabricates instanceId)
   */
  async processTrigger(event: OuijaEvent): Promise<void> {
    try {
      await this._processTrigger(event);
    } catch (err) {
      if (err instanceof SanitizerBlockedError) {
        // Intentional drop — sanitizer already logged the categories.
        // Webhook still returns 200 (don't leak blocked-status to attackers).
        return;
      }
      this.logger.error('Orchestrator.processTrigger failed', {
        eventId: event.id,
        topic: event.topic,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async _processTrigger(event: OuijaEvent): Promise<void> {
    const topic = event.topic;

    // ---- Resolve or create pipeline instance ----

    let instance: PipelineInstance;

    if (topic === 'kanban.card.moved' || topic === 'kanban.card.assigned') {
      const payload = event.payload as { cardId: CardId };
      const existing = await this.db.pipelines.findByCardId(payload.cardId);

      if (existing !== undefined) {
        instance = existing;
      } else {
        // New pipeline — create in idle state
        instance = await this._createIdleInstance(payload.cardId);
      }
    } else if (topic === 'git.pr.merged') {
      // Merge events carry the PR URL (GitHub's canonical identifier) — never
      // a Ouija instanceId. Resolve via pr_instance_index which the agent
      // populates when it emits agent.work.pr_ready. Before Phase 1 Task 3
      // the webhook handler fabricated `github-pr-<N>` as an instanceId and
      // the lookup silently failed, leaving merged PRs stuck forever.
      const payload = event.payload as { url?: string };
      if (this.db.prInstances === undefined) {
        this.logger.info('processTrigger: pr_instance_index missing; git.pr.merged inert', {
          eventId: event.id,
        });
        return;
      }
      if (!payload.url) {
        this.logger.warn('processTrigger: git.pr.merged event has no url, skipping', {
          eventId: event.id,
        });
        return;
      }
      const resolvedId = await this.db.prInstances.findInstanceByPrUrl(payload.url);
      if (resolvedId === undefined) {
        this.logger.warn('processTrigger: no pr_instance_index mapping for merged PR', {
          prUrl: payload.url,
        });
        return;
      }
      const found = await this.db.pipelines.findById(makeInstanceId(resolvedId));
      if (found === undefined) {
        this.logger.warn('processTrigger: pr_instance_index points to missing pipeline', {
          prUrl: payload.url,
          resolvedId,
        });
        return;
      }
      instance = found;
    } else {
      // Agent callbacks carry instanceId in the payload
      const payload = event.payload as { instanceId?: string };
      if (!payload.instanceId) {
        this.logger.warn('processTrigger: event has no instanceId, skipping', {
          topic,
          eventId: event.id,
        });
        return;
      }
      const found = await this.db.pipelines.findById(makeInstanceId(payload.instanceId));
      if (found === undefined) {
        this.logger.warn('processTrigger: pipeline instance not found', {
          instanceId: payload.instanceId,
          topic,
        });
        return;
      }
      instance = found;
    }

    // ---- Load config (with 30s TTL cache) ----

    let config = await this._getConfig(instance.boardId);
    if (config === undefined) {
      this.logger.warn('processTrigger: no pipeline config for board', {
        boardId: instance.boardId,
      });
      return;
    }

    // ---- Build trigger from event ----

    const trigger = await this._buildTrigger(event, instance, config);
    if (trigger === undefined) {
      this.logger.info('processTrigger: event does not map to a pipeline trigger, skipping', {
        topic,
      });
      return;
    }

    // ---- Handle manual assignment (store agent claim, don't transition) ----
    if (trigger.type === 'card_assigned') {
      const agentId = this.agentMemberLookup.getAgentIdByMemberId(trigger.assigneeId);
      if (agentId) {
        const now = new Date().toISOString();
        const updated: PipelineInstance = {
          ...instance,
          assignedAgentId: agentId,
          updatedAt: now,
        };
        await this.db.pipelines.save(updated);
        this.logger.info('Manual assignment: agent claimed card', {
          instanceId: String(instance.id),
          agentId,
          assigneeId: trigger.assigneeId,
        });
      }
      return; // Don't call transition — assignment is stored, dispatch waits for column move
    }

    // ---- Override column mapping agentId with assigned agent (manual mode) ----
    if (trigger.type === 'card_moved' && instance.assignedAgentId) {
      const targetMapping = config.columnMappings.find(
        (m) => m.columnId === trigger.toColumnId && m.action === 'dispatch_agent',
      );
      if (targetMapping) {
        config = {
          ...config,
          columnMappings: config.columnMappings.map((m) =>
            m.columnId === trigger.toColumnId && m.action === 'dispatch_agent'
              ? { ...m, agentId: makeAgentId(instance.assignedAgentId!) }
              : m,
          ),
        };
      }
    }

    // ---- Auto-acknowledge: if pipeline is dispatching and we get a progress/completed event,
    // implicitly acknowledge first (dispatching → running), then process the event.
    // This avoids requiring the agent plugin to send a separate acknowledged callback. ----

    if (
      instance.state.status === 'dispatching' &&
      (trigger.type === 'agent_progress' || trigger.type === 'agent_completed')
    ) {
      const ackTrigger = {
        type: 'agent_acknowledged' as const,
        dispatchId: instance.state.dispatchId,
      };
      const ackOutcome = transition(instance.state, ackTrigger, config);
      if (!ackOutcome.rejected) {
        this.logger.info('processTrigger: auto-acknowledged dispatching → running', {
          instanceId: String(instance.id),
        });
        const now = new Date().toISOString();
        const existingForAck = await this.db.pipelineEvents.listByInstance(instance.id);
        const ackSynthEvent = {
          id: randomUUID(),
          instanceId: instance.id,
          topic: 'pipeline.transitioned' as const,
          payload: {
            instanceId: instance.id,
            fromStatus: instance.state.status,
            toStatus: ackOutcome.nextState.status,
            trigger: 'auto_acknowledge',
          },
          occurredAt: now,
          sequence: existingForAck.length,
        };
        await this.db.transaction(async (uow) => {
          await uow.pipelines.save({
            ...instance,
            state: ackOutcome.nextState,
            updatedAt: now,
          });
          await uow.pipelineEvents.appendMany([ackSynthEvent]);
        });
        // Update local instance for the subsequent transition
        instance = { ...instance, state: ackOutcome.nextState, updatedAt: now };
      }
    }

    // ---- Delegate to the shared applyTrigger primitive ----

    const result = await this.applyTrigger(instance, trigger, config);

    if (!result.accepted) {
      this.logger.info('processTrigger: transition rejected', {
        instanceId: instance.id,
        reason: result.reason,
        topic,
      });
      return;
    }

    this.logger.info('processTrigger: transition persisted', {
      instanceId: instance.id,
      prevStatus: result.prevStatus,
      nextStatus: result.nextStatus,
      sideEffectCount: result.sideEffectCount,
    });
  }

  // ---- applyTrigger: the one persist-+-side-effect primitive ----

  /**
   * The single path every trigger source flows through. Entry points
   * (`_processTrigger`, `processStallDetected`, `processReviewBundle`, and
   * Phase-3+ additions like `ouija watch`) resolve the pipeline instance and
   * board config, then hand off to this method.
   *
   * Responsibilities:
   *   1. Invoke the pure transition.
   *   2. On rejection, return `{accepted: false, reason}` — caller logs.
   *   3. Stamp instance-level set-once values (`sessionLogPath`) from the
   *      trigger when the instance has none yet.
   *   4. Synthesise a `pipeline.transitioned` event when the status changes,
   *      so the audit log is populated even for transitions whose pure
   *      handler returns `events: []`.
   *   5. Persist (updated instance + events) in a single transaction.
   *   6. Execute side effects after the DB commit. Side-effect failures are
   *      logged and swallowed — they do NOT roll back the transition.
   *
   * Does NOT:
   *   - Load the instance (caller resolves it).
   *   - Load the board config (caller resolves it).
   *   - Handle pre-transition logic like manual assignment or auto-ack (those
   *     stay in the entry points that own them).
   */
  private async applyTrigger(
    instance: PipelineInstance,
    trigger: PipelineTrigger,
    config: PipelineConfig,
  ): Promise<ApplyTriggerResult> {
    const outcome = transition(instance.state, trigger, config);

    if (outcome.rejected) {
      return { accepted: false, reason: outcome.reason };
    }

    const now = new Date().toISOString();
    const updatedInstance: PipelineInstance = {
      ...instance,
      state: outcome.nextState,
      updatedAt: now,
    };

    // Stamp session_log_path onto the instance when a DispatchOutcome carries
    // one and the instance has none yet. Instance-level (not on state JSONB)
    // because the value is set once per dispatch and must survive all
    // subsequent transitions. Never overwrite: once set, the path is stable.
    if (
      trigger.type === 'agent_completed' &&
      trigger.outcome?.sessionLogPath !== undefined &&
      updatedInstance.sessionLogPath === undefined
    ) {
      updatedInstance.sessionLogPath = trigger.outcome.sessionLogPath;
    }

    const existingEvents = await this.db.pipelineEvents.listByInstance(instance.id);
    const seqBase = existingEvents.length;

    const eventRecords = outcome.events.map((e, i) => ({
      id: randomUUID(),
      instanceId: instance.id,
      topic: e.topic,
      // The pure transition cannot fill instanceId on payloads that carry it
      // (it has no knowledge of the pipeline instance). Stamp it here so
      // persisted events are self-contained. Covers `dispatch.outcome`
      // specifically; other topics already carry instanceId from the trigger
      // or are instance-free.
      payload: stampInstanceId(e.topic, e.payload, instance.id),
      occurredAt: now,
      sequence: seqBase + i,
    }));

    if (outcome.nextState.status !== instance.state.status) {
      eventRecords.push({
        id: randomUUID(),
        instanceId: instance.id,
        topic: 'pipeline.transitioned',
        payload: {
          instanceId: instance.id,
          fromStatus: instance.state.status,
          toStatus: outcome.nextState.status,
          trigger: trigger.type,
        },
        occurredAt: now,
        sequence: seqBase + eventRecords.length,
      });
    }

    await this.db.transaction(async (uow) => {
      await uow.pipelines.save(updatedInstance);
      if (eventRecords.length > 0) {
        await uow.pipelineEvents.appendMany(eventRecords);
      }
    });

    await Promise.all(
      outcome.sideEffects.map((effect) =>
        this._executeSideEffect(effect, instance).catch((err) => {
          this.logger.error('Side effect failed (transition committed, continuing)', {
            effectType: effect.type,
            idempotencyKey: effect.idempotencyKey,
            instanceId: instance.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    );

    return {
      accepted: true,
      prevStatus: instance.state.status,
      nextStatus: outcome.nextState.status,
      sideEffectCount: outcome.sideEffects.length,
    };
  }

  // ---- Side effect dispatch ----

  private async _executeSideEffect(
    effect: SideEffect,
    instance: PipelineInstance,
  ): Promise<void> {
    switch (effect.type) {
      case 'dispatch_agent': {
        const dispatchJobData: AgentDispatchJobData = {
          instanceId: String(instance.id),
          dispatchId: String(effect.payload['dispatchId'] ?? ''),
          agentId: String(effect.payload['agentId'] ?? ''),
          cardId: String(instance.cardId),
          projectId: instance.projectId,
          workOrderDescription: String(effect.payload['workOrderDescription'] ?? ''),
          dispatchedAt: new Date().toISOString(),
        };
        // On review-loop iterations, the transition handler attaches the
        // aggregated reviewer feedback as `reviewContext` on the side effect.
        // Forward it to the worker so the WorkOrder prompt includes it.
        const reviewContext = effect.payload['reviewContext'] as
          | AgentDispatchJobData['reviewContext']
          | undefined;
        if (reviewContext !== undefined) {
          dispatchJobData.reviewContext = reviewContext;
        }
        await this.jobQueue.enqueue(QUEUE_NAMES.agentDispatch, dispatchJobData, {
          jobId: effect.idempotencyKey,
        });
        break;
      }

      case 'enqueue_stall_check': {
        const delayMs =
          typeof effect.payload['delayMs'] === 'number' ? effect.payload['delayMs'] : 300_000;
        const dispatchIdVal = String(effect.payload['dispatchId'] ?? '');
        const stallJobData: StallCheckJobData = {
          instanceId: String(instance.id),
          dispatchId: dispatchIdVal,
          expectedBy: new Date(Date.now() + delayMs).toISOString(),
        };
        await this.jobQueue.enqueue(QUEUE_NAMES.stallCheck, stallJobData, {
          jobId: effect.idempotencyKey,
          delayMs,
        });
        break;
      }

      case 'cancel_stall_check': {
        // Cancel by jobId. The stall check was enqueued with the idempotencyKey of the
        // enqueue_stall_check effect as its jobId. We cancel using the idempotencyKey
        // of THIS cancel effect — however the transition function sets the cancel's
        // idempotencyKey independently. We use the dispatchId to reconstruct possible
        // jobId patterns. cancelJob is a no-op if not found.
        const dispatchIdVal = String(effect.payload['dispatchId'] ?? '');
        if (dispatchIdVal) {
          await Promise.all([
            this.jobQueue
              .cancelJob(QUEUE_NAMES.stallCheck, `stall-check-${dispatchIdVal}`)
              .catch(() => undefined),
            this.jobQueue
              .cancelJob(QUEUE_NAMES.stallCheck, `stall-check-retry-${dispatchIdVal}`)
              .catch(() => undefined),
            // The idempotencyKey is also a valid jobId candidate
            this.jobQueue
              .cancelJob(QUEUE_NAMES.stallCheck, effect.idempotencyKey)
              .catch(() => undefined),
          ]);
        }
        break;
      }

      case 'move_card': {
        const columnName = String(effect.payload['columnName'] ?? '');
        if (columnName) {
          const config = await this._getConfig(instance.boardId);
          const mapping = config?.columnMappings.find((m) => m.columnName === columnName);
          if (mapping !== undefined) {
            await this.kanbanPlugin.moveCard(instance.cardId, mapping.columnId);
          } else {
            this.logger.warn('move_card: no column mapping found for name', {
              columnName,
              boardId: instance.boardId,
            });
          }
        }
        break;
      }

      case 'add_comment': {
        const body = String(effect.payload['body'] ?? '');
        if (body) {
          await this.kanbanPlugin.addComment(instance.cardId, body);
        }
        break;
      }

      case 'send_notification': {
        // Publish on the dedicated notification.send topic so any registered
        // notification plugin can consume it. The Telegram plugin subscribes here.
        const notifTitle = String(effect.payload['title'] ?? 'Pipeline Update');
        const notifBody = String(effect.payload['body'] ?? '');
        const notifLevel = (effect.payload['level'] as import('@ouija-dev/types').NotificationLevel | undefined) ?? 'info';
        await this.eventBus.publish(
          'notification.send',
          {
            title: notifTitle,
            body: notifBody,
            level: notifLevel,
            idempotencyKey: effect.idempotencyKey,
            instanceId: String(instance.id),
          },
          {
            correlationId: effect.idempotencyKey,
            sourcePlugin: 'orchestrator',
          },
        );
        break;
      }

      case 'cancel_agent': {
        // cancel_agent is handled by the server layer (JWT revocation + AgentPlugin.cancel).
        // Log for now; the server subscribes to pipeline state and handles revocation.
        this.logger.info('cancel_agent side effect recorded', {
          dispatchId: String(effect.payload['dispatchId'] ?? ''),
          instanceId: String(instance.id),
        });
        break;
      }

      case 'record_pr_mapping': {
        // Persist the pr_url → instance_id mapping so an incoming review
        // webhook can resolve back to this pipeline without scanning the
        // pipeline_instances.state JSONB. No-op when the agents/prInstances
        // migration hasn't been applied (older deployments).
        const prUrl = String(effect.payload['prUrl'] ?? '');
        if (!prUrl) break;
        if (this.db.prInstances === undefined) {
          this.logger.info(
            'record_pr_mapping skipped: migration 004 not applied; review loop will remain dormant',
            { prUrl, instanceId: String(instance.id) },
          );
          break;
        }
        try {
          await this.db.prInstances.record(prUrl, String(instance.id));
        } catch (err) {
          this.logger.error('record_pr_mapping failed (review loop may be inert)', {
            prUrl,
            instanceId: String(instance.id),
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      default: {
        // Unknown side effect type — log and continue to avoid silent drops.
        this.logger.warn('Unknown side effect type, skipping', {
          type: (effect as SideEffect).type,
          instanceId: String(instance.id),
        });
      }
    }
  }

  // ---- Trigger construction ----

  private async _buildTrigger(
    event: OuijaEvent,
    instance: PipelineInstance,
    _config: PipelineConfig,
  ): Promise<PipelineTrigger | undefined> {
    const topic = event.topic;

    switch (topic) {
      case 'kanban.card.moved': {
        const payload = event.payload as {
          cardId: CardId;
          fromColumnId: ColumnId;
          toColumnId: ColumnId;
        };
        const guardContext = await this._fetchGuardContext(payload.cardId);
        return {
          type: 'card_moved',
          cardId: payload.cardId,
          toColumnId: payload.toColumnId,
          fromColumnId: payload.fromColumnId,
          guardContext,
        };
      }

      case 'kanban.card.assigned': {
        const payload = event.payload as { cardId: CardId; assigneeId: string };
        const agentId = this.agentMemberLookup.getAgentIdByMemberId(payload.assigneeId);

        if (agentId === undefined) {
          // Not an agent — ignore
          this.logger.info('card_assigned: assignee is not an agent, skipping', {
            assigneeId: payload.assigneeId,
          });
          return undefined;
        }

        const triggerMode = this.agentMemberLookup.getTriggerMode(agentId);

        if (triggerMode === 'auto') {
          // Convert to card_moved to dispatch immediately.
          // First try agent-specific column, then fall back to any dispatch column.
          let mapping = _config.columnMappings.find(
            (m) => m.action === 'dispatch_agent' && String(m.agentId ?? '') === agentId,
          );
          if (mapping === undefined) {
            mapping = _config.columnMappings.find(
              (m) => m.action === 'dispatch_agent',
            );
          }
          if (mapping === undefined) {
            this.logger.warn('card_assigned auto: no dispatch column mapping found', {
              agentId,
              boardId: instance.boardId,
            });
            return undefined;
          }
          // Store the assignment so the card_moved override uses this agent
          const now = new Date().toISOString();
          instance.assignedAgentId = agentId;
          await this.db.pipelines.save({ ...instance, assignedAgentId: agentId, updatedAt: now });

          const guardContext = await this._fetchGuardContext(payload.cardId);
          return {
            type: 'card_moved',
            cardId: payload.cardId,
            toColumnId: mapping.columnId,
            fromColumnId: makeColumnId(''),
            guardContext,
          };
        }

        // Manual mode: return the assignment trigger
        return {
          type: 'card_assigned',
          cardId: payload.cardId,
          assigneeId: payload.assigneeId,
        };
      }

      case 'agent.work.progress': {
        const payload = event.payload as { dispatchId: string; message: string };
        return {
          type: 'agent_progress',
          dispatchId: makeDispatchId(payload.dispatchId),
          heartbeatAt: event.timestamp,
          message: payload.message ?? '',
        };
      }

      case 'agent.work.pr_ready': {
        const payload = event.payload as { dispatchId: string; prUrl: string; prId: string };
        return {
          type: 'agent_pr_ready',
          dispatchId: makeDispatchId(payload.dispatchId),
          prUrl: payload.prUrl,
          prId: makePrId(payload.prId),
        };
      }

      case 'agent.work.completed': {
        const payload = event.payload as {
          dispatchId: string;
          cost?: number;
          tokensUsed?: number;
          outcome?: import('@ouija-dev/types').DispatchOutcome;
        };
        return {
          type: 'agent_completed',
          dispatchId: makeDispatchId(payload.dispatchId),
          ...(payload.cost !== undefined ? { cost: payload.cost } : {}),
          ...(payload.tokensUsed !== undefined ? { tokensUsed: payload.tokensUsed } : {}),
          ...(payload.outcome !== undefined ? { outcome: payload.outcome } : {}),
        };
      }

      case 'agent.work.failed': {
        const payload = event.payload as {
          dispatchId: string;
          error: string;
          retryable: boolean;
        };
        return {
          type: 'agent_failed',
          dispatchId: makeDispatchId(payload.dispatchId),
          error: payload.error,
          retryable: payload.retryable,
        };
      }

      case 'git.pr.merged': {
        const payload = event.payload as { prId: string; mergedAt: string };
        return {
          type: 'pr_merged',
          prId: makePrId(payload.prId),
          mergedAt: payload.mergedAt,
        };
      }

      default:
        return undefined;
    }
  }

  // ---- Guard context fetch with sanitization ----

  private async _fetchGuardContext(cardId: CardId): Promise<GuardContext> {
    const card = await this.kanbanPlugin.getCard(cardId);

    // Sanitize the description before it flows into guards (and ultimately into WorkOrder).
    // Warnings are recorded for the pipeline timeline.
    const sanitizeResult = sanitize(card.description);

    if (sanitizeResult.blocked) {
      const categories = Array.from(
        new Set(sanitizeResult.warnings.map((w) => w.type)),
      );
      this.logger.error('Card description blocked by sanitizer — dropping event', {
        cardId: String(cardId),
        warningCount: sanitizeResult.warnings.length,
        categories,
        warnings: sanitizeResult.warnings
          .slice(0, 5)
          .map((w) => `${w.type}: ${w.detail}`),
      });
      throw new SanitizerBlockedError(String(cardId), categories);
    }

    if (sanitizeResult.warnings.length > 0) {
      this.logger.warn('Card description sanitization warnings', {
        cardId: String(cardId),
        warnings: sanitizeResult.warnings.map((w) => `${w.type}: ${w.detail}`),
      });
    }

    return {
      cardDescription: sanitizeResult.sanitized,
      cardLabels: card.labels,
      cardAssignees: card.assignees,
    };
  }

  // ---- Config cache ----

  private async _getConfig(boardId: BoardId): Promise<PipelineConfig | undefined> {
    const cached = this._configCache.get(boardId as string);
    if (cached !== undefined && Date.now() - cached.cachedAt < CONFIG_CACHE_TTL_MS) {
      return cached.config;
    }
    const config = await this.db.boardConfigs.findByBoardId(boardId);
    if (config !== undefined) {
      this._configCache.set(boardId as string, { config, cachedAt: Date.now() });
    }
    return config;
  }

  /** Invalidate the config cache for a board (call after config updates). */
  invalidateConfigCache(boardId: BoardId): void {
    this._configCache.delete(boardId as string);
  }

  // ---- Instance creation ----

  private async _createIdleInstance(cardId: CardId): Promise<PipelineInstance> {
    // Fetch the card to resolve boardId — kanban plugin is the source of truth.
    const card = await this.kanbanPlugin.getCard(cardId);
    const now = new Date().toISOString();
    const id = makeInstanceId(randomUUID());
    const idleState: PipelineState = { status: 'idle' };

    const newInstance: PipelineInstance = {
      id,
      cardId,
      boardId: card.boardId,
      // projectId defaults to boardId until a proper project-to-board mapping is configured
      projectId: String(card.boardId),
      state: idleState,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Persist immediately (outside the transition transaction) so the instance exists
    // before the transition is applied.
    await this.db.pipelines.save(newInstance);
    return newInstance;
  }

  // ---- Stall monitor integration ----

  /**
   * Called by StallMonitor (Layer 2) when a stall candidate is detected in the DB.
   * Bypasses the event→trigger mapping path and directly builds a stall_detected trigger.
   *
   * @param instanceIdStr - Pipeline instance ID as a plain string
   * @param dispatchIdVal - Dispatch ID (DispatchId branded type)
   * @param detectedAt    - ISO timestamp of when the stall was detected
   */
  async processStallDetected(
    instanceIdStr: string,
    dispatchIdVal: DispatchId,
    detectedAt: string,
  ): Promise<void> {
    const instance = await this.db.pipelines.findById(makeInstanceId(instanceIdStr));
    if (instance === undefined) {
      this.logger.warn('processStallDetected: instance not found', { instanceId: instanceIdStr });
      return;
    }

    const config = await this._getConfig(instance.boardId);
    if (config === undefined) {
      this.logger.warn('processStallDetected: no config for board', { boardId: instance.boardId });
      return;
    }

    const trigger: PipelineTrigger = {
      type: 'stall_detected',
      dispatchId: dispatchIdVal,
      detectedAt,
    };

    const result = await this.applyTrigger(instance, trigger, config);

    if (!result.accepted) {
      this.logger.info('processStallDetected: transition rejected', {
        instanceId: instanceIdStr,
        reason: result.reason,
      });
      return;
    }

    this.logger.warn('processStallDetected: pipeline marked stalled', {
      instanceId: instanceIdStr,
      dispatchId: String(dispatchIdVal),
      detectedAt,
      prevStatus: result.prevStatus,
      nextStatus: result.nextStatus,
    });
  }

  /**
   * Review loop entry point. Called by the server wiring when the bundler
   * finishes draining its debounce window for a PR. Resolves the pipeline
   * instance via pr_instance_index, then drives the pr_review_received
   * trigger through the standard transition → persist → side-effect pipeline.
   *
   * Returns silently if:
   *   - pr_instance_index has no mapping (pipeline opened its PR before
   *     migration 004 was applied, or the mapping was manually cleared)
   *   - the instance was deleted
   *   - the pipeline is no longer in awaiting_review (the transition handler
   *     rejects and we log the reason)
   */
  async processReviewBundle(bundle: ReviewBundle): Promise<void> {
    if (this.db.prInstances === undefined) {
      this.logger.info('processReviewBundle: pr_instance_index missing; review loop inert', {
        prUrl: bundle.prUrl,
      });
      return;
    }

    const instanceIdStr = await this.db.prInstances.findInstanceByPrUrl(bundle.prUrl);
    if (instanceIdStr === undefined) {
      this.logger.info('processReviewBundle: no instance mapped to PR', { prUrl: bundle.prUrl });
      return;
    }

    const instance = await this.db.pipelines.findById(makeInstanceId(instanceIdStr));
    if (instance === undefined) {
      this.logger.warn('processReviewBundle: instance vanished', {
        instanceId: instanceIdStr,
        prUrl: bundle.prUrl,
      });
      return;
    }

    const config = await this._getConfig(instance.boardId);
    if (config === undefined) {
      this.logger.warn('processReviewBundle: no pipeline config for board', {
        boardId: instance.boardId,
      });
      return;
    }

    const trigger: PipelineTrigger = {
      type: 'pr_review_received',
      prUrl: bundle.prUrl,
      prId: bundle.prId,
      bundle,
    };

    const result = await this.applyTrigger(instance, trigger, config);

    if (!result.accepted) {
      this.logger.info('processReviewBundle: transition rejected', {
        instanceId: instanceIdStr,
        reason: result.reason,
      });
      return;
    }

    this.logger.info('processReviewBundle: transition persisted', {
      instanceId: instanceIdStr,
      prevStatus: result.prevStatus,
      nextStatus: result.nextStatus,
      reviews: bundle.reviews.length,
      comments: bundle.comments.length,
    });
  }
}
