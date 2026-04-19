/**
 * Review bundler — debounces + aggregates PR review webhooks.
 *
 * CodeRabbit, Copilot review, and human reviewers frequently post 5–20
 * comments within a couple of seconds (one per file or one per concern). We
 * must not fire 20 agent dispatches back-to-back, so every review/comment
 * event pushes into a per-PR bundle that flushes after a quiet window
 * (default 60s). When the window closes, the orchestrator receives a single
 * `pr_review_received` trigger carrying every review + comment in the bundle.
 *
 * Backend: the store is pluggable. Ship with InMemoryReviewBundleStore (fine
 * for single-process deployments). A Redis-backed store is trivial to bolt on
 * later for multi-instance setups — same interface, different internals.
 *
 * Idempotency: bundles dedupe by `reviewId` / `commentId`, so GitHub webhook
 * retries never inflate the bundle.
 */

import type { ReviewBundle, PrId } from '@ouija-dev/types';

export const DEFAULT_REVIEW_DEBOUNCE_MS = 60_000;

export interface BundleReview {
  reviewId: string;
  reviewerLogin: string;
  state: 'approved' | 'changes_requested' | 'commented';
  body: string;
  submittedAt: string;
}

export interface BundleComment {
  commentId: string;
  reviewerLogin: string;
  body: string;
  path?: string;
  line?: number;
  postedAt: string;
}

export type ReviewFlushHandler = (bundle: ReviewBundle) => Promise<void> | void;

/**
 * Storage contract — lets us swap in-memory (tests, single-node) for Redis
 * (multi-node) without touching the debounce logic.
 */
export interface ReviewBundleStore {
  /** Merge a review into the bundle for a PR. Deduplicates by reviewId. */
  addReview(prUrl: string, prId: PrId, review: BundleReview): Promise<void>;
  /** Merge a comment into the bundle for a PR. Deduplicates by commentId. */
  addComment(prUrl: string, prId: PrId, comment: BundleComment): Promise<void>;
  /** Drain the bundle for a PR. Returns null if nothing is buffered. */
  drain(prUrl: string): Promise<ReviewBundle | null>;
  /** How many items (reviews + comments) are currently buffered for a PR. */
  size(prUrl: string): Promise<number>;
}

export class InMemoryReviewBundleStore implements ReviewBundleStore {
  private readonly reviewsByPr = new Map<string, Map<string, BundleReview>>();
  private readonly commentsByPr = new Map<string, Map<string, BundleComment>>();
  private readonly prIdByPr = new Map<string, PrId>();

  async addReview(prUrl: string, prId: PrId, review: BundleReview): Promise<void> {
    let reviews = this.reviewsByPr.get(prUrl);
    if (reviews === undefined) {
      reviews = new Map<string, BundleReview>();
      this.reviewsByPr.set(prUrl, reviews);
    }
    reviews.set(review.reviewId, review);
    this.prIdByPr.set(prUrl, prId);
  }

  async addComment(prUrl: string, prId: PrId, comment: BundleComment): Promise<void> {
    let comments = this.commentsByPr.get(prUrl);
    if (comments === undefined) {
      comments = new Map<string, BundleComment>();
      this.commentsByPr.set(prUrl, comments);
    }
    comments.set(comment.commentId, comment);
    this.prIdByPr.set(prUrl, prId);
  }

  async drain(prUrl: string): Promise<ReviewBundle | null> {
    const reviews = this.reviewsByPr.get(prUrl);
    const comments = this.commentsByPr.get(prUrl);
    const prId = this.prIdByPr.get(prUrl);
    if (prId === undefined) return null;
    if ((reviews === undefined || reviews.size === 0) && (comments === undefined || comments.size === 0)) {
      return null;
    }
    this.reviewsByPr.delete(prUrl);
    this.commentsByPr.delete(prUrl);
    this.prIdByPr.delete(prUrl);
    return {
      prUrl,
      prId,
      reviews: reviews === undefined ? [] : [...reviews.values()],
      comments: comments === undefined ? [] : [...comments.values()],
      flushedAt: new Date().toISOString(),
    };
  }

  async size(prUrl: string): Promise<number> {
    const r = this.reviewsByPr.get(prUrl)?.size ?? 0;
    const c = this.commentsByPr.get(prUrl)?.size ?? 0;
    return r + c;
  }
}

export interface ReviewBundlerLogger {
  debug(message: string, ctx?: Record<string, unknown>): void;
  info(message: string, ctx?: Record<string, unknown>): void;
  warn(message: string, ctx?: Record<string, unknown>): void;
  error(message: string, ctx?: Record<string, unknown>): void;
}

const noopLogger: ReviewBundlerLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ReviewBundlerOptions {
  debounceMs?: number;
  /** Hard cap on buffered events per PR; excess silently dropped with a warning. */
  maxBundleSize?: number;
  /** Injected so tests can fake time. Defaults to setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  logger?: ReviewBundlerLogger;
}

const DEFAULT_MAX_BUNDLE_SIZE = 500;

/**
 * Sliding-window debouncer. Every push either starts a new window or extends
 * the existing one. When the window elapses with no new events, the bundle
 * for that PR is drained and handed to the flush handler as a single
 * `pr_review_received` trigger.
 */
export class ReviewBundler {
  private readonly timers = new Map<string, unknown>();
  private readonly debounceMs: number;
  private readonly maxBundleSize: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly logger: ReviewBundlerLogger;

  constructor(
    private readonly store: ReviewBundleStore,
    private readonly flush: ReviewFlushHandler,
    opts: ReviewBundlerOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_REVIEW_DEBOUNCE_MS;
    this.maxBundleSize = opts.maxBundleSize ?? DEFAULT_MAX_BUNDLE_SIZE;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimer =
      opts.clearTimer ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.logger = opts.logger ?? noopLogger;
  }

  async pushReview(prUrl: string, prId: PrId, review: BundleReview): Promise<void> {
    const currentSize = await this.store.size(prUrl);
    if (currentSize >= this.maxBundleSize) {
      this.logger.warn('review-bundler: dropped review — bundle at cap', {
        prUrl,
        maxBundleSize: this.maxBundleSize,
      });
      return;
    }
    await this.store.addReview(prUrl, prId, review);
    this.scheduleFlush(prUrl);
  }

  async pushComment(prUrl: string, prId: PrId, comment: BundleComment): Promise<void> {
    const currentSize = await this.store.size(prUrl);
    if (currentSize >= this.maxBundleSize) {
      this.logger.warn('review-bundler: dropped comment — bundle at cap', {
        prUrl,
        maxBundleSize: this.maxBundleSize,
      });
      return;
    }
    await this.store.addComment(prUrl, prId, comment);
    this.scheduleFlush(prUrl);
  }

  /** Force an immediate flush for a PR — used by tests and by cancel paths. */
  async flushNow(prUrl: string): Promise<void> {
    const existing = this.timers.get(prUrl);
    if (existing !== undefined) {
      this.clearTimer(existing);
      this.timers.delete(prUrl);
    }
    await this.drainAndDispatch(prUrl);
  }

  /** Cancel any pending flush for a PR without draining. */
  cancel(prUrl: string): void {
    const existing = this.timers.get(prUrl);
    if (existing !== undefined) {
      this.clearTimer(existing);
      this.timers.delete(prUrl);
    }
  }

  private scheduleFlush(prUrl: string): void {
    const existing = this.timers.get(prUrl);
    if (existing !== undefined) {
      this.clearTimer(existing);
    }
    const handle = this.setTimer(() => {
      this.timers.delete(prUrl);
      this.drainAndDispatch(prUrl).catch((err) => {
        this.logger.error('review-bundler: flush handler threw', {
          prUrl,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.debounceMs);
    this.timers.set(prUrl, handle);
  }

  private async drainAndDispatch(prUrl: string): Promise<void> {
    const bundle = await this.store.drain(prUrl);
    if (bundle === null) {
      this.logger.debug('review-bundler: drain found empty bundle', { prUrl });
      return;
    }
    this.logger.info('review-bundler: flushing bundle', {
      prUrl,
      reviews: bundle.reviews.length,
      comments: bundle.comments.length,
    });
    await this.flush(bundle);
  }
}
