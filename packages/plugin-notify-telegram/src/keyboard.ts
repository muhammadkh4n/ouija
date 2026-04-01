// ---- Inline keyboard builder for Telegram notifications ----

import type { NotificationAction } from '@ouija/types';
import type { TelegramInlineKeyboard, TelegramInlineButton } from './telegram-client.js';

export type { TelegramInlineKeyboard, TelegramInlineButton };

/**
 * Build a Telegram inline keyboard from Notification actions.
 * Each action becomes a single-button row (max 3 rows for mobile readability).
 *
 * Returns undefined when there are no actions — caller omits reply_markup.
 */
export function buildInlineKeyboard(
  actions: NotificationAction[] | undefined,
): TelegramInlineKeyboard | undefined {
  if (actions === undefined || actions.length === 0) return undefined;

  // Cap at 3 rows to keep the message mobile-friendly
  const rows = actions.slice(0, 3).map((action): TelegramInlineButton[] => [
    { text: action.label, url: action.url },
  ]);

  return { inline_keyboard: rows };
}
