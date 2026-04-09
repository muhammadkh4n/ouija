import type {
  GitPlugin,
  StandardPR,
  OpenPRParams,
  PluginManifest,
  PluginContext,
  PluginHealth,
} from '@ouija-dev/types';
import type { PrId } from '@ouija-dev/types';
import { prId } from '@ouija-dev/types';

// ---- Mock Git Plugin ----

/**
 * In-memory GitPlugin for use in engine integration tests and plugin development.
 * No network calls. Branches and PRs are tracked in Maps.
 *
 * `openPR()` generates deterministic fake IDs and URLs.
 * `mergePR()` marks the PR as merged in-place.
 */
export class MockGitPlugin implements GitPlugin<Record<string, never>> {
  readonly manifest: PluginManifest = {
    name: '@ouija-dev/mock-git',
    version: '0.1.0',
    type: 'git',
    coreApiVersion: '>=1.0.0 <2.0.0',
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    dependencies: [],
  };

  /** repoUrl → Set of branch names */
  readonly branches: Map<string, Set<string>> = new Map();
  /** PR id → StandardPR */
  readonly prs: Map<PrId, StandardPR> = new Map();
  /** PR id → list of comment bodies */
  readonly prComments: Map<PrId, string[]> = new Map();

  private prCounter = 0;
  private initialised = false;
  private running = false;

  // ---- Lifecycle ----

  async init(_context: PluginContext<Record<string, never>>): Promise<void> {
    this.initialised = true;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async healthCheck(): Promise<PluginHealth> {
    return {
      healthy: true,
      message: 'Mock git plugin is always healthy',
      details: { initialised: this.initialised, running: this.running },
    };
  }

  // ---- GitPlugin methods ----

  async createBranch(repoUrl: string, branchName: string, _fromBranch: string): Promise<void> {
    const repo = this.branches.get(repoUrl) ?? new Set<string>();
    repo.add(branchName);
    this.branches.set(repoUrl, repo);
  }

  async openPR(repoUrl: string, params: OpenPRParams): Promise<StandardPR> {
    this.prCounter += 1;
    const id = prId(`mock-pr-${this.prCounter}`);
    const now = new Date().toISOString();

    const pr: StandardPR = {
      id,
      url: `https://mock.git/${repoUrl}/pull/${this.prCounter}`,
      title: params.title,
      body: params.body,
      branch: params.branch,
      baseBranch: params.baseBranch,
      state: 'open',
      draft: params.draft ?? false,
      createdAt: now,
      updatedAt: now,
    };

    this.prs.set(id, pr);
    return { ...pr };
  }

  async mergePR(id: PrId): Promise<void> {
    const pr = this.prs.get(id);
    if (!pr) {
      throw new Error(`MockGitPlugin: PR "${id}" not found`);
    }
    const now = new Date().toISOString();
    this.prs.set(id, { ...pr, state: 'merged', mergedAt: now, updatedAt: now });
  }

  async addPRComment(id: PrId, body: string): Promise<void> {
    const existing = this.prComments.get(id) ?? [];
    this.prComments.set(id, [...existing, body]);
  }

  async getPR(id: PrId): Promise<StandardPR> {
    const pr = this.prs.get(id);
    if (!pr) {
      throw new Error(`MockGitPlugin: PR "${id}" not found`);
    }
    return { ...pr };
  }
}
