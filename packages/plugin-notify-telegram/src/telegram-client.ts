// ---- Raw Telegram Bot API client ----
// No SDK dependency. Uses global fetch (Node 18+).

// ---- Telegram API response types ----

export interface TelegramResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
}

export interface TelegramInlineButton {
  text: string;
  url: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}

export interface SendMessageOptions {
  parseMode?: 'HTML' | 'MarkdownV2';
  disableNotification?: boolean;
  replyMarkup?: TelegramInlineKeyboard;
}

// ---- Rate limiting ----
// Telegram allows 30 messages/second to the same chat.
// We enforce a minimum 34ms gap between sends to the same chat to stay safely
// within that limit, and add a short sleep when we receive a 429.

const MIN_INTERVAL_MS = 34; // ~29 msg/sec, comfortably under the 30/sec limit

// ---- Error classes ----

export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: number,
    public readonly description?: string,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export class TelegramRateLimitError extends TelegramApiError {
  constructor(
    public readonly retryAfterMs: number,
  ) {
    super(`Rate limited — retry after ${retryAfterMs}ms`, 429, 'Too Many Requests');
    this.name = 'TelegramRateLimitError';
  }
}

// ---- Client ----

export class TelegramClient {
  private readonly baseUrl: string;
  private lastSendTimes = new Map<string, number>();

  /** Override for testing — allows injecting a mock fetch. */
  _fetchFn: typeof fetch = globalThis.fetch.bind(globalThis);

  constructor(private readonly botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  /**
   * Call a Telegram Bot API method.
   * Handles 429 rate limit errors and surfaces typed errors.
   */
  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/${method}`;

    // Build RequestInit carefully to satisfy exactOptionalPropertyTypes — no
    // undefined values in the object literal where the type expects absence.
    const init: RequestInit =
      body !== undefined
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : { method: 'GET' };

    const response = await this._fetchFn(url, init);

    // Handle Telegram's 429 before parsing JSON — it always includes Retry-After
    if (response.status === 429) {
      const retryAfterSec = parseInt(response.headers.get('Retry-After') ?? '1', 10);
      const retryAfterMs = retryAfterSec * 1000;
      throw new TelegramRateLimitError(retryAfterMs);
    }

    const result = (await response.json()) as TelegramResponse<T>;

    if (!result.ok) {
      throw new TelegramApiError(
        `Telegram API error [${method}]: ${result.description ?? 'Unknown error'}`,
        result.error_code,
        result.description,
      );
    }

    return result.result as T;
  }

  /**
   * Send a text message to a chat.
   * Enforces per-chat rate limiting (30 msg/sec).
   */
  async sendMessage(
    chatId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<TelegramMessage> {
    await this.enforceRateLimit(chatId);

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };

    if (options?.parseMode !== undefined) {
      body['parse_mode'] = options.parseMode;
    }

    if (options?.disableNotification === true) {
      body['disable_notification'] = true;
    }

    if (options?.replyMarkup !== undefined) {
      body['reply_markup'] = JSON.stringify(options.replyMarkup);
    }

    const message = await this.call<TelegramMessage>('sendMessage', body);
    this.lastSendTimes.set(chatId, Date.now());
    return message;
  }

  /**
   * Call getMe to verify the bot token and retrieve bot info.
   * Used as a health check — no side effects.
   */
  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe');
  }

  /**
   * Enforce per-chat rate limit: >= MIN_INTERVAL_MS between sends.
   * Sleeps only the remaining time if a send happened recently.
   */
  private async enforceRateLimit(chatId: string): Promise<void> {
    const last = this.lastSendTimes.get(chatId);
    if (last !== undefined) {
      const elapsed = Date.now() - last;
      if (elapsed < MIN_INTERVAL_MS) {
        await sleep(MIN_INTERVAL_MS - elapsed);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
