import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWebhook, verifySignature, computeSignature } from '../src/webhook-handler.js';
import type { OuijaEvent } from '@ouija-dev/types';

// ---- Fixture loader ----

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function loadFixture(name: string): unknown {
  const fixturePath = join(__dirname, '..', 'fixtures', name);
  const raw = readFileSync(fixturePath, 'utf8');
  return JSON.parse(raw) as unknown;
}

const prOpenedPayload = loadFixture('pr-opened.json');
const prMergedPayload = loadFixture('pr-merged.json');

// ---- Webhook normalization tests ----

describe('normalizeWebhook', () => {
  describe('pull_request / opened → git.pr.opened', () => {
    it('returns a git.pr.opened event with correct fields', () => {
      const event = normalizeWebhook('pull_request', prOpenedPayload);

      expect(event).not.toBeNull();
      expect(event!.topic).toBe('git.pr.opened');
      expect(event!.sourcePlugin).toBe('@ouija-dev/plugin-github');
      expect(event!.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(event!.timestamp).toBeTruthy();
      expect(event!.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('encodes prId as owner/repo#number', () => {
      const event = normalizeWebhook('pull_request', prOpenedPayload) as OuijaEvent<'git.pr.opened'>;
      expect(event.payload.prId).toBe('acme/backend#42');
    });

    it('includes PR url', () => {
      const event = normalizeWebhook('pull_request', prOpenedPayload) as OuijaEvent<'git.pr.opened'>;
      expect(event.payload.url).toBe('https://github.com/acme/backend/pull/42');
    });

    it('includes branch names', () => {
      const event = normalizeWebhook('pull_request', prOpenedPayload) as OuijaEvent<'git.pr.opened'>;
      expect(event.payload.branch).toBe('feature/user-auth');
      expect(event.payload.targetBranch).toBe('main');
    });

    it('sets instanceId as a non-empty string', () => {
      const event = normalizeWebhook('pull_request', prOpenedPayload) as OuijaEvent<'git.pr.opened'>;
      expect(typeof event.payload.instanceId).toBe('string');
      expect(event.payload.instanceId.length).toBeGreaterThan(0);
    });
  });

  describe('pull_request / closed (merged) → git.pr.merged', () => {
    it('returns a git.pr.merged event with correct topic', () => {
      const event = normalizeWebhook('pull_request', prMergedPayload);

      expect(event).not.toBeNull();
      expect(event!.topic).toBe('git.pr.merged');
    });

    it('encodes prId correctly', () => {
      const event = normalizeWebhook('pull_request', prMergedPayload) as OuijaEvent<'git.pr.merged'>;
      expect(event.payload.prId).toBe('acme/backend#42');
    });

    it('includes mergedAt timestamp', () => {
      const event = normalizeWebhook('pull_request', prMergedPayload) as OuijaEvent<'git.pr.merged'>;
      expect(event.payload.mergedAt).toBe('2026-04-01T12:00:00Z');
    });

    it('sets instanceId as a non-empty string', () => {
      const event = normalizeWebhook('pull_request', prMergedPayload) as OuijaEvent<'git.pr.merged'>;
      expect(typeof event.payload.instanceId).toBe('string');
      expect(event.payload.instanceId.length).toBeGreaterThan(0);
    });
  });

  describe('pull_request / closed without merge → null', () => {
    it('returns null when PR is closed but not merged', () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 7,
          html_url: 'https://github.com/acme/backend/pull/7',
          title: 'Draft: WIP feature',
          body: '',
          state: 'closed',
          draft: false,
          merged: false,
          merged_at: null,
          created_at: '2026-04-01T09:00:00Z',
          updated_at: '2026-04-01T11:00:00Z',
          head: { ref: 'feature/wip', sha: 'aaa' },
          base: { ref: 'main', sha: 'bbb' },
        },
        repository: {
          name: 'backend',
          full_name: 'acme/backend',
          html_url: 'https://github.com/acme/backend',
          owner: { login: 'acme' },
        },
      };

      const event = normalizeWebhook('pull_request', payload);
      expect(event).toBeNull();
    });
  });

  describe('other GitHub events → null', () => {
    it('returns null for push events', () => {
      const pushPayload = {
        ref: 'refs/heads/main',
        before: '0000000',
        after: 'abc1234',
        repository: { full_name: 'acme/backend' },
        commits: [],
      };

      const event = normalizeWebhook('push', pushPayload);
      expect(event).toBeNull();
    });

    it('returns null for issues events', () => {
      const issuePayload = {
        action: 'opened',
        issue: { number: 1, title: 'Bug report', body: '' },
        repository: { full_name: 'acme/backend' },
      };

      const event = normalizeWebhook('issues', issuePayload);
      expect(event).toBeNull();
    });

    it('returns null for pull_request / synchronize', () => {
      const syncPayload = {
        action: 'synchronize',
        pull_request: {
          number: 42,
          html_url: 'https://github.com/acme/backend/pull/42',
          title: 'feat: update',
          body: '',
          state: 'open',
          draft: false,
          merged: false,
          merged_at: null,
          created_at: '2026-04-01T10:00:00Z',
          updated_at: '2026-04-01T10:30:00Z',
          head: { ref: 'feature/update', sha: 'ccc' },
          base: { ref: 'main', sha: 'ddd' },
        },
        repository: {
          name: 'backend',
          full_name: 'acme/backend',
          html_url: 'https://github.com/acme/backend',
          owner: { login: 'acme' },
        },
      };

      const event = normalizeWebhook('pull_request', syncPayload);
      expect(event).toBeNull();
    });

    it('returns null for ping events', () => {
      const event = normalizeWebhook('ping', { zen: 'Practicality beats purity.' });
      expect(event).toBeNull();
    });
  });
});

// ---- HMAC-SHA256 signature verification tests ----

describe('verifySignature / computeSignature', () => {
  const secret = 'super-secret-webhook-key';
  const body = JSON.stringify({ action: 'opened', number: 1 });

  it('computeSignature returns sha256=<hex> format', () => {
    const sig = computeSignature(secret, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('computeSignature matches manual HMAC-SHA256 computation', () => {
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const actual = computeSignature(secret, body);
    expect(actual).toBe(expected);
  });

  it('verifySignature returns true for a valid signature', () => {
    const sig = computeSignature(secret, body);
    expect(verifySignature(secret, body, sig)).toBe(true);
  });

  it('verifySignature returns true for Buffer body', () => {
    const buf = Buffer.from(body, 'utf8');
    const sig = computeSignature(secret, buf);
    expect(verifySignature(secret, buf, sig)).toBe(true);
  });

  it('verifySignature returns false for wrong secret', () => {
    const sig = computeSignature('wrong-secret', body);
    expect(verifySignature(secret, body, sig)).toBe(false);
  });

  it('verifySignature returns false for tampered body', () => {
    const sig = computeSignature(secret, body);
    const tampered = body + ' ';
    expect(verifySignature(secret, tampered, sig)).toBe(false);
  });

  it('verifySignature returns false for empty signature header', () => {
    expect(verifySignature(secret, body, '')).toBe(false);
  });

  it('verifySignature returns false for garbage signature', () => {
    expect(verifySignature(secret, body, 'sha256=notahexstring')).toBe(false);
  });

  it('verifySignature produces same result for string and equivalent Buffer', () => {
    const sig = computeSignature(secret, body);
    const bufSig = computeSignature(secret, Buffer.from(body, 'utf8'));
    expect(sig).toBe(bufSig);
  });

  it('verifySignature is robust against signature without sha256= prefix', () => {
    const hexOnly = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifySignature(secret, body, hexOnly)).toBe(false);
  });
});

// ---- Review loop: submitted reviews + PR comments ----

describe('normalizeWebhook — review loop events', () => {
  const reviewPayload = loadFixture('pr-review-submitted.json');
  const reviewCommentPayload = loadFixture('pr-review-comment-created.json');
  const issueCommentPrPayload = loadFixture('issue-comment-on-pr.json');
  const issueCommentIssuePayload = loadFixture('issue-comment-on-issue.json');

  describe('pull_request_review / submitted → git.pr.review.submitted', () => {
    it('emits a git.pr.review.submitted event with normalised fields', () => {
      const event = normalizeWebhook('pull_request_review', reviewPayload) as OuijaEvent<'git.pr.review.submitted'>;
      expect(event).not.toBeNull();
      expect(event.topic).toBe('git.pr.review.submitted');
      expect(event.payload.prUrl).toBe('https://github.com/acme/backend/pull/42');
      expect(event.payload.prId).toBe('acme/backend#42');
      expect(event.payload.reviewId).toBe('2800123456');
      expect(event.payload.state).toBe('changes_requested');
      expect(event.payload.reviewerLogin).toBe('coderabbitai[bot]');
      expect(event.payload.body).toContain('Two nitpicks');
      expect(event.payload.submittedAt).toBe('2026-04-20T14:32:10Z');
    });

    it('drops PENDING reviews (not yet submitted)', () => {
      const pending = {
        ...(reviewPayload as Record<string, unknown>),
        review: {
          ...((reviewPayload as { review: Record<string, unknown> }).review),
          state: 'PENDING',
        },
      };
      expect(normalizeWebhook('pull_request_review', pending)).toBeNull();
    });

    it('drops DISMISSED reviews (retraction, not a new signal)', () => {
      const dismissed = {
        ...(reviewPayload as Record<string, unknown>),
        review: {
          ...((reviewPayload as { review: Record<string, unknown> }).review),
          state: 'DISMISSED',
        },
      };
      expect(normalizeWebhook('pull_request_review', dismissed)).toBeNull();
    });

    it('drops non-submitted actions (e.g. edited, dismissed)', () => {
      const edited = {
        ...(reviewPayload as Record<string, unknown>),
        action: 'edited',
      };
      expect(normalizeWebhook('pull_request_review', edited)).toBeNull();
    });

    it('normalises all three valid states', () => {
      for (const [raw, expected] of [
        ['APPROVED', 'approved'],
        ['COMMENTED', 'commented'],
        ['CHANGES_REQUESTED', 'changes_requested'],
      ] as const) {
        const patched = {
          ...(reviewPayload as Record<string, unknown>),
          review: {
            ...((reviewPayload as { review: Record<string, unknown> }).review),
            state: raw,
          },
        };
        const event = normalizeWebhook('pull_request_review', patched) as OuijaEvent<'git.pr.review.submitted'>;
        expect(event.payload.state).toBe(expected);
      }
    });
  });

  describe('pull_request_review_comment / created → git.pr.comment.posted', () => {
    it('emits git.pr.comment.posted with path + line for inline comments', () => {
      const event = normalizeWebhook(
        'pull_request_review_comment',
        reviewCommentPayload,
      ) as OuijaEvent<'git.pr.comment.posted'>;
      expect(event.topic).toBe('git.pr.comment.posted');
      expect(event.payload.commentId).toBe('1900987654');
      expect(event.payload.path).toBe('src/auth/email-validator.ts');
      expect(event.payload.line).toBe(23);
      expect(event.payload.reviewerLogin).toBe('coderabbitai[bot]');
      expect(event.payload.body).toContain('RFC 5321');
    });

    it('omits line when GitHub sends null (multi-line or file-level comment)', () => {
      const nullLine = {
        ...(reviewCommentPayload as Record<string, unknown>),
        comment: {
          ...((reviewCommentPayload as { comment: Record<string, unknown> }).comment),
          line: null,
        },
      };
      const event = normalizeWebhook(
        'pull_request_review_comment',
        nullLine,
      ) as OuijaEvent<'git.pr.comment.posted'>;
      expect(event.payload.line).toBeUndefined();
      expect(event.payload.path).toBe('src/auth/email-validator.ts');
    });

    it('drops actions other than created', () => {
      const edited = {
        ...(reviewCommentPayload as Record<string, unknown>),
        action: 'edited',
      };
      expect(normalizeWebhook('pull_request_review_comment', edited)).toBeNull();
    });
  });

  describe('issue_comment / created (on PR) → git.pr.comment.posted', () => {
    it('emits git.pr.comment.posted for PR-attached issue comments', () => {
      const event = normalizeWebhook(
        'issue_comment',
        issueCommentPrPayload,
      ) as OuijaEvent<'git.pr.comment.posted'>;
      expect(event).not.toBeNull();
      expect(event.topic).toBe('git.pr.comment.posted');
      expect(event.payload.prUrl).toBe('https://github.com/acme/backend/pull/42');
      expect(event.payload.prId).toBe('acme/backend#42');
      expect(event.payload.reviewerLogin).toBe('muhammadkh4n');
      expect(event.payload.body).toContain('@rex-coder');
      // Top-level comment — no path/line
      expect(event.payload.path).toBeUndefined();
      expect(event.payload.line).toBeUndefined();
    });

    it('ignores comments on plain issues (no pull_request field)', () => {
      expect(normalizeWebhook('issue_comment', issueCommentIssuePayload)).toBeNull();
    });
  });

  describe('unsupported events', () => {
    it('returns null for check_run events', () => {
      expect(normalizeWebhook('check_run', {})).toBeNull();
    });

    it('returns null for star events', () => {
      expect(normalizeWebhook('star', {})).toBeNull();
    });
  });
});
