// ---- Plane webhook normalization ----
// Converts raw Plane webhook payloads into typed OuijaEvents.
//
// Plane's webhook schema (as of Plane ~0.23):
//   event:      "issue_activity"
//   data:       full issue snapshot at time of event
//   activity:   the specific change that triggered this webhook
//     .field:   "state" | "assignees" | "name" | "comment" | ...
//
// We only care about:
//   field === "state"     → kanban.card.moved
//   field === "assignees" → kanban.card.assigned
// Everything else returns null.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { cardId, columnId } from '@ouija/types';
import type {
  OuijaEvent,
  KanbanCardMovedPayload,
  KanbanCardAssignedPayload,
  KanbanCard,
} from '@ouija/types';
import { boardId as mkBoardId } from '@ouija/types';

// ---- Raw Plane webhook shape ----

interface PlaneWebhookActivityDetail {
  id: string;
  email?: string;
  display_name?: string;
}

interface PlaneWebhookActivity {
  id: string;
  verb: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  old_identifier: string | null;
  new_identifier: string | null;
  actor_detail: PlaneWebhookActivityDetail;
  created_at: string;
}

interface PlaneWebhookIssueData {
  id: string;
  name: string;
  description_html: string;
  state: string;
  state_detail?: {
    id: string;
    name: string;
    color: string;
    group: string;
    sequence: number;
  };
  project: string;
  workspace: string;
  label_details: Array<{ id: string; name: string }>;
  assignee_details: Array<{ id: string; email: string; display_name: string }>;
  created_at: string;
  updated_at: string;
}

interface PlaneWebhookPayload {
  event: string;
  identifier: string;
  activity_id: string;
  data: PlaneWebhookIssueData;
  activity: PlaneWebhookActivity;
  webhook_id: string;
  workspace_id: string;
  project_id: string;
  timestamp: string;
}

// ---- Type guard ----

function isPlaneWebhookPayload(raw: unknown): raw is PlaneWebhookPayload {
  if (typeof raw !== 'object' || raw === null) return false;
  const p = raw as Record<string, unknown>;

  if (
    typeof p['event'] !== 'string' ||
    typeof p['data'] !== 'object' ||
    p['data'] === null ||
    typeof p['activity'] !== 'object' ||
    p['activity'] === null ||
    typeof p['project_id'] !== 'string' ||
    typeof p['workspace_id'] !== 'string'
  ) {
    return false;
  }

  const data = p['data'] as Record<string, unknown>;
  if (typeof data['id'] !== 'string' || typeof data['state'] !== 'string') {
    return false;
  }

  const activity = p['activity'] as Record<string, unknown>;
  if (typeof activity['field'] !== 'string') {
    return false;
  }

  return true;
}

// ---- Normalize issue data → KanbanCard ----

function toKanbanCard(
  data: PlaneWebhookIssueData,
  workspaceSlug: string,
  baseUrl: string,
): KanbanCard {
  return {
    id: cardId(data.id),
    title: data.name,
    description: data.description_html,
    columnId: columnId(data.state),
    boardId: mkBoardId(data.project),
    labels: data.label_details.map((l) => l.name),
    assignees: data.assignee_details.map((a) => a.id),
    url: `${baseUrl.replace(/\/$/, '')}/${workspaceSlug}/projects/${data.project}/issues/${data.id}`,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

// ---- Normalized result type ----

export type NormalizedWebhookEvent =
  | OuijaEvent<'kanban.card.moved'>
  | OuijaEvent<'kanban.card.assigned'>
  | null;

// ---- Main normalization function ----

/**
 * Parse and normalize a raw Plane webhook payload.
 *
 * Returns:
 *  - OuijaEvent<'kanban.card.moved'>    when field === "state"
 *  - OuijaEvent<'kanban.card.assigned'> when field === "assignees"
 *  - null for all other activity types or on any parse error
 *
 * This function never throws — all errors are swallowed and return null.
 * Callers must not rely on thrown errors for control flow.
 */
export function normalizeWebhook(
  raw: unknown,
  sourcePlugin = '@ouija/plugin-plane',
  baseUrl = '',
): NormalizedWebhookEvent {
  try {
    if (!isPlaneWebhookPayload(raw)) {
      return null;
    }

    const payload = raw;
    const { data, activity } = payload;

    // Only handle issue_activity events.
    if (payload.event !== 'issue_activity') {
      return null;
    }

    const workspaceSlug = data.workspace ?? '';
    const eventId = activity.id;
    const timestamp = activity.created_at ?? payload.timestamp ?? new Date().toISOString();

    if (activity.field === 'state') {
      // State change → card moved.
      const fromColumnId = activity.old_value ?? activity.old_identifier;
      const toColumnId = activity.new_value ?? activity.new_identifier ?? data.state;

      if (!fromColumnId || !toColumnId) {
        return null;
      }

      const movedByDetail = activity.actor_detail;
      const movedBy = movedByDetail.email ?? movedByDetail.id ?? 'unknown';

      const cardMovedPayload: KanbanCardMovedPayload = {
        cardId: cardId(data.id),
        fromColumnId: columnId(fromColumnId),
        toColumnId: columnId(toColumnId),
        movedBy,
      };

      const event: OuijaEvent<'kanban.card.moved'> = {
        id: eventId,
        topic: 'kanban.card.moved',
        payload: cardMovedPayload,
        timestamp,
        sourcePlugin,
        correlationId: payload.activity_id,
      };

      return event;
    }

    if (activity.field === 'assignees') {
      // Assignee change → card assigned.
      // new_identifier holds the newly-added assignee member ID.
      const assigneeId = activity.new_identifier ?? activity.new_value;

      if (!assigneeId) {
        // Unassignment — we don't emit an event for that.
        return null;
      }

      const actorDetail = activity.actor_detail;
      const assignedBy = actorDetail.email ?? actorDetail.id ?? 'unknown';

      const cardAssignedPayload: KanbanCardAssignedPayload = {
        cardId: cardId(data.id),
        assigneeId,
        assignedBy,
      };

      const event: OuijaEvent<'kanban.card.assigned'> = {
        id: eventId,
        topic: 'kanban.card.assigned',
        payload: cardAssignedPayload,
        timestamp,
        sourcePlugin,
        correlationId: payload.activity_id,
      };

      return event;
    }

    // Unrecognised activity field (comment, name change, etc.) — ignore.
    return null;
  } catch {
    // Never propagate parse errors to callers.
    return null;
  }
}

// ---- HMAC signature verification ----

/**
 * Verify the Plane webhook HMAC-SHA256 signature.
 *
 * Plane sends: X-Plane-Signature: sha256=<hex-digest>
 *
 * @param secret      The webhook secret configured in Plane
 * @param rawBody     The raw request body bytes (Buffer or string)
 * @param sigHeader   The value of X-Plane-Signature header
 * @returns           true if valid, false if invalid or missing
 */
export function verifyPlaneSignature(
  secret: string,
  rawBody: Buffer | string,
  sigHeader: string | undefined,
): boolean {
  if (!sigHeader) return false;

  const prefix = 'sha256=';
  if (!sigHeader.startsWith(prefix)) return false;

  const receivedHex = sigHeader.slice(prefix.length);

  const bodyBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', secret).update(bodyBuffer).digest('hex');

  // Constant-time comparison to prevent timing attacks.
  try {
    const expectedBuf = Buffer.from(expected, 'hex');
    const receivedBuf = Buffer.from(receivedHex, 'hex');

    if (expectedBuf.length !== receivedBuf.length) return false;

    return timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

// ---- Timestamp freshness check ----

/**
 * Reject webhooks older than maxAgeMs (default 5 minutes).
 * Plane includes a top-level `timestamp` field in ISO 8601 format.
 *
 * @returns true if the timestamp is within the allowed window, false otherwise
 */
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

// Re-export KanbanCard helper for consumers.
export { toKanbanCard };
