/**
 * Pipeline CRUD routes (spec §5.2):
 *
 *   GET  /api/v1/pipelines        — list with cursor pagination + filters
 *   GET  /api/v1/pipelines/:id    — get single pipeline with timeline + allowed_actions
 *   POST /api/v1/pipelines/:id/retry  — retry a failed/stalled pipeline
 *   POST /api/v1/pipelines/:id/cancel — cancel a running pipeline (revokes agent JWT)
 *   POST /api/v1/pipelines/:id/reset  — admin recovery: stuck pipeline → idle
 *
 * All routes require authentication (requireAuth preHandler).
 * Pagination: cursor-based (opaque base64) per spec §5.6.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Database, OuijaEvent } from '@ouija-dev/types';
import { instanceId as makeInstanceId } from '@ouija-dev/types';
import { ApiError } from '@ouija-dev/types';
import type { Orchestrator, ManualDispatchOutcome } from '@ouija-dev/engine';
import { resolveDwellBudgetMs } from '@ouija-dev/engine';
import { requireAuth } from '../middleware/auth.js';
import { apiAdminRateLimit } from '../middleware/rate-limit.js';
import { revokeJWT } from '../jwt.js';

export interface PipelineRouteOptions {
  db: Database;
  orchestrator: Orchestrator;
}

// ---- Response serializers ----

function serializePipeline(
  instance: import('@ouija-dev/types').PipelineInstance,
  boardConfig: import('@ouija-dev/types').PipelineConfig | undefined,
) {
  const state = instance.state;
  // allowed_actions depends on current status
  const allowedActions: string[] = [];
  if (state.status === 'failed' || state.status === 'stalled') {
    allowedActions.push('retry');
  }
  if (state.status === 'dispatching' || state.status === 'running' || state.status === 'awaiting_review') {
    allowedActions.push('cancel');
  }
  // Admin recovery: any "stuck-recoverable" state should expose `reset` so the
  // dashboard surfaces the operator action without needing per-status logic.
  // Mirrors the allowlist in `handleAdminReset` (engine/transition.ts).
  if (
    state.status === 'provisioning' ||
    state.status === 'dispatching' ||
    state.status === 'running' ||
    state.status === 'awaiting_review' ||
    state.status === 'stalled'
  ) {
    allowedActions.push('reset');
  }

  // Review-loop iteration lives on state for dispatching/running/awaiting_review.
  const iteration =
    'iteration' in state && typeof state.iteration === 'number' ? state.iteration : null;

  // Dwell budget mirrors the DwellReconciler's resolution so the dashboard
  // can render an "over budget" badge identical to what the reconciler will
  // act on. `null` means no budget (terminal/idle/stalled — operator-driven)
  // or no board config available.
  const dwellBudgetMs =
    boardConfig !== undefined ? (resolveDwellBudgetMs(state.status, boardConfig) ?? null) : null;

  return {
    id: String(instance.id),
    cardId: String(instance.cardId),
    boardId: String(instance.boardId),
    projectId: instance.projectId,
    status: state.status,
    attempt: instance.attempt,
    prUrl: instance.prUrl,
    cost: instance.cost,
    tokensUsed: instance.tokensUsed,
    sessionLogPath: instance.sessionLogPath,
    iteration,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    stateEnteredAt: instance.stateEnteredAt,
    dwellBudgetMs,
    allowedActions,
  };
}

// ---- Routes ----

export async function pipelineRoutes(
  app: FastifyInstance,
  opts: PipelineRouteOptions,
): Promise<void> {
  const { db, orchestrator } = opts;

  // ---- GET /api/v1/pipelines ----
  app.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      boardId?: string;
      status?: string;
    };
  }>(
    '/api/v1/pipelines',
    { preHandler: requireAuth },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit ?? '20', 10) || 20, 100);
      const cursor = request.query.cursor;
      const boardIdFilter = request.query.boardId;

      if (!boardIdFilter) {
        // For v1, boardId is required to keep queries efficient
        throw new ApiError(
          'VALIDATION_ERROR',
          'boardId query parameter is required',
          400,
          false,
          [{ field: 'boardId', message: 'required' }],
        );
      }

      const page = await db.pipelines.listByBoard(
        boardIdFilter as import('@ouija-dev/types').BoardId,
        cursor,
        limit,
      );

      // One config lookup per list call: every row in the page belongs to
      // the same board so we resolve once and pass through to the
      // serializer. Skips the lookup when the page is empty.
      const boardConfig =
        page.items.length > 0
          ? await db.boardConfigs.findByBoardId(
              boardIdFilter as import('@ouija-dev/types').BoardId,
            )
          : undefined;

      return reply.status(200).send({
        items: page.items.map((p) => serializePipeline(p, boardConfig)),
        nextCursor: page.nextCursor,
      });
    },
  );

  // ---- GET /api/v1/pipelines/:id ----
  app.get<{ Params: { id: string } }>(
    '/api/v1/pipelines/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const instance = await db.pipelines.findById(makeInstanceId(request.params.id));
      if (!instance) {
        throw new ApiError(
          'PIPELINE_NOT_FOUND',
          `Pipeline ${request.params.id} does not exist.`,
          404,
          false,
        );
      }

      const timeline = await db.pipelineEvents.listByInstance(makeInstanceId(request.params.id));

      const boardConfig = await db.boardConfigs.findByBoardId(instance.boardId);

      return reply.status(200).send({
        pipeline: serializePipeline(instance, boardConfig),
        timeline: timeline.map((e) => ({
          id: e.id,
          topic: e.topic,
          payload: e.payload,
          occurredAt: e.occurredAt,
          sequence: e.sequence,
        })),
      });
    },
  );

  // ---- POST /api/v1/pipelines/:id/retry ----
  app.post<{ Params: { id: string } }>(
    '/api/v1/pipelines/:id/retry',
    { preHandler: requireAuth },
    async (request, reply) => {
      const instance = await db.pipelines.findById(makeInstanceId(request.params.id));
      if (!instance) {
        throw new ApiError(
          'PIPELINE_NOT_FOUND',
          `Pipeline ${request.params.id} does not exist.`,
          404,
          false,
        );
      }

      const status = instance.state.status;
      if (status !== 'failed' && status !== 'stalled') {
        throw new ApiError(
          'PIPELINE_NOT_RETRYABLE',
          `Pipeline ${request.params.id} cannot be retried from state "${status}".`,
          409,
          false,
        );
      }

      // Build human_retry trigger event and dispatch to orchestrator
      const retryEvent: OuijaEvent = {
        id: randomUUID(),
        topic: 'kanban.card.moved', // Use card.moved to re-trigger pipeline
        payload: {
          cardId: instance.cardId,
          fromColumnId: instance.cardId as unknown as import('@ouija-dev/types').ColumnId,
          toColumnId: instance.cardId as unknown as import('@ouija-dev/types').ColumnId,
          movedBy: request.user?.userId ?? 'api',
        },
        timestamp: new Date().toISOString(),
        sourcePlugin: 'server',
        correlationId: randomUUID(),
      };

      // For retry we directly call a human_retry trigger — publish on event bus
      // For v1 simplicity: call orchestrator.processTrigger with synthetic event
      orchestrator.processTrigger(retryEvent).catch((err) => {
        app.log.error({ err, instanceId: request.params.id }, 'pipeline retry failed');
      });

      return reply.status(202).send({ ok: true, instanceId: request.params.id });
    },
  );

  // ---- POST /api/v1/pipelines/:id/cancel ----
  app.post<{ Params: { id: string } }>(
    '/api/v1/pipelines/:id/cancel',
    { preHandler: requireAuth },
    async (request, reply) => {
      const instance = await db.pipelines.findById(makeInstanceId(request.params.id));
      if (!instance) {
        throw new ApiError(
          'PIPELINE_NOT_FOUND',
          `Pipeline ${request.params.id} does not exist.`,
          404,
          false,
        );
      }

      const state = instance.state;
      if (state.status !== 'dispatching' && state.status !== 'running') {
        throw new ApiError(
          'PIPELINE_ALREADY_RUNNING',
          `Pipeline ${request.params.id} is in state "${state.status}" and cannot be cancelled.`,
          409,
          false,
        );
      }

      // Revoke the agent JWT if we have a dispatchId (use dispatchId as jti proxy for v1)
      // In production, the jti is stored in the pipeline state or a separate table
      if ('dispatchId' in state) {
        await revokeJWT(String(state.dispatchId)).catch((err) => {
          app.log.warn({ err }, 'pipeline cancel: JWT revocation failed (continuing)');
        });
      }

      // Trigger human_cancel via a synthetic cancel event
      const cancelEvent: OuijaEvent = {
        id: randomUUID(),
        topic: 'kanban.card.moved',
        payload: {
          cardId: instance.cardId,
          fromColumnId: instance.cardId as unknown as import('@ouija-dev/types').ColumnId,
          toColumnId: instance.cardId as unknown as import('@ouija-dev/types').ColumnId,
          movedBy: request.user?.userId ?? 'api',
        },
        timestamp: new Date().toISOString(),
        sourcePlugin: 'server',
        correlationId: randomUUID(),
      };

      orchestrator.processTrigger(cancelEvent).catch((err) => {
        app.log.error({ err, instanceId: request.params.id }, 'pipeline cancel failed');
      });

      return reply.status(202).send({ ok: true, instanceId: request.params.id });
    },
  );

  // ---- POST /api/v1/pipelines/dispatch ----
  //
  // Phase 2 Task 7. Promotes the prior v0.3.4 do-not-ship scratch
  // (`fix/v0.3.4-dispatch-endpoint` at `94f20a1`) into a first-class route.
  // Drives the new `manual_dispatch` trigger through `applyTrigger` (6th
  // caller), creating a fresh idle pipeline instance with a synthetic
  // `manual/<uuid>` cardId and immediately dispatching it. Closes
  // friction-log #17 ("no path to first dispatch when kanban is broken").
  //
  // Path is `/dispatch` (not `/:id/dispatch`) because the route is what
  // creates the instance. Auth-gated; rate-limited under
  // `apiAdminRateLimit` to mirror the reset endpoint — manual dispatch
  // is an operator action, not a hot path.
  app.post<{
    Body: {
      agentId: string;
      title: string;
      description: string;
      boardId?: string;
      requestedBy?: string;
    };
  }>(
    '/api/v1/pipelines/dispatch',
    {
      preHandler: requireAuth,
      ...apiAdminRateLimit,
      schema: {
        body: {
          type: 'object',
          properties: {
            agentId: { type: 'string', minLength: 1, maxLength: 200 },
            title: { type: 'string', minLength: 1, maxLength: 300 },
            description: { type: 'string', minLength: 1, maxLength: 10_000 },
            boardId: { type: 'string', minLength: 1, maxLength: 200, nullable: true },
            requestedBy: { type: 'string', maxLength: 200, nullable: true },
          },
          required: ['agentId', 'title', 'description'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { agentId, title, description, boardId } = request.body;
      const requestedBy =
        (request.body.requestedBy && request.body.requestedBy.trim()) ||
        request.user?.userId ||
        'api';

      const outcome: ManualDispatchOutcome = await orchestrator.requestManualDispatch({
        agentId,
        title,
        description,
        ...(boardId !== undefined ? { boardId } : {}),
        requestedBy,
      });

      switch (outcome.kind) {
        case 'dispatched':
          return reply.status(202).send({
            ok: true,
            instanceId: outcome.instanceId,
            cardId: outcome.cardId,
            boardId: outcome.boardId,
            dispatchId: outcome.dispatchId,
          });
        case 'no_board':
          throw new ApiError(
            'NO_BOARD_CONFIGURED',
            'No board is configured. Add at least one board to ouija.config.yaml before dispatching.',
            409,
            false,
          );
        case 'ambiguous_board':
          throw new ApiError(
            'BOARD_ID_REQUIRED',
            `Multiple boards configured (${outcome.boardIds.join(', ')}); pass boardId in the request body.`,
            400,
            false,
            outcome.boardIds.map((id) => ({ field: 'boardId', message: `candidate: ${id}` })),
          );
        case 'config_missing':
          throw new ApiError(
            'PIPELINE_CONFIG_MISSING',
            `No board config for ${outcome.boardId}; cannot dispatch.`,
            500,
            false,
          );
        case 'rejected':
          throw new ApiError('DISPATCH_REJECTED', outcome.reason, 409, false);
        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
          throw new ApiError(
            'INTERNAL_ERROR',
            'Unknown manual-dispatch outcome',
            500,
            false,
          );
        }
      }
    },
  );

  // ---- POST /api/v1/pipelines/:id/reset ----
  //
  // Admin recovery (Phase 2 friction-log #16). Drives the new `admin_reset`
  // trigger through `applyTrigger`, returning the pipeline to `idle` and
  // emitting a dedicated `pipeline.admin_reset` audit event alongside the
  // automatic `pipeline.transitioned` event. Unlike the older /retry and
  // /cancel scaffolding (which synthesise bogus card-moved events), this
  // route uses the trigger primitive directly — no SQL hand-edit ever needed.
  app.post<{ Params: { id: string }; Body?: { requestedBy?: string } }>(
    '/api/v1/pipelines/:id/reset',
    { preHandler: requireAuth, ...apiAdminRateLimit },
    async (request, reply) => {
      // `requireAuth` guarantees `request.user` is set here.
      const requestedBy =
        (request.body?.requestedBy && request.body.requestedBy.trim()) ||
        request.user?.userId ||
        'api';

      const outcome = await orchestrator.requestAdminReset(request.params.id, requestedBy);

      if (outcome.kind === 'not_found') {
        throw new ApiError(
          'PIPELINE_NOT_FOUND',
          `Pipeline ${request.params.id} does not exist.`,
          404,
          false,
        );
      }
      if (outcome.kind === 'config_missing') {
        throw new ApiError(
          'PIPELINE_CONFIG_MISSING',
          `No board config for pipeline ${request.params.id}; cannot reset.`,
          500,
          false,
        );
      }
      if (outcome.kind === 'rejected') {
        throw new ApiError('PIPELINE_NOT_RESETTABLE', outcome.reason, 409, false);
      }

      return reply.status(200).send({
        ok: true,
        instanceId: request.params.id,
        prevStatus: outcome.prevStatus,
        nextStatus: outcome.nextStatus,
      });
    },
  );
}
