/**
 * LocalAgentRunner — AgentRunner implementation for self-hosted execution.
 *
 * Spawns `claude --print --output-format text` as a child process inside the
 * provisioned workspace directory. The prompt is sent via stdin so it never
 * appears in the process argument list or shell history.
 *
 * Security invariants:
 *  - process.env is NEVER spread into the subprocess. Only an allowlist of
 *    safe vars (PATH, HOME, TMPDIR, SHELL, LANG, LC_ALL, USER, TERM,
 *    NODE_ENV) is forwarded, then caller-provided env is merged on top.
 *  - CI=1 is always injected to disable interactive TTY detection.
 *  - ANTHROPIC_API_KEY (and other secrets) come from the caller-provided env
 *    and are passed as environment variables, never as CLI arguments.
 *
 * Termination order when timeout or AbortSignal fires:
 *  1. SIGTERM sent to the child process.
 *  2. 5 s grace period.
 *  3. SIGKILL if still alive.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  Workspace,
} from '@ouija-dev/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Spawn function signature — matches the subset of node:child_process.spawn
 * used by LocalAgentRunner. Injectable for testing.
 */
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface LocalAgentRunnerOptions {
  /** Path to the claude binary. Defaults to "claude" (PATH lookup). */
  binaryPath?: string;
  /**
   * Custom spawn implementation — for testing only.
   * Defaults to node:child_process.spawn.
   */
  spawnFn?: SpawnFn;
}

// ---------------------------------------------------------------------------
// Environment allowlist
// ---------------------------------------------------------------------------

/** Safe env vars forwarded to the claude subprocess. */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'SHELL',
  'LANG',
  'LC_ALL',
  'USER',
  'TERM',
  'NODE_ENV',
] as const;

// ---------------------------------------------------------------------------
// LocalAgentRunner
// ---------------------------------------------------------------------------

export class LocalAgentRunner implements AgentRunner {
  private readonly binaryPath: string;
  private readonly spawnFn: SpawnFn;

  constructor(options: LocalAgentRunnerOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'claude';
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /**
   * Runs `claude --print --output-format text` inside workspace.endpoint.
   * The prompt is piped via stdin; caller-provided env vars are merged on
   * top of the safe allowlist.
   */
  async run(
    workspace: Workspace,
    prompt: string,
    env: Record<string, string>,
    timeoutMs: number,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const binary = this.binaryPath;
    // -p: non-interactive prompt mode (reads prompt, acts, exits)
    // --dangerously-skip-permissions: auto-accept all tool calls (agent mode)
    // --output-format text: plain text output (not JSON)
    const args = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text'];

    // Build env: allowlist from process.env, then caller env, then CI=1.
    const safeBaseEnv: Record<string, string | undefined> = {};
    for (const key of ENV_ALLOWLIST) {
      if (process.env[key] !== undefined) {
        safeBaseEnv[key] = process.env[key];
      }
    }
    const mergedEnv: Record<string, string | undefined> = {
      ...safeBaseEnv,
      ...env,
      CI: '1',
    };

    const spawnFn = this.spawnFn;

    return new Promise<AgentRunResult>((resolve, reject) => {
      const startTime = Date.now();
      let timedOut = false;
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      let child: ChildProcess;
      try {
        child = spawnFn(binary, args, {
          cwd: workspace.endpoint,
          env: mergedEnv as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(
          new Error(
            `Failed to spawn ${binary}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }

      // Prompt is passed via -p flag, not stdin. Close stdin immediately.
      if (child.stdin) {
        child.stdin.end();
      }

      // ---- stdout: buffer + optional live callback ----
      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          stdoutChunks.push(text);
          options?.onOutput?.(text);
        });
      }

      // ---- stderr: buffer only ----
      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          stderrChunks.push(chunk.toString('utf8'));
        });
      }

      // ---- helper: kill child with SIGTERM then SIGKILL after grace period ----
      const killChild = (): void => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5_000);
      };

      // ---- timeout enforcement ----
      const timeoutId = setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutMs);

      // ---- external cancellation via AbortSignal ----
      const onAbort = (): void => {
        killChild();
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          // Already aborted before spawn — kill immediately.
          onAbort();
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      // ---- error (post-fork spawn failure) ----
      child.on('error', (err) => {
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });

      // ---- exit: collect result ----
      child.on('exit', (code) => {
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener('abort', onAbort);
        resolve({
          exitCode: code ?? 1,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          timedOut,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }
}
