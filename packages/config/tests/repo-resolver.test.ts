import { describe, it, expect } from 'vitest';
import { resolveRepo } from '../src/repo-resolver.js';
import type { RepoConfig } from '../src/types.js';

describe('resolveRepo', () => {
  const repos: RepoConfig[] = [
    { url: 'https://github.com/org/frontend.git', baseBranch: 'main', projectId: 'proj-frontend' },
    { url: 'https://github.com/org/backend.git', baseBranch: 'develop', projectId: 'proj-backend' },
    { path: '/home/mk/Projects/infra', baseBranch: 'main', default: true },
  ];

  it('resolves by projectId match', () => {
    const result = resolveRepo(repos, 'proj-frontend');
    expect(result?.url).toBe('https://github.com/org/frontend.git');
    expect(result?.baseBranch).toBe('main');
  });

  it('resolves second repo by projectId', () => {
    const result = resolveRepo(repos, 'proj-backend');
    expect(result?.url).toBe('https://github.com/org/backend.git');
    expect(result?.baseBranch).toBe('develop');
  });

  it('falls back to default repo when no projectId match', () => {
    const result = resolveRepo(repos, 'proj-unknown');
    expect(result?.path).toBe('/home/mk/Projects/infra');
  });

  it('falls back to default repo when no projectId given', () => {
    const result = resolveRepo(repos);
    expect(result?.path).toBe('/home/mk/Projects/infra');
  });

  it('falls back to first repo when no default', () => {
    const noDefault: RepoConfig[] = [
      { url: 'https://github.com/org/a.git', baseBranch: 'main' },
      { url: 'https://github.com/org/b.git', baseBranch: 'main' },
    ];
    const result = resolveRepo(noDefault);
    expect(result?.url).toBe('https://github.com/org/a.git');
  });

  it('returns undefined for empty array', () => {
    expect(resolveRepo([])).toBeUndefined();
  });

  it('does not include extra fields in resolved output', () => {
    const result = resolveRepo(repos, 'proj-frontend');
    expect(result).toEqual({
      url: 'https://github.com/org/frontend.git',
      path: undefined,
      baseBranch: 'main',
    });
  });
});
