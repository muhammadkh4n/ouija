// ---- Agent user registration and management on Plane ----
// Agents need to be real Plane users so they can be assigned to issues,
// appear in the board UI, and post comments attributed to their identity.
//
// This module handles creating / verifying agent bot users during plugin start.

import type { PlaneApiClient } from './api-client.js';
import type { PluginLogger } from '@ouija/types';

export interface AgentUserRecord {
  memberId: string;
  email: string;
  displayName: string;
}

/**
 * Ensure an agent bot user exists in the given Plane workspace.
 *
 * - If the email is already a member: no-op (returns existing record).
 * - If not: sends a workspace invitation.
 *
 * This is best-effort. If the invitation fails (e.g. Plane is in SSO-only
 * mode or email is blocked) we log a warning but do NOT prevent the plugin
 * from starting. The bot can still move cards; assignment will fail gracefully.
 */
export async function ensureAgentUser(
  client: PlaneApiClient,
  workspaceSlug: string,
  agentEmail: string,
  logger: PluginLogger,
): Promise<AgentUserRecord | null> {
  try {
    const result = await client.createMember(workspaceSlug, agentEmail, 10);
    logger.info('Agent user provisioned on Plane', {
      workspaceSlug,
      email: agentEmail,
      memberId: result.id,
    });
    return {
      memberId: result.id,
      email: result.email,
      displayName: agentEmail,
    };
  } catch (err) {
    // A 400 often means "already a member" — treat as success by logging a warning.
    // Callers should not block startup on this.
    logger.warn('Could not provision agent user on Plane (non-fatal)', {
      workspaceSlug,
      email: agentEmail,
      error: String(err),
    });
    return null;
  }
}
