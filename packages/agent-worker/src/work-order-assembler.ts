/**
 * WorkOrder assembler — enriches minimal AgentDispatchJobData with card
 * details, agent profile, and a freshly-issued JWT so the plugin has
 * everything it needs to do real work.
 *
 * The orchestrator only puts IDs in the queue. This module does the
 * database lookups and JWT issuance that would be wasteful to do before
 * the job is actually dequeued.
 */

import type { WorkOrder } from '@ouija/types';
import { instanceId as makeInstanceId } from '@ouija/types';
import type { AgentDispatchJobData } from '@ouija/bus';

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
  configDir?: string;
  authMethod?: string;
  /** All repos for this agent — resolved at assembly time using projectId. */
  repos?: Array<{ url?: string | undefined; path?: string | undefined; baseBranch: string; projectId?: string | undefined; default?: boolean | undefined }>;
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
    const { resolveRepo } = await import('@ouija/config');
    const resolved = resolveRepo(profile.repos as import('@ouija/config').RepoConfig[], jobData.projectId);
    if (resolved) {
      repoUrl = resolved.url ?? '';
      repoPath = resolved.path;
      baseBranch = resolved.baseBranch;
    }
  }

  // 3. Fetch card details from kanban plugin
  const card = await deps.getCardDetails(jobData.cardId);

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

  // 6. Construct the WorkOrder
  const workOrder: WorkOrder = {
    instanceId: makeInstanceId(jobData.instanceId),
    cardId: jobData.cardId,
    title: card.title,
    description: card.description,
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
