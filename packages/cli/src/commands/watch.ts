/**
 * `ouija watch <owner/repo>` — Phase 3 Task 1.
 *
 * Polls GitHub for issues labeled with `ouija` and for issue/PR comments
 * mentioning `@ouija`. Each new match is converted into a `manual_dispatch`
 * trigger via `POST /api/v1/pipelines/dispatch` on the running Ouija
 * server (the v0.4.1 first-class admin route). This is the headline
 * onboarding path for v0.5.0 — kanban becomes optional, friction-log
 * items #19 + #20 disappear because the operator never has to wire a
 * webhook.
 *
 * Design notes:
 * - **Stateless dedup.** An in-memory `Set<string>` of dispatched keys
 *   prevents re-dispatching on every poll. The set is seeded on the first
 *   tick with whatever already matches, so issues that had the label
 *   *before* `ouija watch` started don't fire — only newly-labeled issues
 *   and freshly-posted mentions do. Restarting `watch` re-seeds; if the
 *   server already has a pipeline for an old issue, that pipeline is
 *   unaffected.
 * - **Two GitHub endpoints.** `GET /repos/{o}/{r}/issues?labels=…` for
 *   the label half; `GET /repos/{o}/{r}/issues/comments?since=…` for
 *   mentions. Both are stable REST v3, no octokit dependency.
 * - **`--dry-run` first.** Per the phase note's sequencing hint: the
 *   dry-run path validates the GitHub auth + label parsing + mention
 *   detection without dispatching. Once green, `--dry-run` flips off
 *   and the same path POSTs to `/api/v1/pipelines/dispatch`.
 * - **No surprise deps.** Plain `fetch` against GitHub + Ouija APIs.
 *   The CLI's "no CLI framework" stance from index.ts holds.
 * - **Pure helpers extracted** for unit testing — `parseWatchArgs`,
 *   `findLabelMatches`, `findMentionMatches` are I/O-free; the loop
 *   only wires them to fetch + setTimeout.
 */

import { log, die } from '../lib/logger.js';

// ---- Pure types + helpers (unit-tested) ----

export interface WatchConfig {
  owner: string;
  repo: string;
  label: string;
  mention: string;
  pollIntervalMs: number;
  dryRun: boolean;
  serverUrl: string;
  apiKey: string;
  githubPat: string;
  agentId: string;
  boardId: string | undefined;
  /**
   * Whether the loop applies the {@link POLL_BACKOFF_MULTIPLIERS} ladder
   * on quiet ticks. Default `true`. Disabled by setting
   * `OUIJA_POLL_BACKOFF=off` (or `0` / `false` / `disabled`) in the env.
   * Disable when watching a high-activity repo where every minute
   * matters more than the GitHub rate-limit budget.
   */
  backoffEnabled: boolean;
}

export type WatchSource = 'label' | 'mention';

export interface WatchMatch {
  /** Dedup key — `issue:<number>` or `comment:<id>`. Stable across polls. */
  key: string;
  source: WatchSource;
  /** Human-meaningful task title forwarded to the dispatch endpoint. */
  title: string;
  /** Free-form description forwarded to the dispatch endpoint. */
  description: string;
  /** GitHub URL for the originating issue/comment, used in log lines. */
  refUrl: string;
}

/**
 * Minimal structural shape of the GitHub `issues` REST response we care
 * about. Defined here so the matchers don't need an octokit type-import.
 */
export interface GhIssueLike {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  pull_request?: unknown;
}

/**
 * Minimal structural shape of the GitHub `issues/comments` REST response.
 */
export interface GhCommentLike {
  id: number;
  body: string;
  html_url: string;
  issue_url: string;
}

interface ParseResult {
  ok: true;
  config: WatchConfig;
}

interface ParseError {
  ok: false;
  error: string;
}

const DEFAULT_LABEL = 'ouija';
const DEFAULT_MENTION = '@ouija';
const DEFAULT_POLL_SECONDS = 30;
const MIN_POLL_SECONDS = 5;
const DEFAULT_SERVER_URL = 'http://localhost:4000';

/**
 * Backoff ladder applied as multipliers on `pollIntervalMs`. After every
 * tick that produces no activity (no new matches AND no comments fetched),
 * the level advances one rung; any activity resets to 0.
 *
 * For the default 30s base interval, this maps to 30s → 60s → 120s → 300s,
 * matching the phase note's spec. For non-default bases, the proportions
 * stay the same so the human-meaningful "5 minutes between polls when the
 * repo is quiet" property holds at any reasonable base.
 */
export const POLL_BACKOFF_MULTIPLIERS: readonly number[] = [1, 2, 4, 10];

/**
 * Parse `ouija watch` argv + env into a validated config. Pure; returns
 * a discriminated union so callers can format error messages without
 * the helper touching stdout/stderr.
 */
export function parseWatchArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseResult | ParseError {
  let ownerRepo: string | undefined;
  let label = DEFAULT_LABEL;
  let mention = DEFAULT_MENTION;
  let pollSeconds = DEFAULT_POLL_SECONDS;
  let dryRun = false;
  let serverUrl: string | undefined;
  let agentId: string | undefined;
  let boardId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--label' || arg === '--mention' || arg === '--poll-interval' ||
        arg === '--server' || arg === '--agent' || arg === '--board') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ok: false, error: `${arg} requires a value` };
      }
      i++;
      switch (arg) {
        case '--label':
          label = value;
          break;
        case '--mention':
          mention = value.startsWith('@') ? value : `@${value}`;
          break;
        case '--poll-interval': {
          const n = Number(value);
          if (!Number.isFinite(n) || n < MIN_POLL_SECONDS) {
            return {
              ok: false,
              error: `--poll-interval must be a number ≥ ${MIN_POLL_SECONDS} (seconds); got "${value}"`,
            };
          }
          pollSeconds = n;
          break;
        }
        case '--server':
          serverUrl = value.replace(/\/+$/, '');
          break;
        case '--agent':
          agentId = value;
          break;
        case '--board':
          boardId = value;
          break;
      }
      continue;
    }
    if (arg.startsWith('-')) {
      return { ok: false, error: `unknown flag: ${arg}` };
    }
    if (ownerRepo === undefined) {
      ownerRepo = arg;
      continue;
    }
    return { ok: false, error: `unexpected positional argument: ${arg}` };
  }

  if (ownerRepo === undefined) {
    return { ok: false, error: 'missing required argument: <owner/repo>' };
  }
  const slash = ownerRepo.indexOf('/');
  if (slash <= 0 || slash === ownerRepo.length - 1) {
    return { ok: false, error: `<owner/repo> must look like "octocat/Hello-World"; got "${ownerRepo}"` };
  }
  const owner = ownerRepo.slice(0, slash);
  const repo = ownerRepo.slice(slash + 1);

  if (agentId === undefined || agentId.trim().length === 0) {
    return {
      ok: false,
      error: '--agent <agentId> is required (which agent profile dispatches the matched issues?)',
    };
  }

  const githubPat = env['GITHUB_PAT'] ?? env['GH_TOKEN'];
  if (githubPat === undefined || githubPat.length === 0) {
    return {
      ok: false,
      error: 'GITHUB_PAT (or GH_TOKEN) env var is required so `ouija watch` can poll GitHub',
    };
  }

  const apiKey = env['OUIJA_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    return {
      ok: false,
      error: 'OUIJA_API_KEY env var is required so `ouija watch` can dispatch via the server',
    };
  }

  return {
    ok: true,
    config: {
      owner,
      repo,
      label,
      mention,
      pollIntervalMs: pollSeconds * 1000,
      dryRun,
      serverUrl: serverUrl ?? env['OUIJA_SERVER_URL']?.replace(/\/+$/, '') ?? DEFAULT_SERVER_URL,
      apiKey,
      githubPat,
      agentId: agentId.trim(),
      boardId,
      backoffEnabled: parseBackoffEnv(env['OUIJA_POLL_BACKOFF']),
    },
  };
}

/**
 * Read the `OUIJA_POLL_BACKOFF` env var. Default-on; opted out by the
 * common "disabled" idioms operators reach for. Anything else (including
 * unset) keeps backoff enabled. Pure for unit tests.
 */
export function parseBackoffEnv(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'off' || v === '0' || v === 'false' || v === 'disabled' || v === 'no') {
    return false;
  }
  return true;
}

/**
 * Compute the next backoff level given the current level + whether the
 * tick produced activity. Activity always resets to 0; quiet advances by
 * one rung up to the ladder length minus one. When `enabled` is false,
 * the level stays at 0 regardless. Pure; the loop wires it.
 */
export function nextBackoffLevel(
  current: number,
  hadActivity: boolean,
  enabled: boolean,
  maxLevel: number = POLL_BACKOFF_MULTIPLIERS.length - 1,
): number {
  if (!enabled) return 0;
  if (hadActivity) return 0;
  if (current < 0) return 0;
  if (current >= maxLevel) return maxLevel;
  return current + 1;
}

/**
 * Resolve the effective sleep duration for the current backoff level
 * against the operator's configured base interval. Same multipliers
 * regardless of base so a `--poll-interval 60` user gets 60 → 120 → 240
 * → 600 (mirroring the default ladder's proportions, not its absolute
 * cap). Returns `pollIntervalMs` unchanged when level is 0.
 */
export function effectivePollMs(pollIntervalMs: number, level: number): number {
  const safeLevel = Math.max(0, Math.min(level, POLL_BACKOFF_MULTIPLIERS.length - 1));
  return pollIntervalMs * (POLL_BACKOFF_MULTIPLIERS[safeLevel] ?? 1);
}

/**
 * Filter GitHub issues against the dedup set. Skips PRs (the issues
 * endpoint includes them by default) — those are the review-loop's
 * problem, not the watch daemon's. Returns one match per new issue.
 */
export function findLabelMatches(
  issues: readonly GhIssueLike[],
  processedKeys: ReadonlySet<string>,
): WatchMatch[] {
  const out: WatchMatch[] = [];
  for (const issue of issues) {
    if (issue.pull_request !== undefined) continue;
    const key = `issue:${issue.number}`;
    if (processedKeys.has(key)) continue;
    out.push({
      key,
      source: 'label',
      title: issue.title,
      description: typeof issue.body === 'string' && issue.body.trim().length > 0
        ? issue.body
        : `(no description on issue #${issue.number})`,
      refUrl: issue.html_url,
    });
  }
  return out;
}

/**
 * Filter GitHub issue/PR comments against the dedup set + a case-insensitive
 * mention substring. The mention check is plain `includes` rather than a
 * word-boundary regex so users typing `@ouija!` or `@ouija,` still trigger.
 * Title is the first 80 chars of the comment body for log readability.
 */
export function findMentionMatches(
  comments: readonly GhCommentLike[],
  mention: string,
  processedKeys: ReadonlySet<string>,
): WatchMatch[] {
  const needle = mention.toLowerCase();
  const out: WatchMatch[] = [];
  for (const comment of comments) {
    const body = comment.body ?? '';
    if (!body.toLowerCase().includes(needle)) continue;
    const key = `comment:${comment.id}`;
    if (processedKeys.has(key)) continue;
    const firstLine = body.split('\n', 1)[0]?.trim() ?? '';
    const title = firstLine.length === 0
      ? `Mention in comment ${comment.id}`
      : firstLine.length > 80
        ? `${firstLine.slice(0, 77)}…`
        : firstLine;
    out.push({
      key,
      source: 'mention',
      title,
      description: body,
      refUrl: comment.html_url,
    });
  }
  return out;
}

// ---- Wired loop (not unit-tested) ----

interface PollClock {
  /** Returns the current ISO-8601 instant. Injectable for tests. */
  now(): string;
  /** Sleep `ms` milliseconds. Returns a promise. */
  sleep(ms: number): Promise<void>;
}

const realClock: PollClock = {
  now: () => new Date().toISOString(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function fetchLabeledIssues(
  config: WatchConfig,
): Promise<GhIssueLike[]> {
  const url = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues?state=open&labels=${encodeURIComponent(config.label)}&per_page=50`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.githubPat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ouija-watch',
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${response.status} ${response.statusText} on labeled-issues fetch (${url})`,
    );
  }
  return (await response.json()) as GhIssueLike[];
}

async function fetchCommentsSince(
  config: WatchConfig,
  sinceIso: string,
): Promise<GhCommentLike[]> {
  const url = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues/comments?since=${encodeURIComponent(sinceIso)}&per_page=50`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.githubPat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ouija-watch',
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${response.status} ${response.statusText} on comments-since fetch (${url})`,
    );
  }
  return (await response.json()) as GhCommentLike[];
}

async function dispatchOne(config: WatchConfig, match: WatchMatch): Promise<void> {
  const url = `${config.serverUrl}/api/v1/pipelines/dispatch`;
  const body = {
    agentId: config.agentId,
    title: match.title,
    description: `${match.description}\n\n— from ${match.refUrl} via ouija watch (source: ${match.source})`,
    requestedBy: `ouija-watch:${config.owner}/${config.repo}`,
    ...(config.boardId !== undefined ? { boardId: config.boardId } : {}),
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const err = (await response.json()) as { error?: { code?: string; message?: string } };
      if (err.error?.code !== undefined || err.error?.message !== undefined) {
        detail = `${err.error?.code ?? 'unknown'}: ${err.error?.message ?? ''}`;
      }
    } catch {
      /* keep statusText */
    }
    throw new Error(`dispatch failed (${response.status}): ${detail}`);
  }
}

export async function runWatch(
  argv: readonly string[],
  options: { clock?: PollClock; signal?: AbortSignal } = {},
): Promise<number> {
  const parsed = parseWatchArgs(argv, process.env);
  if (!parsed.ok) {
    log.error(parsed.error);
    log.dim('  Usage: ouija watch <owner/repo> --agent <agentId> [--label ouija] [--mention @ouija] [--poll-interval 30] [--server http://localhost:4000] [--board <id>] [--dry-run]');
    return 1;
  }
  const config = parsed.config;
  const clock = options.clock ?? realClock;
  const signal = options.signal;

  log.step(`ouija watch ${config.owner}/${config.repo}`);
  log.info(`agent: ${config.agentId}${config.boardId !== undefined ? ` · board: ${config.boardId}` : ''}`);
  log.info(`label: ${config.label} · mention: ${config.mention} · poll: ${config.pollIntervalMs / 1000}s${config.backoffEnabled ? '' : ' (backoff: off)'}`);
  log.info(`server: ${config.serverUrl}`);
  if (config.dryRun) {
    log.warn('DRY RUN — matches will be logged but not dispatched');
  }

  const processedKeys = new Set<string>();
  let lastCommentPollIso = clock.now();
  let firstTick = true;
  let backoffLevel = 0;

  while (signal === undefined || !signal.aborted) {
    let tickHadActivity = false;
    try {
      const tickStart = clock.now();
      const issues = await fetchLabeledIssues(config);
      const comments = await fetchCommentsSince(config, lastCommentPollIso);
      lastCommentPollIso = tickStart;

      const labelMatches = findLabelMatches(issues, processedKeys);
      const mentionMatches = findMentionMatches(comments, config.mention, processedKeys);
      const newMatches = [...labelMatches, ...mentionMatches];

      // "Activity" for backoff purposes = any new matches OR any comments
      // since last poll. The latter signals genuine repo motion even when
      // nothing matched our label/mention — avoids the "quiet repo with
      // active maintainers" edge case where backoff would mute the loop
      // for legitimate work.
      tickHadActivity = newMatches.length > 0 || comments.length > 0;

      if (firstTick) {
        // Seed dedup with whatever currently matches so we don't fire on
        // pre-existing labels. The set picks up new keys on subsequent ticks.
        for (const m of newMatches) processedKeys.add(m.key);
        log.info(`seeded ${newMatches.length} pre-existing match(es); not dispatching`);
        firstTick = false;
      } else if (newMatches.length === 0) {
        log.dim(`tick ${tickStart} — no new matches`);
      } else {
        for (const match of newMatches) {
          if (config.dryRun) {
            log.info(`[dry-run] would dispatch ${match.source}: ${match.title} (${match.refUrl})`);
            processedKeys.add(match.key);
            continue;
          }
          try {
            await dispatchOne(config, match);
            processedKeys.add(match.key);
            log.success(`dispatched ${match.source}: ${match.title} (${match.refUrl})`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`dispatch failed for ${match.refUrl} — ${msg}`);
            // Don't add to processedKeys; the next tick will retry.
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`poll error — ${msg}`);
      // Treat a fetch error as quiet — same backoff behaviour applies so
      // a sustained outage doesn't burn rate-limit budget retrying every
      // base interval.
      tickHadActivity = false;
    }

    // First tick is always "quiet for backoff purposes" because we just
    // seeded — nothing dispatched, so don't reset the level yet.
    const previousLevel = backoffLevel;
    backoffLevel = nextBackoffLevel(backoffLevel, tickHadActivity, config.backoffEnabled);
    if (config.backoffEnabled && backoffLevel !== previousLevel) {
      const newSleepSec = effectivePollMs(config.pollIntervalMs, backoffLevel) / 1000;
      if (backoffLevel > previousLevel) {
        log.dim(`quiet — backing off to ${newSleepSec}s`);
      } else {
        log.dim(`activity resumed — back to base ${newSleepSec}s`);
      }
    }

    if (signal?.aborted) break;
    await clock.sleep(effectivePollMs(config.pollIntervalMs, backoffLevel));
  }

  log.info('ouija watch stopped');
  return 0;
}

/**
 * Suppress unused-import warning for `die`. Kept available for callers
 * that want to bail on a malformed runtime in the future.
 */
void die;
