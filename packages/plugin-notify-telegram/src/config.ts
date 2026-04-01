// ---- Telegram plugin configuration ----

export interface TelegramConfig {
  /** Telegram Bot API token (from BotFather) */
  botToken: string;
  /** Telegram chat ID to send notifications to (MK's personal chat) */
  chatId: string;
  /** HTML or MarkdownV2. Defaults to HTML — simpler escaping rules. */
  parseMode: 'HTML' | 'MarkdownV2';
  /** When true, messages are delivered silently (no phone notification) */
  disableNotification: boolean;
  /** Base URL for deep links back to Ouija dashboard */
  dashboardBaseUrl: string;
}

/**
 * JSON Schema for Ajv validation at plugin load time.
 * Matches TelegramConfig shape exactly.
 */
export const telegramConfigSchema = {
  type: 'object',
  required: ['botToken', 'chatId'],
  properties: {
    botToken: {
      type: 'string',
      minLength: 1,
      description: 'Telegram Bot API token (from BotFather)',
    },
    chatId: {
      type: 'string',
      minLength: 1,
      description: 'Target chat ID for notifications',
    },
    parseMode: {
      type: 'string',
      enum: ['HTML', 'MarkdownV2'],
      default: 'HTML',
      description: 'Telegram message parse mode',
    },
    disableNotification: {
      type: 'boolean',
      default: false,
      description: 'Send messages silently without phone notification',
    },
    dashboardBaseUrl: {
      type: 'string',
      default: 'http://localhost:4000',
      description: 'Base URL for dashboard deep links',
    },
  },
  additionalProperties: false,
} as const;
