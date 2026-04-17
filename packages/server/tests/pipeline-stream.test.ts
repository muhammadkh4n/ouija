/**
 * Integration test for GET /api/v1/pipelines/:id/stream.
 *
 * Fastify's inject() buffers the full response before returning, which
 * doesn't work for long-lived SSE. These tests therefore bind the app
 * to an ephemeral port and drive it with real fetch().
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { LiveEventBus } from '../src/live-events.js';
import type {
  Database,
  PipelineInstance,
  PipelineRepository,
  PipelineEventRepository,
  BoardConfigRepository,
  DeduplicationRepository,
  OuijaEvent,
} from '@ouija-dev/types';
import {
  instanceId as makeInstanceId,
  cardId as makeCardId,
  boardId as makeBoardId,
} from '@ouija-dev/types';

const INSTANCE_ID = 'inst-sse-001';
const MISSING_ID = 'inst-sse-missing';
const API_KEY = 'ouija_test_key_for_sse_integration';

// ---- Minimal DB stub ----

function makeStubDb(): Database {
  const instance: PipelineInstance = {
    id: makeInstanceId(INSTANCE_ID),
    cardId: makeCardId('card-1'),
    boardId: makeBoardId('board-1'),
    projectId: null,
    attempt: 1,
    state: { status: 'running', dispatchId: 'disp-1' as never },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as PipelineInstance;

  const pipelines: PipelineRepository = {
    async findById(id) {
      return String(id) === INSTANCE_ID ? instance : undefined;
    },
    async findByCardId() {
      return undefined;
    },
    async listByBoard() {
      return { items: [] } as never;
    },
    async save() {
      /* noop */
    },
    async delete() {
      /* noop */
    },
    async findStalledCandidates() {
      return [];
    },
  };

  const pipelineEvents: PipelineEventRepository = {
    async append() {},
    async appendMany() {},
    async listByInstance() {
      return [];
    },
  };

  const boardConfigs: BoardConfigRepository = {
    async findByBoardId() {
      return undefined;
    },
    async listAll() {
      return [];
    },
    async save() {},
    async delete() {},
  };

  const deduplication: DeduplicationRepository = {
    async isDuplicate() {
      return false;
    },
    async markProcessed() {},
    async purgeExpired() {
      return 0;
    },
  };

  return {
    pipelines,
    pipelineEvents,
    boardConfigs,
    deduplication,
    ping: async () => {},
    transaction: async (fn) =>
      fn({
        pipelines,
        pipelineEvents,
        boardConfigs,
        deduplication,
      } as never),
  } as Database;
}

// ---- Shared setup ----

let app: FastifyInstance;
let liveEvents: LiveEventBus;
let baseUrl = '';

beforeAll(async () => {
  process.env['OUIJA_SECRET_KEY'] = 'test-secret-key-at-least-32-chars-long!';
  process.env['OUIJA_API_KEY'] = API_KEY;

  liveEvents = new LiveEventBus();
  app = await buildApp({
    logger: false,
    db: makeStubDb(),
    liveEvents,
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = typeof address === 'string' ? address : `http://127.0.0.1:${(address as { port: number }).port}`;
});

afterAll(async () => {
  await app.close();
});

// ---- Helpers ----

interface SseFrame {
  event: string;
  data: string;
}

async function openStream(
  id: string,
  apiKey: string = API_KEY,
): Promise<{
  response: Response;
  frames: SseFrame[];
  close: () => void;
  waitForEvent: (event: string, timeoutMs?: number) => Promise<SseFrame>;
}> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/v1/pipelines/${id}/stream`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: controller.signal,
  });

  const frames: SseFrame[] = [];
  const waiters = new Map<string, (frame: SseFrame) => void>();
  let done = false;

  // Stream consumer — runs in the background.
  if (response.ok && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    (async () => {
      let buffer = '';
      try {
        while (!done) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            // Skip SSE comment lines (": ...")
            if (chunk.startsWith(':')) continue;
            const lines = chunk.split('\n');
            let event = 'message';
            let data = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            const frame = { event, data };
            frames.push(frame);
            const waiter = waiters.get(event);
            if (waiter) {
              waiters.delete(event);
              waiter(frame);
            }
          }
        }
      } catch {
        // aborted or connection closed
      }
    })();
  }

  return {
    response,
    frames,
    close: () => {
      done = true;
      controller.abort();
    },
    waitForEvent: (event, timeoutMs = 2000) =>
      new Promise<SseFrame>((resolve, reject) => {
        const existing = frames.find((f) => f.event === event);
        if (existing) return resolve(existing);
        const timer = setTimeout(
          () => reject(new Error(`Timeout waiting for event: ${event}`)),
          timeoutMs,
        );
        waiters.set(event, (f) => {
          clearTimeout(timer);
          resolve(f);
        });
      }),
  };
}

function progressEvent(iid: string): OuijaEvent<'agent.work.progress'> {
  return {
    id: `evt-${Date.now()}`,
    topic: 'agent.work.progress',
    payload: {
      instanceId: iid as never,
      dispatchId: 'disp-1' as never,
      progress: 50,
      message: 'hello from the agent',
    },
    timestamp: new Date().toISOString(),
    sourcePlugin: 'test',
    correlationId: 'corr-1',
  };
}

// ---- Tests ----

describe('GET /api/v1/pipelines/:id/stream', () => {
  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/api/v1/pipelines/${INSTANCE_ID}/stream`);
    expect(res.status).toBe(401);
    // Drain body so fetch doesn't keep the socket alive.
    await res.text();
  });

  it('returns 404 for an unknown pipeline id', async () => {
    const res = await fetch(`${baseUrl}/api/v1/pipelines/${MISSING_ID}/stream`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(404);
    await res.text();
  });

  it('emits a "ready" handshake frame on connect', async () => {
    const stream = await openStream(INSTANCE_ID);
    try {
      const ready = await stream.waitForEvent('ready');
      const parsed = JSON.parse(ready.data) as { instanceId: string; status: string };
      expect(parsed.instanceId).toBe(INSTANCE_ID);
      expect(parsed.status).toBe('running');
    } finally {
      stream.close();
    }
  });

  it('forwards live events scoped to the requested instance', async () => {
    const stream = await openStream(INSTANCE_ID);
    try {
      await stream.waitForEvent('ready');

      // Fire a matching event — should surface as a frame.
      liveEvents.emit(INSTANCE_ID, {
        topic: 'agent.work.progress',
        event: progressEvent(INSTANCE_ID),
      });

      const frame = await stream.waitForEvent('agent.work.progress');
      const parsed = JSON.parse(frame.data) as {
        topic: string;
        payload: { progress: number; message: string };
      };
      expect(parsed.topic).toBe('agent.work.progress');
      expect(parsed.payload.progress).toBe(50);
      expect(parsed.payload.message).toBe('hello from the agent');
    } finally {
      stream.close();
    }
  });

  it('does not leak events from other instances', async () => {
    const stream = await openStream(INSTANCE_ID);
    try {
      await stream.waitForEvent('ready');

      // Fire an event for a different instance — must not appear.
      liveEvents.emit('some-other-instance', {
        topic: 'agent.work.progress',
        event: progressEvent('some-other-instance'),
      });

      // Also fire a matching one so we have something to wait on.
      liveEvents.emit(INSTANCE_ID, {
        topic: 'agent.work.progress',
        event: progressEvent(INSTANCE_ID),
      });
      await stream.waitForEvent('agent.work.progress');

      const foreign = stream.frames.find((f) => {
        if (f.event !== 'agent.work.progress') return false;
        const p = JSON.parse(f.data) as { payload: { instanceId: string } };
        return p.payload.instanceId === 'some-other-instance';
      });
      expect(foreign).toBeUndefined();
    } finally {
      stream.close();
    }
  });

  it('sets SSE content-type and disables proxy buffering', async () => {
    const stream = await openStream(INSTANCE_ID);
    try {
      expect(stream.response.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(stream.response.headers.get('x-accel-buffering')).toBe('no');
    } finally {
      stream.close();
    }
  });
});
