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
} from '@ouija/types';
import {
  instanceId as makeInstanceId,
  columnId as makeColumnId,
  dispatchId as makeDispatchId,
  prId as makePrId,
} from '@ouija/types';
import type { EventBus } from '@ouija/bus';
import type { JobQueue, AgentDispatchJobData, StallCheckJobData } from '@ouija/bus';
import { QUEUE_NAMES } from '@ouija/bus';
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

// ---- Config cache entry ----

interface ConfigCacheEntry {
  config: PipelineConfig;
  cachedAt: number;
}

export const CONFIG_CACHE_TTL_MS = 30_000;

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
  ) {}

  /**
   * Main entry point. Called for every pipeline-relevant event from the event bus.
   *
   * Events routed here:
   *  - kanban.card.moved  → load/create instance, build card_moved trigger
   *  - kanban.card.assigned → load/create instance, build card_assigned trigger
   *  - agent.work.progress / agent.work.completed / agent.work.failed / agent.work.pr_ready
   *    → load instance by instanceId from payload
   *  - git.pr.merged → load instance by instanceId
   */
  async processTrigger(event: OuijaEvent): Promise<void> {
    try {
      await this._processTrigger(event);
    } catch (err) {
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
    } else {
      // Agent callbacks and git events carry instanceId in the payload
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

    const config = await this._getConfig(instance.boardId);
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

    // ---- Call pure transition ----

    const outcome = transition(instance.state, trigger, config);

    if (outcome.rejected) {
      this.logger.info('processTrigger: transition rejected', {
        instanceId: instance.id,
        reason: outcome.reason,
        topic,
      });
      return;
    }

    // ---- Compute next sequence base for event records ----

    const existingEvents = await this.db.pipelineEvents.listByInstance(instance.id);
    const seqBase = existingEvents.length;

    // ---- Persist in a single transaction ----

    const now = new Date().toISOString();
    const updatedInstance: PipelineInstance = {
      ...instance,
      state: outcome.nextState,
      updatedAt: now,
    };

    const eventRecords = outcome.events.map((e, i) => ({
      id: randomUUID(),
      instanceId: instance.id,
      topic: e.topic,
      payload: e.payload,
      occurredAt: now,
      sequence: seqBase + i,
    }));

    await this.db.transaction(async (uow) => {
      await uow.pipelines.save(updatedInstance);
      if (eventRecords.length > 0) {
        await uow.pipelineEvents.appendMany(eventRecords);
      }
    });

    this.logger.info('processTrigger: transition persisted', {
      instanceId: instance.id,
      prevStatus: instance.state.status,
      nextStatus: outcome.nextState.status,
      sideEffectCount: outcome.sideEffects.length,
    });

    // ---- Execute side effects AFTER db commit ----
    // Failures here are logged but do NOT roll back the transition.

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
        const notifLevel = (effect.payload['level'] as import('@ouija/types').NotificationLevel | undefined) ?? 'info';
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
        };
        return {
          type: 'agent_completed',
          dispatchId: makeDispatchId(payload.dispatchId),
          ...(payload.cost !== undefined ? { cost: payload.cost } : {}),
          ...(payload.tokensUsed !== undefined ? { tokensUsed: payload.tokensUsed } : {}),
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
      this.logger.warn('Card description blocked by sanitizer', {
        cardId: String(cardId),
        warningCount: sanitizeResult.warnings.length,
      });
    } else if (sanitizeResult.warnings.length > 0) {
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

    const outcome = transition(instance.state, trigger, config);

    if (outcome.rejected) {
      this.logger.info('processStallDetected: transition rejected', {
        instanceId: instanceIdStr,
        reason: outcome.reason,
      });
      return;
    }

    const now = new Date().toISOString();
    const updatedInstance: PipelineInstance = {
      ...instance,
      state: outcome.nextState,
      updatedAt: now,
    };

    await this.db.transaction(async (uow) => {
      await uow.pipelines.save(updatedInstance);
    });

    this.logger.warn('processStallDetected: pipeline marked stalled', {
      instanceId: instanceIdStr,
      dispatchId: String(dispatchIdVal),
      detectedAt,
    });

    // Execute side effects (typically a send_notification)
    await Promise.all(
      outcome.sideEffects.map((effect) =>
        this._executeSideEffect(effect, instance).catch((err) => {
          this.logger.error('processStallDetected: side effect failed', {
            effectType: effect.type,
            instanceId: instanceIdStr,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    );
  }
}
