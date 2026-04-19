/**
 * WorkOrder assembler — enriches minimal AgentDispatchJobData with card
 * details, agent profile, and a freshly-issued JWT so the plugin has
 * everything it needs to do real work.
 *
 * The orchestrator only puts IDs in the queue. This module does the
 * database lookups and JWT issuance that would be wasteful to do before
 * the job is actually dequeued.
 */

import type { WorkOrder } from '@ouija-dev/types';
import { instanceId as makeInstanceId } from '@ouija-dev/types';
import type { AgentDispatchJobData } from '@ouija-dev/bus';
import { sanitize } from '@ouija-dev/engine';

// ---- Agent profile shape ----

export interface AgentProfile {
  id: string;
  name: string;
  systemPrompt: string;
  secretRef: string;
  model: string;
  maxDurationMs: number;
  repoUrl?: string;
  repoPath?: string;
  baseBranch: string;
  triggerMode: 'auto' | 'manual';
  /**
   * Runner implementation to dispatch this agent with.
   * See packages/config/src/types.ts RunnerType.
   * Defaults to 'stream-json' when unset — applied in the plugin.
   */
  runner?: 'local' | 'stream-json' | 'sdk';
  configDir?: string;
  authMethod?: string;
  /** All repos for this agent — resolved at assembly time using projectId. */
  repos?: Array<{ url?: string | undefined; path?: string | undefined; baseBranch: string; projectId?: string | undefined; default?: boolean | undefined }>;
}

/**
 * Convert an agents-table config row (validated AgentProfileConfig JSONB) into
 * the AgentProfile shape the work-order assembler expects. Used by the server
 * wiring to make DB-stored agents dispatchable alongside YAML-defined ones.
 */
export function agentConfigToProfile(config: Record<string, unknown>): AgentProfile {
  // Shape is validated at write time by @ouija-dev/config#validateAgentProfile,
  // so we trust the structural invariants here. Surfaced as structured access
  // rather than unsafe casting so that missing required fields throw on read.
  const getString = (key: string, optional = false): string => {
    const v = config[key];
    if (typeof v === 'string') return v;
    if (optional) return '';
    throw new Error(`AgentRecord config missing required string field: ${key}`);
  };
  const getNumber = (key: string): number => {
    const v = config[key];
    if (typeof v === 'number') return v;
    throw new Error(`AgentRecord config missing required number field: ${key}`);
  };

  const auth = config['auth'] as { method?: string; secretRef?: string } | undefined;
  const limits = config['limits'] as { maxDurationMs?: number } | undefined;
  const repos = (config['repos'] as Array<{
    url?: string;
    path?: string;
    baseBranch: string;
    projectId?: string;
    default?: boolean;
  }>);
  const defaultRepo = repos.find((r) => r.default === true) ?? repos[0]!;

  const profile: AgentProfile = {
    id: getString('id'),
    name: getString('name'),
    systemPrompt: typeof config['systemPrompt'] === 'string' ? config['systemPrompt'] : '',
    secretRef: auth?.secretRef ?? '',
    model: getString('model'),
    maxDurationMs: limits?.maxDurationMs ?? getNumber('maxDurationMs'),
    baseBranch: defaultRepo.baseBranch,
    triggerMode: (config['triggerMode'] as 'auto' | 'manual') ?? 'auto',
    repos: repos.map((r) => ({
      url: r.url,
      path: r.path,
      baseBranch: r.baseBranch,
      projectId: r.projectId,
      default: r.default,
    })),
  };

  if (defaultRepo.url) profile.repoUrl = defaultRepo.url;
  if (defaultRepo.path) profile.repoPath = defaultRepo.path;
  if (typeof config['configDir'] === 'string') profile.configDir = config['configDir'];
  if (auth?.method) profile.authMethod = auth.method;
  if (
    typeof config['runner'] === 'string' &&
    (config['runner'] === 'local' || config['runner'] === 'stream-json' || config['runner'] === 'sdk')
  ) {
    profile.runner = config['runner'];
  }

  return profile;
}

// ---- Assembler dependencies (injectable for testing) ----

export interface AssemblerDeps {
  /** Look up an agent profile by its ID. Returns undefined if not found. */
  getAgentProfile(agentId: string): Promise<AgentProfile | undefined>;
  /** Fetch card title, description, acceptance criteria, and labels. */
  getCardDetails(cardId: string): Promise<{
    title: string;
    description: string;
    acceptanceCriteria: string[];
    labels: string[];
  }>;
  /** Base URL of the Ouija server (used to build the callbackUrl). */
  serverBaseUrl: string;
  /** Issue a short-lived JWT for agent callbacks. */
  issueJwt(instanceId: string, boardId: string, workspaceId: string): Promise<string>;
  /** Global claudeHome setting from ouija.config.yaml — injected into metadata. */
  claudeHome?: string | null | undefined;
}

// ---- assembleWorkOrder ----

/**
 * Assemble a complete WorkOrder from the minimal data carried by an
 * AgentDispatchJobData job.
 *
 * Throws when the agent profile cannot be found — BullMQ will retry.
 */
export async function assembleWorkOrder(
  jobData: AgentDispatchJobData,
  deps: AssemblerDeps,
): Promise<WorkOrder> {
  // 1. Load agent profile (fail fast — no point fetching the card if config is missing)
  const profile = await deps.getAgentProfile(jobData.agentId);
  if (!profile) {
    throw new Error(`Agent profile not found: ${jobData.agentId}`);
  }

  // 2. Resolve repo based on project ID (multi-repo support)
  let repoUrl = profile.repoUrl ?? '';
  let repoPath = profile.repoPath;
  let baseBranch = profile.baseBranch;

  if (profile.repos && profile.repos.length > 0) {
    const { resolveRepo } = await import('@ouija-dev/config');
    const resolved = resolveRepo(profile.repos as import('@ouija-dev/config').RepoConfig[], jobData.projectId);
    if (resolved) {
      repoUrl = resolved.url ?? '';
      repoPath = resolved.path;
      baseBranch = resolved.baseBranch;
    }
  }

  // 3. Fetch card details from kanban plugin
  const card = await deps.getCardDetails(jobData.cardId);

  // 3a. Sanitize the description before it flows into the WorkOrder and
  // ultimately the agent prompt. The orchestrator's _fetchGuardContext runs
  // the same sanitizer at trigger time (for guard evaluation); re-running it
  // here is defense in depth — plus we need the HTML-stripped plain text for
  // the prompt regardless. If the sanitizer blocks, throw so BullMQ records
  // the failure rather than sending raw input to the subprocess.
  const sanitized = sanitize(card.description);
  if (sanitized.blocked) {
    const categories = Array.from(new Set(sanitized.warnings.map((w) => w.type)));
    throw new Error(
      `Card description for ${jobData.cardId} blocked by sanitizer (categories: ${categories.join(', ')})`,
    );
  }
  const safeDescription = sanitized.sanitized;

  // 4. Issue a JWT for callback authentication
  const jwt = await deps.issueJwt(jobData.instanceId, '', '');

  // 5. Build metadata (include optional profile fields when present)
  const metadata: Record<string, string> = {
    pipelineDispatchId: jobData.dispatchId,
  };
  if (repoPath) metadata['repoPath'] = repoPath;
  if (profile.configDir) metadata['configDir'] = profile.configDir;
  if (profile.authMethod) metadata['authMethod'] = profile.authMethod;
  if (deps.claudeHome) metadata['claudeHome'] = deps.claudeHome;
  if (profile.runner) metadata['runner'] = profile.runner;

  // 6. Construct the WorkOrder
  const workOrder: WorkOrder = {
    instanceId: makeInstanceId(jobData.instanceId),
    cardId: jobData.cardId,
    title: card.title,
    description: safeDescription,
    acceptanceCriteria: card.acceptanceCriteria,
    repoUrl,
    branch: `ouija/${jobData.instanceId}`,
    baseBranch,
    agentProfileId: jobData.agentId,
    systemPrompt: profile.systemPrompt,
    secretRef: profile.secretRef,
    callbackUrl: `${deps.serverBaseUrl}/hooks/agent/callback`,
    callbackToken: jwt,
    maxDurationMs: profile.maxDurationMs,
    metadata,
  };

  return workOrder;
}
