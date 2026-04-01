/**
 * WorkOrder → Claude CLI arguments mapping.
 *
 * Converts the structured WorkOrder into the flat prompt text and environment
 * variables that the Claude Code CLI subprocess needs. Kept separate from
 * the plugin so it can be unit-tested in isolation without touching I/O.
 */

import type { WorkOrder } from '@ouija/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Arguments consumed by spawnClaude().
 */
export interface ClaudeCliArgs {
  /** The full prompt string sent to Claude Code via stdin. */
  prompt: string;
  /** Working directory (the cloned repo). */
  cwd: string;
  /**
   * Environment variables — MUST include ANTHROPIC_API_KEY.
   * These are merged on top of process.env inside spawnClaude().
   */
  env: Record<string, string>;
  /** Timeout in milliseconds for the subprocess. */
  timeoutMs: number;
}

/**
 * Git clone coordinates derived from a WorkOrder.
 */
export interface GitCloneArgs {
  /** Repository URL. May have a credential token embedded for HTTPS repos. */
  cloneUrl: string;
  /** Local directory to clone into. */
  targetDir: string;
  /** Feature branch the agent should create and work on. */
  branch: string;
  /** Base branch to clone from (e.g. "main"). */
  baseBranch: string;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the prompt text from a WorkOrder.
 *
 * Sections included:
 *   - Card title as a Markdown heading
 *   - Card description (sanitized upstream by the engine)
 *   - Numbered acceptance criteria (if any)
 *   - Relevant file path hints (if any)
 *   - Explicit branching and PR instructions
 */
export function buildPrompt(workOrder: WorkOrder): string {
  const sections: string[] = [];

  sections.push(`# Task: ${workOrder.title}`);
  sections.push('');
  sections.push(workOrder.description);

  if (workOrder.acceptanceCriteria.length > 0) {
    sections.push('');
    sections.push('## Acceptance Criteria');
    workOrder.acceptanceCriteria.forEach((criterion, i) => {
      sections.push(`${i + 1}. ${criterion}`);
    });
  }

  if (workOrder.filePathHints && workOrder.filePathHints.length > 0) {
    sections.push('');
    sections.push('## Relevant Files');
    workOrder.filePathHints.forEach((filePath) => {
      sections.push(`- ${filePath}`);
    });
  }

  sections.push('');
  sections.push('## Instructions');
  sections.push(`- Work on branch: ${workOrder.branch}`);
  sections.push(`- Base branch: ${workOrder.baseBranch}`);
  sections.push('- Implement the changes described above');
  sections.push('- Write tests for any new functionality');
  sections.push('- Commit your changes with clear commit messages');
  sections.push('- Push the branch and open a pull request against the base branch');

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// CLI args builder
// ---------------------------------------------------------------------------

/**
 * Build SpawnClaude arguments from a WorkOrder.
 *
 * The anthropicApiKey is injected as an environment variable rather than
 * a CLI argument so it is never visible in `ps` output.
 */
export function buildCliArgs(
  workOrder: WorkOrder,
  cloneDir: string,
  anthropicApiKey: string,
): ClaudeCliArgs {
  return {
    prompt: buildPrompt(workOrder),
    cwd: cloneDir,
    env: {
      ANTHROPIC_API_KEY: anthropicApiKey,
    },
    timeoutMs: workOrder.maxDurationMs,
  };
}

// ---------------------------------------------------------------------------
// Git clone args builder
// ---------------------------------------------------------------------------

/**
 * Build git clone arguments from a WorkOrder.
 *
 * Security note: embedding the access token in the URL is a pragmatic trade-off
 * for simplicity. git does not log the URL by default, and the token is
 * short-lived (PAT scoped to the repo). A stricter alternative is GIT_ASKPASS,
 * which is used by repo-manager.ts when a gitAskPassScript is configured.
 *
 * If no accessToken is provided, the plain URL is returned and git will fall
 * back to whatever credential helper is configured on the host.
 */
export function buildGitCloneArgs(
  workOrder: WorkOrder,
  targetDir: string,
  accessToken?: string,
): GitCloneArgs {
  let cloneUrl = workOrder.repoUrl;

  // Embed token in HTTPS URLs only — SSH URLs use key-based auth.
  if (accessToken && cloneUrl.startsWith('https://')) {
    const url = new URL(cloneUrl);
    url.username = accessToken;
    cloneUrl = url.toString();
  }

  return {
    cloneUrl,
    targetDir,
    branch: workOrder.branch,
    baseBranch: workOrder.baseBranch,
  };
}
