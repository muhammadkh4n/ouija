/**
 * Workspace config assembly — merges agent Claude Code config into the
 * workspace at dispatch time.
 *
 * Layering order (each layer appends/merges on top of previous):
 *   1. Repo's .claude/ — already in the workspace from clone/worktree
 *   2. Agent's configDir/.claude/ — agent-specific settings.json and CLAUDE.md
 *   3. Task context — card title, description, acceptance criteria
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface WorkspaceConfigOptions {
  /** Absolute path to the workspace directory (clone or worktree). */
  workspaceDir: string;
  /** Agent's systemPrompt from config. Used when configDir is not set. */
  systemPrompt?: string | undefined;
  /** Path to agent's config directory containing .claude/ folder. */
  configDir?: string | undefined;
  /** Card title */
  title: string;
  /** Card description (HTML sanitized by engine) */
  description: string;
  /** Acceptance criteria from the card */
  acceptanceCriteria: string[];
  /** Branch name the agent is working on */
  branch: string;
  /** Base branch */
  baseBranch: string;
}

// ---------------------------------------------------------------------------
// Deep merge utility
// ---------------------------------------------------------------------------

/**
 * Simple recursive deep merge. Objects merge recursively, arrays are replaced,
 * primitives are overwritten. `override` values win on conflict.
 */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overVal = override[key];

    if (
      overVal !== null &&
      typeof overVal === 'object' &&
      !Array.isArray(overVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>,
      );
    } else {
      result[key] = overVal;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

async function readJsonOrEmpty(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main assembly function
// ---------------------------------------------------------------------------

/**
 * Assemble the workspace's .claude/ directory by layering agent config
 * and task context on top of whatever the repo already has.
 *
 * - If configDir is set: merge configDir/.claude/settings.json into workspace,
 *   append configDir/.claude/CLAUDE.md to workspace's CLAUDE.md
 * - If configDir is NOT set but systemPrompt is: append systemPrompt to CLAUDE.md
 * - Always: append task context section to CLAUDE.md
 */
export async function assembleWorkspaceConfig(options: WorkspaceConfigOptions): Promise<void> {
  const {
    workspaceDir,
    systemPrompt,
    configDir,
    title,
    description,
    acceptanceCriteria,
    branch,
    baseBranch,
  } = options;

  const claudeDir = join(workspaceDir, '.claude');
  await mkdir(claudeDir, { recursive: true });

  // ---- CLAUDE.md assembly ----

  const claudeMdPath = join(claudeDir, 'CLAUDE.md');
  const parts: string[] = [];

  // Layer 1: existing repo CLAUDE.md
  const existingMd = await readFileOrEmpty(claudeMdPath);
  if (existingMd.trim()) {
    parts.push(existingMd.trim());
  }

  // Layer 2: agent config (configDir CLAUDE.md wins over systemPrompt)
  if (configDir) {
    const agentMd = await readFileOrEmpty(join(configDir, '.claude', 'CLAUDE.md'));
    if (agentMd.trim()) {
      parts.push(agentMd.trim());
    }
  } else if (systemPrompt) {
    parts.push(systemPrompt.trim());
  }

  // Layer 3: task context (always appended)
  const taskSection = buildTaskSection(title, description, acceptanceCriteria, branch, baseBranch);
  parts.push(taskSection);

  await writeFile(claudeMdPath, parts.join('\n\n---\n\n') + '\n', 'utf-8');

  // ---- settings.json merge (only when configDir is set) ----

  if (configDir) {
    const settingsPath = join(claudeDir, 'settings.json');
    const agentSettingsPath = join(configDir, '.claude', 'settings.json');

    const workspaceSettings = await readJsonOrEmpty(settingsPath);
    const agentSettings = await readJsonOrEmpty(agentSettingsPath);

    if (agentSettings) {
      const merged = workspaceSettings
        ? deepMerge(workspaceSettings, agentSettings)
        : agentSettings;
      await writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    }
  }
}

// ---------------------------------------------------------------------------
// Task context builder
// ---------------------------------------------------------------------------

function buildTaskSection(
  title: string,
  description: string,
  acceptanceCriteria: string[],
  branch: string,
  baseBranch: string,
): string {
  const lines: string[] = [];

  lines.push('## Current Task');
  lines.push('');
  lines.push(`**${title}**`);

  if (description.trim()) {
    lines.push('');
    lines.push(description.trim());
  }

  if (acceptanceCriteria.length > 0) {
    lines.push('');
    lines.push('## Acceptance Criteria');
    for (const criterion of acceptanceCriteria) {
      lines.push(`- ${criterion}`);
    }
  }

  lines.push('');
  lines.push('## Working Branch');
  lines.push('');
  lines.push(`You are on branch \`${branch}\`, based off \`${baseBranch}\`.`);
  lines.push('Push your changes and create a pull request when done.');

  return lines.join('\n');
}
