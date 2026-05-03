/**
 * `ouija github connect <owner/repo>` — Phase 3 Task 3.
 *
 * Registers (or updates) the `POST /hooks/github/:secret` webhook on the
 * target repo. Closes friction-log #20 — the manual gh-UI / gh-CLI dance
 * + correct event-type checklist disappears; one command produces a
 * working webhook.
 *
 * Idempotent: lists existing hooks and updates the matching `config.url`
 * in place if found, otherwise creates a fresh one. Re-running with the
 * same `--server-url` + secret is safe; re-running with a new
 * `--server-url` (e.g. after a quick-tunnel restart) updates the
 * existing hook's URL atomically — that's the wire that Task 5
 * (quick-tunnel URL churn mitigation) builds on.
 *
 * Implementation: plain `fetch` against the GitHub REST v3 API, same
 * style as `ouija watch`. Bypasses `gh api` for portability + so the
 * test surface stays unit-testable. `ouija doctor` (Task 11) will check
 * `gh auth status` separately for operators who want to use a different
 * auth flow.
 */

import { log } from '../lib/logger.js';

// ---- Pure types + helpers (unit-tested) ----

const DEFAULT_EVENTS: readonly string[] = [
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
  'check_run',
  'pull_request',
];

export interface ConnectConfig {
  owner: string;
  repo: string;
  serverUrl: string;
  secret: string;
  pat: string;
  events: readonly string[];
  /** When true, skip writing — just preview the payload. */
  dryRun: boolean;
}

interface ParseResult {
  ok: true;
  config: ConnectConfig;
}

interface ParseError {
  ok: false;
  error: string;
}

/**
 * Parse argv + env into a validated config. Pure; no I/O.
 */
export function parseConnectArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseResult | ParseError {
  let ownerRepo: string | undefined;
  let serverUrl: string | undefined;
  let secret: string | undefined;
  let pat: string | undefined;
  let events: string[] | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--server-url' || arg === '--secret' || arg === '--pat' || arg === '--events') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ok: false, error: `${arg} requires a value` };
      }
      i++;
      switch (arg) {
        case '--server-url':
          serverUrl = value.replace(/\/+$/, '');
          break;
        case '--secret':
          secret = value;
          break;
        case '--pat':
          pat = value;
          break;
        case '--events':
          events = value.split(',').map((e) => e.trim()).filter((e) => e.length > 0);
          if (events.length === 0) {
            return { ok: false, error: '--events requires a non-empty comma-separated list' };
          }
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

  const resolvedServerUrl = serverUrl ?? env['OUIJA_PUBLIC_URL']?.replace(/\/+$/, '');
  if (resolvedServerUrl === undefined || resolvedServerUrl.length === 0) {
    return {
      ok: false,
      error: '--server-url <url> (or OUIJA_PUBLIC_URL env) is required — the public URL where the Ouija server is reachable',
    };
  }
  if (!/^https?:\/\//.test(resolvedServerUrl)) {
    return {
      ok: false,
      error: `--server-url must start with http:// or https://; got "${resolvedServerUrl}"`,
    };
  }

  const resolvedSecret = secret ?? env['GITHUB_WEBHOOK_SECRET'];
  if (resolvedSecret === undefined || resolvedSecret.length === 0) {
    return {
      ok: false,
      error: '--secret <hex> (or GITHUB_WEBHOOK_SECRET env) is required — used both as the URL path component and the HMAC key',
    };
  }

  const resolvedPat = pat ?? env['GITHUB_PAT'] ?? env['GH_TOKEN'];
  if (resolvedPat === undefined || resolvedPat.length === 0) {
    return {
      ok: false,
      error: '--pat <token> (or GITHUB_PAT / GH_TOKEN env) is required to register the webhook on GitHub',
    };
  }

  return {
    ok: true,
    config: {
      owner,
      repo,
      serverUrl: resolvedServerUrl,
      secret: resolvedSecret,
      pat: resolvedPat,
      events: events ?? DEFAULT_EVENTS,
      dryRun,
    },
  };
}

/**
 * Compose the full webhook URL the GitHub repo will POST to. Matches
 * the server's `POST /hooks/github/:secret` route. The secret is in the
 * path (Fastify routing) AND used as the HMAC key
 * (`X-Hub-Signature-256`).
 */
export function webhookTargetUrl(serverUrl: string, secret: string): string {
  return `${serverUrl}/hooks/github/${encodeURIComponent(secret)}`;
}

/**
 * Body for `POST /repos/{o}/{r}/hooks` and the body-shape `PATCH` accepts
 * for updates. Pure; tested directly.
 */
export function buildHookConfig(config: ConnectConfig): {
  name: 'web';
  active: true;
  events: string[];
  config: { url: string; content_type: 'json'; secret: string; insecure_ssl: '0' };
} {
  return {
    name: 'web',
    active: true,
    events: [...config.events],
    config: {
      url: webhookTargetUrl(config.serverUrl, config.secret),
      content_type: 'json',
      secret: config.secret,
      insecure_ssl: '0',
    },
  };
}

/**
 * Minimal structural shape of a GitHub repo-hook resource we need.
 */
export interface GhHookLike {
  id: number;
  config: { url?: string };
  events?: string[];
}

/**
 * Find an existing hook whose config.url matches the target — the
 * strongest dedup signal. Per-server-URL-change updates land via the
 * caller's `PATCH` once this returns the matching id.
 */
export function findExistingHook(
  hooks: readonly GhHookLike[],
  targetUrl: string,
): GhHookLike | undefined {
  return hooks.find((h) => h.config.url === targetUrl);
}

// ---- Wired ops (not unit-tested) ----

const GH_BASE = 'https://api.github.com';

interface GhApiOpts {
  pat: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
}

async function ghApi<T>(opts: GhApiOpts): Promise<T> {
  const response = await fetch(`${GH_BASE}${opts.path}`, {
    method: opts.method,
    headers: {
      Authorization: `Bearer ${opts.pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ouija-github-connect',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const err = (await response.json()) as { message?: string };
      if (typeof err.message === 'string' && err.message.length > 0) detail = err.message;
    } catch {
      /* keep statusText */
    }
    throw new Error(`GitHub API ${opts.method} ${opts.path} → ${response.status} ${detail}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function runGithubConnect(argv: readonly string[]): Promise<number> {
  const parsed = parseConnectArgs(argv, process.env);
  if (!parsed.ok) {
    log.error(parsed.error);
    log.dim('  Usage: ouija github connect <owner/repo> --server-url <url> [--secret <hex>] [--pat <token>] [--events a,b,c] [--dry-run]');
    return 1;
  }
  const config = parsed.config;
  const targetUrl = webhookTargetUrl(config.serverUrl, config.secret);

  log.step(`ouija github connect ${config.owner}/${config.repo}`);
  log.info(`server: ${config.serverUrl}`);
  log.info(`webhook url: ${targetUrl}`);
  log.info(`events: ${config.events.join(', ')}`);

  if (config.dryRun) {
    log.warn('DRY RUN — no API calls will be made');
    log.dim(`POST body: ${JSON.stringify(buildHookConfig(config), null, 2)}`);
    return 0;
  }

  let existingHooks: GhHookLike[];
  try {
    existingHooks = await ghApi<GhHookLike[]>({
      pat: config.pat,
      method: 'GET',
      path: `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/hooks`,
    });
  } catch (err) {
    log.error(`failed to list existing hooks — ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const existing = findExistingHook(existingHooks, targetUrl);
  const body = buildHookConfig(config);

  try {
    if (existing !== undefined) {
      const updated = await ghApi<{ id: number; events: string[]; config: { url: string } }>({
        pat: config.pat,
        method: 'PATCH',
        path: `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/hooks/${existing.id}`,
        body: {
          active: true,
          events: body.events,
          config: body.config,
        },
      });
      log.success(`updated existing webhook (id ${updated.id})`);
      log.info(`  events: ${updated.events.join(', ')}`);
      log.info(`  url:    ${updated.config.url}`);
      log.dim('  secret: (unchanged in this output; it lives in $GITHUB_WEBHOOK_SECRET)');
      return 0;
    }

    const created = await ghApi<{ id: number; events: string[]; config: { url: string } }>({
      pat: config.pat,
      method: 'POST',
      path: `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/hooks`,
      body,
    });
    log.success(`registered new webhook (id ${created.id})`);
    log.info(`  events: ${created.events.join(', ')}`);
    log.info(`  url:    ${created.config.url}`);
    log.dim('  secret: kept in $GITHUB_WEBHOOK_SECRET; rotate via `ouija init --force` then re-run connect');
    return 0;
  } catch (err) {
    log.error(`webhook registration failed — ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  }
}
