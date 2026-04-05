import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FizzyApiClient, FizzyApiError, FizzyRateLimitError } from '../src/api-client.js';

const BASE_URL = 'https://fizzy.example.com';
const TOKEN = 'test-token-123';

describe('FizzyApiClient', () => {
  let client: FizzyApiClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new FizzyApiClient(BASE_URL, TOKEN);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      headers: {
        get: (key: string) => headers?.[key] ?? null,
      },
    } as unknown as Response;
  }

  // ---- Auth header ----

  it('sends Bearer token in Authorization header', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200, []));
    await client.listBoards();
    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('sends Accept: application/json', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200, []));
    await client.listBoards();
    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['Accept']).toBe('application/json');
  });

  // ---- listBoards ----

  it('fetches /boards', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200, [{ id: 1, name: 'Board' }]));
    const boards = await client.listBoards();
    expect(boards).toHaveLength(1);
    expect(boards[0]!.name).toBe('Board');
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE_URL}/boards`);
  });

  // ---- getBoard ----

  it('fetches /boards/:id', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200, { id: 3, name: 'Dev Board' }));
    const board = await client.getBoard(3);
    expect(board.id).toBe(3);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE_URL}/boards/3`);
  });

  // ---- getColumns ----

  it('fetches /boards/:id/columns', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200, [
      { id: 5, name: 'In Progress', color: 'red', created_at: '2026-01-01T00:00:00Z' },
    ]));
    const cols = await client.getColumns(3);
    expect(cols).toHaveLength(1);
    expect(cols[0]!.name).toBe('In Progress');
  });

  // ---- getCard ----

  it('fetches /cards/:id', async () => {
    const card = {
      id: 42, number: 7, title: 'Test', status: 'published',
      description: 'desc', description_html: '<p>desc</p>',
      tags: [], column: null, board: { id: 3, name: 'Board' },
      creator: { id: 1, name: 'Admin', email_address: 'a@b.com' },
      assignees: [], created_at: '2026-01-01T00:00:00Z', url: '/cards/42',
    };
    fetchSpy.mockResolvedValue(mockResponse(200, card));
    const result = await client.getCard(42);
    expect(result.id).toBe(42);
    expect(result.title).toBe('Test');
  });

  // ---- triageCard ----

  it('posts to /cards/:id/triages with column_id', async () => {
    fetchSpy.mockResolvedValue(mockResponse(204, ''));
    await client.triageCard(42, 5);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE_URL}/cards/42/triages`);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ column_id: 5 });
  });

  // ---- closeCard ----

  it('posts to /cards/:id/closures', async () => {
    fetchSpy.mockResolvedValue(mockResponse(204, ''));
    await client.closeCard(42);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE_URL}/cards/42/closures`);
  });

  // ---- reopenCard ----

  it('deletes /cards/:id/closures', async () => {
    fetchSpy.mockResolvedValue(mockResponse(204, ''));
    await client.reopenCard(42);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE_URL}/cards/42/closures`);
    expect(fetchSpy.mock.calls[0]![1]!.method).toBe('DELETE');
  });

  // ---- addComment ----

  it('posts to /cards/:id/comments', async () => {
    fetchSpy.mockResolvedValue(mockResponse(201, { id: 1, body: { plain_text: 'hi', html: '<p>hi</p>' } }));
    await client.addComment(42, 'hi');
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ body: 'hi' });
  });

  // ---- assignUser ----

  it('posts to /cards/:id/assignments with assignee_id', async () => {
    fetchSpy.mockResolvedValue(mockResponse(204, ''));
    await client.assignUser(42, 10);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ assignee_id: 10 });
  });

  // ---- createWebhook ----

  it('posts to /boards/:id/webhooks', async () => {
    fetchSpy.mockResolvedValue(mockResponse(201, {
      id: 1, name: 'ouija', url: 'https://ouija.dev/hooks/fizzy/secret',
      signing_secret: 'abc', active: true, subscribed_actions: ['card_triaged'],
    }));
    const wh = await client.createWebhook(3, 'ouija', 'https://ouija.dev/hooks/fizzy/secret', ['card_triaged']);
    expect(wh.name).toBe('ouija');
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE_URL}/boards/3/webhooks`);
  });

  // ---- ping ----

  it('calls /boards for connectivity check', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200, []));
    await client.ping();
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE_URL}/boards`);
  });

  // ---- Error handling ----

  it('throws FizzyRateLimitError on 429', async () => {
    fetchSpy.mockResolvedValue(mockResponse(429, 'Too many requests', { 'Retry-After': '30' }));
    await expect(client.listBoards()).rejects.toThrow(FizzyRateLimitError);
    await expect(client.listBoards()).rejects.toMatchObject({ retryAfter: 30 });
  });

  it('throws FizzyApiError on 404', async () => {
    fetchSpy.mockResolvedValue(mockResponse(404, 'Not found'));
    await expect(client.getCard(999)).rejects.toThrow(FizzyApiError);
    await expect(client.getCard(999)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws FizzyApiError on 500', async () => {
    fetchSpy.mockResolvedValue(mockResponse(500, 'Internal Server Error'));
    await expect(client.listBoards()).rejects.toThrow(FizzyApiError);
  });

  // ---- URL normalization ----

  it('strips trailing slash from baseUrl', async () => {
    const c = new FizzyApiClient('https://fizzy.example.com/', TOKEN);
    fetchSpy.mockResolvedValue(mockResponse(200, []));
    await c.listBoards();
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://fizzy.example.com/boards');
  });
});
