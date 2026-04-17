/**
 * Tests for the SSE consumer in src/lib/pipeline-stream.ts.
 *
 * Exercises the frame parser across chunk boundaries, comment skipping,
 * auth header propagation, clean teardown via the returned disposer, and
 * the single-shot reconnect on transport error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- Browser globals stub ----

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  (globalThis as Record<string, unknown>)['window'] = {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['window'];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const { streamPipelineEvents } = await import('../src/lib/pipeline-stream.js');
const { setApiKey } = await import('../src/lib/api-client.js');

// ---- Helpers ----

/** Build a Response whose body streams chunks on demand. */
function makeScriptedResponse(chunks: readonly string[], status = 200): {
  response: Response;
  push: (chunk: string) => void;
  end: () => void;
  error: (err: Error) => void;
  signalReceived: () => AbortSignal | null;
} {
  let signal: AbortSignal | null = null;
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
    },
  });

  const response = new Response(body, { status });

  return {
    response,
    push: (chunk: string) => controllerRef?.enqueue(encoder.encode(chunk)),
    end: () => controllerRef?.close(),
    error: (err: Error) => controllerRef?.error(err),
    signalReceived: () => signal,
  };
}

function stubFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return impl(url, init);
    }),
  );
  return { calls };
}

// ---- Tests ----

describe('streamPipelineEvents — frame parsing', () => {
  it('parses a single complete frame', async () => {
    const scripted = makeScriptedResponse([
      'event: ready\ndata: {"instanceId":"inst-1"}\n\n',
    ]);
    stubFetch(async () => {
      scripted.end();
      return scripted.response;
    });

    const frames: Array<{ event: string; data: unknown }> = [];
    const stop = streamPipelineEvents('inst-1', {
      onFrame: (f) => frames.push(f),
    });

    await vi.waitFor(() => expect(frames.length).toBe(1), 500);
    expect(frames[0]?.event).toBe('ready');
    expect(frames[0]?.data).toEqual({ instanceId: 'inst-1' });

    stop();
  });

  it('reassembles frames split across chunk boundaries', async () => {
    const scripted = makeScriptedResponse([
      'event: agent.work.progress\n',
      'data: {"topic":"agent.work.progress","payload":{"progress":20}}',
      '\n\n',
    ]);
    stubFetch(async () => {
      scripted.end();
      return scripted.response;
    });

    const frames: Array<{ event: string; data: unknown }> = [];
    const stop = streamPipelineEvents('inst-1', {
      onFrame: (f) => frames.push(f),
    });

    await vi.waitFor(() => expect(frames.length).toBe(1), 500);
    expect(frames[0]?.event).toBe('agent.work.progress');
    expect(frames[0]?.data).toEqual({
      topic: 'agent.work.progress',
      payload: { progress: 20 },
    });

    stop();
  });

  it('skips SSE comment lines (heartbeats)', async () => {
    const scripted = makeScriptedResponse([
      ': ping\n\n',
      'event: ready\ndata: {}\n\n',
      ': ping\n\n',
    ]);
    stubFetch(async () => {
      scripted.end();
      return scripted.response;
    });

    const frames: Array<{ event: string; data: unknown }> = [];
    const stop = streamPipelineEvents('inst-1', {
      onFrame: (f) => frames.push(f),
    });

    await vi.waitFor(() => expect(frames.length).toBe(1), 500);
    expect(frames[0]?.event).toBe('ready');

    stop();
  });

  it('falls back to raw string data when JSON parse fails', async () => {
    const scripted = makeScriptedResponse([
      'event: note\ndata: not-json\n\n',
    ]);
    stubFetch(async () => {
      scripted.end();
      return scripted.response;
    });

    const frames: Array<{ event: string; data: unknown }> = [];
    const stop = streamPipelineEvents('inst-1', {
      onFrame: (f) => frames.push(f),
    });

    await vi.waitFor(() => expect(frames.length).toBe(1), 500);
    expect(frames[0]?.data).toBe('not-json');

    stop();
  });
});

describe('streamPipelineEvents — auth + lifecycle', () => {
  it('sends the stored API key as a Bearer header', async () => {
    setApiKey('ouija_live_stream_key');

    const scripted = makeScriptedResponse(['event: ready\ndata: {}\n\n']);
    const tracker = stubFetch(async () => {
      scripted.end();
      return scripted.response;
    });

    const stop = streamPipelineEvents('inst-7', { onFrame: () => undefined });
    await vi.waitFor(() => expect(tracker.calls.length).toBe(1), 500);

    const init = tracker.calls[0]?.init ?? {};
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer ouija_live_stream_key');
    expect(headers['Accept']).toBe('text/event-stream');
    expect(tracker.calls[0]?.url).toBe('/api/v1/pipelines/inst-7/stream');

    stop();
  });

  it('fires onOpen when the request resolves successfully', async () => {
    const scripted = makeScriptedResponse(['event: ready\ndata: {}\n\n']);
    stubFetch(async () => {
      scripted.end();
      return scripted.response;
    });

    const onOpen = vi.fn();
    const stop = streamPipelineEvents('inst-1', {
      onFrame: () => undefined,
      onOpen,
    });

    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1), 500);
    stop();
  });

  it('aborts the fetch when the returned disposer is called', async () => {
    const abortSpy = vi.fn();

    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        init.signal?.addEventListener('abort', abortSpy);
        // Promise that resolves only when aborted.
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(
              Object.assign(new Error('aborted'), {
                name: 'AbortError',
              }),
            ),
          );
        });
      }),
    );

    const stop = streamPipelineEvents('inst-1', { onFrame: () => undefined });
    stop();

    await vi.waitFor(() => expect(abortSpy).toHaveBeenCalledTimes(1), 500);
  });

  it('does not reconnect after the disposer is called', async () => {
    const tracker = stubFetch(async () => {
      throw new Error('boom');
    });

    const stop = streamPipelineEvents('inst-1', {
      onFrame: () => undefined,
      onError: () => undefined,
    });

    // Let the first fetch fail and the reconnect timer be scheduled.
    await vi.waitFor(() => expect(tracker.calls.length).toBe(1), 500);
    stop();

    // 2s later, the reconnect timer would have fired. It must not.
    await new Promise((r) => setTimeout(r, 2000));
    expect(tracker.calls.length).toBe(1);
  });

  it('reports non-2xx responses via onError', async () => {
    stubFetch(async () => new Response('nope', { status: 404 }));

    const onError = vi.fn();
    const stop = streamPipelineEvents('inst-1', {
      onFrame: () => undefined,
      onError,
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalled(), 500);
    stop();
  });
});
