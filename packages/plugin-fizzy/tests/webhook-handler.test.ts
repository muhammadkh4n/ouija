import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeFizzyWebhook,
  verifyFizzySignature,
  isWebhookFresh,
} from '../src/webhook-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8'));
}

// ---- normalizeFizzyWebhook ----

describe('normalizeFizzyWebhook', () => {
  describe('card_triaged → kanban.card.moved', () => {
    const fixture = loadFixture('card-triaged.json');

    it('returns a kanban.card.moved event', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event).not.toBeNull();
      expect(event!.topic).toBe('kanban.card.moved');
    });

    it('sets toColumnId from eventable.column.id', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event!.payload).toHaveProperty('toColumnId', '5');
    });

    it('sets fromColumnId to sentinel "0"', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event!.payload).toHaveProperty('fromColumnId', '0');
    });

    it('sets cardId from eventable.id', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event!.payload).toHaveProperty('cardId', '42');
    });

    it('sets movedBy from creator email', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event!.payload).toHaveProperty('movedBy', 'admin@example.com');
    });

    it('uses event id as correlationId', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event!.correlationId).toBe('evt_abc123');
    });

    it('preserves timestamp', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event!.timestamp).toBe('2026-04-04T12:00:00Z');
    });

    it('returns null when column is null', () => {
      const noColumn = { ...(fixture as Record<string, unknown>), eventable: { ...((fixture as Record<string, unknown>)['eventable'] as Record<string, unknown>), column: null } };
      const event = normalizeFizzyWebhook(noColumn);
      expect(event).toBeNull();
    });
  });

  describe('card_assigned → kanban.card.assigned', () => {
    const fixture = loadFixture('card-assigned.json');

    it('returns a kanban.card.assigned event', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event).not.toBeNull();
      expect(event!.topic).toBe('kanban.card.assigned');
    });

    it('sets assigneeId from last assignee', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event!.payload).toHaveProperty('assigneeId', '10');
    });

    it('sets assignedBy from creator email', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event!.payload).toHaveProperty('assignedBy', 'admin@example.com');
    });

    it('returns null when no assignees', () => {
      const noAssignees = {
        ...(fixture as Record<string, unknown>),
        eventable: {
          ...((fixture as Record<string, unknown>)['eventable'] as Record<string, unknown>),
          assignees: [],
        },
      };
      const event = normalizeFizzyWebhook(noAssignees);
      expect(event).toBeNull();
    });
  });

  describe('card_closed → kanban.card.moved', () => {
    const fixture = loadFixture('card-closed.json');

    it('returns a kanban.card.moved event', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event).not.toBeNull();
      expect(event!.topic).toBe('kanban.card.moved');
    });

    it('sets toColumnId to "closed"', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event!.payload).toHaveProperty('toColumnId', 'closed');
    });

    it('sets fromColumnId from previous column', () => {
      const event = normalizeFizzyWebhook(fixture);
      expect(event!.payload).toHaveProperty('fromColumnId', '5');
    });
  });

  describe('other events → null', () => {
    it('returns null for comment_created', () => {
      const payload = {
        id: 'evt_999',
        action: 'comment_created',
        created_at: '2026-04-04T12:00:00Z',
        eventable: { id: 42, number: 7, title: 'Test', column: null, assignees: [] },
        board: { id: 3, name: 'Board' },
        creator: { id: 1, name: 'Admin' },
      };
      expect(normalizeFizzyWebhook(payload)).toBeNull();
    });

    it('returns null for card_postponed', () => {
      const payload = {
        id: 'evt_999',
        action: 'card_postponed',
        created_at: '2026-04-04T12:00:00Z',
        eventable: { id: 42, number: 7, title: 'Test', column: null, assignees: [] },
        board: { id: 3, name: 'Board' },
        creator: { id: 1, name: 'Admin' },
      };
      expect(normalizeFizzyWebhook(payload)).toBeNull();
    });

    it('returns null for card_unassigned', () => {
      const payload = {
        id: 'evt_999',
        action: 'card_unassigned',
        created_at: '2026-04-04T12:00:00Z',
        eventable: { id: 42, number: 7, title: 'Test', column: null, assignees: [] },
        board: { id: 3, name: 'Board' },
        creator: { id: 1, name: 'Admin' },
      };
      expect(normalizeFizzyWebhook(payload)).toBeNull();
    });
  });

  describe('card_sent_back_to_triage → kanban.card.moved', () => {
    it('maps to card.moved with toColumnId "0"', () => {
      const payload = {
        id: 'evt_triage',
        action: 'card_sent_back_to_triage',
        created_at: '2026-04-04T12:00:00Z',
        eventable: {
          id: 42,
          number: 7,
          title: 'Test',
          column: { id: 5, name: 'In Progress', color: 'red' },
          assignees: [],
        },
        board: { id: 3, name: 'Board' },
        creator: { id: 1, name: 'Admin', email_address: 'admin@test.com' },
      };
      const event = normalizeFizzyWebhook(payload);
      expect(event).not.toBeNull();
      expect(event!.topic).toBe('kanban.card.moved');
      expect(event!.payload).toHaveProperty('toColumnId', '0');
      expect(event!.payload).toHaveProperty('fromColumnId', '5');
    });
  });

  describe('malformed payloads', () => {
    it('returns null for null input', () => {
      expect(normalizeFizzyWebhook(null)).toBeNull();
    });

    it('returns null for empty object', () => {
      expect(normalizeFizzyWebhook({})).toBeNull();
    });

    it('returns null for missing eventable', () => {
      expect(normalizeFizzyWebhook({ id: 'x', action: 'card_triaged', created_at: 'now' })).toBeNull();
    });

    it('returns null for non-numeric eventable id', () => {
      expect(normalizeFizzyWebhook({
        id: 'x',
        action: 'card_triaged',
        created_at: 'now',
        eventable: { id: 'not-a-number' },
        board: { id: 1, name: 'B' },
        creator: { id: 1, name: 'A' },
      })).toBeNull();
    });
  });
});

// ---- verifyFizzySignature ----

describe('verifyFizzySignature', () => {
  const secret = 'test-secret-key';
  const body = '{"action":"card_triaged"}';
  const validSig = createHmac('sha256', secret).update(body).digest('hex');

  it('returns true for valid signature', () => {
    expect(verifyFizzySignature(secret, body, validSig)).toBe(true);
  });

  it('returns true for Buffer body', () => {
    const bufBody = Buffer.from(body, 'utf8');
    const bufSig = createHmac('sha256', secret).update(bufBody).digest('hex');
    expect(verifyFizzySignature(secret, bufBody, bufSig)).toBe(true);
  });

  it('returns false for wrong secret', () => {
    expect(verifyFizzySignature('wrong-secret', body, validSig)).toBe(false);
  });

  it('returns false for tampered body', () => {
    expect(verifyFizzySignature(secret, '{"tampered":true}', validSig)).toBe(false);
  });

  it('returns false for missing signature', () => {
    expect(verifyFizzySignature(secret, body, undefined)).toBe(false);
  });

  it('returns false for empty signature', () => {
    expect(verifyFizzySignature(secret, body, '')).toBe(false);
  });

  it('returns false for garbage signature', () => {
    expect(verifyFizzySignature(secret, body, 'not-hex-at-all!!!')).toBe(false);
  });
});

// ---- isWebhookFresh ----

describe('isWebhookFresh', () => {
  const now = Date.now();

  it('returns true for recent timestamp', () => {
    const ts = new Date(now - 60_000).toISOString();
    expect(isWebhookFresh(ts, now)).toBe(true);
  });

  it('returns false for stale timestamp', () => {
    const ts = new Date(now - 10 * 60_000).toISOString();
    expect(isWebhookFresh(ts, now)).toBe(false);
  });

  it('returns false for undefined timestamp', () => {
    expect(isWebhookFresh(undefined, now)).toBe(false);
  });

  it('returns false for invalid date string', () => {
    expect(isWebhookFresh('not-a-date', now)).toBe(false);
  });

  it('returns true for timestamp exactly at boundary', () => {
    const ts = new Date(now - 5 * 60_000).toISOString();
    expect(isWebhookFresh(ts, now)).toBe(true);
  });
});

// ---- UUID compatibility (Fizzy main branch) ----

describe('normalizeFizzyWebhook — ULID/UUID ids from fizzy:main', () => {
  function uuidCardTriaged(): unknown {
    return {
      id: 'evt_01abcxyz123',
      action: 'card_triaged',
      created_at: '2026-04-19T03:00:00Z',
      eventable: {
        id: '03fyyf7i896v3p3pz0593fovk',
        number: 11,
        title: 'Add LICENSE.txt file',
        column: { id: '03fyyez9ap9rzvq7huekq2iuh', name: 'In Progress' },
        assignees: [{ id: '03fyyez7a34katupr09ysk839', name: 'Rex' }],
        board: { id: '03fyyez87d0oiusw0hoq6qibu', name: 'Ouija Test Board' },
      },
      board: { id: '03fyyez87d0oiusw0hoq6qibu', name: 'Ouija Test Board' },
      creator: { id: '03fyyez6e1b7bkv0c3ipm8u64', name: 'MK', email_address: 'mk@ouija.dev' },
    };
  }

  it('accepts ULID card id (string) and maps it without String() coercion', () => {
    const event = normalizeFizzyWebhook(uuidCardTriaged());
    expect(event).not.toBeNull();
    expect(event!.topic).toBe('kanban.card.moved');
    // Prior to WS2.3 the normalizer required eventable.id to be a number,
    // so a ULID string would hit the early-return null branch.
    expect(event!.payload).toHaveProperty('cardId', '03fyyf7i896v3p3pz0593fovk');
  });

  it('accepts ULID column id and preserves it as-is', () => {
    const event = normalizeFizzyWebhook(uuidCardTriaged());
    expect(event!.payload).toHaveProperty(
      'toColumnId',
      '03fyyez9ap9rzvq7huekq2iuh',
    );
  });

  it('still accepts integer ids (backwards compat with older Fizzy)', () => {
    const payload = uuidCardTriaged() as Record<string, unknown>;
    (payload['eventable'] as Record<string, unknown>)['id'] = 42;
    ((payload['eventable'] as Record<string, unknown>)['column'] as Record<string, unknown>)['id'] = 5;
    const event = normalizeFizzyWebhook(payload);
    expect(event).not.toBeNull();
    expect(event!.payload).toHaveProperty('cardId', '42');
    expect(event!.payload).toHaveProperty('toColumnId', '5');
  });
});
