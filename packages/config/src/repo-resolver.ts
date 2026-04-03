import type { RepoConfig } from './types.js';

export interface ResolvedRepo {
  url?: string | undefined;
  path?: string | undefined;
  baseBranch: string;
}

/**
 * Resolve which repo to use for a given project ID.
 *
 * Resolution order:
 * 1. Repo with matching projectId
 * 2. Default repo (default: true)
 * 3. First repo in the array (fallback)
 *
 * Returns undefined only if repos array is empty.
 */
export function resolveRepo(
  repos: RepoConfig[],
  projectId?: string,
): ResolvedRepo | undefined {
  if (repos.length === 0) return undefined;

  // 1. Match by projectId
  if (projectId) {
    const match = repos.find((r) => r.projectId === projectId);
    if (match) return { url: match.url, path: match.path, baseBranch: match.baseBranch };
  }

  // 2. Default repo
  const defaultRepo = repos.find((r) => r.default);
  if (defaultRepo) return { url: defaultRepo.url, path: defaultRepo.path, baseBranch: defaultRepo.baseBranch };

  // 3. First repo
  const first = repos[0]!;
  return { url: first.url, path: first.path, baseBranch: first.baseBranch };
}
