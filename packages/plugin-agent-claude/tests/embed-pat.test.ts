import { describe, it, expect } from 'vitest';
import { embedGithubPat } from '../src/index.js';

describe('embedGithubPat', () => {
  it('embeds the PAT as x-access-token user on HTTPS URLs', () => {
    const out = embedGithubPat(
      'https://github.com/muhammadkh4n/mcp-server-template.git',
      'ghp_deadbeef',
    );
    expect(out).toBe(
      'https://x-access-token:ghp_deadbeef@github.com/muhammadkh4n/mcp-server-template.git',
    );
  });

  it('returns the URL unchanged when no PAT is provided', () => {
    const url = 'https://github.com/owner/repo.git';
    expect(embedGithubPat(url, undefined)).toBe(url);
    expect(embedGithubPat(url, '')).toBe(url);
  });

  it('leaves SSH URLs alone — they authenticate via host keys', () => {
    const ssh = 'git@github.com:owner/repo.git';
    expect(embedGithubPat(ssh, 'ghp_deadbeef')).toBe(ssh);
  });

  it('does not overwrite an existing credential on the URL', () => {
    const url = 'https://user:pass@github.com/owner/repo.git';
    expect(embedGithubPat(url, 'ghp_deadbeef')).toBe(url);
  });

  it('returns the URL unchanged on malformed input', () => {
    const bad = 'https://';
    expect(embedGithubPat(bad, 'ghp_deadbeef')).toBe(bad);
  });
});
