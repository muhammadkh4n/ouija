import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OuijaEvent, StandardPR, GitPrOpenedPayload, GitPrMergedPayload } from '@ouija/types';
import { prId, instanceId } from '@ouija/types';
import { encodePrId } from './api-client.js';

// ---- GitHub webhook payload shapes (only the fields we need) ----

interface GitHubRepo {
  full_name: string;
  html_url: string;
  name: string;
  owner: { login: string };
}

interface GitHubPR {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  head: { ref: string };
  base: { ref: string };
}

interface PullRequestPayload {
  action: string;
  pull_request: GitHubPR;
  repository: GitHubRepo;
  installation?: { id: number };
}

// ---- Signature verification ----

/**
 * Compute the expected HMAC-SHA256 signature for a raw webhook body.
 * Returns the value in the format GitHub sends: "sha256=<hex>".
 */
export function computeSignature(secret: string, rawBody: string | Buffer): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(typeof rawBody === 'string' ? rawBody : rawBody);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Verify the X-Hub-Signature-256 header against the raw request body.
 * Uses timingSafeEqual to prevent timing attacks.
 *
 * Returns true if the signature matches, false otherwise.
 */
export function verifySignature(
  secret: string,
  rawBody: string | Buffer,
  signatureHeader: string,
): boolean {
  const expected = computeSignature(secret, rawBody);

  try {
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(signatureHeader, 'utf8');

    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }

    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

// ---- Payload normalizer ----

/**
 * Normalize a raw GitHub webhook into an OuijaEvent.
 *
 * Supported mappings:
 *   pull_request / opened   → git.pr.opened
 *   pull_request / closed (merged: true) → git.pr.merged
 *
 * All other events/actions return null (caller should 200 OK and discard).
 */
export function normalizeWebhook(
  githubEvent: string,
  payload: unknown,
): OuijaEvent<'git.pr.opened'> | OuijaEvent<'git.pr.merged'> | null {
  if (githubEvent !== 'pull_request') {
    return null;
  }

  const typed = payload as PullRequestPayload;
  const { action, pull_request: pr, repository: repo } = typed;

  const owner = repo.owner.login;
  const repoName = repo.name;
  const encodedPrId = encodePrId(owner, repoName, pr.number);

  if (action === 'opened') {
    const eventPayload: GitPrOpenedPayload = {
      prId: encodedPrId,
      url: pr.html_url,
      // instanceId is not available from a bare webhook — callers that
      // need it will correlate by prId. We generate a placeholder here.
      instanceId: instanceId(`github-pr-${String(pr.number)}`),
      branch: pr.head.ref,
      targetBranch: pr.base.ref,
    };

    return buildEvent('git.pr.opened', eventPayload);
  }

  if (action === 'closed' && pr.merged === true) {
    const mergedAt = pr.merged_at ?? new Date().toISOString();

    const eventPayload: GitPrMergedPayload = {
      prId: encodedPrId,
      instanceId: instanceId(`github-pr-${String(pr.number)}`),
      mergedAt,
    };

    return buildEvent('git.pr.merged', eventPayload);
  }

  // PR closed without merge, or any other action (synchronize, review_requested, etc.)
  return null;
}

/**
 * Build a StandardPR from a GitHub pull_request payload object.
 * Exported so the main plugin can use it when returning from openPR.
 */
export function normalizePR(pr: GitHubPR, owner: string, repoName: string): StandardPR {
  let state: StandardPR['state'];
  if (pr.merged) {
    state = 'merged';
  } else if (pr.state === 'closed') {
    state = 'closed';
  } else {
    state = 'open';
  }

  return {
    id: prId(encodePrId(owner, repoName, pr.number)),
    url: pr.html_url,
    title: pr.title,
    body: pr.body ?? '',
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    state,
    draft: pr.draft,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    ...(pr.merged_at ? { mergedAt: pr.merged_at } : {}),
  };
}

// ---- Internal helpers ----

function buildEvent<T extends 'git.pr.opened' | 'git.pr.merged'>(
  topic: T,
  payload: T extends 'git.pr.opened' ? GitPrOpenedPayload : GitPrMergedPayload,
): OuijaEvent<T> {
  return {
    id: crypto.randomUUID(),
    topic,
    payload,
    timestamp: new Date().toISOString(),
    sourcePlugin: '@ouija/plugin-github',
    correlationId: crypto.randomUUID(),
  } as OuijaEvent<T>;
}
