/**
 * Plane bootstrap — eliminates manual "create project in Plane admin" steps.
 *
 * Called from `PlanePlugin.start()` after API connectivity has been verified.
 * Iterates the `boards:` section of `ouija.config.yaml` and ensures every
 * referenced project exists in Plane. Projects that don't match an existing
 * UUID are created fresh; projects that do are left alone.
 *
 * Cannot auto-create:
 *   - The workspace itself (Plane requires session-auth admin signup).
 *   - API tokens (chicken-and-egg — the token is what authorises this call).
 *   - Webhooks (Plane's webhook API lives under `/api/workspaces/…` which
 *     requires session auth, not the X-Api-Key token). The webhook URL is
 *     logged clearly so the self-hoster can paste it into the Plane UI once.
 */

import type { PlaneApiClient, PlaneProject } from './api-client.js';

export interface BootstrapLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface BoardSpec {
  /** Pre-declared project UUID, if the user has one. Treated as the ensure key. */
  projectId?: string;
  /** The board identifier from config — falls back when projectId is absent. */
  boardId?: string;
}

export interface BootstrapInput {
  workspaceSlug: string;
  boards: BoardSpec[];
  /**
   * Used only when a board has no matching project — we create one with this
   * name prefix plus the board index (1-indexed). The identifier is derived
   * from the name (uppercased, alphanumeric, truncated to 12 chars).
   */
  projectNamePrefix?: string;
}

export interface BootstrapResult {
  /** Projects that already existed by UUID — no action taken. */
  existing: PlaneProject[];
  /** Projects freshly created during bootstrap. */
  created: PlaneProject[];
  /** Boards we couldn't resolve (e.g. API error); each has an error message. */
  failed: Array<{ boardId?: string; projectId?: string; error: string }>;
}

/**
 * Derive a 1-12 char uppercase alphanumeric identifier from a display name.
 * Plane uses this as the issue prefix (e.g. OUIJA-42). Rejecting empty results.
 */
function deriveIdentifier(name: string, fallback: string): string {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length === 0) return fallback;
  return cleaned.slice(0, 12);
}

/**
 * Ensure every board in the config has a backing Plane project. Returns a
 * summary the caller can log + surface in `ouija doctor`.
 */
export async function bootstrapPlaneProjects(
  client: PlaneApiClient,
  input: BootstrapInput,
  logger: BootstrapLogger,
): Promise<BootstrapResult> {
  const existing: PlaneProject[] = [];
  const created: PlaneProject[] = [];
  const failed: BootstrapResult['failed'] = [];

  const prefix = input.projectNamePrefix ?? 'Ouija';

  for (let i = 0; i < input.boards.length; i += 1) {
    const board = input.boards[i]!;
    const targetId = board.projectId ?? board.boardId;
    const displayName = `${prefix} Board ${i + 1}`;
    const identifier = deriveIdentifier(displayName, 'OUIJA');

    try {
      const project = await client.ensureProject(
        input.workspaceSlug,
        targetId,
        displayName,
        identifier,
      );
      if (targetId && project.id === targetId) {
        existing.push(project);
        logger.info('Plane bootstrap: project already exists', {
          projectId: project.id,
          name: project.name,
        });
      } else {
        created.push(project);
        logger.info('Plane bootstrap: project created', {
          projectId: project.id,
          name: project.name,
          identifier: project.identifier,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Plane bootstrap: project ensure failed', {
        ...(board.projectId ? { projectId: board.projectId } : {}),
        ...(board.boardId ? { boardId: board.boardId } : {}),
        error: message,
      });
      failed.push({
        ...(board.projectId ? { projectId: board.projectId } : {}),
        ...(board.boardId ? { boardId: board.boardId } : {}),
        error: message,
      });
    }
  }

  return { existing, created, failed };
}

/**
 * Log the exact webhook URL the self-hoster needs to paste into Plane.
 * Called after bootstrap so the next-step instructions are obvious.
 *
 * Plane's webhook admin (`/god-mode/` or `Settings → Workspace → Webhooks`)
 * requires session auth — we cannot POST it via X-Api-Key, so this is the
 * one manual step that remains for self-hosters.
 */
export function logWebhookSetupHint(
  logger: BootstrapLogger,
  ouijaServerUrl: string,
  webhookSecret: string,
  workspaceSlug: string,
  planeBaseUrl: string,
): void {
  const webhookUrl = `${ouijaServerUrl.replace(/\/$/, '')}/hooks/plane/${webhookSecret}`;
  const settingsUrl = `${planeBaseUrl.replace(/\/$/, '')}/${workspaceSlug}/settings/webhooks`;

  logger.info('Plane webhook setup hint', {
    action: 'paste the webhookUrl at settingsUrl with events [issue, issue_activity, project]',
    webhookUrl,
    settingsUrl,
    secret: `${webhookSecret.slice(0, 8)}…(hidden)`,
  });
}
