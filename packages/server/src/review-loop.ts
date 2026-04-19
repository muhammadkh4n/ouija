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
  Database,
  ReviewBundle,
} from '@ouija-dev/types';
import {
  ReviewBundler,
  InMemoryReviewBundleStore,
  filterReviewBundle,
  type ReviewBundlerLogger,
  type ReviewLoopFilterConfig,
} from '@ouija-dev/engine';
import type { Orchestrator } from '@ouija-dev/engine';

export interface ReviewLoopOptions {
  eventBus: EventBus;
  orchestrator: Orchestrator;
  logger: ReviewBundlerLogger;
  /** Override the default 60s debounce (used in tests). */
  debounceMs?: number;
  /**
   * Optional db for pr_instance_index + agents lookups. When present, the
   * flush handler resolves the owning agent for each PR and applies its
   * `reviewLoop` config (enabled toggle, ignoreReviewers, triggerReviewers,
   * ignoreWorkflows). When absent, all bundles pass through unfiltered —
   * older deployments keep working.
   */
  db?: Database;
  /**
   * Optional fallback lookup for agent reviewLoop config. Called only when
   * `db.agents` is missing — YAML-only deployments should wire this so
   * configuration from ouija.config.yaml still gates the loop. Accepts the
   * agentId and returns the config or undefined.
   */
  getAgentReviewLoop?: (agentId: string) => ReviewLoopFilterConfig | undefined;
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
        const filtered = await applyReviewLoopFilter(bundle, opts);
        if (filtered === null) {
          opts.logger.info('review-loop: bundle filtered out (disabled or no matching signals)', {
            prUrl: bundle.prUrl,
          });
          return;
        }
        await opts.orchestrator.processReviewBundle(filtered);
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

/**
 * Resolve the owning agent for a PR and apply its reviewLoop config to a
 * flushed bundle. Order of resolution:
 *   1. db.agents (dashboard-managed, encrypted vault) when migration 003 is
 *      applied and the agent exists.
 *   2. getAgentReviewLoop callback (YAML / legacy) when provided.
 *   3. Permissive default (loop enabled, no filtering).
 *
 * Silently returns the bundle unfiltered when the instance can't be resolved
 * — that's a different failure mode (PR index missing) which the orchestrator
 * logs when processReviewBundle runs.
 */
async function applyReviewLoopFilter(
  bundle: ReviewBundle,
  opts: ReviewLoopOptions,
): Promise<ReviewBundle | null> {
  const db = opts.db;
  if (db === undefined || db.prInstances === undefined) {
    // Can't look up the agent — pass through unchanged; orchestrator may
    // still reject when it can't find the instance either.
    return bundle;
  }

  const instanceIdStr = await db.prInstances.findInstanceByPrUrl(bundle.prUrl);
  if (instanceIdStr === undefined) return bundle;

  const instance = await db.pipelines.findById(
    (await import('@ouija-dev/types')).instanceId(instanceIdStr),
  );
  if (instance === undefined) return bundle;

  // Only awaiting_review pipelines carry an agentId in state. Others fall
  // through — if the orchestrator rejects the transition, no dispatch fires.
  const state = instance.state;
  if (!('agentId' in state) || typeof state.agentId !== 'string') {
    return bundle;
  }
  const agentIdStr = String(state.agentId);

  let reviewLoop: ReviewLoopFilterConfig | undefined;
  if (db.agents !== undefined) {
    try {
      const record = await db.agents.findById(agentIdStr);
      const config = record?.config as { reviewLoop?: ReviewLoopFilterConfig } | undefined;
      reviewLoop = config?.reviewLoop;
    } catch {
      // Agent lookup failed — fall through to YAML callback / defaults.
    }
  }
  if (reviewLoop === undefined && opts.getAgentReviewLoop !== undefined) {
    reviewLoop = opts.getAgentReviewLoop(agentIdStr);
  }

  return filterReviewBundle(bundle, reviewLoop);
}
