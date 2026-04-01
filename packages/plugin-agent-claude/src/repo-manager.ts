/**
 * Git operations for the Claude agent dispatcher.
 *
 * Uses the git CLI via child_process.execFile rather than a library.
 * Rationale: git is always available in the agent's execution environment,
 * CLI output is predictable, and this avoids an extra dependency.
 *
 * Security invariants:
 *  - Credentials are NEVER embedded in the clone URL. Use GIT_ASKPASS or a
 *    pre-configured credential helper instead.
 *  - All git operations use execFile (not exec/shell) to prevent argument
 *    injection from user-controlled data like branch names.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for cloneRepo.
 */
export interface CloneOptions {
  /** Remote repository URL. Must NOT contain embedded credentials. */
  repoUrl: string;
  /** Branch to check out after cloning. */
  branch: string;
  /** Local directory to clone into (must not already exist). */
  targetDir: string;
  /**
   * Optional: GIT_ASKPASS script path that prints the token to stdout.
   * Used to supply credentials without embedding them in the URL.
   * See: https://git-scm.com/docs/gitcredentials
   */
  gitAskPassScript?: string;
}

// ---------------------------------------------------------------------------
// Git operations
// ---------------------------------------------------------------------------

/**
 * Clone a repository, checking out a specific branch.
 *
 * Uses --single-branch to avoid downloading all refs — faster for large repos.
 *
 * If gitAskPassScript is provided, it is set as GIT_ASKPASS so git calls it
 * to obtain the password when prompted. This keeps the credential out of the
 * URL (and out of the process argument list).
 */
export async function cloneRepo(options: CloneOptions): Promise<void> {
  const { repoUrl, branch, targetDir, gitAskPassScript } = options;

  // SECURITY (F1): Allowlist env — git only needs PATH, HOME, SSH_AUTH_SOCK
  const GIT_ENV_ALLOWLIST = ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'LANG', 'LC_ALL', 'TMPDIR'];
  const env: Record<string, string | undefined> = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Disable interactive prompts — fail fast if credentials are wrong.
  env['GIT_TERMINAL_PROMPT'] = '0';

  if (gitAskPassScript) {
    env['GIT_ASKPASS'] = gitAskPassScript;
  }

  await execFileAsync(
    'git',
    [
      'clone',
      '--branch', branch,
      '--single-branch',
      '--depth', '1',
      repoUrl,
      targetDir,
    ],
    { env: env as NodeJS.ProcessEnv },
  );
}

/**
 * Create a new branch and check it out in the given directory.
 *
 * Equivalent to `git checkout -b <branchName>`.
 */
export async function createBranch(dir: string, branchName: string): Promise<void> {
  await execFileAsync('git', ['checkout', '-b', branchName], { cwd: dir });
}

/**
 * Push a local branch to the specified remote.
 *
 * `--set-upstream` (or `-u`) links the local branch to the remote tracking
 * branch so subsequent `git push` calls inside the agent don't need args.
 */
export async function pushBranch(
  dir: string,
  remote: string,
  branch: string,
): Promise<void> {
  await execFileAsync('git', ['push', '--set-upstream', remote, branch], { cwd: dir });
}

/**
 * Configure git user identity for commits made inside a cloned repo.
 *
 * The agent needs a committer identity or git will refuse to commit.
 * We use a neutral bot identity that is clearly machine-generated.
 */
export async function configureGitIdentity(
  dir: string,
  name = 'Ouija Agent',
  email = 'ouija-agent@noreply.local',
): Promise<void> {
  await execFileAsync('git', ['config', 'user.name', name], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', email], { cwd: dir });
}
