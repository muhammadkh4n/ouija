/**
 * Subprocess management for the Claude Code CLI.
 *
 * Security invariants:
 *  - ANTHROPIC_API_KEY is injected via environment variable only. Never
 *    passed as a CLI argument (would be visible in `ps` output).
 *  - The prompt is sent via stdin, not shell-expanded CLI args, to prevent
 *    injection attacks if the prompt contains shell metacharacters.
 *  - process.env is NEVER spread into the subprocess. Only an allowlist
 *    of safe vars (PATH, HOME, LANG, etc.) is passed. This prevents
 *    leaking DB passwords, JWT keys, or other server secrets.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result returned after a Claude Code CLI subprocess completes (or is killed).
 */
export interface SubprocessResult {
  /** Process exit code. 1 when killed. */
  exitCode: number;
  /** Accumulated stdout text. */
  stdout: string;
  /** Accumulated stderr text. */
  stderr: string;
  /** True when the process was killed due to timeout. */
  timedOut: boolean;
  /** Wall-clock duration of the subprocess in milliseconds. */
  durationMs: number;
}

/**
 * Options for spawning a Claude Code CLI subprocess.
 */
export interface SpawnClaudeOptions {
  /** Prompt text — sent to the process via stdin. */
  prompt: string;
  /** Working directory (the cloned repo). */
  cwd: string;
  /**
   * Extra environment variables merged on top of process.env.
   * ANTHROPIC_API_KEY must be included here — it is NEVER passed as a CLI arg.
   */
  env: Record<string, string>;
  /** Timeout in milliseconds. SIGTERM is sent when exceeded. */
  timeoutMs: number;
  /** Path to the claude binary. Defaults to "claude" (PATH lookup). */
  binaryPath?: string;
  /**
   * Called with each stdout chunk as it arrives.
   * Used for live heartbeat reporting without buffering the full output.
   */
  onOutput?: (chunk: string) => void;
  /** External cancellation signal (e.g. from AbortController on cancel()). */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Spawn a Claude Code CLI process and wait for it to exit.
 *
 * Uses `claude --print --output-format text` (non-interactive mode).
 * The prompt is piped via stdin so it never appears in the process argument
 * list or shell history.
 *
 * Termination order:
 *  1. Timeout or AbortSignal fires → SIGTERM
 *  2. 5 s grace period → SIGKILL if still alive
 */
export async function spawnClaude(options: SpawnClaudeOptions): Promise<SubprocessResult> {
  const binary = options.binaryPath ?? 'claude';

  // --print puts Claude in non-interactive, single-shot mode.
  // --output-format text returns plain text (not JSON).
  const args = ['--print', '--output-format', 'text'];

  // SECURITY (F1): Allowlist env vars — never spread process.env into the
  // subprocess. The Claude CLI process could read DB passwords, JWT signing
  // keys, etc. Only pass what it actually needs.
  const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'USER', 'TERM', 'NODE_ENV'];
  const safeBaseEnv: Record<string, string | undefined> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) safeBaseEnv[key] = process.env[key];
  }
  const mergedEnv: Record<string, string | undefined> = {
    ...safeBaseEnv,
    ...options.env,
    // Disable any interactive TTY detection inside Claude Code.
    CI: '1',
  };

  return new Promise<SubprocessResult>((resolve, reject) => {
    const startTime = Date.now();
    let timedOut = false;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        cwd: options.cwd,
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

    // ---- stdin: write the prompt then close ----
    if (child.stdin) {
      child.stdin.write(options.prompt, 'utf8');
      child.stdin.end();
    }

    // ---- stdout: buffer + optional live callback ----
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdoutChunks.push(text);
        options.onOutput?.(text);
      });
    }

    // ---- stderr: buffer only ----
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk.toString('utf8'));
      });
    }

    // ---- timeout enforcement ----
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Force-kill after 5 s if SIGTERM was ignored.
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5_000);
    }, options.timeoutMs);

    // ---- external cancellation via AbortSignal ----
    const onAbort = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5_000);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        // Signal was already aborted before we even started — kill immediately.
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // ---- error (spawn failure after initial fork) ----
    child.on('error', (err) => {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    // ---- exit: collect result ----
    child.on('exit', (code) => {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onAbort);
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
