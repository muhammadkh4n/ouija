import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import {
  normalizeWebhook,
  verifyPlaneSignature,
  isWebhookFresh,
} from '../src/webhook-handler.js';

// ---- Load fixtures ----

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const fixturesDir = join(__dir, '..', 'fixtures');

function loadFixture(name: string): unknown {
  const raw = readFileSync(join(fixturesDir, name), 'utf8');
  return JSON.parse(raw);
}

const stateChangeFixture = loadFixture('issue-updated-state.json');
const assignedFixture = loadFixture('issue-assigned.json');

// ---- Helpers ----

function signBody(secret: string, body: string): string {
  const mac = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `sha256=${mac}`;
}

// ---- normalizeWebhook ----

describe('normalizeWebhook: state change fixture', () => {
  it('returns a kanban.card.moved event', () => {
    const event = normalizeWebhook(stateChangeFixture);

    expect(event).not.toBeNull();
    expect(event?.topic).toBe('kanban.card.moved');
  });

  it('maps fromColumnId to the old state value', () => {
    const event = normalizeWebhook(stateChangeFixture);

    // From fixture: activity.old_value = "eeeeeeee-5555-5555-5555-555555555555"
    expect(event?.topic).toBe('kanban.card.moved');
    if (event?.topic === 'kanban.card.moved') {
      expect(event.payload.fromColumnId).toBe('eeeeeeee-5555-5555-5555-555555555555');
    }
  });

  it('maps toColumnId to the new state value', () => {
    const event = normalizeWebhook(stateChangeFixture);

    // From fixture: activity.new_value = "cccccccc-3333-3333-3333-333333333333"
    expect(event?.topic).toBe('kanban.card.moved');
    if (event?.topic === 'kanban.card.moved') {
      expect(event.payload.toColumnId).toBe('cccccccc-3333-3333-3333-333333333333');
    }
  });

  it('maps cardId to the issue id from data', () => {
    const event = normalizeWebhook(stateChangeFixture);

    expect(event?.topic).toBe('kanban.card.moved');
    if (event?.topic === 'kanban.card.moved') {
      expect(event.payload.cardId).toBe('aaaaaaaa-1111-1111-1111-111111111111');
    }
  });

  it('maps movedBy to the actor email', () => {
    const event = normalizeWebhook(stateChangeFixture);

    expect(event?.topic).toBe('kanban.card.moved');
    if (event?.topic === 'kanban.card.moved') {
      expect(event.payload.movedBy).toBe('bob@example.com');
    }
  });

  it('sets sourcePlugin correctly', () => {
    const event = normalizeWebhook(stateChangeFixture, '@ouija/plugin-plane');
    expect(event?.sourcePlugin).toBe('@ouija/plugin-plane');
  });

  it('sets event id from activity id', () => {
    const event = normalizeWebhook(stateChangeFixture);
    // From fixture: activity.id = "a1b2c3d4-0001-0001-0001-000000000001"
    expect(event?.id).toBe('a1b2c3d4-0001-0001-0001-000000000001');
  });

  it('sets correlationId from activity_id', () => {
    const event = normalizeWebhook(stateChangeFixture);
    expect(event?.correlationId).toBe('a1b2c3d4-0001-0001-0001-000000000001');
  });
});

describe('normalizeWebhook: assignment fixture', () => {
  it('returns a kanban.card.assigned event', () => {
    const event = normalizeWebhook(assignedFixture);

    expect(event).not.toBeNull();
    expect(event?.topic).toBe('kanban.card.assigned');
  });

  it('maps assigneeId to the new member identifier', () => {
    const event = normalizeWebhook(assignedFixture);

    expect(event?.topic).toBe('kanban.card.assigned');
    if (event?.topic === 'kanban.card.assigned') {
      // From fixture: activity.new_identifier = "dddddddd-4444-4444-4444-444444444445"
      expect(event.payload.assigneeId).toBe('dddddddd-4444-4444-4444-444444444445');
    }
  });

  it('maps assignedBy to the actor email', () => {
    const event = normalizeWebhook(assignedFixture);

    expect(event?.topic).toBe('kanban.card.assigned');
    if (event?.topic === 'kanban.card.assigned') {
      expect(event.payload.assignedBy).toBe('manager@example.com');
    }
  });

  it('maps cardId correctly', () => {
    const event = normalizeWebhook(assignedFixture);

    expect(event?.topic).toBe('kanban.card.assigned');
    if (event?.topic === 'kanban.card.assigned') {
      expect(event.payload.cardId).toBe('aaaaaaaa-1111-1111-1111-111111111112');
    }
  });
});

describe('normalizeWebhook: irrelevant events', () => {
  it('returns null for a comment_added activity', () => {
    const commentPayload = {
      ...stateChangeFixture as object,
      activity: {
        ...((stateChangeFixture as Record<string, unknown>)['activity'] as object),
        field: 'comment',
        old_value: null,
        new_value: null,
      },
    };

    const event = normalizeWebhook(commentPayload);
    expect(event).toBeNull();
  });

  it('returns null for a name change activity', () => {
    const namePayload = {
      ...stateChangeFixture as object,
      activity: {
        ...((stateChangeFixture as Record<string, unknown>)['activity'] as object),
        field: 'name',
        old_value: 'Old Title',
        new_value: 'New Title',
      },
    };

    const event = normalizeWebhook(namePayload);
    expect(event).toBeNull();
  });

  it('returns null for a non-issue_activity event type', () => {
    const otherPayload = {
      ...stateChangeFixture as object,
      event: 'cycle_issue',
    };

    const event = normalizeWebhook(otherPayload);
    expect(event).toBeNull();
  });

  it('returns null for an unassignment (new_value and new_identifier both null)', () => {
    const unassignPayload = {
      ...assignedFixture as object,
      activity: {
        ...((assignedFixture as Record<string, unknown>)['activity'] as object),
        new_value: null,
        new_identifier: null,
      },
    };

    const event = normalizeWebhook(unassignPayload);
    expect(event).toBeNull();
  });
});

describe('normalizeWebhook: malformed payloads', () => {
  it('returns null for null input', () => {
    expect(normalizeWebhook(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(normalizeWebhook(undefined)).toBeNull();
  });

  it('returns null for an empty object', () => {
    expect(normalizeWebhook({})).toBeNull();
  });

  it('returns null for a string', () => {
    expect(normalizeWebhook('not-a-payload')).toBeNull();
  });

  it('returns null for a number', () => {
    expect(normalizeWebhook(42)).toBeNull();
  });

  it('returns null when data.id is missing', () => {
    const broken = {
      event: 'issue_activity',
      data: {
        // id intentionally omitted
        state: 'some-state',
      },
      activity: { field: 'state', old_value: 'a', new_value: 'b', actor_detail: { id: 'u1' }, created_at: new Date().toISOString() },
      project_id: 'p1',
      workspace_id: 'w1',
      activity_id: 'act1',
      timestamp: new Date().toISOString(),
    };
    expect(normalizeWebhook(broken)).toBeNull();
  });

  it('returns null when activity.field is missing', () => {
    const broken = {
      event: 'issue_activity',
      data: { id: 'issue-1', state: 'some-state', name: 'T', description_html: '', project: 'p', workspace: 'w', label_details: [], assignee_details: [], created_at: '', updated_at: '' },
      activity: {
        // field intentionally omitted
        id: 'a1',
        verb: 'updated',
        actor_detail: { id: 'u1' },
        created_at: new Date().toISOString(),
      },
      project_id: 'p1',
      workspace_id: 'w1',
      activity_id: 'act1',
      timestamp: new Date().toISOString(),
    };
    expect(normalizeWebhook(broken)).toBeNull();
  });

  it('does not throw on deeply malformed input', () => {
    expect(() => normalizeWebhook({ event: 'issue_activity', data: null })).not.toThrow();
    expect(() => normalizeWebhook({ event: 'issue_activity', data: 42, activity: {} })).not.toThrow();
    expect(() => normalizeWebhook([])).not.toThrow();
  });
});

// ---- verifyPlaneSignature ----

describe('verifyPlaneSignature', () => {
  const secret = 'my-webhook-secret-123';
  const body = JSON.stringify({ event: 'issue_activity', data: {} });

  it('accepts a correct sha256 signature', () => {
    const sig = signBody(secret, body);
    expect(verifyPlaneSignature(secret, body, sig)).toBe(true);
  });

  it('accepts a Buffer body', () => {
    const buf = Buffer.from(body, 'utf8');
    const sig = signBody(secret, body);
    expect(verifyPlaneSignature(secret, buf, sig)).toBe(true);
  });

  it('rejects an incorrect signature', () => {
    const sig = 'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(verifyPlaneSignature(secret, body, sig)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const sig = signBody('wrong-secret', body);
    expect(verifyPlaneSignature(secret, body, sig)).toBe(false);
  });

  it('rejects a missing (undefined) signature header', () => {
    expect(verifyPlaneSignature(secret, body, undefined)).toBe(false);
  });

  it('rejects an empty string signature header', () => {
    expect(verifyPlaneSignature(secret, body, '')).toBe(false);
  });

  it('rejects a signature without the sha256= prefix', () => {
    const mac = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(verifyPlaneSignature(secret, body, mac)).toBe(false);
  });

  it('rejects a signature from a tampered body', () => {
    const sig = signBody(secret, body);
    const tamperedBody = body + ' extra';
    expect(verifyPlaneSignature(secret, tamperedBody, sig)).toBe(false);
  });
});

// ---- isWebhookFresh ----

describe('isWebhookFresh', () => {
  it('accepts a timestamp from right now', () => {
    const now = Date.now();
    expect(isWebhookFresh(new Date(now).toISOString(), now)).toBe(true);
  });

  it('accepts a timestamp 4 minutes old', () => {
    const now = Date.now();
    const fourMinAgo = new Date(now - 4 * 60 * 1000).toISOString();
    expect(isWebhookFresh(fourMinAgo, now)).toBe(true);
  });

  it('rejects a timestamp 6 minutes old', () => {
    const now = Date.now();
    const sixMinAgo = new Date(now - 6 * 60 * 1000).toISOString();
    expect(isWebhookFresh(sixMinAgo, now)).toBe(false);
  });

  it('rejects an undefined timestamp', () => {
    expect(isWebhookFresh(undefined)).toBe(false);
  });

  it('rejects a garbage timestamp', () => {
    expect(isWebhookFresh('not-a-date')).toBe(false);
  });
});
