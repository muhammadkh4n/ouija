import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  OuijaEvent,
  StandardPR,
  GitPrOpenedPayload,
  GitPrMergedPayload,
  GitPrReviewSubmittedPayload,
  GitPrCommentPostedPayload,
  GitCiFailedPayload,
} from '@ouija-dev/types';
import { prId, instanceId } from '@ouija-dev/types';
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

// ---- Review + comment webhook shapes ----
// These power the review loop (see ~/.claude/plans/zesty-swinging-whistle.md).

interface GitHubUser {
  login: string;
}

interface GitHubReview {
  id: number;
  user: GitHubUser;
  body: string | null;
  /** GitHub sends uppercase; normalised on read. */
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at: string | null;
  html_url: string;
}

interface PullRequestReviewPayload {
  action: string;
  review: GitHubReview;
  pull_request: GitHubPR;
  repository: GitHubRepo;
}

interface GitHubReviewComment {
  id: number;
  user: GitHubUser;
  body: string;
  path: string;
  line: number | null;
  created_at: string;
}

interface PullRequestReviewCommentPayload {
  action: string;
  comment: GitHubReviewComment;
  pull_request: GitHubPR;
  repository: GitHubRepo;
}

interface GitHubIssueComment {
  id: number;
  user: GitHubUser;
  body: string;
  created_at: string;
  /** Present on issue_comment payloads to distinguish issue vs PR comments. */
  html_url: string;
}

interface IssueCommentPayload {
  action: string;
  comment: GitHubIssueComment;
  /**
   * When `issue_comment` is delivered for a PR, GitHub still sends
   * `issue.pull_request` as a marker. We use its presence to filter out true
   * issue comments from PR comments.
   */
  issue: {
    number: number;
    pull_request?: { url: string; html_url: string };
    html_url: string;
  };
  repository: GitHubRepo;
}

// ---- Check-run / workflow-run webhook shapes (CI failure loop) ----

interface GitHubCheckRunPullRef {
  number: number;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface GitHubCheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
  html_url: string;
  details_url?: string;
  output?: {
    title?: string | null;
    summary?: string | null;
  };
  check_suite?: {
    id: number;
    head_branch?: string | null;
    head_sha?: string;
    pull_requests?: GitHubCheckRunPullRef[];
  };
  pull_requests?: GitHubCheckRunPullRef[];
}

interface CheckRunPayload {
  action: string;
  check_run: GitHubCheckRun;
  repository: GitHubRepo;
}

interface GitHubWorkflowRun {
  id: number;
  name: string;
  head_sha: string;
  conclusion: string | null;
  html_url: string;
  logs_url?: string;
  updated_at: string;
  pull_requests?: GitHubCheckRunPullRef[];
}

interface WorkflowRunPayload {
  action: string;
  workflow_run: GitHubWorkflowRun;
  repository: GitHubRepo;
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

type ReviewState = GitPrReviewSubmittedPayload['state'];

/** GitHub sends UPPERCASE states; normalise to the lowercase union our types use. */
function normaliseReviewState(raw: GitHubReview['state']): ReviewState | null {
  switch (raw) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'COMMENTED':
      return 'commented';
    case 'DISMISSED':
    case 'PENDING':
      // Dismissed reviews don't affect the loop — they just retract prior
      // feedback. Pending reviews haven't been submitted yet and GitHub will
      // re-fire when they are. Both are dropped here.
      return null;
  }
}

/**
 * Normalize a raw GitHub webhook into an OuijaEvent.
 *
 * Supported mappings:
 *   pull_request / opened                   → git.pr.opened
 *   pull_request / closed (merged: true)    → git.pr.merged
 *   pull_request_review / submitted         → git.pr.review.submitted
 *   pull_request_review_comment / created   → git.pr.comment.posted
 *   issue_comment / created (on a PR)       → git.pr.comment.posted
 *   check_run / completed (failure-class)   → git.ci.failed
 *   workflow_run / completed (failure-class)→ git.ci.failed
 *
 * All other events/actions return null (caller should 200 OK and discard).
 */
export function normalizeWebhook(
  githubEvent: string,
  payload: unknown,
):
  | OuijaEvent<'git.pr.opened'>
  | OuijaEvent<'git.pr.merged'>
  | OuijaEvent<'git.pr.review.submitted'>
  | OuijaEvent<'git.pr.comment.posted'>
  | OuijaEvent<'git.ci.failed'>
  | null {
  switch (githubEvent) {
    case 'pull_request':
      return normalisePullRequestEvent(payload as PullRequestPayload);
    case 'pull_request_review':
      return normalisePullRequestReviewEvent(payload as PullRequestReviewPayload);
    case 'pull_request_review_comment':
      return normalisePullRequestReviewCommentEvent(
        payload as PullRequestReviewCommentPayload,
      );
    case 'issue_comment':
      return normaliseIssueCommentEvent(payload as IssueCommentPayload);
    case 'check_run':
      return normaliseCheckRunEvent(payload as CheckRunPayload);
    case 'workflow_run':
      return normaliseWorkflowRunEvent(payload as WorkflowRunPayload);
    default:
      return null;
  }
}

function normalisePullRequestEvent(
  typed: PullRequestPayload,
): OuijaEvent<'git.pr.opened'> | OuijaEvent<'git.pr.merged'> | null {
  const { action, pull_request: pr, repository: repo } = typed;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const encodedPrId = encodePrId(owner, repoName, pr.number);

  if (action === 'opened') {
    const eventPayload: GitPrOpenedPayload = {
      prId: encodedPrId,
      url: pr.html_url,
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

  return null;
}

function normalisePullRequestReviewEvent(
  typed: PullRequestReviewPayload,
): OuijaEvent<'git.pr.review.submitted'> | null {
  if (typed.action !== 'submitted') return null;

  const state = normaliseReviewState(typed.review.state);
  if (state === null) return null;

  const { pull_request: pr, repository: repo, review } = typed;
  const encodedPrId = encodePrId(repo.owner.login, repo.name, pr.number);

  const eventPayload: GitPrReviewSubmittedPayload = {
    prUrl: pr.html_url,
    prId: encodedPrId,
    reviewId: String(review.id),
    state,
    reviewerLogin: review.user.login,
    body: review.body ?? '',
    submittedAt: review.submitted_at ?? new Date().toISOString(),
  };
  return buildEvent('git.pr.review.submitted', eventPayload);
}

function normalisePullRequestReviewCommentEvent(
  typed: PullRequestReviewCommentPayload,
): OuijaEvent<'git.pr.comment.posted'> | null {
  if (typed.action !== 'created') return null;

  const { pull_request: pr, repository: repo, comment } = typed;
  const encodedPrId = encodePrId(repo.owner.login, repo.name, pr.number);

  const payload: GitPrCommentPostedPayload = {
    prUrl: pr.html_url,
    prId: encodedPrId,
    commentId: String(comment.id),
    reviewerLogin: comment.user.login,
    body: comment.body,
    path: comment.path,
    postedAt: comment.created_at,
  };
  if (comment.line !== null) payload.line = comment.line;

  return buildEvent('git.pr.comment.posted', payload);
}

function normaliseIssueCommentEvent(
  typed: IssueCommentPayload,
): OuijaEvent<'git.pr.comment.posted'> | null {
  if (typed.action !== 'created') return null;
  // Filter out true issue comments — GitHub sends issue_comment for both
  // issues and PRs and the only reliable discriminator is issue.pull_request.
  const pullRequestRef = typed.issue.pull_request;
  if (pullRequestRef === undefined) return null;

  const { issue, repository: repo, comment } = typed;
  const encodedPrId = encodePrId(repo.owner.login, repo.name, issue.number);

  const payload: GitPrCommentPostedPayload = {
    // issue.html_url on a PR comment points at the PR conversation anchor;
    // the pull_request.html_url attribute isn't on this event.
    prUrl: pullRequestRef.html_url,
    prId: encodedPrId,
    commentId: String(comment.id),
    reviewerLogin: comment.user.login,
    body: comment.body,
    postedAt: comment.created_at,
  };
  return buildEvent('git.pr.comment.posted', payload);
}

// ---- CI failure normalisers ----

type CiConclusion = GitCiFailedPayload['conclusion'];

function mapCiConclusion(raw: string | null): CiConclusion | null {
  switch (raw) {
    case 'failure':
      return 'failure';
    case 'timed_out':
      return 'timed_out';
    case 'action_required':
      return 'action_required';
    // success / neutral / skipped / cancelled → no re-dispatch signal.
    default:
      return null;
  }
}

function normaliseCheckRunEvent(
  typed: CheckRunPayload,
): OuijaEvent<'git.ci.failed'> | null {
  if (typed.action !== 'completed') return null;

  const conclusion = mapCiConclusion(typed.check_run.conclusion);
  if (conclusion === null) return null;

  const prRef = findPrRef(typed.check_run.pull_requests, typed.check_run.check_suite?.pull_requests);
  if (prRef === null) {
    // Cross-repo PR or orphan check — no PR to attach to.
    return null;
  }

  const { repository: repo, check_run: run } = typed;
  const encodedPrId = encodePrId(repo.owner.login, repo.name, prRef.number);
  const workflowName = run.check_suite?.head_branch ? 'check_suite' : run.name;

  const payload: GitCiFailedPayload = {
    prUrl: prRef.html_url,
    prId: encodedPrId,
    checkId: `github-actions:${String(run.id)}:${run.name}`,
    provider: 'github-actions',
    workflowName,
    jobName: run.name,
    conclusion,
    headSha: run.head_sha,
    completedAt: run.completed_at ?? new Date().toISOString(),
  };
  if (run.details_url !== undefined) payload.logsUrl = run.details_url;
  else if (run.html_url) payload.logsUrl = run.html_url;
  if (run.output?.summary !== undefined && run.output.summary !== null && run.output.summary !== '') {
    payload.summary = run.output.summary;
  }
  return buildEvent('git.ci.failed', payload);
}

function normaliseWorkflowRunEvent(
  typed: WorkflowRunPayload,
): OuijaEvent<'git.ci.failed'> | null {
  if (typed.action !== 'completed') return null;

  const conclusion = mapCiConclusion(typed.workflow_run.conclusion);
  if (conclusion === null) return null;

  const prRef = findPrRef(typed.workflow_run.pull_requests);
  if (prRef === null) return null;

  const { repository: repo, workflow_run: run } = typed;
  const encodedPrId = encodePrId(repo.owner.login, repo.name, prRef.number);

  const payload: GitCiFailedPayload = {
    prUrl: prRef.html_url,
    prId: encodedPrId,
    // workflow_run IDs are distinct from check_run IDs; the namespace keeps
    // the two channels from colliding in the bundler's dedupe map when both
    // fire for the same job.
    checkId: `github-actions:workflow:${String(run.id)}`,
    provider: 'github-actions',
    workflowName: run.name,
    jobName: run.name,
    conclusion,
    headSha: run.head_sha,
    completedAt: run.updated_at,
  };
  if (run.logs_url !== undefined) payload.logsUrl = run.logs_url;
  else if (run.html_url) payload.logsUrl = run.html_url;
  return buildEvent('git.ci.failed', payload);
}

/**
 * Pick the first attached PR ref from the webhook. Accepts multiple arrays
 * because check_run puts them under `check_run.pull_requests` but
 * check_suite-style payloads use `check_run.check_suite.pull_requests`.
 * Returns null when none are present (happens for forks + release-branch
 * pushes that don't correspond to an open PR).
 */
function findPrRef(
  ...arrays: Array<GitHubCheckRunPullRef[] | undefined>
): GitHubCheckRunPullRef | null {
  for (const arr of arrays) {
    if (arr !== undefined && arr.length > 0 && arr[0] !== undefined) {
      return arr[0];
    }
  }
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

type GitHubTopic =
  | 'git.pr.opened'
  | 'git.pr.merged'
  | 'git.pr.review.submitted'
  | 'git.pr.comment.posted'
  | 'git.ci.failed';

type GitHubTopicPayload<T extends GitHubTopic> = T extends 'git.pr.opened'
  ? GitPrOpenedPayload
  : T extends 'git.pr.merged'
  ? GitPrMergedPayload
  : T extends 'git.pr.review.submitted'
  ? GitPrReviewSubmittedPayload
  : T extends 'git.pr.comment.posted'
  ? GitPrCommentPostedPayload
  : GitCiFailedPayload;

function buildEvent<T extends GitHubTopic>(
  topic: T,
  payload: GitHubTopicPayload<T>,
): OuijaEvent<T> {
  return {
    id: crypto.randomUUID(),
    topic,
    payload,
    timestamp: new Date().toISOString(),
    sourcePlugin: '@ouija-dev/plugin-github',
    correlationId: crypto.randomUUID(),
  } as OuijaEvent<T>;
}
