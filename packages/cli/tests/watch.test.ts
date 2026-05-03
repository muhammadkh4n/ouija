/**
 * `ouija watch` pure-helper tests.
 *
 * Covers `parseWatchArgs` (env + flag validation), `findLabelMatches`
 * (issue dedup + PR exclusion), and `findMentionMatches` (case-insensitive
 * mention substring + dedup + title truncation). The HTTP loop in
 * `runWatch` is not unit-tested here — its only signal is "did fetch get
 * called with the right args" which is better validated via the CI smoke
 * once the route is wired in Phase 3 Task 12 (fizzy preset CI smoke).
 */

import { describe, it, expect } from 'vitest';
import {
  POLL_BACKOFF_MULTIPLIERS,
  effectivePollMs,
  findLabelMatches,
  findMentionMatches,
  nextBackoffLevel,
  parseBackoffEnv,
  parseWatchArgs,
  type GhCommentLike,
  type GhIssueLike,
} from '../src/commands/watch.js';

const baseEnv = {
  GITHUB_PAT: 'ghp_test',
  OUIJA_API_KEY: 'ouija_test',
};

describe('parseWatchArgs', () => {
  it('parses owner/repo + agent and applies defaults', () => {
    const result = parseWatchArgs(['octocat/Hello-World', '--agent', 'agent-1'], baseEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.owner).toBe('octocat');
    expect(result.config.repo).toBe('Hello-World');
    expect(result.config.agentId).toBe('agent-1');
    expect(result.config.label).toBe('ouija');
    expect(result.config.mention).toBe('@ouija');
    expect(result.config.pollIntervalMs).toBe(30_000);
    expect(result.config.dryRun).toBe(false);
    expect(result.config.serverUrl).toBe('http://localhost:4000');
    expect(result.config.boardId).toBeUndefined();
  });

  it('parses every overridable flag', () => {
    const argv = [
      'foo/bar',
      '--agent', 'agent-x',
      '--label', 'agent-please',
      '--mention', 'ouija-bot',
      '--poll-interval', '90',
      '--server', 'https://ouija.example.com/',
      '--board', 'board_42',
      '--dry-run',
    ];
    const result = parseWatchArgs(argv, baseEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.label).toBe('agent-please');
    expect(result.config.mention).toBe('@ouija-bot');
    expect(result.config.pollIntervalMs).toBe(90_000);
    expect(result.config.dryRun).toBe(true);
    expect(result.config.serverUrl).toBe('https://ouija.example.com');
    expect(result.config.boardId).toBe('board_42');
  });

  it('preserves a leading @ on --mention without doubling it', () => {
    const result = parseWatchArgs(
      ['o/r', '--agent', 'a', '--mention', '@bot'],
      baseEnv,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.mention).toBe('@bot');
  });

  it('rejects missing positional', () => {
    const result = parseWatchArgs(['--agent', 'a'], baseEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('missing required argument');
  });

  it('rejects malformed owner/repo', () => {
    const result = parseWatchArgs(['no-slash', '--agent', 'a'], baseEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('owner/repo');
  });

  it('rejects missing --agent', () => {
    const result = parseWatchArgs(['o/r'], baseEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('--agent');
  });

  it('rejects flags without a value', () => {
    const result = parseWatchArgs(['o/r', '--agent'], baseEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('requires a value');
  });

  it('rejects unknown flags', () => {
    const result = parseWatchArgs(['o/r', '--agent', 'a', '--bogus', 'x'], baseEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unknown flag');
  });

  it('rejects extra positional args', () => {
    const result = parseWatchArgs(['o/r', 'extra', '--agent', 'a'], baseEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unexpected positional');
  });

  it('rejects --poll-interval below the floor', () => {
    const result = parseWatchArgs(
      ['o/r', '--agent', 'a', '--poll-interval', '2'],
      baseEnv,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('--poll-interval');
  });

  it('rejects missing GITHUB_PAT', () => {
    const result = parseWatchArgs(
      ['o/r', '--agent', 'a'],
      { OUIJA_API_KEY: 'ouija_test' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('GITHUB_PAT');
  });

  it('accepts GH_TOKEN as a fallback for GITHUB_PAT', () => {
    const result = parseWatchArgs(
      ['o/r', '--agent', 'a'],
      { GH_TOKEN: 'ghp_alt', OUIJA_API_KEY: 'ouija_test' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.githubPat).toBe('ghp_alt');
  });

  it('rejects missing OUIJA_API_KEY', () => {
    const result = parseWatchArgs(
      ['o/r', '--agent', 'a'],
      { GITHUB_PAT: 'ghp_test' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('OUIJA_API_KEY');
  });

  it('falls back to OUIJA_SERVER_URL env when --server is not provided', () => {
    const result = parseWatchArgs(
      ['o/r', '--agent', 'a'],
      { ...baseEnv, OUIJA_SERVER_URL: 'https://prod.example.com/' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.serverUrl).toBe('https://prod.example.com');
  });
});

describe('findLabelMatches', () => {
  const issue = (overrides: Partial<GhIssueLike>): GhIssueLike => ({
    number: 1,
    title: 'Add a LICENSE file',
    body: 'GPL-3.0 please',
    html_url: 'https://github.com/o/r/issues/1',
    ...overrides,
  });

  it('returns one match per labeled issue not yet processed', () => {
    const issues = [issue({ number: 1 }), issue({ number: 2, title: 'Bump deps' })];
    const matches = findLabelMatches(issues, new Set());
    expect(matches).toHaveLength(2);
    expect(matches[0]!.key).toBe('issue:1');
    expect(matches[0]!.source).toBe('label');
    expect(matches[1]!.key).toBe('issue:2');
    expect(matches[1]!.title).toBe('Bump deps');
  });

  it('skips already-processed issues', () => {
    const issues = [issue({ number: 1 }), issue({ number: 2 })];
    const matches = findLabelMatches(issues, new Set(['issue:1']));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.key).toBe('issue:2');
  });

  it('skips PRs (the issues endpoint returns them too)', () => {
    const issues = [
      issue({ number: 1 }),
      issue({ number: 2, pull_request: { url: 'https://...' } }),
    ];
    const matches = findLabelMatches(issues, new Set());
    expect(matches).toHaveLength(1);
    expect(matches[0]!.key).toBe('issue:1');
  });

  it('substitutes a placeholder when body is empty/null', () => {
    const matches = findLabelMatches(
      [issue({ number: 7, body: null }), issue({ number: 8, body: '   ' })],
      new Set(),
    );
    expect(matches[0]!.description).toBe('(no description on issue #7)');
    expect(matches[1]!.description).toBe('(no description on issue #8)');
  });
});

describe('findMentionMatches', () => {
  const comment = (overrides: Partial<GhCommentLike>): GhCommentLike => ({
    id: 100,
    body: '@ouija please add a LICENSE',
    html_url: 'https://github.com/o/r/issues/1#issuecomment-100',
    issue_url: 'https://api.github.com/repos/o/r/issues/1',
    ...overrides,
  });

  it('matches case-insensitively on the mention substring', () => {
    const matches = findMentionMatches(
      [
        comment({ id: 1, body: '@OUIJA help me' }),
        comment({ id: 2, body: '@ouija help me' }),
        comment({ id: 3, body: '@Ouija help me' }),
      ],
      '@ouija',
      new Set(),
    );
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m.key)).toEqual(['comment:1', 'comment:2', 'comment:3']);
  });

  it('skips comments without the mention', () => {
    const matches = findMentionMatches(
      [
        comment({ id: 1, body: 'looks good to me' }),
        comment({ id: 2, body: '@ouija please review' }),
      ],
      '@ouija',
      new Set(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.key).toBe('comment:2');
  });

  it('skips already-processed comments', () => {
    const matches = findMentionMatches(
      [comment({ id: 1 }), comment({ id: 2 })],
      '@ouija',
      new Set(['comment:1']),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.key).toBe('comment:2');
  });

  it('truncates titles longer than 80 chars with an ellipsis', () => {
    const longLine = 'x'.repeat(120);
    const matches = findMentionMatches(
      [comment({ id: 1, body: `@ouija ${longLine}` })],
      '@ouija',
      new Set(),
    );
    expect(matches[0]!.title.length).toBeLessThanOrEqual(80);
    expect(matches[0]!.title.endsWith('…')).toBe(true);
  });

  it('uses just the first line as the title when multi-line', () => {
    const matches = findMentionMatches(
      [comment({ id: 1, body: '@ouija fix the linter\n\n## Steps\n1. Run eslint' })],
      '@ouija',
      new Set(),
    );
    expect(matches[0]!.title).toBe('@ouija fix the linter');
  });

  it('falls back to a synthetic title when the body is empty', () => {
    const matches = findMentionMatches(
      [comment({ id: 7, body: '@ouija' })],
      '@ouija',
      new Set(),
    );
    expect(matches[0]!.title).toBe('@ouija');
  });

  it('respects a custom mention different from @ouija', () => {
    const matches = findMentionMatches(
      [
        comment({ id: 1, body: '@ouija ignored' }),
        comment({ id: 2, body: '@bot used' }),
      ],
      '@bot',
      new Set(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.key).toBe('comment:2');
  });
});

describe('parseBackoffEnv', () => {
  it('defaults to enabled when env is unset', () => {
    expect(parseBackoffEnv(undefined)).toBe(true);
  });

  it('treats common opt-out spellings as disabled', () => {
    for (const v of ['off', 'OFF', '0', 'false', 'False', 'disabled', 'no', '  off  ', '']) {
      expect(parseBackoffEnv(v)).toBe(false);
    }
  });

  it('treats anything else (including "on" / "1" / "true") as enabled', () => {
    for (const v of ['on', '1', 'true', 'enabled', 'yes', 'whatever']) {
      expect(parseBackoffEnv(v)).toBe(true);
    }
  });
});

describe('nextBackoffLevel', () => {
  it('returns 0 when backoff is disabled (regardless of input)', () => {
    expect(nextBackoffLevel(0, false, false)).toBe(0);
    expect(nextBackoffLevel(2, false, false)).toBe(0);
    expect(nextBackoffLevel(3, true, false)).toBe(0);
  });

  it('resets to 0 on activity', () => {
    expect(nextBackoffLevel(0, true, true)).toBe(0);
    expect(nextBackoffLevel(2, true, true)).toBe(0);
    expect(nextBackoffLevel(POLL_BACKOFF_MULTIPLIERS.length - 1, true, true)).toBe(0);
  });

  it('advances by one rung on quiet ticks until the cap', () => {
    expect(nextBackoffLevel(0, false, true)).toBe(1);
    expect(nextBackoffLevel(1, false, true)).toBe(2);
    expect(nextBackoffLevel(2, false, true)).toBe(3);
    // At the cap, stays at the cap.
    expect(nextBackoffLevel(3, false, true)).toBe(3);
    expect(nextBackoffLevel(POLL_BACKOFF_MULTIPLIERS.length - 1, false, true)).toBe(
      POLL_BACKOFF_MULTIPLIERS.length - 1,
    );
  });

  it('clamps negative or out-of-range current values to 0', () => {
    expect(nextBackoffLevel(-1, false, true)).toBe(0);
    expect(nextBackoffLevel(99, false, true)).toBe(POLL_BACKOFF_MULTIPLIERS.length - 1);
  });

  it('respects a custom maxLevel cap', () => {
    expect(nextBackoffLevel(0, false, true, 1)).toBe(1);
    expect(nextBackoffLevel(1, false, true, 1)).toBe(1);
  });
});

describe('effectivePollMs', () => {
  it('returns the base interval at level 0', () => {
    expect(effectivePollMs(30_000, 0)).toBe(30_000);
    expect(effectivePollMs(60_000, 0)).toBe(60_000);
  });

  it('multiplies by the ladder rungs at higher levels', () => {
    // Default ladder is [1, 2, 4, 10] so 30s base → 30, 60, 120, 300s.
    expect(effectivePollMs(30_000, 1)).toBe(60_000);
    expect(effectivePollMs(30_000, 2)).toBe(120_000);
    expect(effectivePollMs(30_000, 3)).toBe(300_000);
  });

  it('clamps levels above the ladder length to the cap', () => {
    expect(effectivePollMs(30_000, 99)).toBe(30_000 * POLL_BACKOFF_MULTIPLIERS[POLL_BACKOFF_MULTIPLIERS.length - 1]!);
  });

  it('clamps negative levels to the base', () => {
    expect(effectivePollMs(30_000, -1)).toBe(30_000);
  });
});

describe('parseWatchArgs — backoff env wiring', () => {
  it('defaults backoffEnabled to true when OUIJA_POLL_BACKOFF is unset', () => {
    const result = parseWatchArgs(['o/r', '--agent', 'a'], baseEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.backoffEnabled).toBe(true);
  });

  it('disables backoff when OUIJA_POLL_BACKOFF=off', () => {
    const result = parseWatchArgs(
      ['o/r', '--agent', 'a'],
      { ...baseEnv, OUIJA_POLL_BACKOFF: 'off' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.backoffEnabled).toBe(false);
  });
});
