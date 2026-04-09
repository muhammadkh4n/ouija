/**
 * Agent callback endpoint: POST /hooks/agent/callback
 *
 * Agents POST here to report progress, completion, failure, or PR readiness.
 * Auth: JWT in Authorization header (NOT in URL — tokens in URLs leak via logs).
 *
 * Flow:
 *   1. Extract Bearer JWT from Authorization header
 *   2. Verify JWT (signature + expiry + denylist)
 *   3. Validate instanceId in JWT matches payload
 *   4. Route to correct event type and publish to orchestrator
 *   5. If JWT has < 5 min remaining on a progress call: include refreshed token in response
 *
 * Callback payload types (spec §5.2, agent.work.* events):
 *   - agent_acknowledged: agent received work order
 *   - agent_progress: heartbeat + progress message
 *   - agent_pr_ready: PR opened, includes prUrl + prId
 *   - agent_completed: work done, optional cost/tokensUsed
 *   - agent_failed: terminal failure, error + retryable flag
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { OuijaEvent } from '@ouija-dev/types';
import {
  instanceId as makeInstanceId,
  dispatchId as makeDispatchId,
  prId as makePrId,
} from '@ouija-dev/types';
import { ApiError } from '@ouija-dev/types';
import type { Orchestrator } from '@ouija-dev/engine';
import {
  verifyAgentJWT,
  refreshAgentJWT,
  getRemainingSeconds,
  REFRESH_THRESHOLD_SECS,
} from '../jwt.js';

// ---- Request body shapes ----

interface AgentCallbackBody {
  type: 'agent_acknowledged' | 'agent_progress' | 'agent_pr_ready' | 'agent_completed' | 'agent_failed';
  instanceId: string;
  dispatchId: string;
  // agent_progress fields
  progress?: number;
  message?: string;
  // agent_pr_ready fields
  prUrl?: string;
  prId?: string;
  // agent_completed fields
  cost?: number;
  tokensUsed?: number;
  // agent_failed fields
  error?: string;
  retryable?: boolean;
}

export interface AgentCallbackRouteOptions {
  orchestrator: Orchestrator;
}

// ---- Route ----

export async function agentCallbackRoutes(
  app: FastifyInstance,
  opts: AgentCallbackRouteOptions,
): Promise<void> {
  app.post<{ Body: AgentCallbackBody }>(
    '/hooks/agent/callback',
    {
      schema: {
        body: {
          type: 'object',
          required: ['type', 'instanceId', 'dispatchId'],
          properties: {
            type: {
              type: 'string',
              enum: [
                'agent_acknowledged',
                'agent_progress',
                'agent_pr_ready',
                'agent_completed',
                'agent_failed',
              ],
            },
            instanceId: { type: 'string', minLength: 1 },
            dispatchId: { type: 'string', minLength: 1 },
            progress: { type: 'number', minimum: 0, maximum: 100 },
            message: { type: 'string' },
            prUrl: { type: 'string' },
            prId: { type: 'string' },
            cost: { type: 'number', minimum: 0 },
            tokensUsed: { type: 'number', minimum: 0 },
            error: { type: 'string' },
            retryable: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request: FastifyRequest<{ Body: AgentCallbackBody }>, reply: FastifyReply) => {
      // 1. Extract JWT from Authorization header
      const authHeader = request.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        throw new ApiError('UNAUTHORIZED', 'Agent JWT required in Authorization header.', 401);
      }
      const token = authHeader.slice(7);

      // 2. Verify JWT (throws on invalid/expired/revoked)
      let claims;
      try {
        claims = await verifyAgentJWT(token);
      } catch (err) {
        throw new ApiError(
          'UNAUTHORIZED',
          `Invalid agent JWT: ${err instanceof Error ? err.message : String(err)}`,
          401,
        );
      }

      // 3. Validate instanceId in JWT matches payload
      const body = request.body;
      if (claims.instanceId !== body.instanceId) {
        throw new ApiError(
          'UNAUTHORIZED',
          'JWT instanceId does not match payload instanceId.',
          403,
        );
      }

      // 4. Build and publish OuijaEvent
      const event = buildAgentEvent(body);
      if (!event) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `Unknown agent callback type: ${body.type}`,
          400,
        );
      }

      // Fire-and-forget — callback should return quickly; orchestrator processes async
      opts.orchestrator.processTrigger(event).catch((err) => {
        request.log.error({ err, instanceId: body.instanceId }, 'agent-callback: orchestrator error');
      });

      // 5. Check if JWT needs refresh (< 5 min remaining on progress calls)
      const remainingSecs = getRemainingSeconds(claims);
      let refreshedToken: string | undefined;

      if (
        body.type === 'agent_progress' &&
        remainingSecs > 0 &&
        remainingSecs < REFRESH_THRESHOLD_SECS
      ) {
        try {
          const newToken = await refreshAgentJWT(token);
          refreshedToken = newToken ?? undefined;
        } catch (err) {
          request.log.warn({ err }, 'agent-callback: JWT refresh failed');
        }
      }

      return reply.status(200).send({
        ok: true,
        ...(refreshedToken !== undefined ? { refreshedToken } : {}),
      });
    },
  );
}

// ---- Event builder ----

function buildAgentEvent(body: AgentCallbackBody): OuijaEvent | null {
  const baseFields = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    sourcePlugin: 'agent-callback',
    correlationId: randomUUID(),
  } as const;

  const instanceId = makeInstanceId(body.instanceId);
  const dispatchIdVal = makeDispatchId(body.dispatchId);

  switch (body.type) {
    case 'agent_acknowledged':
      // agent_acknowledged maps to agent_progress with 0% — publish as progress event
      return {
        ...baseFields,
        topic: 'agent.work.progress',
        payload: {
          instanceId,
          dispatchId: dispatchIdVal,
          progress: 0,
          message: 'Agent acknowledged work order.',
        },
      };

    case 'agent_progress':
      return {
        ...baseFields,
        topic: 'agent.work.progress',
        payload: {
          instanceId,
          dispatchId: dispatchIdVal,
          progress: body.progress ?? 0,
          message: body.message ?? '',
        },
      };

    case 'agent_pr_ready':
      if (!body.prUrl || !body.prId) return null;
      return {
        ...baseFields,
        topic: 'agent.work.pr_ready',
        payload: {
          instanceId,
          dispatchId: dispatchIdVal,
          prUrl: body.prUrl,
          prId: makePrId(body.prId),
        },
      };

    case 'agent_completed':
      return {
        ...baseFields,
        topic: 'agent.work.completed',
        payload: {
          instanceId,
          dispatchId: dispatchIdVal,
          ...(body.cost !== undefined ? { cost: body.cost } : {}),
          ...(body.tokensUsed !== undefined ? { tokensUsed: body.tokensUsed } : {}),
        },
      };

    case 'agent_failed':
      if (!body.error) return null;
      return {
        ...baseFields,
        topic: 'agent.work.failed',
        payload: {
          instanceId,
          dispatchId: dispatchIdVal,
          error: body.error,
          retryable: body.retryable ?? false,
        },
      };

    default:
      return null;
  }
}
