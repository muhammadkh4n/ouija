/**
 * Agent CRUD routes (WS3.1).
 *
 *   GET    /api/v1/agents       — list active agents (no secret values)
 *   GET    /api/v1/agents/:id   — detail (no secret values)
 *   POST   /api/v1/agents       — create, with optional secrets map that gets
 *                                 encrypted into the secrets_vault JSONB column
 *   PUT    /api/v1/agents/:id   — update; secrets are merged (not replaced)
 *                                 unless `replaceSecrets: true` is passed
 *   DELETE /api/v1/agents/:id   — soft delete (active=false) so pipeline
 *                                 history still resolves the name
 *
 * Returned payloads never include raw secret values. The `secretFields` array
 * surfaces which field names the vault contains so the dashboard can render
 * "ANTHROPIC_API_KEY is set" without ever round-tripping ciphertext.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Database, AgentRecord } from '@ouija-dev/types';
import { ApiError } from '@ouija-dev/types';
import { encryptSecrets, decryptSecrets } from '@ouija-dev/engine';
import { requireAuth } from '../middleware/auth.js';

export interface AgentRouteOptions {
  db: Database;
}

// ---- Serialization ----

function serializeAgent(record: AgentRecord) {
  return {
    id: record.id,
    config: record.config,
    secretFields: record.secretsVault?.fields ?? [],
    active: record.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function getMasterKey(): string {
  const key = process.env['OUIJA_SECRET_KEY'];
  if (!key || key.length < 32) {
    throw new ApiError(
      'CONFIG_ERROR',
      'OUIJA_SECRET_KEY must be set and at least 32 characters for agent CRUD',
      500,
      false,
    );
  }
  return key;
}

// ---- Routes ----

export async function agentRoutes(
  app: FastifyInstance,
  opts: AgentRouteOptions,
): Promise<void> {
  const { db } = opts;

  if (db.agents === undefined) {
    // No agents repository available — likely migration 003 hasn't been applied
    // yet. Emit 404 on everything so the dashboard can detect this cleanly.
    app.all('/api/v1/agents', { preHandler: requireAuth }, async (_req, reply) =>
      reply.status(404).send({
        error: { code: 'NOT_AVAILABLE', message: 'Agent CRUD requires migration 003-agents' },
      }),
    );
    return;
  }

  const agents = db.agents;

  // ---- GET /api/v1/agents ----
  app.get<{
    Querystring: { includeInactive?: string };
  }>(
    '/api/v1/agents',
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            includeInactive: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const includeInactive = request.query.includeInactive === 'true';
      const records = await agents.listAll(!includeInactive);
      return reply.status(200).send({
        items: records.map(serializeAgent),
        total: records.length,
      });
    },
  );

  // ---- GET /api/v1/agents/:id ----
  app.get<{ Params: { id: string } }>(
    '/api/v1/agents/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const record = await agents.findById(request.params.id);
      if (!record) {
        throw new ApiError('AGENT_NOT_FOUND', `Agent ${request.params.id} does not exist.`, 404, false);
      }
      return reply.status(200).send(serializeAgent(record));
    },
  );

  // ---- POST /api/v1/agents ----
  app.post<{
    Body: {
      id: string;
      config: Record<string, unknown>;
      secrets?: Record<string, string>;
    };
  }>(
    '/api/v1/agents',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['id', 'config'],
          properties: {
            id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', minLength: 1, maxLength: 64 },
            config: { type: 'object' },
            secrets: {
              type: 'object',
              additionalProperties: { type: 'string', minLength: 1 },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { id, config, secrets } = request.body;

      const existing = await agents.findById(id);
      if (existing && existing.active) {
        throw new ApiError(
          'AGENT_EXISTS',
          `Agent "${id}" already exists. Use PUT to update.`,
          409,
          false,
        );
      }

      const vault = secrets ? encryptSecrets(secrets, getMasterKey()) : null;
      const now = new Date().toISOString();

      const record: AgentRecord = {
        id,
        config,
        secretsVault: vault,
        active: true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      await agents.save(record);
      return reply.status(201).send(serializeAgent(record));
    },
  );

  // ---- PUT /api/v1/agents/:id ----
  app.put<{
    Params: { id: string };
    Body: {
      config?: Record<string, unknown>;
      secrets?: Record<string, string>;
      /** When true, secrets replaces the vault entirely; otherwise merges. */
      replaceSecrets?: boolean;
      active?: boolean;
    };
  }>(
    '/api/v1/agents/:id',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          properties: {
            config: { type: 'object' },
            secrets: {
              type: 'object',
              additionalProperties: { type: 'string', minLength: 1 },
            },
            replaceSecrets: { type: 'boolean' },
            active: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const existing = await agents.findById(request.params.id);
      if (!existing) {
        throw new ApiError('AGENT_NOT_FOUND', `Agent ${request.params.id} does not exist.`, 404, false);
      }

      const { config, secrets, replaceSecrets, active } = request.body;
      const masterKey = getMasterKey();

      // Merge-or-replace secrets. When merging, decrypt existing + apply updates + re-encrypt.
      let newVault = existing.secretsVault;
      if (secrets !== undefined) {
        if (replaceSecrets || existing.secretsVault === null) {
          newVault = encryptSecrets(secrets, masterKey);
        } else {
          const current = decryptSecrets(existing.secretsVault, masterKey);
          newVault = encryptSecrets({ ...current, ...secrets }, masterKey);
        }
      }

      const record: AgentRecord = {
        id: existing.id,
        config: config ?? existing.config,
        secretsVault: newVault,
        active: active ?? existing.active,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };

      await agents.save(record);
      return reply.status(200).send(serializeAgent(record));
    },
  );

  // ---- DELETE /api/v1/agents/:id ----
  app.delete<{ Params: { id: string } }>(
    '/api/v1/agents/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const existing = await agents.findById(request.params.id);
      if (!existing) {
        throw new ApiError('AGENT_NOT_FOUND', `Agent ${request.params.id} does not exist.`, 404, false);
      }
      await agents.softDelete(request.params.id);
      return reply.status(204).send();
    },
  );
}
