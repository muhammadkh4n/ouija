/**
 * Client-side SSE consumer for /api/v1/pipelines/:id/stream.
 *
 * EventSource can't set custom headers, so the stream is driven by fetch()
 * with a ReadableStream reader. The parser tolerates frames split across
 * chunks and skips SSE comment lines ("`: ping`").
 *
 * Reconnection: a single reconnect with 1.5s backoff on transport error.
 * Anything worse bubbles to `onError` so the caller can fall back to
 * polling — which PipelineDetail already runs for in-flight pipelines.
 */

import { getApiKey } from './api-client.js';

export interface StreamFrame {
  readonly event: string;
  readonly data: unknown;
}

export interface StreamOptions {
  onFrame: (frame: StreamFrame) => void;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
}

const RECONNECT_DELAY_MS = 1500;

export function streamPipelineEvents(
  instanceId: string,
  opts: StreamOptions,
): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (stopped) return;

    controller = new AbortController();
    const apiKey = getApiKey();
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
    };
    if (apiKey !== null) headers['Authorization'] = `Bearer ${apiKey}`;

    fetch(`/api/v1/pipelines/${encodeURIComponent(instanceId)}/stream`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`stream failed: ${response.status} ${response.statusText}`);
        }
        if (!response.body) {
          throw new Error('stream has no body');
        }

        opts.onOpen?.();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (chunk.startsWith(':') || chunk.trim() === '') continue;

            let event = 'message';
            let dataRaw = '';
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7).trim();
              else if (line.startsWith('data: ')) dataRaw += line.slice(6);
            }

            let data: unknown;
            try {
              data = dataRaw.length > 0 ? JSON.parse(dataRaw) : null;
            } catch {
              data = dataRaw;
            }
            opts.onFrame({ event, data });
          }
        }
      })
      .catch((err: unknown) => {
        if (stopped) return;
        // AbortError from our own stop() — treat as clean close.
        if (err instanceof DOMException && err.name === 'AbortError') return;

        opts.onError?.(err);
        // Single reconnect attempt so a transient disconnect (server
        // restart, network blip) resumes streaming without user action.
        reconnectTimer = setTimeout(() => {
          if (!stopped) connect();
        }, RECONNECT_DELAY_MS);
      });
  };

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    controller?.abort();
  };
}
