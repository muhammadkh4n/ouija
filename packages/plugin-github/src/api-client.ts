import { Octokit } from '@octokit/rest';
import type { OpenPRParams, StandardPR } from '@ouija/types';
import { prId } from '@ouija/types';

// ---- Helpers ----

/**
 * Encode a GitHub PR as a branded PrId.
 * Format: "owner/repo#number"
 * This is the canonical parse boundary — all external callers use this format.
 */
export function encodePrId(owner: string, repo: string, prNumber: number) {
  return prId(`${owner}/${repo}#${prNumber}`);
}

/**
 * Decode a PrId back to its GitHub coordinates.
 * Throws if the format is unexpected — a broken PrId means something upstream
 * gave us bad data.
 */
export function decodePrId(id: string): { owner: string; repo: string; prNumber: number } {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id);
  if (!match) {
    throw new Error(`GitHubApiClient: cannot decode PrId "${id}" — expected "owner/repo#number"`);
  }
  return {
    owner: match[1] as string,
    repo: match[2] as string,
    prNumber: parseInt(match[3] as string, 10),
  };
}

/**
 * Parse a GitHub repo URL into owner/repo components.
 * Accepts:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 */
export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = /git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(repoUrl);
  if (sshMatch) {
    return { owner: sshMatch[1] as string, repo: sshMatch[2] as string };
  }

  // HTTPS format: https://github.com/owner/repo[.git]
  const httpsMatch = /github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(repoUrl);
  if (httpsMatch) {
    return { owner: httpsMatch[1] as string, repo: httpsMatch[2] as string };
  }

  throw new Error(`GitHubApiClient: cannot parse repo URL "${repoUrl}"`);
}

// ---- GitHub API client ----

export class GitHubApiClient {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  /**
   * Create a new branch from an existing ref.
   * `fromRef` may be a branch name, tag, or full SHA.
   */
  async createBranch(owner: string, repo: string, branch: string, fromRef: string): Promise<void> {
    // Resolve fromRef to a SHA. If it's already a SHA (40 hex chars) we skip this.
    let sha: string;

    if (/^[0-9a-f]{40}$/i.test(fromRef)) {
      sha = fromRef;
    } else {
      const { data: refData } = await this.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${fromRef}`,
      });
      sha = refData.object.sha;
    }

    await this.octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  /**
   * Open a pull request and return its standard representation.
   * `repoUrl` is parsed to extract owner/repo.
   */
  async openPR(repoUrl: string, params: OpenPRParams): Promise<StandardPR> {
    const { owner, repo } = parseRepoUrl(repoUrl);

    const { data } = await this.octokit.pulls.create({
      owner,
      repo,
      title: params.title,
      body: params.body,
      head: params.branch,
      base: params.baseBranch,
      draft: params.draft ?? false,
    });

    return {
      id: encodePrId(owner, repo, data.number),
      url: data.html_url,
      title: data.title,
      body: data.body ?? '',
      branch: data.head.ref,
      baseBranch: data.base.ref,
      state: 'open',
      draft: data.draft ?? false,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  /**
   * Merge a pull request by its PrId.
   * Uses the squash merge strategy by default.
   */
  async mergePR(prIdValue: string): Promise<void> {
    const { owner, repo, prNumber } = decodePrId(prIdValue);

    await this.octokit.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: 'squash',
    });
  }

  /**
   * Add a comment to a pull request (as an issue comment — visible on the PR timeline).
   */
  async addPRComment(prIdValue: string, body: string): Promise<void> {
    const { owner, repo, prNumber } = decodePrId(prIdValue);

    await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
  }

  /**
   * Get a pull request by its PrId.
   */
  async getPR(prIdValue: string): Promise<StandardPR> {
    const { owner, repo, prNumber } = decodePrId(prIdValue);

    const { data } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    let state: StandardPR['state'];
    if (data.merged) {
      state = 'merged';
    } else if (data.state === 'closed') {
      state = 'closed';
    } else {
      state = 'open';
    }

    return {
      id: encodePrId(owner, repo, data.number),
      url: data.html_url,
      title: data.title,
      body: data.body ?? '',
      branch: data.head.ref,
      baseBranch: data.base.ref,
      state,
      draft: data.draft ?? false,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      ...(data.merged_at ? { mergedAt: data.merged_at } : {}),
    };
  }

  /**
   * Check whether a branch exists on the repo.
   * Returns null if not found, the branch ref object if found.
   */
  async getBranch(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ sha: string; name: string } | null> {
    try {
      const { data } = await this.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      return { sha: data.object.sha, name: branch };
    } catch (err: unknown) {
      // Octokit throws a RequestError with status 404 when the ref doesn't exist.
      if (isOctokitNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Verify that the token has sufficient access by listing repos.
   * Throws if the request fails (bad token, revoked, etc.).
   */
  async verifyToken(): Promise<void> {
    await this.octokit.repos.listForAuthenticatedUser({ per_page: 1 });
  }

  /**
   * Lightweight health check — call GET /user and return whether it succeeds.
   */
  async getAuthenticatedUser(): Promise<{ login: string }> {
    const { data } = await this.octokit.users.getAuthenticated();
    return { login: data.login };
  }
}

// ---- Error helpers ----

function isOctokitNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status: unknown }).status === 404
  );
}
