/**
 * Formats a Notification into the markdown body that gets stored in Engram.
 *
 * Shape: a short structured header (title, level, when) + the raw body +
 * any action links. Pure function — no I/O, fully testable.
 */

import type { Notification } from '@ouija-dev/types';

export function formatMemory(notification: Notification): string {
  const lines: string[] = [];

  // Headline — Engram's salience classifier scans the first line hardest.
  lines.push(`# Ouija: ${notification.title}`);
  lines.push('');
  lines.push(`**Level:** ${notification.level}`);
  lines.push(`**When:** ${notification.occurredAt}`);
  lines.push('');

  // Body — preserved verbatim. Callers pre-format via the notification body.
  lines.push(notification.body.trim());

  if (notification.actions !== undefined && notification.actions.length > 0) {
    lines.push('');
    lines.push('**Links:**');
    for (const action of notification.actions) {
      lines.push(`- [${action.label}](${action.url})`);
    }
  }

  // Trailing idempotency marker — helps Engram dedup pick up near-duplicates
  // if two different Ouija processes ingest the same event.
  lines.push('');
  lines.push(`<!-- ouija:${notification.idempotencyKey} -->`);

  return lines.join('\n');
}
