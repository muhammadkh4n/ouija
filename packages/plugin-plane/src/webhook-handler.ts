// ---- Plane webhook normalization ----
// Converts raw Plane webhook payloads into typed OuijaEvents.
//
// Plane Community Edition webhook format:
//   event:      "issue" (not "issue_activity")
//   action:     "created" | "updated" | "deleted"
//   data:       full issue snapshot (state is an object {id, name, group}, not a string)
//   activity:   the specific change
//     .field:   "state_id" | "assignees" | ... (note: "state_id", not "state")
//     .actor:   {id, first_name, last_name, email, display_name}
//
// We only care about:
//   field === "state_id" or field === "state" → kanban.card.moved
//   field === "assignees"                     → kanban.card.assigned
// Everything else returns null.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { cardId, columnId } from '@ouija-dev/types';
import type {
  OuijaEvent,
  KanbanCardMovedPayload,
  KanbanCardAssignedPayload,
  KanbanCard,
} from '@ouija-dev/types';
import { boardId as mkBoardId } from '@ouija-dev/types';

// ---- Raw Plane webhook shape ----

interface PlaneWebhookActivityActor {
  id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  display_name?: string;
}

interface PlaneWebhookActivity {
  field: string;
  old_value: string | null;
  new_value: string | null;
  old_identifier: string | null;
  new_identifier: string | null;
  // Community edition uses "actor", older versions use "actor_detail"
  actor?: PlaneWebhookActivityActor;
  actor_detail?: PlaneWebhookActivityActor;
  // Older format fields
  id?: string;
  verb?: string;
  created_at?: string;
}

interface PlaneWebhookIssueData {
  id: string;
  name: string;
  description_html: string;
  // Community edition: state is an object { id, name, color, group }
  // Older versions: state is a string (UUID)
  state: string | { id: string; name: string; color?: string; group?: string };
  project: string;
  workspace: string;
  // Community edition uses "labels" and "assignees"
  labels?: Array<{ id: string; name: string }>;
  assignees?: Array<{ id: string; email?: string; display_name?: string }>;
  // Older versions use "label_details" and "assignee_details"
  label_details?: Array<{ id: string; name: string }>;
  assignee_details?: Array<{ id: string; email: string; display_name: string }>;
  created_at: string;
  updated_at: string;
}

interface PlaneWebhookPayload {
  event: string;
  action?: string;
  data: PlaneWebhookIssueData;
  activity: PlaneWebhookActivity;
  webhook_id: string;
  workspace_id: string;
  // Older format has these at top level; community edition does not
  project_id?: string;
  identifier?: string;
  activity_id?: string;
  timestamp?: string;
}

// ---- Type guard ----

function isPlaneWebhookPayload(raw: unknown): raw is PlaneWebhookPayload {
  if (typeof raw !== 'object' || raw === null) return false;
  const p = raw as Record<string, unknown>;

  // Must have event, data, activity, workspace_id
  if (typeof p['event'] !== 'string') return false;
  if (typeof p['data'] !== 'object' || p['data'] === null) return false;
  if (typeof p['activity'] !== 'object' || p['activity'] === null) return false;
  if (typeof p['workspace_id'] !== 'string') return false;

  const data = p['data'] as Record<string, unknown>;
  if (typeof data['id'] !== 'string') return false;
  // state can be a string (UUID) or an object { id, name, ... }
  if (typeof data['state'] !== 'string' && (typeof data['state'] !== 'object' || data['state'] === null)) return false;

  const activity = p['activity'] as Record<string, unknown>;
  if (typeof activity['field'] !== 'string') return false;

  return true;
}

// ---- Normalize issue data → KanbanCard ----

/** Extract state ID from either string or object form. */
function extractStateId(state: PlaneWebhookIssueData['state']): string {
  return typeof state === 'string' ? state : state.id;
}

function toKanbanCard(
  data: PlaneWebhookIssueData,
  workspaceSlug: string,
  baseUrl: string,
): KanbanCard {
  const labels = data.labels ?? data.label_details ?? [];
  const assignees = data.assignees ?? data.assignee_details ?? [];

  return {
    id: cardId(data.id),
    title: data.name,
    description: data.description_html,
    columnId: columnId(extractStateId(data.state)),
    boardId: mkBoardId(data.project),
    labels: labels.map((l) => l.name),
    assignees: assignees.map((a) => a.id),
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
  sourcePlugin = '@ouija-dev/plugin-plane',
  baseUrl = '',
): NormalizedWebhookEvent {
  try {
    if (!isPlaneWebhookPayload(raw)) {
      return null;
    }

    const payload = raw;
    const { data, activity } = payload;

    // Accept both "issue" (community edition) and "issue_activity" (older versions).
    if (payload.event !== 'issue' && payload.event !== 'issue_activity') {
      return null;
    }

    const workspaceSlug = data.workspace ?? '';
    const eventId = activity.id ?? payload.webhook_id ?? crypto.randomUUID();
    const timestamp = activity.created_at ?? payload.timestamp ?? new Date().toISOString();
    const correlationId = payload.activity_id ?? payload.webhook_id ?? eventId;

    // Actor can be in "actor" (community) or "actor_detail" (older)
    const actor = activity.actor ?? activity.actor_detail;

    // "state_id" (community edition) or "state" (older) → card moved
    if (activity.field === 'state_id' || activity.field === 'state') {
      const fromColumnId = activity.old_identifier ?? activity.old_value;
      const toColumnId = activity.new_identifier ?? activity.new_value ?? extractStateId(data.state);

      if (!fromColumnId || !toColumnId) {
        return null;
      }

      const movedBy = actor?.email ?? actor?.display_name ?? actor?.id ?? 'unknown';

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
        correlationId,
      };

      return event;
    }

    if (activity.field === 'assignees') {
      const assigneeId = activity.new_identifier ?? activity.new_value;

      if (!assigneeId) {
        return null;
      }

      const assignedBy = actor?.email ?? actor?.display_name ?? actor?.id ?? 'unknown';

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
        correlationId,
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
