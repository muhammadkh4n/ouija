import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TelegramClient,
  TelegramApiError,
  TelegramRateLimitError,
} from '../src/telegram-client.js';

// ---- Helpers ----

function makeJsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeMockFetch(response: Response) {
  return vi.fn().mockResolvedValue(response);
}

// ---- Tests ----

describe('TelegramClient.getMe()', () => {
  it('calls the correct URL with GET', async () => {
    const mockFetch = makeMockFetch(
      makeJsonResponse({ ok: true, result: { id: 1, is_bot: true, first_name: 'OuijaBot', username: 'ouija_bot' } }),
    );
    const client = new TelegramClient('test-token');
    client._fetchFn = mockFetch;

    const user = await client.getMe();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/bottest-token/getMe');
    expect(opts?.method).toBe('GET');
    expect(user.username).toBe('ouija_bot');
  });

  it('throws TelegramApiError on ok=false', async () => {
    const client = new TelegramClient('bad-token');
    client._fetchFn = makeMockFetch(
      makeJsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }),
    );

    await expect(client.getMe()).rejects.toThrow(TelegramApiError);
    await expect(client.getMe()).rejects.toThrow('Unauthorized');
  });
});

describe('TelegramClient.sendMessage()', () => {
  let client: TelegramClient;

  beforeEach(() => {
    client = new TelegramClient('bot-token');
  });

  it('sends POST to sendMessage endpoint with required params', async () => {
    const mockFetch = makeMockFetch(
      makeJsonResponse({ ok: true, result: { message_id: 1, date: 1234567890, text: 'hello' } }),
    );
    client._fetchFn = mockFetch;

    await client.sendMessage('123456', 'hello');

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    expect(opts?.method).toBe('POST');

    const body = JSON.parse(opts?.body as string);
    expect(body.chat_id).toBe('123456');
    expect(body.text).toBe('hello');
  });

  it('includes parse_mode when specified', async () => {
    const mockFetch = makeMockFetch(
      makeJsonResponse({ ok: true, result: { message_id: 2, date: 0 } }),
    );
    client._fetchFn = mockFetch;

    await client.sendMessage('123', 'hi', { parseMode: 'HTML' });

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(body.parse_mode).toBe('HTML');
  });

  it('includes disable_notification when true', async () => {
    const mockFetch = makeMockFetch(
      makeJsonResponse({ ok: true, result: { message_id: 3, date: 0 } }),
    );
    client._fetchFn = mockFetch;

    await client.sendMessage('123', 'silent', { disableNotification: true });

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(body.disable_notification).toBe(true);
  });

  it('does not include disable_notification when false', async () => {
    const mockFetch = makeMockFetch(
      makeJsonResponse({ ok: true, result: { message_id: 4, date: 0 } }),
    );
    client._fetchFn = mockFetch;

    await client.sendMessage('123', 'loud', { disableNotification: false });

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(body.disable_notification).toBeUndefined();
  });

  it('includes JSON-stringified reply_markup when keyboard provided', async () => {
    const mockFetch = makeMockFetch(
      makeJsonResponse({ ok: true, result: { message_id: 5, date: 0 } }),
    );
    client._fetchFn = mockFetch;

    const keyboard = {
      inline_keyboard: [[{ text: 'View PR', url: 'https://github.com/org/repo/pull/1' }]],
    };

    await client.sendMessage('123', 'PR ready', { replyMarkup: keyboard });

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(body.reply_markup).toBeDefined();
    const parsedKeyboard = JSON.parse(body.reply_markup);
    expect(parsedKeyboard.inline_keyboard[0][0].text).toBe('View PR');
  });

  it('throws TelegramApiError on API failure', async () => {
    client._fetchFn = makeMockFetch(
      makeJsonResponse({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
    );

    await expect(client.sendMessage('bad-chat', 'hi')).rejects.toThrow(TelegramApiError);
    await expect(client.sendMessage('bad-chat', 'hi')).rejects.toThrow('chat not found');
  });

  it('throws TelegramRateLimitError on 429 response', async () => {
    client._fetchFn = makeMockFetch(
      makeJsonResponse(
        { ok: false, description: 'Too Many Requests: retry after 1' },
        429,
        { 'retry-after': '2' },
      ),
    );

    let thrown: unknown;
    try {
      await client.sendMessage('123', 'hi');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TelegramRateLimitError);
    expect((thrown as TelegramRateLimitError).retryAfterMs).toBe(2000);
  });

  it('TelegramApiError has errorCode and description fields', async () => {
    client._fetchFn = makeMockFetch(
      makeJsonResponse({ ok: false, error_code: 403, description: 'Forbidden: bot was kicked' }),
    );

    let thrown: unknown;
    try {
      await client.sendMessage('123', 'hi');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TelegramApiError);
    expect((thrown as TelegramApiError).errorCode).toBe(403);
    expect((thrown as TelegramApiError).description).toBe('Forbidden: bot was kicked');
  });

  it('propagates network errors (fetch rejection) as-is', async () => {
    client._fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(client.sendMessage('123', 'hi')).rejects.toThrow('ECONNREFUSED');
  });
});
