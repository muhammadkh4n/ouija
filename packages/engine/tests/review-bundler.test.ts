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
  type BundleReview,
  type BundleComment,
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
