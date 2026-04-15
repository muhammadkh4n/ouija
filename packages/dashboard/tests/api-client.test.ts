/**
 * API client tests. Runs in Node with a stubbed `fetch` and a minimal
 * localStorage polyfill, so it doesn't need jsdom or happy-dom.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- Minimal browser globals stub ----

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
});

// Import after the window stub so module-level localStorage access works.
const {
  ApiError,
  getApiKey,
  setApiKey,
  listBoards,
  listPipelines,
} = await import('../src/lib/api-client.js');

describe('getApiKey / setApiKey', () => {
  it('round-trips a token through localStorage', () => {
    setApiKey('ouija_abc');
    expect(getApiKey()).toBe('ouija_abc');
  });

  it('clears the token when given null', () => {
    setApiKey('ouija_abc');
    setApiKey(null);
    expect(getApiKey()).toBeNull();
  });

  it('returns null when nothing has been set', () => {
    expect(getApiKey()).toBeNull();
  });
});

describe('listBoards', () => {
  it('injects the bearer header and returns parsed JSON', async () => {
    setApiKey('ouija_test');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listBoards();
    expect(result).toEqual({ items: [], total: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/boards');
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer ouija_test');
  });

  it('omits the header when no token is stored', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"items":[],"total":0}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await listBoards();
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBeNull();
  });
});

describe('error handling', () => {
  it('throws ApiError with structured code/message from the body', async () => {
    setApiKey('ouija_test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'PIPELINE_NOT_FOUND', message: 'no such pipeline' },
          }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      ),
    );

    await expect(listPipelines('b1')).rejects.toMatchObject({
      status: 404,
      code: 'PIPELINE_NOT_FOUND',
      message: 'no such pipeline',
    });
  });

  it('throws ApiError with statusText when body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('oops', { status: 500, statusText: 'Server Error' }),
      ),
    );

    const err = await listPipelines('b1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(500);
  });
});
