/**
 * HelperCommandProvider — runs an operator-supplied script that prints
 * Claude credentials JSON to stdout.
 *
 * The escape hatch for credential stores we don't natively know about:
 * HashiCorp Vault, AWS Secrets Manager, Doppler, 1Password CLI, a
 * homemade `gpg --decrypt` chain. The operator writes whatever script
 * makes sense for their secret-management tool and points us at it.
 *
 * Subprocess discipline mirrors `subprocess.ts`:
 *  - ENV is allowlisted, never `...process.env`. Only `PATH`, `HOME`,
 *    `TMPDIR` plus operator-allowlisted keys go through.
 *  - Hard timeout (default 10s — credential helpers should be fast).
 *  - Non-zero exit → resolve() throws with the captured stderr so the
 *    operator can see what their script did wrong.
 */

import { spawn } from 'node:child_process';
import type {
  AuthProvider,
  ClaudeCredentials,
  HelperCommandProviderConfig,
  ResolvedIdentity,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'] as const;

export interface HelperRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export type HelperRunner = (
  command: string,
  args: readonly string[],
  options: {
    env: Record<string, string>;
    timeoutMs: number;
  },
) => Promise<HelperRunResult>;

/**
 * Default subprocess runner. Mirrors `spawnClaude` discipline: kill
 * on timeout (SIGTERM, then SIGKILL after 5s), buffer stdout/stderr
 * fully, never spread `process.env`.
 */
export const defaultHelperRunner: HelperRunner = (command, args, options) =>
  new Promise<HelperRunResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(command, [...args], {
      env: options.env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5_000);
    }, options.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
    });
  });

export class HelperCommandProvider implements AuthProvider {
  public readonly kind = 'helper-command' as const;
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly timeoutMs: number;
  private readonly extraEnv: Readonly<Record<string, string>>;
  private readonly run: HelperRunner;
  private readonly baseEnv: Readonly<Record<string, string | undefined>>;

  constructor(
    config: Readonly<HelperCommandProviderConfig>,
    deps: {
      runner?: HelperRunner;
      env?: Readonly<Record<string, string | undefined>>;
    } = {},
  ) {
    if (config.command.length === 0) {
      throw new Error('HelperCommandProvider: command must be non-empty');
    }
    this.command = config.command;
    this.args = config.args ?? [];
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraEnv = config.env ?? {};
    this.run = deps.runner ?? defaultHelperRunner;
    this.baseEnv = deps.env ?? process.env;
  }

  /**
   * We can't probe whether `command` exists on PATH without spawning,
   * which is exactly what `resolve()` does. So `isAvailable()` is a
   * lightweight "config looks OK" check — the factory uses it as a
   * "this provider is configured, attempt to run it" signal.
   */
  async isAvailable(): Promise<boolean> {
    return this.command.length > 0;
  }

  async resolve(): Promise<ResolvedIdentity> {
    const env: Record<string, string> = {};
    for (const key of ENV_ALLOWLIST) {
      const value = this.baseEnv[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, this.extraEnv);

    const result = await this.run(this.command, this.args, {
      env,
      timeoutMs: this.timeoutMs,
    });

    if (result.timedOut) {
      throw new Error(
        `HelperCommandProvider: ${this.command} timed out after ${this.timeoutMs}ms`,
      );
    }
    if (result.exitCode !== 0) {
      const tail = result.stderr.trim().slice(-400);
      throw new Error(
        `HelperCommandProvider: ${this.command} exited ${result.exitCode}${
          tail.length > 0 ? ` — stderr: ${tail}` : ''
        }`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(
        `HelperCommandProvider: ${this.command} stdout is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).length === 0) {
      throw new Error(
        `HelperCommandProvider: ${this.command} stdout JSON is empty or not an object`,
      );
    }

    return {
      credentials: parsed as ClaudeCredentials,
      envOverrides: {},
      source: 'helper-command',
    };
  }
}
