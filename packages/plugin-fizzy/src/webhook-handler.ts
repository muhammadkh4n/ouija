// ---- Fizzy webhook normalization ----
// Converts raw Fizzy webhook payloads into typed OuijaEvents.
//
// Fizzy webhook format:
//   id:         string (event ID)
//   action:     "card_triaged" | "card_assigned" | "card_closed" | etc.
//   created_at: ISO 8601 timestamp
//   eventable:  full card or comment object
//   board:      { id, name }
//   creator:    { id, name, email_address }
//
// We care about:
//   card_triaged          → kanban.card.moved
//   card_assigned         → kanban.card.assigned
//   card_closed           → kanban.card.moved (to virtual "closed" column)
//   card_sent_back_to_triage → kanban.card.moved (to virtual "triage" column)
// Everything else returns null.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { cardId, columnId } from '@ouija/types';
import type {
  OuijaEvent,
  KanbanCardMovedPayload,
  KanbanCardAssignedPayload,
} from '@ouija/types';

// ---- Raw Fizzy webhook shape ----

interface FizzyWebhookUser {
  id: number;
  name: string;
  email_address?: string;
}

interface FizzyWebhookColumn {
  id: number;
  name: string;
  color?: string;
}

interface FizzyWebhookCard {
  id: number;
  number: number;
  title: string;
  column: FizzyWebhookColumn | null;
  assignees: FizzyWebhookUser[];
  board?: { id: number; name: string };
  tags?: string[];
}

interface FizzyWebhookPayload {
  id: string;
  action: string;
  created_at: string;
  eventable: FizzyWebhookCard;
  board: { id: number; name: string };
  creator: FizzyWebhookUser;
}

// ---- Type guard ----

function isFizzyWebhookPayload(raw: unknown): raw is FizzyWebhookPayload {
  if (typeof raw !== 'object' || raw === null) return false;
  const p = raw as Record<string, unknown>;

  if (typeof p['id'] !== 'string') return false;
  if (typeof p['action'] !== 'string') return false;
  if (typeof p['created_at'] !== 'string') return false;
  if (typeof p['eventable'] !== 'object' || p['eventable'] === null) return false;
  if (typeof p['board'] !== 'object' || p['board'] === null) return false;
  if (typeof p['creator'] !== 'object' || p['creator'] === null) return false;

  const eventable = p['eventable'] as Record<string, unknown>;
  if (typeof eventable['id'] !== 'number') return false;

  return true;
}

// ---- Normalized result type ----

export type NormalizedWebhookEvent =
  | OuijaEvent<'kanban.card.moved'>
  | OuijaEvent<'kanban.card.assigned'>
  | null;

// ---- Main normalization function ----

export function normalizeFizzyWebhook(
  raw: unknown,
  sourcePlugin = '@ouija/plugin-fizzy',
): NormalizedWebhookEvent {
  try {
    if (!isFizzyWebhookPayload(raw)) {
      return null;
    }

    const { id: eventId, action, created_at, eventable, creator } = raw;
    const cardIdStr = String(eventable.id);
    const creatorName = creator.email_address ?? creator.name ?? 'fizzy-webhook';

    if (action === 'card_triaged') {
      if (!eventable.column) return null;

      const payload: KanbanCardMovedPayload = {
        cardId: cardId(cardIdStr),
        fromColumnId: columnId('0'),
        toColumnId: columnId(String(eventable.column.id)),
        movedBy: creatorName,
      };

      return {
        id: eventId,
        topic: 'kanban.card.moved',
        payload,
        timestamp: created_at,
        sourcePlugin,
        correlationId: eventId,
      };
    }

    if (action === 'card_assigned') {
      const lastAssignee = eventable.assignees[eventable.assignees.length - 1];
      if (!lastAssignee) return null;

      const payload: KanbanCardAssignedPayload = {
        cardId: cardId(cardIdStr),
        assigneeId: String(lastAssignee.id),
        assignedBy: creatorName,
      };

      return {
        id: eventId,
        topic: 'kanban.card.assigned',
        payload,
        timestamp: created_at,
        sourcePlugin,
        correlationId: eventId,
      };
    }

    if (action === 'card_closed') {
      const payload: KanbanCardMovedPayload = {
        cardId: cardId(cardIdStr),
        fromColumnId: columnId(eventable.column ? String(eventable.column.id) : '0'),
        toColumnId: columnId('closed'),
        movedBy: creatorName,
      };

      return {
        id: eventId,
        topic: 'kanban.card.moved',
        payload,
        timestamp: created_at,
        sourcePlugin,
        correlationId: eventId,
      };
    }

    if (action === 'card_sent_back_to_triage') {
      const payload: KanbanCardMovedPayload = {
        cardId: cardId(cardIdStr),
        fromColumnId: columnId(eventable.column ? String(eventable.column.id) : '0'),
        toColumnId: columnId('0'),
        movedBy: creatorName,
      };

      return {
        id: eventId,
        topic: 'kanban.card.moved',
        payload,
        timestamp: created_at,
        sourcePlugin,
        correlationId: eventId,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ---- HMAC signature verification ----

/**
 * Verify Fizzy webhook HMAC-SHA256 signature.
 *
 * Fizzy sends: X-Webhook-Signature: <hex-digest> (no prefix)
 */
export function verifyFizzySignature(
  secret: string,
  rawBody: Buffer | string,
  sigHeader: string | undefined,
): boolean {
  if (!sigHeader) return false;

  const bodyBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', secret).update(bodyBuffer).digest('hex');

  try {
    const expectedBuf = Buffer.from(expected, 'hex');
    const receivedBuf = Buffer.from(sigHeader, 'hex');

    if (expectedBuf.length !== receivedBuf.length) return false;

    return timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

// ---- Timestamp freshness check ----

export function isWebhookFresh(
  timestamp: string | undefined,
  nowMs = Date.now(),
  maxAgeMs = 5 * 60 * 1000,
): boolean {
  if (!timestamp) return false;

  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) return false;

  return Math.abs(nowMs - ts) <= maxAgeMs;
}
