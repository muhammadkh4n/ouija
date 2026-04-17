/**
 * Server-Sent Events stream for a single pipeline instance.
 *
 * GET /api/v1/pipelines/:id/stream
 *
 * Emits each forwarded OuijaEvent scoped to the given instanceId as an SSE
 * frame. Auth is Bearer/Cookie (shared with the REST surface) — EventSource
 * can't send custom headers, so the client uses fetch + ReadableStream.
 *
 * Frame shape:
 *   event: <topic>
 *   id: <ouija event id>
 *   data: <JSON-encoded { topic, payload, timestamp, sequence? }>
 *
 * A comment heartbeat (": ping\n\n") is written every 15s so intermediaries
 * don't drop idle connections.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '@ouija-dev/types';
import { ApiError } from '@ouija-dev/types';
import { instanceId as makeInstanceId } from '@ouija-dev/types';
import { requireAuth } from '../middleware/auth.js';
import type { LiveEventBus } from '../live-events.js';

const HEARTBEAT_MS = 15_000;

export interface PipelineStreamRouteOptions {
  db: Database;
  live: LiveEventBus;
}

export async function pipelineStreamRoutes(
  app: FastifyInstance,
  opts: PipelineStreamRouteOptions,
): Promise<void> {
  const { db, live } = opts;

  app.get<{ Params: { id: string } }>(
    '/api/v1/pipelines/:id/stream',
    { preHandler: requireAuth },
    async (request, reply) => {
      const instanceId = makeInstanceId(request.params.id);

      // 404 if the pipeline doesn't exist — consistent with GET /:id.
      const instance = await db.pipelines.findById(instanceId);
      if (!instance) {
        throw new ApiError(
          'PIPELINE_NOT_FOUND',
          `Pipeline ${request.params.id} does not exist.`,
          404,
          false,
        );
      }

      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Disable proxy buffering (nginx / fly edge) so frames flush immediately.
        'X-Accel-Buffering': 'no',
      });
      raw.flushHeaders?.();

      // Initial handshake frame — gives the client a deterministic
      // "connected" signal and the current pipeline status so it can
      // seed its UI without waiting for the next update.
      writeFrame(raw, 'ready', {
        instanceId: String(instanceId),
        status: instance.state.status,
        attempt: instance.attempt,
        serverTime: new Date().toISOString(),
      });

      const heartbeat = setInterval(() => {
        try {
          raw.write(': ping\n\n');
        } catch {
          // Write-after-close — cleanup handled by the 'close' listener.
        }
      }, HEARTBEAT_MS);
      // Don't block the event loop on shutdown if the client lingers.
      heartbeat.unref?.();

      const unsubscribe = live.subscribe(String(instanceId), (liveEvent) => {
        try {
          writeFrame(raw, liveEvent.topic, {
            id: liveEvent.event.id,
            topic: liveEvent.topic,
            payload: liveEvent.event.payload,
            timestamp: liveEvent.event.timestamp,
          });
        } catch (err) {
          app.log.warn({ err, instanceId: String(instanceId) }, 'SSE write failed');
        }
      });

      const cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);

      // Returning the raw response tells Fastify we're handling the lifecycle.
      return reply;
    },
  );
}

function writeFrame(
  raw: import('node:http').ServerResponse,
  event: string,
  data: unknown,
): void {
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
}
