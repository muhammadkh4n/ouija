export type AuthMethod = 'api-key' | 'bedrock' | 'vertex' | 'foundry' | 'api-key-helper' | 'proxy';

export interface AuthConfig {
  method: AuthMethod;
  secretRef: string;
}

/**
 * Which agent runner to use for dispatches.
 *
 *   'local'       — spawn `claude -p` in text mode. Subscription auth via
 *                   ~/.claude/. No structured events. Simplest fallback.
 *   'stream-json' — spawn `claude -p --input-format stream-json
 *                   --output-format stream-json --verbose`. Subscription
 *                   auth preserved AND emits structured events (assistant
 *                   text, cost, turn count). **Default.**
 *   'sdk'         — use @anthropic-ai/claude-agent-sdk's query(). Requires
 *                   API key (Anthropic, Bedrock, Vertex, Foundry, Proxy).
 *                   Does NOT support subscription auth.
 *
 * See docs/configuration.md#runners for the full trade-off matrix.
 */
export type RunnerType = 'local' | 'stream-json' | 'sdk';

export interface RepoConfig {
  url?: string | undefined;
  path?: string | undefined;
  baseBranch: string;
  default?: boolean | undefined;
  /** Optional: Plane project UUID this repo maps to. */
  projectId?: string | undefined;
}

export type TriggerMode = 'auto' | 'manual';

/**
 * Review-loop controls — per-agent gates that decide whether reviewer
 * feedback or CI failures on an open PR trigger a follow-up dispatch.
 * Absent means defaults: enabled=true, no reviewer allowlist, no workflow
 * exclusions. Set `enabled: false` to opt a single agent out entirely.
 */
export interface ReviewLoopConfig {
  /** Master switch. When false, the orchestrator drops review bundles for this agent's PRs. */
  enabled?: boolean;
  /**
   * Reviewer logins whose reviews/comments should never trigger a re-dispatch.
   * Matched case-insensitively. The agent's own GitHub login is automatically
   * ignored at orchestration time even when not listed here.
   */
  ignoreReviewers?: string[];
  /**
   * Allowlist — when non-empty, ONLY reviews from these logins trigger a
   * re-dispatch. Useful to accept only CodeRabbit + human-with-@-mention,
   * or only Copilot's suggestions. Case-insensitive.
   */
  triggerReviewers?: string[];
  /**
   * Workflow names whose CI failures should be ignored (flaky nightly runs,
   * perf benchmarks that fail on branch pushes by design). Matched against
   * GitHub Actions workflow name. Case-sensitive.
   */
  ignoreWorkflows?: string[];
  /** Cap on review-loop iterations before the pipeline stalls. Default 5. */
  maxIterations?: number;
}

export interface AgentProfileConfig {
  id: string;
  name: string;
  email: string;
  kanbanUserId?: string;
  avatar?: string;
  systemPrompt?: string;
  configDir?: string;
  model: string;
  triggerMode: TriggerMode;
  /**
   * Which runner to use. Defaults to 'stream-json' when unset —
   * subscription billing + structured events out of the box.
   * See docs/configuration.md#runners for the trade-off matrix.
   */
  runner?: RunnerType;
  auth: AuthConfig;
  repos: RepoConfig[];
  limits: {
    maxDurationMs: number;
    stallThresholdMs?: number;
  };
  /** Review-loop controls. Absent → defaults (enabled, no filtering). */
  reviewLoop?: ReviewLoopConfig;
}

export interface BoardColumnConfig {
  /** Plane state name (e.g. "In Progress", "Done"). Matched case-insensitively. */
  name: string;
  /** What happens when a card enters this column. */
  action: 'dispatch_agent' | 'close_and_notify' | 'noop';
  /** Which agent handles dispatch for this column. Required when action is dispatch_agent. */
  agentId?: string;
}

export interface BoardConfig {
  boardId?: string;
  /** Plane project UUID or slug. */
  projectId?: string;
  /** Column → action mappings. Columns not listed default to 'noop'. */
  columns: BoardColumnConfig[];
  defaultStallThresholdMs?: number;
  autoStartOnAssign?: boolean;
}

export interface OuijaConfig {
  claudeHome: string | null;
  agents: AgentProfileConfig[];
  /** Board configurations. If empty, a default config is auto-generated. */
  boards?: BoardConfig[];
}
