import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramNotifyPlugin, PluginFactory } from '../src/index.js';
import { createMockContext } from '@ouija/plugin-sdk';
import type { Notification } from '@ouija/types';

// ---- Test helpers ----

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    title: 'Pipeline Dispatched',
    body: 'Agent dispatched for card OUIJA-42',
    level: 'info',
    occurredAt: new Date().toISOString(),
    idempotencyKey: `test-${Date.now()}-${Math.random()}`,
    ...overrides,
  };
}

/**
 * Create a mock fetch that returns a successful Telegram API response.
 * Optionally override the response body.
 */
function makeMockFetch(responseBody: unknown = { ok: true, result: { message_id: 1, date: 0 } }) {
  return vi.fn().mockResolvedValue({
    status: 200,
    headers: { get: () => null },
    json: async () => responseBody,
  });
}

// ---- Tests ----

describe('TelegramNotifyPlugin', () => {
  let plugin: TelegramNotifyPlugin;

  beforeEach(async () => {
    plugin = new TelegramNotifyPlugin();
    const ctx = createMockContext({
      botToken: 'test-bot-token',
      chatId: '123456789',
      parseMode: 'HTML',
      disableNotification: false,
      dashboardBaseUrl: 'http://localhost:4000',
    });
    await plugin.init(ctx);
    // init() creates the TelegramClient — safe to set _fetchFn now.
    // Individual tests override this per-test as needed.
  });

  // ---- manifest ----

  describe('manifest', () => {
    it('has correct plugin name', () => {
      expect(plugin.manifest.name).toBe('@ouija/plugin-notify-telegram');
    });

    it('has notification type', () => {
      expect(plugin.manifest.type).toBe('notification');
    });

    it('consumes notification.send event', () => {
      expect(plugin.manifest.events?.consumes).toContain('notification.send');
    });
  });

  // ---- send() ----

  describe('send()', () => {
    it('calls Telegram sendMessage API with correct params', async () => {
      const mockFetch = makeMockFetch();
      plugin.client._fetchFn = mockFetch;

      const notification = makeNotification();
      await plugin.send(notification);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.telegram.org/bottest-bot-token/sendMessage');
      expect(opts?.method).toBe('POST');

      const body = JSON.parse(opts?.body as string);
      expect(body.chat_id).toBe('123456789');
      expect(body.parse_mode).toBe('HTML');
      expect(body.text).toContain('Pipeline Dispatched');
    });

    it('includes inline keyboard when actions are present', async () => {
      const mockFetch = makeMockFetch();
      plugin.client._fetchFn = mockFetch;

      const notification = makeNotification({
        actions: [
          { label: 'View Pipeline', url: 'http://localhost:4000/pipelines/abc' },
        ],
      });
      await plugin.send(notification);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
      expect(body.reply_markup).toBeDefined();
      const keyboard = JSON.parse(body.reply_markup);
      expect(keyboard.inline_keyboard[0][0].text).toBe('View Pipeline');
      expect(keyboard.inline_keyboard[0][0].url).toBe('http://localhost:4000/pipelines/abc');
    });

    it('does not include reply_markup when no actions', async () => {
      const mockFetch = makeMockFetch();
      plugin.client._fetchFn = mockFetch;

      await plugin.send(makeNotification());

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
      expect(body.reply_markup).toBeUndefined();
    });

    it('skips duplicate sends — idempotency on idempotencyKey', async () => {
      const mockFetch = makeMockFetch();
      plugin.client._fetchFn = mockFetch;

      const notification = makeNotification({ idempotencyKey: 'dedup-key-1' });
      await plugin.send(notification);
      await plugin.send(notification);
      await plugin.send(notification);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('sends different notifications with different keys', async () => {
      const mockFetch = makeMockFetch();
      plugin.client._fetchFn = mockFetch;

      await plugin.send(makeNotification({ idempotencyKey: 'key-a' }));
      await plugin.send(makeNotification({ idempotencyKey: 'key-b' }));

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws on Telegram API error', async () => {
      plugin.client._fetchFn = makeMockFetch({ ok: false, error_code: 400, description: 'Bot token invalid' });

      await expect(plugin.send(makeNotification())).rejects.toThrow('Bot token invalid');
    });

    it('logs info after successful send', async () => {
      // Access the mock logger via context — need a fresh plugin to capture logger
      const freshPlugin = new TelegramNotifyPlugin();
      const ctx = createMockContext({
        botToken: 'test-token',
        chatId: '999',
        parseMode: 'HTML' as const,
        disableNotification: false,
        dashboardBaseUrl: 'http://localhost:4000',
      });
      await freshPlugin.init(ctx);
      freshPlugin.client._fetchFn = makeMockFetch();

      await freshPlugin.send(makeNotification({ title: 'Test Alert' }));

      const infoLogs = ctx.logger.entriesAt('info');
      expect(infoLogs.some((e) => e.msg === 'Notification sent')).toBe(true);
    });
  });

  // ---- testConnection() ----

  describe('testConnection()', () => {
    it('returns ok=true and bot name when getMe succeeds', async () => {
      plugin.client._fetchFn = makeMockFetch({
        ok: true,
        result: { id: 1, is_bot: true, first_name: 'OuijaBot', username: 'ouija_bot' },
      });

      const result = await plugin.testConnection();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('ouija_bot');
    });

    it('returns ok=false with description on API failure', async () => {
      plugin.client._fetchFn = makeMockFetch({
        ok: false,
        error_code: 401,
        description: 'Unauthorized',
      });

      const result = await plugin.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('Unauthorized');
    });

    it('returns ok=false on network error', async () => {
      plugin.client._fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await plugin.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('ECONNREFUSED');
    });

    it('uses first_name when username is absent', async () => {
      plugin.client._fetchFn = makeMockFetch({
        ok: true,
        result: { id: 1, is_bot: true, first_name: 'OuijaBot' },
      });

      const result = await plugin.testConnection();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('OuijaBot');
    });
  });

  // ---- healthCheck() ----

  describe('healthCheck()', () => {
    it('returns healthy=true when testConnection succeeds', async () => {
      plugin.client._fetchFn = makeMockFetch({
        ok: true,
        result: { id: 1, is_bot: true, first_name: 'OuijaBot', username: 'ouija_bot' },
      });

      const health = await plugin.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('returns healthy=false when testConnection fails', async () => {
      plugin.client._fetchFn = makeMockFetch({
        ok: false,
        error_code: 401,
        description: 'Unauthorized',
      });

      const health = await plugin.healthCheck();
      expect(health.healthy).toBe(false);
    });
  });

  // ---- stop() ----

  describe('stop()', () => {
    it('clears the idempotency cache', async () => {
      const mockFetch = makeMockFetch();
      plugin.client._fetchFn = mockFetch;

      const notification = makeNotification({ idempotencyKey: 'cache-clear-test' });
      await plugin.send(notification);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await plugin.stop();

      // After stop, same key should be sent again
      plugin.client._fetchFn = makeMockFetch();
      await plugin.send(notification);
      expect(plugin.client._fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  // ---- PluginFactory ----

  describe('PluginFactory', () => {
    it('has the correct manifest name', () => {
      expect(PluginFactory.manifest.name).toBe('@ouija/plugin-notify-telegram');
    });

    it('create() returns a TelegramNotifyPlugin instance', () => {
      const instance = PluginFactory.create();
      expect(instance).toBeInstanceOf(TelegramNotifyPlugin);
    });

    it('create() returns a new instance each time', () => {
      const a = PluginFactory.create();
      const b = PluginFactory.create();
      expect(a).not.toBe(b);
    });
  });
});
