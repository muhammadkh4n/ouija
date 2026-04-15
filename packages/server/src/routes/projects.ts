/**
 * Project + board config routes (spec §5.2).
 *
 *   GET  /api/v1/boards             — list all configured boards (for dashboard picker)
 *   GET  /api/v1/projects           — list board configs (offset pagination, stub)
 *   POST /api/v1/projects           — create a board config
 *   PUT  /api/v1/projects/:id/column-mappings — replace column-action mappings
 *
 * All routes require authentication.
 * These are thin wrappers around the BoardConfigRepository for v1.
 * Full project management (cost summary, pipeline list per project) is Phase 2.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Database, PipelineConfig, ColumnMapping } from '@ouija-dev/types';
import { boardId as makeBoardId, columnId as makeColumnId, agentId as makeAgentId } from '@ouija-dev/types';
import { ApiError } from '@ouija-dev/types';
import { requireAuth } from '../middleware/auth.js';

export interface ProjectRouteOptions {
  db: Database;
}

// ---- Helpers ----

function serializeConfig(config: PipelineConfig) {
  return {
    boardId: String(config.boardId),
    columnMappings: config.columnMappings.map((m) => ({
      columnId: String(m.columnId),
      columnName: m.columnName,
      action: m.action,
      agentId: m.agentId !== undefined ? String(m.agentId) : undefined,
      guards: m.guards,
      stallThresholdMs: m.stallThresholdMs,
    })),
    defaultStallThresholdMs: config.defaultStallThresholdMs,
    autoStartOnAssign: config.autoStartOnAssign,
  };
}

// ---- Routes ----

export async function projectRoutes(
  app: FastifyInstance,
  opts: ProjectRouteOptions,
): Promise<void> {
  const { db } = opts;

  // ---- GET /api/v1/boards ----
  // Lightweight endpoint for the dashboard board picker. Returns the full
  // column mappings so the UI can show which columns dispatch agents
  // without needing a second round-trip.
  app.get(
    '/api/v1/boards',
    { preHandler: requireAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const boards = await db.boardConfigs.listAll();
      return reply.status(200).send({
        items: boards.map(serializeConfig),
        total: boards.length,
      });
    },
  );

  // ---- GET /api/v1/projects ----
  // v1: boardId is the project identity — list is not yet paginated
  app.get(
    '/api/v1/projects',
    { preHandler: requireAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      // v1: Return empty list — full project listing deferred to Phase 2
      // (requires a projects table, not just board configs)
      return reply.status(200).send({ items: [], total: 0, offset: 0, limit: 50 });
    },
  );

  // ---- POST /api/v1/projects ----
  app.post<{
    Body: {
      boardId: string;
      defaultStallThresholdMs?: number;
      autoStartOnAssign?: boolean;
    };
  }>(
    '/api/v1/projects',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['boardId'],
          properties: {
            boardId: { type: 'string', minLength: 1 },
            defaultStallThresholdMs: { type: 'number', minimum: 60000 },
            autoStartOnAssign: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { boardId: boardIdRaw, defaultStallThresholdMs = 300_000, autoStartOnAssign = false } =
        request.body;

      const boardIdVal = makeBoardId(boardIdRaw);

      // Idempotent create: check if already exists
      const existing = await db.boardConfigs.findByBoardId(boardIdVal);
      if (existing) {
        return reply.status(200).send(serializeConfig(existing));
      }

      const config: PipelineConfig = {
        boardId: boardIdVal,
        columnMappings: [],
        defaultStallThresholdMs,
        autoStartOnAssign,
      };

      await db.boardConfigs.save(config);
      return reply.status(201).send(serializeConfig(config));
    },
  );

  // ---- PUT /api/v1/projects/:id/column-mappings ----
  // Replace-all semantics: the provided array becomes the full set.
  app.put<{
    Params: { id: string };
    Body: {
      columnMappings: Array<{
        columnId: string;
        columnName: string;
        action: 'dispatch_agent' | 'close_and_notify' | 'noop';
        agentId?: string;
        guards?: Array<{ type: 'min_description_length' | 'has_label' | 'has_assignee'; value: string | number }>;
        stallThresholdMs?: number;
      }>;
    };
  }>(
    '/api/v1/projects/:id/column-mappings',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['columnMappings'],
          properties: {
            columnMappings: {
              type: 'array',
              items: {
                type: 'object',
                required: ['columnId', 'columnName', 'action'],
                properties: {
                  columnId: { type: 'string', minLength: 1 },
                  columnName: { type: 'string', minLength: 1 },
                  action: { type: 'string', enum: ['dispatch_agent', 'close_and_notify', 'noop'] },
                  agentId: { type: 'string' },
                  guards: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['type', 'value'],
                      properties: {
                        type: { type: 'string', enum: ['min_description_length', 'has_label', 'has_assignee'] },
                        value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                      },
                    },
                  },
                  stallThresholdMs: { type: 'number', minimum: 60000 },
                },
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const boardIdVal = makeBoardId(request.params.id);
      const existing = await db.boardConfigs.findByBoardId(boardIdVal);

      if (!existing) {
        throw new ApiError(
          'PROJECT_NOT_FOUND',
          `Project ${request.params.id} does not exist.`,
          404,
          false,
        );
      }

      const newMappings: ColumnMapping[] = request.body.columnMappings.map((m) => ({
        columnId: makeColumnId(m.columnId),
        columnName: m.columnName,
        action: m.action,
        ...(m.agentId !== undefined ? { agentId: makeAgentId(m.agentId) } : {}),
        guards: (m.guards ?? []).map((g) => ({ type: g.type, value: g.value })),
        ...(m.stallThresholdMs !== undefined ? { stallThresholdMs: m.stallThresholdMs } : {}),
      }));

      const updated: PipelineConfig = {
        ...existing,
        columnMappings: newMappings,
      };

      await db.boardConfigs.save(updated);
      return reply.status(200).send(serializeConfig(updated));
    },
  );
}
