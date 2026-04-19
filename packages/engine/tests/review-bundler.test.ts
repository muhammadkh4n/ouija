/**
 * ReviewBundler tests — in-memory store + fake timer injection.
 *
 * The bundler is the debounce heart of the review loop. If it misbehaves we
 * either spam the agent with one dispatch per comment or lose comments
 * entirely. These tests cover the invariants that matter:
 *
 *  - Each new event resets the flush timer (sliding window).
 *  - Duplicate reviewId/commentId dedupe so webhook retries don't inflate.
 *  - Flush fires exactly once per quiet window.
 *  - Multiple PRs debounce independently.
 *  - Bundle size cap silently drops excess events.
 *  - cancel() / flushNow() behave correctly.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ReviewBundler,
  InMemoryReviewBundleStore,
  filterReviewBundle,
  type BundleReview,
  type BundleComment,
  type BundleCiFailure,
} from '../src/review-bundler.js';
import type { ReviewBundle } from '@ouija-dev/types';
import { prId } from '@ouija-dev/types';

// ---- Fake timer harness ----

interface FakeTimer {
  fn: () => void;
  ms: number;
  scheduledAt: number;
}

function makeFakeTimers() {
  const timers = new Map<number, FakeTimer>();
  let nextId = 1;
  let now = 0;

  const setTimer = (fn: () => void, ms: number): unknown => {
    const id = nextId++;
    timers.set(id, { fn, ms, scheduledAt: now });
    return id;
  };

  const clearTimer = (handle: unknown) => {
    timers.delete(handle as number);
  };

  const advance = async (ms: number): Promise<void> => {
    now += ms;
    const toFire = [...timers.entries()]
      .filter(([, t]) => t.scheduledAt + t.ms <= now)
      .sort(([, a], [, b]) => a.scheduledAt + a.ms - (b.scheduledAt + b.ms));
    for (const [id, t] of toFire) {
      timers.delete(id);
      t.fn();
      // Let any queued microtasks resolve (flush handler awaits).
      await Promise.resolve();
      await Promise.resolve();
    }
  };

  return { setTimer, clearTimer, advance, activeCount: () => timers.size };
}

// ---- Fixtures ----

const PR_URL = 'https://github.com/acme/backend/pull/42';
const PR_ID = prId('acme/backend#42');

function review(id: string, overrides: Partial<BundleReview> = {}): BundleReview {
  return {
    reviewId: id,
    reviewerLogin: 'coderabbitai[bot]',
    state: 'changes_requested',
    body: `review ${id}`,
    submittedAt: '2026-04-20T14:32:00Z',
    ...overrides,
  };
}

function comment(id: string, overrides: Partial<BundleComment> = {}): BundleComment {
  return {
    commentId: id,
    reviewerLogin: 'coderabbitai[bot]',
    body: `comment ${id}`,
    postedAt: '2026-04-20T14:32:01Z',
    ...overrides,
  };
}

// ---- Unit tests for the store ----

describe('InMemoryReviewBundleStore', () => {
  it('dedupes reviews by reviewId', async () => {
    const store = new InMemoryReviewBundleStore();
    await store.addReview(PR_URL, PR_ID, review('r1', { body: 'first' }));
    await store.addReview(PR_URL, PR_ID, review('r1', { body: 'second' }));
    const drained = await store.drain(PR_URL);
    expect(drained?.reviews).toHaveLength(1);
    expect(drained?.reviews[0]?.body).toBe('second'); // last-write-wins on dedupe
  });

  it('dedupes comments by commentId', async () => {
    const store = new InMemoryReviewBundleStore();
    await store.addComment(PR_URL, PR_ID, comment('c1'));
    await store.addComment(PR_URL, PR_ID, comment('c1'));
    const drained = await store.drain(PR_URL);
    expect(drained?.comments).toHaveLength(1);
  });

  it('drain returns null for a PR with nothing buffered', async () => {
    const store = new InMemoryReviewBundleStore();
    expect(await store.drain('https://unknown')).toBeNull();
  });

  it('drain clears the PR bucket (second drain returns null)', async () => {
    const store = new InMemoryReviewBundleStore();
    await store.addReview(PR_URL, PR_ID, review('r1'));
    expect(await store.drain(PR_URL)).not.toBeNull();
    expect(await store.drain(PR_URL)).toBeNull();
  });

  it('size reports reviews + comments combined', async () => {
    const store = new InMemoryReviewBundleStore();
    await store.addReview(PR_URL, PR_ID, review('r1'));
    await store.addComment(PR_URL, PR_ID, comment('c1'));
    await store.addComment(PR_URL, PR_ID, comment('c2'));
    expect(await store.size(PR_URL)).toBe(3);
  });
});

// ---- Bundler behaviour ----

describe('ReviewBundler debounce', () => {
  it('fires the flush handler after the debounce window elapses', async () => {
    const store = new InMemoryReviewBundleStore();
    const flushed: ReviewBundle[] = [];
    const clock = makeFakeTimers();
    const bundler = new ReviewBundler(store, (b) => void flushed.push(b), {
      debounceMs: 60_000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    await bundler.pushReview(PR_URL, PR_ID, review('r1'));
    expect(flushed).toHaveLength(0);

    await clock.advance(59_999);
    expect(flushed).toHaveLength(0);

    await clock.advance(2);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.reviews[0]?.reviewId).toBe('r1');
  });

  it('resets the window on each new event (sliding debounce)', async () => {
    const store = new InMemoryReviewBundleStore();
    const flushed: ReviewBundle[] = [];
    const clock = makeFakeTimers();
    const bundler = new ReviewBundler(store, (b) => void flushed.push(b), {
      debounceMs: 60_000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    await bundler.pushReview(PR_URL, PR_ID, review('r1'));
    await clock.advance(30_000);
    await bundler.pushComment(PR_URL, PR_ID, comment('c1'));
    await clock.advance(30_000); // total 60s but only 30s since last event
    expect(flushed).toHaveLength(0);

    await clock.advance(31_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.reviews).toHaveLength(1);
    expect(flushed[0]?.comments).toHaveLength(1);
  });

  it('coalesces bursts into a single flush', async () => {
    const store = new InMemoryReviewBundleStore();
    const flushed: ReviewBundle[] = [];
    const clock = makeFakeTimers();
    const bundler = new ReviewBundler(store, (b) => void flushed.push(b), {
      debounceMs: 1_000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    // CodeRabbit-style burst: 8 inline comments in quick succession.
    for (let i = 0; i < 8; i++) {
      await bundler.pushComment(PR_URL, PR_ID, comment(`c${i}`));
      await clock.advance(50);
    }

    await clock.advance(2_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.comments).toHaveLength(8);
  });

  it('debounces PRs independently', async () => {
    const store = new InMemoryReviewBundleStore();
    const flushed: ReviewBundle[] = [];
    const clock = makeFakeTimers();
    const bundler = new ReviewBundler(store, (b) => void flushed.push(b), {
      debounceMs: 1_000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const PR_A = 'https://github.com/acme/backend/pull/42';
    const PR_B = 'https://github.com/acme/backend/pull/43';
    const ID_A = prId('acme/backend#42');
    const ID_B = prId('acme/backend#43');

    await bundler.pushReview(PR_A, ID_A, review('ra'));
    await clock.advance(600);
    await bundler.pushReview(PR_B, ID_B, review('rb'));
    await clock.advance(500); // 1100ms from PR_A push → PR_A should fire
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.prUrl).toBe(PR_A);

    await clock.advance(600); // 1100ms from PR_B push → PR_B fires
    expect(flushed).toHaveLength(2);
    expect(flushed[1]?.prUrl).toBe(PR_B);
  });

  it('flushNow fires immediately and clears the pending timer', async () => {
    const store = new InMemoryReviewBundleStore();
    const flushed: ReviewBundle[] = [];
    const clock = makeFakeTimers();
    const bundler = new ReviewBundler(store, (b) => void flushed.push(b), {
      debounceMs: 60_000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    await bundler.pushReview(PR_URL, PR_ID, review('r1'));
    await bundler.flushNow(PR_URL);
    expect(flushed).toHaveLength(1);

    // Advance past the original window — the cancelled timer must not refire.
    await clock.advance(61_000);
    expect(flushed).toHaveLength(1);
  });

  it('cancel drops the pending window without flushing', async () => {
    const store = new InMemoryReviewBundleStore();
    const flushed: ReviewBundle[] = [];
    const clock = makeFakeTimers();
    const bundler = new ReviewBundler(store, (b) => void flushed.push(b), {
      debounceMs: 60_000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    await bundler.pushReview(PR_URL, PR_ID, review('r1'));
    bundler.cancel(PR_URL);
    await clock.advance(61_000);
    expect(flushed).toHaveLength(0);
  });

  it('drops new events once the bundle hits maxBundleSize', async () => {
    const store = new InMemoryReviewBundleStore();
    const flushed: ReviewBundle[] = [];
    const warn = vi.fn();
    const clock = makeFakeTimers();
    const bundler = new ReviewBundler(store, (b) => void flushed.push(b), {
      debounceMs: 1_000,
      maxBundleSize: 3,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      logger: { debug: () => undefined, info: () => undefined, warn, error: () => undefined },
    });

    for (let i = 0; i < 5; i++) {
      await bundler.pushComment(PR_URL, PR_ID, comment(`c${i}`));
    }
    await clock.advance(2_000);

    expect(flushed[0]?.comments).toHaveLength(3);
    expect(warn).toHaveBeenCalled();
  });

  it('empty bundle drain does not invoke the flush handler', async () => {
    const store = new InMemoryReviewBundleStore();
    const flushed: ReviewBundle[] = [];
    const clock = makeFakeTimers();
    const bundler = new ReviewBundler(store, (b) => void flushed.push(b), {
      debounceMs: 1_000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await bundler.flushNow(PR_URL);
    expect(flushed).toHaveLength(0);
  });
});

// ---- CI failure handling ----

describe('InMemoryReviewBundleStore — CI failures', () => {
  function ciFailure(checkId: string, overrides: Partial<BundleCiFailure> = {}): BundleCiFailure {
    return {
      checkId,
      provider: 'github-actions',
      workflowName: 'CI',
      jobName: 'unit-tests',
      conclusion: 'failure',
      headSha: 'abc123',
      completedAt: '2026-04-21T09:12:34Z',
      ...overrides,
    };
  }

  it('dedupes CI failures by checkId (re-runs of the same job replace the prior entry)', async () => {
    const store = new InMemoryReviewBundleStore();
    await store.addCiFailure(PR_URL, PR_ID, ciFailure('gha:1:tests', { summary: 'first' }));
    await store.addCiFailure(PR_URL, PR_ID, ciFailure('gha:1:tests', { summary: 'second' }));
    const drained = await store.drain(PR_URL);
    expect(drained?.ciFailures).toHaveLength(1);
    expect(drained?.ciFailures?.[0]?.summary).toBe('second');
  });

  it('coalesces CI failures with reviews + comments into a single bundle', async () => {
    const store = new InMemoryReviewBundleStore();
    await store.addReview(PR_URL, PR_ID, review('r1'));
    await store.addComment(PR_URL, PR_ID, comment('c1'));
    await store.addCiFailure(PR_URL, PR_ID, ciFailure('gha:1:tests'));
    await store.addCiFailure(PR_URL, PR_ID, ciFailure('gha:2:lint'));

    const drained = await store.drain(PR_URL);
    expect(drained?.reviews).toHaveLength(1);
    expect(drained?.comments).toHaveLength(1);
    expect(drained?.ciFailures).toHaveLength(2);
  });

  it('drain returns undefined ciFailures when none are buffered', async () => {
    const store = new InMemoryReviewBundleStore();
    await store.addReview(PR_URL, PR_ID, review('r1'));
    const drained = await store.drain(PR_URL);
    expect(drained?.ciFailures).toBeUndefined();
  });

  it('size includes CI failures', async () => {
    const store = new InMemoryReviewBundleStore();
    await store.addReview(PR_URL, PR_ID, review('r1'));
    await store.addCiFailure(PR_URL, PR_ID, ciFailure('gha:1:tests'));
    await store.addCiFailure(PR_URL, PR_ID, ciFailure('gha:2:lint'));
    expect(await store.size(PR_URL)).toBe(3);
  });
});

describe('ReviewBundler.pushCiFailure', () => {
  function ciFailure(checkId: string): BundleCiFailure {
    return {
      checkId,
      provider: 'github-actions',
      workflowName: 'CI',
      jobName: 'tests',
      conclusion: 'failure',
      headSha: 'abc',
      completedAt: '2026-04-21T09:12:34Z',
    };
  }

  it('a CI failure alone triggers the flush window', async () => {
    const store = new InMemoryReviewBundleStore();
    const flushed: ReviewBundle[] = [];
    const clock = makeFakeTimers();
    const bundler = new ReviewBundler(store, (b) => void flushed.push(b), {
      debounceMs: 1_000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    await bundler.pushCiFailure(PR_URL, PR_ID, ciFailure('gha:1:tests'));
    await clock.advance(2_000);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.ciFailures).toHaveLength(1);
    expect(flushed[0]?.ciFailures?.[0]?.checkId).toBe('gha:1:tests');
  });

  it('drops new CI failures once the bundle hits maxBundleSize', async () => {
    const store = new InMemoryReviewBundleStore();
    const flushed: ReviewBundle[] = [];
    const clock = makeFakeTimers();
    const bundler = new ReviewBundler(store, (b) => void flushed.push(b), {
      debounceMs: 1_000,
      maxBundleSize: 2,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (let i = 0; i < 5; i++) {
      await bundler.pushCiFailure(PR_URL, PR_ID, ciFailure(`gha:${i}:tests`));
    }
    await clock.advance(2_000);
    expect(flushed[0]?.ciFailures).toHaveLength(2);
  });
});

// ---- filterReviewBundle (per-agent gates) ----

describe('filterReviewBundle', () => {
  function bundle(overrides: Partial<ReviewBundle> = {}): ReviewBundle {
    return {
      prUrl: PR_URL,
      prId: PR_ID,
      reviews: [
        { reviewId: 'r1', reviewerLogin: 'coderabbitai[bot]', state: 'changes_requested', body: 'fix', submittedAt: '2026' },
        { reviewId: 'r2', reviewerLogin: 'muhammadkh4n', state: 'commented', body: 'lgtm', submittedAt: '2026' },
      ],
      comments: [
        { commentId: 'c1', reviewerLogin: 'copilot-pull-request-reviewer[bot]', body: 'nit', postedAt: '2026' },
      ],
      ciFailures: [
        { checkId: 'gha:1:unit', provider: 'github-actions', workflowName: 'CI', jobName: 'unit', conclusion: 'failure', headSha: 'abc', completedAt: '2026' },
        { checkId: 'gha:2:bench', provider: 'github-actions', workflowName: 'nightly-bench', jobName: 'perf', conclusion: 'failure', headSha: 'abc', completedAt: '2026' },
      ],
      flushedAt: '2026',
      ...overrides,
    };
  }

  it('returns bundle unchanged when config is undefined (default permissive)', () => {
    const b = bundle();
    const result = filterReviewBundle(b, undefined);
    expect(result?.reviews).toHaveLength(2);
    expect(result?.ciFailures).toHaveLength(2);
  });

  it('returns null when enabled is explicitly false (agent opted out)', () => {
    expect(filterReviewBundle(bundle(), { enabled: false })).toBeNull();
  });

  it('filters out reviewers in ignoreReviewers (case-insensitive)', () => {
    const result = filterReviewBundle(bundle(), {
      ignoreReviewers: ['CodeRabbitAI[bot]'],
    });
    expect(result?.reviews).toHaveLength(1);
    expect(result?.reviews[0]?.reviewerLogin).toBe('muhammadkh4n');
    expect(result?.comments).toHaveLength(1);
  });

  it('triggerReviewers allowlist drops anyone not on it', () => {
    const result = filterReviewBundle(bundle(), {
      triggerReviewers: ['coderabbitai[bot]'],
    });
    expect(result?.reviews).toHaveLength(1);
    expect(result?.reviews[0]?.reviewerLogin).toBe('coderabbitai[bot]');
    expect(result?.comments).toHaveLength(0); // Copilot dropped
  });

  it('filters out CI failures from ignored workflows', () => {
    const result = filterReviewBundle(bundle(), {
      ignoreWorkflows: ['nightly-bench'],
    });
    expect(result?.ciFailures).toHaveLength(1);
    expect(result?.ciFailures?.[0]?.workflowName).toBe('CI');
  });

  it('returns null when all signals are filtered out (no dispatch)', () => {
    const result = filterReviewBundle(
      {
        prUrl: PR_URL,
        prId: PR_ID,
        reviews: [{ reviewId: 'r', reviewerLogin: 'bot', state: 'changes_requested', body: '', submittedAt: '2026' }],
        comments: [],
        flushedAt: '2026',
      },
      { ignoreReviewers: ['bot'] },
    );
    expect(result).toBeNull();
  });

  it('drops ciFailures key entirely when zero survive filtering', () => {
    const result = filterReviewBundle(bundle(), {
      ignoreWorkflows: ['CI', 'nightly-bench'],
    });
    // Still has reviews/comments so result is non-null, but ciFailures should be absent
    expect(result).not.toBeNull();
    expect(result?.ciFailures).toBeUndefined();
  });

  it('combines ignoreReviewers + ignoreWorkflows independently', () => {
    const result = filterReviewBundle(bundle(), {
      ignoreReviewers: ['coderabbitai[bot]'],
      ignoreWorkflows: ['nightly-bench'],
    });
    expect(result?.reviews).toHaveLength(1);
    expect(result?.ciFailures).toHaveLength(1);
  });
});
