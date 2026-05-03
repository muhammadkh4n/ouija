/**
 * materializeClaudeHome — write a private, minimal `$HOME/.claude/`
 * directory the runner can point at instead of the operator's host
 * one. Phase 3 Task 6 ships the helper; Task 8 wires the orchestrator
 * to call it per-dispatch.
 *
 * Why this exists at all: bind-mounting `${HOME}/.claude:ro` into the
 * runner container drags every operator hook + MCP + custom
 * `settings.json` into agent space. That's the root cause of
 * friction-log #9 — UserPromptSubmit hooks fire inside the runner,
 * exit non-zero, the agent silently produces 0 tokens, and Ouija
 * reports `succeeded`. By materialising a NEUTRAL home (empty hooks,
 * no MCP, `hasCompletedOnboarding: true`) per-dispatch, the runner
 * has zero contact with the operator's Claude config.
 *
 * Layout written:
 *
 *   <targetDir>/
 *     .credentials.json   ← only when `credentials !== null`; 0600
 *     settings.json       ← neutral — no hooks, no MCP, onboarding done
 *     .claude.json         ← seed file the CLI refuses to start without
 *
 * Atomicity: each file is written via tmp+rename, same as
 * `tunnel-state.ts`. The dir is created with `recursive: true` to
 * absorb a partially-existing `<targetDir>` cleanly (idempotent on
 * re-run for the same dispatchId).
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClaudeCredentials } from './types.js';

/** Files a fully-materialised home contains, by basename. */
export const MATERIALIZED_FILES = {
  credentials: '.credentials.json',
  settings: 'settings.json',
  claudeJson: '.claude.json',
} as const;

export interface MaterializedHome {
  /** Absolute path to the materialised dir. */
  path: string;
  /** Basenames of files actually written (ordered as written). */
  filesWritten: string[];
}

/**
 * Default neutral `settings.json`. No hooks, no MCP, onboarding done.
 *
 * Operators with a custom system prompt or extra config STILL set
 * those at the agent layer (`agent-worker` mounts a per-agent config
 * onto the workspace's `.claude/`); they don't leak into the
 * subprocess identity.
 */
export function neutralSettingsJson(): Record<string, unknown> {
  return {
    hooks: {},
    mcpServers: {},
    hasCompletedOnboarding: true,
    /**
     * The CLI will otherwise prompt for a privacy notice on first
     * boot — non-interactive subprocesses hang. Telemetry stays off
     * because that's our default posture, not a stance against the
     * CLI's collection.
     */
    hasAcknowledgedDataConsent: true,
    telemetry: { enabled: false },
  };
}

/**
 * Default neutral `.claude.json` — the per-host CLI state file. We
 * seed it as empty so the CLI sees a "fresh" host without our agent
 * resurrecting the operator's local model picks, MCP server list, or
 * cached project metadata.
 */
export function neutralClaudeJson(): Record<string, unknown> {
  return {
    hasCompletedOnboarding: true,
    projects: {},
  };
}

/**
 * Atomic JSON write — tmp+rename, 0600. Same primitive as
 * `tunnel-state.ts` so runtime semantics line up.
 */
async function atomicWriteJson(
  path: string,
  value: unknown,
  mode: number,
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fs.rename(tmp, path);
}

export interface MaterializeInput {
  /** Per-dispatch absolute path. The dir is created if missing. */
  targetDir: string;
  /** Resolved credentials JSON; `null` skips writing `.credentials.json`. */
  credentials: ClaudeCredentials | null;
  /** Optional override for `settings.json`. Defaults to `neutralSettingsJson()`. */
  settingsOverride?: Record<string, unknown>;
  /** Optional override for `.claude.json`. Defaults to `neutralClaudeJson()`. */
  claudeJsonOverride?: Record<string, unknown>;
}

export async function materializeClaudeHome(
  input: MaterializeInput,
): Promise<MaterializedHome> {
  await fs.mkdir(input.targetDir, { recursive: true });

  const filesWritten: string[] = [];

  if (input.credentials !== null) {
    await atomicWriteJson(
      join(input.targetDir, MATERIALIZED_FILES.credentials),
      input.credentials,
      0o600,
    );
    filesWritten.push(MATERIALIZED_FILES.credentials);
  }

  await atomicWriteJson(
    join(input.targetDir, MATERIALIZED_FILES.settings),
    input.settingsOverride ?? neutralSettingsJson(),
    0o644,
  );
  filesWritten.push(MATERIALIZED_FILES.settings);

  await atomicWriteJson(
    join(input.targetDir, MATERIALIZED_FILES.claudeJson),
    input.claudeJsonOverride ?? neutralClaudeJson(),
    0o644,
  );
  filesWritten.push(MATERIALIZED_FILES.claudeJson);

  return {
    path: input.targetDir,
    filesWritten,
  };
}
