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

  // 2. Fetch card details from kanban plugin
  const card = await deps.getCardDetails(jobData.cardId);

  // 3. Issue a JWT for callback authentication
  const jwt = await deps.issueJwt(jobData.instanceId, '', '');

  // 4. Build metadata (include optional profile fields when present)
  const metadata: Record<string, string> = {
    pipelineDispatchId: jobData.dispatchId,
  };
  if (profile.repoPath) metadata['repoPath'] = profile.repoPath;
  if (profile.configDir) metadata['configDir'] = profile.configDir;
  if (profile.authMethod) metadata['authMethod'] = profile.authMethod;
  if (deps.claudeHome) metadata['claudeHome'] = deps.claudeHome;

  // 5. Construct the WorkOrder
  const workOrder: WorkOrder = {
    instanceId: makeInstanceId(jobData.instanceId),
    cardId: jobData.cardId,
    title: card.title,
    description: card.description,
    acceptanceCriteria: card.acceptanceCriteria,
    repoUrl: profile.repoUrl ?? '',
    branch: `ouija/${jobData.instanceId}`,
    baseBranch: profile.baseBranch,
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
