/**
 * EngramClient — thin subprocess wrapper around `engram-ingest`.
 *
 * Security invariants:
 *   - execFile (not exec) so no shell interpretation
 *   - Content is passed on stdin, not as a CLI arg — avoids argv length
 *     limits and keeps the argv clean in `ps` output
 *   - Env is an allowlist (Engram needs SUPABASE_URL / OPENAI_API_KEY /
 *     NEO4J_* at runtime — we forward those explicitly)
 *   - Wall-clock timeout enforced via AbortController; the child is
 *     SIGTERM'd past the deadline
 *
 * Contract:
 *   - ingest() resolves on exit 0, rejects with EngramIngestError on
 *     non-zero exit, timeout, or spawn failure
 *   - available() returns false without throwing if the binary can't
 *     be invoked — used by the plugin for graceful degradation at boot
 */

import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IngestOptions {
  /** Markdown content to store. Passed to engram-ingest on stdin. */
  content: string;
  /** Provenance tag. Passed as --source. */
  source: string;
  /** Project scope. Passed as --project. */
  project: string;
  /** Optional session ID — linked to Ouija pipeline instance when set. */
  sessionId?: string;
  /** When true, passes --raw to skip salience classification. */
  raw: boolean;
}

/** Injectable exec function — lets tests avoid spawning real processes. */
export type ExecFileFn = (
  binary: string,
  args: readonly string[],
  options: { timeout: number; env: NodeJS.ProcessEnv; stdin?: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export class EngramIngestError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  constructor(message: string, exitCode: number, stderr: string) {
    super(message);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

// ---------------------------------------------------------------------------
// Env allowlist — forwarded to the engram-ingest subprocess
// ---------------------------------------------------------------------------

const ENGRAM_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  // Storage + intelligence backends Engram needs at runtime:
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'OPENAI_API_KEY',
  'NEO4J_URI',
  'NEO4J_USER',
  'NEO4J_PASSWORD',
  // Optional tuning:
  'ENGRAM_SALIENCE_THRESHOLD',
  'ENGRAM_SALIENCE_DISABLED',
] as const;

function buildEngramEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENGRAM_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Default execFile wrapper
// ---------------------------------------------------------------------------

function defaultExecFile(
  binary: string,
  args: readonly string[],
  options: { timeout: number; env: NodeJS.ProcessEnv; stdin?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args as string[],
      { timeout: options.timeout, env: options.env, maxBuffer: 1_048_576 },
      (error, stdout, stderr) => {
        if (error !== null) {
          // Spawn failure (ENOENT) — reject so the caller can degrade gracefully
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(error);
            return;
          }
          // Non-zero exit — surface with stderr intact
          const exitCode = typeof error.code === 'number' ? error.code : 1;
          resolve({ stdout, stderr, exitCode });
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );

    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// EngramClient
// ---------------------------------------------------------------------------

export interface EngramClientOptions {
  binaryPath: string;
  /** Test hook — override the real execFile call. */
  execFn?: ExecFileFn;
}

export class EngramClient {
  private readonly binaryPath: string;
  private readonly execFn: ExecFileFn;

  constructor(options: EngramClientOptions) {
    this.binaryPath = options.binaryPath;
    this.execFn = options.execFn ?? defaultExecFile;
  }

  /**
   * Ingest one memory by shelling out to `engram-ingest --stdin`.
   * Resolves on success, rejects with EngramIngestError on failure.
   */
  async ingest(options: IngestOptions, timeoutMs: number): Promise<void> {
    const args = [
      '--stdin',
      '--source',
      options.source,
      '--project',
      options.project,
    ];
    if (options.raw) args.push('--raw');
    if (options.sessionId !== undefined) {
      args.push('--session-id', options.sessionId);
    }

    const result = await this.execFn(this.binaryPath, args, {
      timeout: timeoutMs,
      env: buildEngramEnv(),
      stdin: options.content,
    });

    if (result.exitCode !== 0) {
      throw new EngramIngestError(
        `engram-ingest exited with code ${result.exitCode}`,
        result.exitCode,
        result.stderr,
      );
    }
  }

  /**
   * Probe the binary with no content to check availability.
   * Returns false (without throwing) if the binary cannot be spawned,
   * true otherwise. Never throws — used for startup health checks.
   */
  async available(): Promise<boolean> {
    try {
      await this.execFn(this.binaryPath, ['--help'], {
        timeout: 5_000,
        env: buildEngramEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }
}
