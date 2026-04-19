/**
 * Review-loop wiring.
 *
 * Subscribes to the two PR-review bus topics, feeds them into the review
 * bundler, and hands each flushed bundle to the orchestrator. Centralised
 * here so server bootstrap stays focused on the happy-path pipeline.
 */

import type { EventBus, Unsubscribe } from '@ouija-dev/bus';
import type {
  GitPrReviewSubmittedPayload,
  GitPrCommentPostedPayload,
  GitCiFailedPayload,
} from '@ouija-dev/types';
import {
  ReviewBundler,
  InMemoryReviewBundleStore,
  type ReviewBundlerLogger,
} from '@ouija-dev/engine';
import type { Orchestrator } from '@ouija-dev/engine';

export interface ReviewLoopOptions {
  eventBus: EventBus;
  orchestrator: Orchestrator;
  logger: ReviewBundlerLogger;
  /** Override the default 60s debounce (used in tests). */
  debounceMs?: number;
}

export interface ReviewLoopHandle {
  bundler: ReviewBundler;
  stop(): Promise<void>;
}

/**
 * Wire the review loop. Returns a handle with a stop() that unsubscribes
 * everything so shutdown can drain cleanly.
 */
export async function registerReviewLoop(opts: ReviewLoopOptions): Promise<ReviewLoopHandle> {
  const store = new InMemoryReviewBundleStore();
  const bundler = new ReviewBundler(
    store,
    async (bundle) => {
      try {
        await opts.orchestrator.processReviewBundle(bundle);
      } catch (err) {
        opts.logger.error('review-loop: processReviewBundle threw', {
          prUrl: bundle.prUrl,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      logger: opts.logger,
      ...(opts.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
    },
  );

  const unsubs: Unsubscribe[] = [];

  unsubs.push(
    await opts.eventBus.subscribe('git.pr.review.submitted', async (event) => {
      const payload = event.payload as GitPrReviewSubmittedPayload;
      await bundler.pushReview(payload.prUrl, payload.prId, {
        reviewId: payload.reviewId,
        reviewerLogin: payload.reviewerLogin,
        state: payload.state,
        body: payload.body,
        submittedAt: payload.submittedAt,
      });
    }),
  );

  unsubs.push(
    await opts.eventBus.subscribe('git.pr.comment.posted', async (event) => {
      const payload = event.payload as GitPrCommentPostedPayload;
      const comment: Parameters<typeof bundler.pushComment>[2] = {
        commentId: payload.commentId,
        reviewerLogin: payload.reviewerLogin,
        body: payload.body,
        postedAt: payload.postedAt,
      };
      if (payload.path !== undefined) comment.path = payload.path;
      if (payload.line !== undefined) comment.line = payload.line;
      await bundler.pushComment(payload.prUrl, payload.prId, comment);
    }),
  );

  // CI failure events coalesce into the same bundle. A burst of
  // (review + 3 failing checks) flushes as a single dispatch, not four.
  unsubs.push(
    await opts.eventBus.subscribe('git.ci.failed', async (event) => {
      const payload = event.payload as GitCiFailedPayload;
      const failure: Parameters<typeof bundler.pushCiFailure>[2] = {
        checkId: payload.checkId,
        provider: payload.provider,
        workflowName: payload.workflowName,
        jobName: payload.jobName,
        conclusion: payload.conclusion,
        headSha: payload.headSha,
        completedAt: payload.completedAt,
      };
      if (payload.logsUrl !== undefined) failure.logsUrl = payload.logsUrl;
      if (payload.summary !== undefined) failure.summary = payload.summary;
      await bundler.pushCiFailure(payload.prUrl, payload.prId, failure);
    }),
  );

  opts.logger.info('review-loop: registered', {
    topics: ['git.pr.review.submitted', 'git.pr.comment.posted', 'git.ci.failed'],
  });

  return {
    bundler,
    async stop() {
      for (const unsub of unsubs) {
        try {
          await unsub();
        } catch {
          /* best-effort shutdown */
        }
      }
    },
  };
}
