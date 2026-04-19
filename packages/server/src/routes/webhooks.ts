/**
 * Webhook ingress routes (spec §5.5):
 *
 *   POST /hooks/plane/:secret  — Plane webhook with HMAC (X-Plane-Signature)
 *   POST /hooks/github/:secret — GitHub webhook with HMAC (X-Hub-Signature-256)
 *
 * Security rules:
 *   1. Path secret check first (cheap filter — secret is the workspace-specific token)
 *   2. HMAC signature verification (primary auth)
 *   3. Timestamp validation: reject webhooks older than 5 minutes
 *   4. Deduplication: 7-day TTL via DB deduplication store
 *   5. Always return 200 — even on auth failure, to prevent path enumeration
 *   6. Body size limit: 1MB (set at Fastify level)
 *   7. Rate-limited: 100/min per IP (silently dropped on exceed, still 200)
 *
 * The actual event processing is delegated to the Orchestrator via the event bus.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Orchestrator } from '@ouija-dev/engine';
import type { Database, OuijaEvent } from '@ouija-dev/types';
import { randomUUID } from 'node:crypto';
import { normalizeWebhook as normalizePlaneWebhook } from '@ouija-dev/plugin-plane/webhook-handler';
import { normalizeWebhook as normalizeGitHubWebhook } from '@ouija-dev/plugin-github/webhook-handler';

const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface WebhookRouteOptions {
  orchestrator: Orchestrator;
  db: Database;
  /**
   * Event bus for republishing review-loop events (git.pr.review.submitted,
   * git.pr.comment.posted). The review bundler subscribes here. Required for
   * the review loop; without it, those event types are silently dropped.
   */
  eventBus?: import('@ouija-dev/bus').EventBus;
  /** Expected path secrets — map from token → workspace info. For v1: single secret from env. */
  planeWebhookSecret?: string;
  githubWebhookSecret?: string;
  /**
   * Optional tracker — called after signature verification passes. Powers the
   * dashboard's "last webhook received" indicator. Omitted in tests.
   */
  activityTracker?: {
    record(source: 'plane' | 'github' | 'fizzy'): void;
  };
}

// ---- HMAC verification helpers ----

function verifyHmacSha256(
  body: Buffer,
  signature: string,
  secret: string,
  prefix: string,
): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const expectedFull = `${prefix}${expected}`;
  try {
    // timingSafeEqual requires same-length buffers
    const a = Buffer.from(expectedFull);
    const b = Buffer.from(signature.padEnd(expectedFull.length, '\0'));
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function getTimestamp(body: unknown): number | null {
  if (
    typeof body === 'object' &&
    body !== null &&
    'timestamp' in body &&
    typeof (body as Record<string, unknown>)['timestamp'] === 'string'
  ) {
    const ts = Date.parse((body as Record<string, unknown>)['timestamp'] as string);
    return isNaN(ts) ? null : ts;
  }
  return null;
}

// ---- Plane webhook ----

async function handlePlaneWebhook(
  request: FastifyRequest<{ Params: { secret: string } }>,
  reply: FastifyReply,
  opts: WebhookRouteOptions,
): Promise<FastifyReply> {
  // Always 200 to prevent enumeration
  const sendOk = () => reply.status(200).send({ ok: true });

  // 1. Path secret check
  const expectedSecret = opts.planeWebhookSecret ?? process.env['PLANE_WEBHOOK_SECRET'];
  if (!expectedSecret || request.params.secret !== expectedSecret) {
    request.log.warn('Plane webhook: invalid path secret');
    return sendOk();
  }

  // 2. HMAC signature check
  const signature = request.headers['x-plane-signature'];
  if (typeof signature !== 'string') {
    request.log.warn('Plane webhook: missing X-Plane-Signature header');
    return sendOk();
  }

  const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    request.log.warn('Plane webhook: raw body not available');
    return sendOk();
  }

  // Plane Community sends raw hex; older versions send "sha256=<hex>"
  const sigToVerify = signature.startsWith('sha256=') ? signature : `sha256=${signature}`;
  if (!verifyHmacSha256(rawBody, sigToVerify, expectedSecret, 'sha256=')) {
    request.log.warn('Plane webhook: HMAC verification failed');
    return sendOk();
  }

  // HMAC passed — record activity so the dashboard indicator turns green even
  // when the payload itself normalises to no event (e.g. an issue field we
  // don't care about).
  opts.activityTracker?.record('plane');

  const body = request.body as Record<string, unknown>;

  // 3. Timestamp validation
  const ts = getTimestamp(body);
  if (ts !== null && Date.now() - ts > WEBHOOK_MAX_AGE_MS) {
    request.log.warn('Plane webhook: stale timestamp, rejecting');
    return sendOk();
  }

  // 4. Deduplication
  const externalEventId = (request.headers['x-plane-delivery'] as string | undefined)
    ?? (body['event_id'] as string | undefined)
    ?? randomUUID();
  try {
    const isDup = await opts.db.deduplication.isDuplicate(externalEventId);
    if (isDup) {
      request.log.info({ externalEventId }, 'Plane webhook: duplicate, skipping');
      return sendOk();
    }
    await opts.db.deduplication.markProcessed(externalEventId, DEDUP_TTL_MS);
  } catch (err) {
    // Dedup store failure is non-fatal — process but log
    request.log.error({ err }, 'Plane webhook: dedup store error, processing anyway');
  }

  // 5. Normalize to OuijaEvent and dispatch (uses plugin-plane's canonical normalizer)
  const event = normalizePlaneWebhook(body);
  if (event) {
    opts.orchestrator.processTrigger(event).catch((err) => {
      request.log.error({ err, externalEventId }, 'Plane webhook: orchestrator error');
    });
  } else {
    request.log.info({ body }, 'Plane webhook: no matching event type, skipping');
  }

  return sendOk();
}

// ---- GitHub webhook ----

async function handleGitHubWebhook(
  request: FastifyRequest<{ Params: { secret: string } }>,
  reply: FastifyReply,
  opts: WebhookRouteOptions,
): Promise<FastifyReply> {
  const sendOk = () => reply.status(200).send({ ok: true });

  // 1. Path secret check
  const expectedSecret = opts.githubWebhookSecret ?? process.env['GITHUB_WEBHOOK_SECRET'];
  if (!expectedSecret || request.params.secret !== expectedSecret) {
    request.log.warn('GitHub webhook: invalid path secret');
    return sendOk();
  }

  // 2. HMAC signature check (X-Hub-Signature-256: sha256=<hex>)
  const signature = request.headers['x-hub-signature-256'];
  if (typeof signature !== 'string') {
    request.log.warn('GitHub webhook: missing X-Hub-Signature-256 header');
    return sendOk();
  }

  const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    request.log.warn('GitHub webhook: raw body not available');
    return sendOk();
  }

  if (!verifyHmacSha256(rawBody, signature, expectedSecret, 'sha256=')) {
    request.log.warn('GitHub webhook: HMAC verification failed');
    return sendOk();
  }

  opts.activityTracker?.record('github');

  const body = request.body as Record<string, unknown>;

  // 3. Deduplication via X-GitHub-Delivery header
  const delivery = request.headers['x-github-delivery'] as string | undefined;
  const externalEventId = delivery ?? randomUUID();

  try {
    const isDup = await opts.db.deduplication.isDuplicate(externalEventId);
    if (isDup) {
      request.log.info({ externalEventId }, 'GitHub webhook: duplicate, skipping');
      return sendOk();
    }
    await opts.db.deduplication.markProcessed(externalEventId, DEDUP_TTL_MS);
  } catch (err) {
    request.log.error({ err }, 'GitHub webhook: dedup store error, processing anyway');
  }

  // 4. Normalize and dispatch via plugin-github's canonical normaliser.
  // Review-loop events (pull_request_review / pull_request_review_comment /
  // issue_comment) are republished on the event bus for the review bundler to
  // consume. PR lifecycle events (opened / merged) go straight to the
  // orchestrator as triggers. The distinction matters because review events
  // don't carry an instanceId — the bundler looks it up via pr_instance_index
  // after the debounce window flushes.
  const ghEvent = request.headers['x-github-event'] as string | undefined;
  const event = normalizeGitHubWebhook(ghEvent ?? '', body);
  if (event) {
    if (
      event.topic === 'git.pr.review.submitted' ||
      event.topic === 'git.pr.comment.posted' ||
      event.topic === 'git.ci.failed'
    ) {
      if (opts.eventBus === undefined) {
        request.log.info(
          { ghEvent, externalEventId },
          'GitHub review-loop event received but no eventBus wired; dropping (loop inactive)',
        );
      } else {
        opts.eventBus.publish(event.topic, event.payload, {
          correlationId: event.correlationId,
          sourcePlugin: event.sourcePlugin,
        }).catch((err) => {
          request.log.error({ err, externalEventId }, 'GitHub webhook: publish review event failed');
        });
      }
    } else {
      opts.orchestrator.processTrigger(event).catch((err) => {
        request.log.error({ err, externalEventId }, 'GitHub webhook: orchestrator error');
      });
    }
  } else {
    request.log.info({ ghEvent }, 'GitHub webhook: no matching event type, skipping');
  }

  return sendOk();
}

/**
 * Extract instanceId from branch name pattern: ouija/<instanceId>
 * Returns null if pattern doesn't match.
 */
function extractInstanceIdFromBranch(branch: string | undefined): string | null {
  if (!branch) return null;
  const match = branch.match(/^ouija\/(.+)$/);
  return match?.[1] ?? null;
}

// ---- Route registration ----

export async function webhookRoutes(
  app: FastifyInstance,
  opts: WebhookRouteOptions,
): Promise<void> {
  // Add raw body capture for HMAC verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      try {
        (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
        const parsed: unknown = JSON.parse((body as Buffer).toString('utf8'));
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post<{ Params: { secret: string } }>(
    '/hooks/plane/:secret',
    {
      config: {
        rateLimit: {
          max: 100,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => `webhook-plane:${req.ip}`,
          // On rate limit exceeded: still return 200 (spec §5.5 rule 3)
          onExceeded: (_req: FastifyRequest, _key: string) => undefined,
        },
      },
    },
    async (request, reply) => {
      return handlePlaneWebhook(request, reply, opts);
    },
  );

  app.post<{ Params: { secret: string } }>(
    '/hooks/github/:secret',
    {
      config: {
        rateLimit: {
          max: 100,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => `webhook-github:${req.ip}`,
          onExceeded: (_req: FastifyRequest, _key: string) => undefined,
        },
      },
    },
    async (request, reply) => {
      return handleGitHubWebhook(request, reply, opts);
    },
  );
}
