/**
 * heartbeat.test.ts
 *
 * Tests for HeartbeatReporter.
 *
 * All HTTP calls are replaced by vi.fn() via the _fetchFn injection point —
 * no real network traffic is produced.
 *
 * Test matrix:
 *  - Correct request shape (URL, method, headers, body) for each payload type
 *  - JWT refresh: if the server returns { token: "new-jwt" }, it is stored
 *    and used for the next call
 *  - Error propagation on non-2xx responses
 *  - Interval management: startInterval / stopInterval
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeartbeatReporter } from '../src/heartbeat.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CALLBACK_URL = 'http://localhost:4000/hooks/agent/callback';
const INITIAL_TOKEN = 'jwt-initial-token';
const INSTANCE_ID = 'inst-abc123';
const DISPATCH_ID = 'disp-xyz789';

function makeOkFetch(body: unknown = { ok: true }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

function makeErrorFetch(status = 401) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ ok: false }),
  });
}

function makeReporter(fetchFn = makeOkFetch()) {
  const reporter = new HeartbeatReporter(
    CALLBACK_URL,
    INITIAL_TOKEN,
    INSTANCE_ID,
    DISPATCH_ID,
    fetchFn,
  );
  return reporter;
}

function lastCallBody(fetchFn: ReturnType<typeof vi.fn>): unknown {
  const lastCall = fetchFn.mock.calls[fetchFn.mock.calls.length - 1];
  if (!lastCall) throw new Error('No calls recorded');
  const [, options] = lastCall as [string, RequestInit];
  return JSON.parse(options.body as string);
}

function lastCallHeaders(fetchFn: ReturnType<typeof vi.fn>): Record<string, string> {
  const lastCall = fetchFn.mock.calls[fetchFn.mock.calls.length - 1];
  if (!lastCall) throw new Error('No calls recorded');
  const [, options] = lastCall as [string, RequestInit];
  return options.headers as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HeartbeatReporter', () => {
  describe('reportProgress()', () => {
    it('POSTs to the callback URL', async () => {
      const fetchFn = makeOkFetch();
      const reporter = makeReporter(fetchFn);

      await reporter.reportProgress('Cloning repository...');

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url] = fetchFn.mock.calls[0] as [string];
      expect(url).toBe(CALLBACK_URL);
    });

    it('sends correct payload shape', async () => {
      const fetchFn = makeOkFetch();
      const reporter = makeReporter(fetchFn);

      await reporter.reportProgress('Working on feature', 42);

      const body = lastCallBody(fetchFn) as Record<string, unknown>;
      expect(body['type']).toBe('agent_progress');
      expect(body['instanceId']).toBe(INSTANCE_ID);
      expect(body['dispatchId']).toBe(DISPATCH_ID);
      expect(body['message']).toBe('Working on feature');
      expect(body['progress']).toBe(42);
    });

    it('omits progress field when not provided', async () => {
      const fetchFn = makeOkFetch();
      const reporter = makeReporter(fetchFn);

      await reporter.reportProgress('No progress number');

      const body = lastCallBody(fetchFn) as Record<string, unknown>;
      expect(body['progress']).toBeUndefined();
    });

    it('sends Authorization header with Bearer token', async () => {
      const fetchFn = makeOkFetch();
      const reporter = makeReporter(fetchFn);

      await reporter.reportProgress('msg');

      const headers = lastCallHeaders(fetchFn);
      expect(headers['Authorization']).toBe(`Bearer ${INITIAL_TOKEN}`);
    });
  });

  describe('reportPrReady()', () => {
    it('sends agent_pr_ready payload', async () => {
      const fetchFn = makeOkFetch();
      const reporter = makeReporter(fetchFn);

      await reporter.reportPrReady('https://github.com/org/repo/pull/42', 'pr-42');

      const body = lastCallBody(fetchFn) as Record<string, unknown>;
      expect(body['type']).toBe('agent_pr_ready');
      expect(body['prUrl']).toBe('https://github.com/org/repo/pull/42');
      expect(body['prId']).toBe('pr-42');
    });
  });

  describe('reportCompleted()', () => {
    it('sends agent_completed payload', async () => {
      const fetchFn = makeOkFetch();
      const reporter = makeReporter(fetchFn);

      await reporter.reportCompleted();

      const body = lastCallBody(fetchFn) as Record<string, unknown>;
      expect(body['type']).toBe('agent_completed');
      expect(body['instanceId']).toBe(INSTANCE_ID);
      expect(body['dispatchId']).toBe(DISPATCH_ID);
    });
  });

  describe('reportFailed()', () => {
    it('sends agent_failed payload with error and retryable flag', async () => {
      const fetchFn = makeOkFetch();
      const reporter = makeReporter(fetchFn);

      await reporter.reportFailed('git clone failed: ECONNREFUSED', true);

      const body = lastCallBody(fetchFn) as Record<string, unknown>;
      expect(body['type']).toBe('agent_failed');
      expect(body['error']).toBe('git clone failed: ECONNREFUSED');
      expect(body['retryable']).toBe(true);
    });

    it('respects retryable=false', async () => {
      const fetchFn = makeOkFetch();
      const reporter = makeReporter(fetchFn);

      await reporter.reportFailed('Fatal error', false);

      const body = lastCallBody(fetchFn) as Record<string, unknown>;
      expect(body['retryable']).toBe(false);
    });
  });

  describe('JWT refresh', () => {
    it('updates the current token when server returns a new one', async () => {
      const fetchFn = makeOkFetch({ ok: true, token: 'jwt-refreshed-token' });
      const reporter = makeReporter(fetchFn);

      expect(reporter.token).toBe(INITIAL_TOKEN);
      await reporter.reportProgress('msg');
      expect(reporter.token).toBe('jwt-refreshed-token');
    });

    it('uses the refreshed token on the next call', async () => {
      // First call returns a new token
      const fetchFn = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, token: 'jwt-second-token' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        });

      const reporter = makeReporter(fetchFn);
      await reporter.reportProgress('first call');
      await reporter.reportProgress('second call');

      // Second call should use the refreshed token
      const secondHeaders = fetchFn.mock.calls[1]?.[1] as RequestInit;
      const authHeader = (secondHeaders?.headers as Record<string, string>)?.['Authorization'];
      expect(authHeader).toBe('Bearer jwt-second-token');
    });

    it('keeps the original token when server does not return one', async () => {
      const fetchFn = makeOkFetch({ ok: true }); // no token field
      const reporter = makeReporter(fetchFn);

      await reporter.reportProgress('msg');
      expect(reporter.token).toBe(INITIAL_TOKEN);
    });
  });

  describe('error handling', () => {
    it('throws when server returns non-2xx status', async () => {
      const reporter = makeReporter(makeErrorFetch(401));

      await expect(reporter.reportProgress('msg')).rejects.toThrow('HTTP 401');
    });

    it('propagates network errors', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const reporter = makeReporter(fetchFn);

      await expect(reporter.reportProgress('msg')).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('interval management', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('fires heartbeats at the specified interval', async () => {
      const fetchFn = makeOkFetch();
      const reporter = makeReporter(fetchFn);

      reporter.startInterval(30_000);

      // Advance time by 90 s — expect 3 heartbeats
      await vi.advanceTimersByTimeAsync(90_000);
      reporter.stopInterval();

      expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('stops firing after stopInterval()', async () => {
      const fetchFn = makeOkFetch();
      const reporter = makeReporter(fetchFn);

      reporter.startInterval(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      reporter.stopInterval();

      // Advance more time — no additional calls
      await vi.advanceTimersByTimeAsync(60_000);

      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('calling startInterval twice replaces the old interval', async () => {
      const fetchFn = makeOkFetch();
      const reporter = makeReporter(fetchFn);

      reporter.startInterval(30_000);
      reporter.startInterval(30_000); // Replace — should not double-fire

      await vi.advanceTimersByTimeAsync(90_000);
      reporter.stopInterval();

      expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('swallows heartbeat errors to keep the interval running', async () => {
      // First two calls fail, third succeeds
      const fetchFn = vi.fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        });

      const reporter = makeReporter(fetchFn);
      reporter.startInterval(30_000);

      // Should not throw even though first two calls fail
      await vi.advanceTimersByTimeAsync(90_000);
      reporter.stopInterval();

      expect(fetchFn).toHaveBeenCalledTimes(3);
    });
  });
});
