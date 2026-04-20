/**
 * Pipeline CRUD routes (spec §5.2):
 *
 *   GET  /api/v1/pipelines        — list with cursor pagination + filters
 *   GET  /api/v1/pipelines/:id    — get single pipeline with timeline + allowed_actions
 *   POST /api/v1/pipelines/:id/retry  — retry a failed/stalled pipeline
 *   POST /api/v1/pipelines/:id/cancel — cancel a running pipeline (revokes agent JWT)
 *
 * All routes require authentication (requireAuth preHandler).
 * Pagination: cursor-based (opaque base64) per spec §5.6.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Database, OuijaEvent } from '@ouija-dev/types';
import { instanceId as makeInstanceId } from '@ouija-dev/types';
import { ApiError } from '@ouija-dev/types';
import type { Orchestrator } from '@ouija-dev/engine';
import { requireAuth } from '../middleware/auth.js';
import { revokeJWT } from '../jwt.js';

export interface PipelineRouteOptions {
  db: Database;
  orchestrator: Orchestrator;
}

// ---- Response serializers ----

function serializePipeline(instance: import('@ouija-dev/types').PipelineInstance) {
  const state = instance.state;
  // allowed_actions depends on current status
  const allowedActions: string[] = [];
  if (state.status === 'failed' || state.status === 'stalled') {
    allowedActions.push('retry');
  }
  if (state.status === 'dispatching' || state.status === 'running' || state.status === 'awaiting_review') {
    allowedActions.push('cancel');
  }

  // Review-loop iteration lives on state for dispatching/running/awaiting_review.
  const iteration =
    'iteration' in state && typeof state.iteration === 'number' ? state.iteration : null;

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
    iteration,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
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

      return reply.status(200).send({
        items: page.items.map(serializePipeline),
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

      return reply.status(200).send({
        pipeline: serializePipeline(instance),
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

  // ---- POST /api/v1/pipelines/dispatch ----
  // Administrative dispatch — creates a pipeline instance and runs the named
  // agent without a kanban round-trip. The review loop after the agent opens
  // a PR is unchanged (git webhooks → processReviewBundle).
  app.post<{
    Body: {
      agentId: string;
      title: string;
      description: string;
      cardId?: string;
      boardId?: string;
    };
  }>(
    '/api/v1/pipelines/dispatch',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          properties: {
            agentId: { type: 'string', minLength: 1 },
            title: { type: 'string', minLength: 1, maxLength: 300 },
            description: { type: 'string', maxLength: 10_000 },
            cardId: { type: 'string', minLength: 1, nullable: true },
            boardId: { type: 'string', minLength: 1, nullable: true },
          },
          required: ['agentId', 'title', 'description'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { agentId, title, description } = request.body;
      // Default boardId mirrors the self-hosted-plane preset so the existing
      // board_configs row (seeded at startup from ouija.config.yaml) applies.
      const boardIdStr = request.body.boardId ?? '00000000-0000-0000-0000-000000000001';
      const cardIdStr = request.body.cardId ?? `manual/${randomUUID()}`;

      const result = await orchestrator.dispatchManual({
        agentId,
        cardId: cardIdStr as unknown as import('@ouija-dev/types').CardId,
        boardId: boardIdStr as unknown as import('@ouija-dev/types').BoardId,
        title,
        description,
        requestedBy: request.user?.userId ?? 'api',
      });

      if (result.rejected) {
        throw new ApiError(
          'DISPATCH_REJECTED',
          result.reason ?? 'dispatch rejected by state machine',
          409,
          false,
        );
      }

      return reply.status(202).send({
        instanceId: result.instanceId,
        cardId: cardIdStr,
        boardId: boardIdStr,
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
}
