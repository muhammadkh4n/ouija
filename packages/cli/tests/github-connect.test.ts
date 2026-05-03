/**
 * `ouija github connect` pure-helper tests.
 *
 * Covers `parseConnectArgs` (env + flag validation, owner/repo parsing,
 * server-url scheme guard, secret/PAT fallbacks), `webhookTargetUrl`
 * (exact path shape against the server's `/hooks/github/:secret`
 * route), `buildHookConfig` (payload shape matches GitHub's expected
 * `POST /repos/{o}/{r}/hooks` body), and `findExistingHook` (dedup
 * predicate). The HTTP wiring in `runGithubConnect` is not unit-tested
 * — its end-to-end path is the operator validating against a real
 * repo + the Phase 3 fizzy CI smoke (Task 11).
 */

import { describe, it, expect } from 'vitest';
import {
  buildHookConfig,
  findExistingHook,
  parseConnectArgs,
  webhookTargetUrl,
  type ConnectConfig,
  type GhHookLike,
} from '../src/commands/github-connect.js';

const baseEnv: Readonly<Record<string, string | undefined>> = {
  GITHUB_PAT: 'ghp_test',
  GITHUB_WEBHOOK_SECRET: 'aaaa1111bbbb2222',
};

describe('parseConnectArgs', () => {
  it('parses minimal args + applies defaults', () => {
    const result = parseConnectArgs(
      ['octocat/Hello-World', '--server-url', 'https://abc.trycloudflare.com'],
      baseEnv,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.owner).toBe('octocat');
    expect(result.config.repo).toBe('Hello-World');
    expect(result.config.serverUrl).toBe('https://abc.trycloudflare.com');
    expect(result.config.secret).toBe('aaaa1111bbbb2222');
    expect(result.config.pat).toBe('ghp_test');
    expect(result.config.events).toEqual([
      'pull_request_review',
      'pull_request_review_comment',
      'issue_comment',
      'check_run',
      'pull_request',
    ]);
    expect(result.config.dryRun).toBe(false);
  });

  it('strips trailing slashes from --server-url', () => {
    const result = parseConnectArgs(
      ['o/r', '--server-url', 'https://abc.trycloudflare.com///'],
      baseEnv,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.serverUrl).toBe('https://abc.trycloudflare.com');
  });

  it('falls back to OUIJA_PUBLIC_URL env when --server-url is not provided', () => {
    const result = parseConnectArgs(
      ['o/r'],
      { ...baseEnv, OUIJA_PUBLIC_URL: 'https://prod.example.com/' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.serverUrl).toBe('https://prod.example.com');
  });

  it('rejects --server-url without an http(s) scheme', () => {
    const result = parseConnectArgs(
      ['o/r', '--server-url', 'abc.trycloudflare.com'],
      baseEnv,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('http://');
  });

  it('parses --secret + --pat overrides over env', () => {
    const result = parseConnectArgs(
      ['o/r', '--server-url', 'https://x.example', '--secret', 'cli_secret', '--pat', 'cli_pat'],
      baseEnv,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.secret).toBe('cli_secret');
    expect(result.config.pat).toBe('cli_pat');
  });

  it('parses --events as a comma-separated list with trim', () => {
    const result = parseConnectArgs(
      ['o/r', '--server-url', 'https://x.example', '--events', ' pull_request , push '],
      baseEnv,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.events).toEqual(['pull_request', 'push']);
  });

  it('rejects --events with an empty list', () => {
    const result = parseConnectArgs(
      ['o/r', '--server-url', 'https://x.example', '--events', ',  ,'],
      baseEnv,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('--events');
  });

  it('falls back to GH_TOKEN when GITHUB_PAT is unset', () => {
    const result = parseConnectArgs(
      ['o/r', '--server-url', 'https://x.example'],
      { GITHUB_WEBHOOK_SECRET: 'sec', GH_TOKEN: 'ghp_alt' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.pat).toBe('ghp_alt');
  });

  it('rejects missing positional', () => {
    const result = parseConnectArgs(['--server-url', 'https://x.example'], baseEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('missing required argument');
  });

  it('rejects malformed owner/repo', () => {
    const result = parseConnectArgs(
      ['no-slash', '--server-url', 'https://x.example'],
      baseEnv,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('owner/repo');
  });

  it('rejects missing --server-url + missing OUIJA_PUBLIC_URL', () => {
    const result = parseConnectArgs(['o/r'], baseEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('--server-url');
  });

  it('rejects missing webhook secret', () => {
    const result = parseConnectArgs(
      ['o/r', '--server-url', 'https://x.example'],
      { GITHUB_PAT: 'ghp_test' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('GITHUB_WEBHOOK_SECRET');
  });

  it('rejects missing PAT', () => {
    const result = parseConnectArgs(
      ['o/r', '--server-url', 'https://x.example'],
      { GITHUB_WEBHOOK_SECRET: 'sec' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('GITHUB_PAT');
  });

  it('rejects unknown flags', () => {
    const result = parseConnectArgs(
      ['o/r', '--server-url', 'https://x.example', '--bogus', 'x'],
      baseEnv,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unknown flag');
  });

  it('rejects flags without a value', () => {
    const result = parseConnectArgs(
      ['o/r', '--server-url'],
      baseEnv,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('requires a value');
  });

  it('parses --dry-run', () => {
    const result = parseConnectArgs(
      ['o/r', '--server-url', 'https://x.example', '--dry-run'],
      baseEnv,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.dryRun).toBe(true);
  });
});

describe('webhookTargetUrl', () => {
  it('produces the exact path the server route expects', () => {
    expect(webhookTargetUrl('https://abc.example.com', 'aaaa1111')).toBe(
      'https://abc.example.com/hooks/github/aaaa1111',
    );
  });

  it('URL-encodes a secret containing slashes / spaces / special chars', () => {
    const url = webhookTargetUrl('https://x', 'a/b c+d');
    expect(url).toBe('https://x/hooks/github/a%2Fb%20c%2Bd');
  });
});

describe('buildHookConfig', () => {
  const baseConfig: ConnectConfig = {
    owner: 'o',
    repo: 'r',
    serverUrl: 'https://abc.example',
    secret: 'sec',
    pat: 'ghp',
    events: ['pull_request', 'check_run'],
    dryRun: false,
  };

  it('matches GitHub`s expected hook-create body shape', () => {
    const body = buildHookConfig(baseConfig);
    expect(body.name).toBe('web');
    expect(body.active).toBe(true);
    expect(body.events).toEqual(['pull_request', 'check_run']);
    expect(body.config).toEqual({
      url: 'https://abc.example/hooks/github/sec',
      content_type: 'json',
      secret: 'sec',
      insecure_ssl: '0',
    });
  });

  it('clones events so the caller`s array can`t mutate the body afterwards', () => {
    const events = ['push'];
    const body = buildHookConfig({ ...baseConfig, events });
    events.push('pull_request');
    expect(body.events).toEqual(['push']);
  });
});

describe('findExistingHook', () => {
  const targetUrl = 'https://abc.example/hooks/github/sec';

  const hook = (overrides: Partial<GhHookLike>): GhHookLike => ({
    id: 100,
    config: { url: targetUrl },
    events: ['push'],
    ...overrides,
  });

  it('returns the matching hook', () => {
    const hooks = [hook({ id: 1, config: { url: 'https://other' } }), hook({ id: 2 })];
    const match = findExistingHook(hooks, targetUrl);
    expect(match?.id).toBe(2);
  });

  it('returns undefined when no hook matches', () => {
    const hooks = [hook({ id: 1, config: { url: 'https://other' } })];
    expect(findExistingHook(hooks, targetUrl)).toBeUndefined();
  });

  it('returns undefined for an empty hook list', () => {
    expect(findExistingHook([], targetUrl)).toBeUndefined();
  });

  it('treats hooks with missing config.url as non-matches', () => {
    const hooks: GhHookLike[] = [{ id: 1, config: {} }];
    expect(findExistingHook(hooks, targetUrl)).toBeUndefined();
  });
});
