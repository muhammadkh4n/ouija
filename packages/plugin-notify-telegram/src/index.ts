// ---- Telegram Notification Plugin ----
// Implements NotificationPlugin<TelegramConfig>.
// Zero external SDK dependencies — raw fetch via TelegramClient.

import type {
  NotificationPlugin,
  Notification,
  PluginManifest,
  PluginContext,
  PluginHealth,
} from '@ouija/types';

import type { TelegramConfig } from './config.js';
import { telegramConfigSchema } from './config.js';
import { TelegramClient, TelegramApiError } from './telegram-client.js';
import { formatNotification } from './formatter.js';
import { buildInlineKeyboard } from './keyboard.js';

// ---- Idempotency cache ----

const SENT_CACHE_MAX = 1_000;

// ---- Plugin implementation ----

export class TelegramNotifyPlugin implements NotificationPlugin<TelegramConfig> {
  readonly manifest: PluginManifest = {
    name: '@ouija/plugin-notify-telegram',
    version: '0.1.0',
    type: 'notification',
    coreApiVersion: '>=1.0.0 <2.0.0',
    configSchema: telegramConfigSchema as unknown as Record<string, unknown>,
    events: {
      produces: [],
      consumes: [
        'notification.send',
        'agent.work.completed',
        'agent.work.failed',
        'agent.work.pr_ready',
        'agent.work.stalled',
      ],
    },
  };

  private config!: TelegramConfig;
  private logger!: PluginContext['logger'];
  /** Exposed for testing — allows injecting a mock fetch into the underlying client. */
  client!: TelegramClient;

  /**
   * LRU-ish idempotency cache: idempotencyKey -> true.
   * Prevents duplicate sends on retry within a single process lifetime.
   */
  private readonly sentCache = new Map<string, true>();

  async init(context: PluginContext<TelegramConfig>): Promise<void> {
    // Apply defaults for optional fields that may be absent in the raw config.
    // Spread defaults first so caller-provided values always win.
    const cfg = context.config;
    this.config = {
      parseMode: cfg.parseMode ?? 'HTML',
      disableNotification: cfg.disableNotification ?? false,
      dashboardBaseUrl: cfg.dashboardBaseUrl ?? 'http://localhost:4000',
      botToken: cfg.botToken,
      chatId: cfg.chatId,
    };
    this.logger = context.logger;

    this.client = new TelegramClient(this.config.botToken);

    this.logger.info('Telegram notification plugin initialised', {
      chatId: this.config.chatId,
      parseMode: this.config.parseMode,
    });
  }

  async start(): Promise<void> {
    // Eagerly verify the bot token on startup so misconfiguration surfaces
    // immediately rather than on the first notification attempt.
    const result = await this.testConnection();
    if (!result.ok) {
      this.logger.warn('Telegram bot token verification failed at startup', {
        message: result.message,
      });
    } else {
      this.logger.info('Telegram notification plugin started', { bot: result.message });
    }
  }

  async stop(): Promise<void> {
    this.sentCache.clear();
    this.logger.info('Telegram notification plugin stopped');
  }

  async healthCheck(): Promise<PluginHealth> {
    try {
      const result = await this.testConnection();
      const health: PluginHealth = { healthy: result.ok };
      if (result.message !== undefined) {
        health.message = result.message;
      }
      return health;
    } catch (err) {
      return {
        healthy: false,
        message: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ---- NotificationPlugin ----

  /**
   * Send a notification to the configured Telegram chat.
   * Idempotent on notification.idempotencyKey — duplicate calls are no-ops.
   */
  async send(notification: Notification): Promise<void> {
    if (this.sentCache.has(notification.idempotencyKey)) {
      this.logger.info('Duplicate notification skipped', {
        idempotencyKey: notification.idempotencyKey,
      });
      return;
    }

    const text = formatNotification(notification);
    const keyboard = buildInlineKeyboard(notification.actions);

    const sendOpts: import('./telegram-client.js').SendMessageOptions = {
      parseMode: this.config.parseMode,
      disableNotification: this.config.disableNotification,
    };
    if (keyboard !== undefined) {
      sendOpts.replyMarkup = keyboard;
    }

    await this.client.sendMessage(this.config.chatId, text, sendOpts);

    // Track sent — evict oldest entry when cache is full to bound memory usage.
    if (this.sentCache.size >= SENT_CACHE_MAX) {
      const firstKey = this.sentCache.keys().next().value;
      if (firstKey !== undefined) this.sentCache.delete(firstKey);
    }
    this.sentCache.set(notification.idempotencyKey, true);

    this.logger.info('Notification sent', {
      title: notification.title,
      level: notification.level,
      idempotencyKey: notification.idempotencyKey,
    });
  }

  /**
   * Verify the bot token and channel reachability without sending a message.
   * Calls getMe() which has no side effects.
   */
  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      const user = await this.client.getMe();
      const botName = user.username !== undefined ? `@${user.username}` : user.first_name;
      return { ok: true, message: `Connected as ${botName}` };
    } catch (err) {
      if (err instanceof TelegramApiError) {
        return { ok: false, message: err.description ?? err.message };
      }
      return {
        ok: false,
        message: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

// ---- Plugin factory (consumed by PluginLoader) ----

export const PluginFactory = {
  manifest: new TelegramNotifyPlugin().manifest,
  create: (): TelegramNotifyPlugin => new TelegramNotifyPlugin(),
};

export default PluginFactory;
