import type { BasePlugin } from './plugin.js';
import type { PrId } from './ids.js';

// ---- Git domain types ----

export interface StandardPR {
  id: PrId;
  url: string;
  title: string;
  body: string;
  branch: string;
  baseBranch: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
}

export interface OpenPRParams {
  title: string;
  body: string;
  branch: string;
  baseBranch: string;
  draft?: boolean;
}

// ---- Git plugin interface ----

export interface GitPlugin<TConfig = unknown> extends BasePlugin<TConfig> {
  /** Create a new branch from the base branch */
  createBranch(repoUrl: string, branchName: string, fromBranch: string): Promise<void>;

  /** Open a pull request */
  openPR(repoUrl: string, params: OpenPRParams): Promise<StandardPR>;

  /** Merge a pull request */
  mergePR(prId: PrId): Promise<void>;

  /** Add a comment to a pull request */
  addPRComment(prId: PrId, body: string): Promise<void>;

  /** Get a pull request by ID */
  getPR(prId: PrId): Promise<StandardPR>;
}
