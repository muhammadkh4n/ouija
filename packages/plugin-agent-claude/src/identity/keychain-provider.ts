/**
 * KeychainProvider — extracts Claude subscription credentials from
 * the macOS Keychain via `/usr/bin/security find-generic-password`.
 *
 * **Highest-risk provider in this phase.** Keychain access from a
 * non-interactive process can fail in several user-visible ways:
 *  - Security preferences set "always require password" → GUI prompt
 *    on every read.
 *  - Keychain locked → empty stdout, exit 51.
 *  - Wrong service name → exit 44 (not found).
 *  - The agent process isn't in the entry's ACL → exit 51 + GUI prompt.
 *
 * Phase 3 Task 7 validates these paths on RexBook before Task 8 wires
 * the orchestrator to actually use this provider in production. Until
 * then, this code lives in the tree but is dormant — no caller.
 *
 * The shipped command shape:
 *
 *   /usr/bin/security find-generic-password \
 *       -s "Claude Code-credentials" -w
 *
 * `-w` writes ONLY the password (the credentials JSON, base64-decoded
 * from how the CLI stored it) to stdout. We don't pass `-a` because
 * the Claude CLI doesn't scope the entry by account; if the operator
 * has multiple Keychain entries with the same service, they can pass
 * `account` in the config to disambiguate.
 *
 * Parsing: Claude CLI stores the credentials JSON DIRECTLY as the
 * password (not base64-wrapped — verified against a 2026-04-20 sample).
 * We `JSON.parse(stdout.trim())` and that's the credentials blob.
 */

import { spawn } from 'node:child_process';
import type {
  AuthProvider,
  ClaudeCredentials,
  KeychainProviderConfig,
  ResolvedIdentity,
} from './types.js';

const DEFAULT_SERVICE = 'Claude Code-credentials';
const DEFAULT_SECURITY_BIN = '/usr/bin/security';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface KeychainRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export type KeychainRunner = (
  bin: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<KeychainRunResult>;

/** Default subprocess runner. Same kill discipline as the helper runner. */
export const defaultKeychainRunner: KeychainRunner = (bin, args, options) =>
  new Promise<KeychainRunResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(bin, [...args], {
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

/**
 * Build the argv for `/usr/bin/security find-generic-password`.
 * Exported so tests + the real runner can both observe the same shape.
 */
export function buildKeychainArgs(config: {
  service: string;
  account?: string;
}): string[] {
  const args = ['find-generic-password', '-s', config.service];
  if (config.account !== undefined && config.account.length > 0) {
    args.push('-a', config.account);
  }
  args.push('-w');
  return args;
}

/**
 * Map known `security` exit codes to operator-actionable messages.
 * Anything we don't recognise falls back to "exit code N — stderr X".
 */
export function diagnoseKeychainExit(exitCode: number, stderr: string): string {
  const tail = stderr.trim().slice(-400);
  switch (exitCode) {
    case 44:
      return 'Keychain entry not found. Has Claude CLI been signed in on this host? (`claude /login`)';
    case 51:
      return 'Keychain access denied. Likely cause: this process is not in the entry\'s ACL. Open Keychain Access.app, find the "Claude Code-credentials" entry, and either grant access to /usr/bin/security or to the calling binary.';
    case 36:
      return 'Keychain locked. Unlock it (`security unlock-keychain ~/Library/Keychains/login.keychain-db`) or grant Always Allow on the entry.';
    default:
      return `security exited with code ${exitCode}${tail.length > 0 ? ` — stderr: ${tail}` : ''}`;
  }
}

export class KeychainProvider implements AuthProvider {
  public readonly kind = 'keychain' as const;
  private readonly service: string;
  private readonly account: string | undefined;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly run: KeychainRunner;
  private readonly platform: NodeJS.Platform;

  constructor(
    config: Readonly<KeychainProviderConfig>,
    deps: {
      runner?: KeychainRunner;
      platform?: NodeJS.Platform;
    } = {},
  ) {
    this.service = config.service ?? DEFAULT_SERVICE;
    this.account = config.account;
    this.bin = config.securityBin ?? DEFAULT_SECURITY_BIN;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.run = deps.runner ?? defaultKeychainRunner;
    this.platform = deps.platform ?? process.platform;
  }

  async isAvailable(): Promise<boolean> {
    // macOS only. On Linux/Windows there's no Keychain to query, full stop.
    return this.platform === 'darwin';
  }

  async resolve(): Promise<ResolvedIdentity> {
    if (this.platform !== 'darwin') {
      throw new Error(
        `KeychainProvider: only available on macOS (current platform: ${this.platform})`,
      );
    }
    const args = buildKeychainArgs({ service: this.service, ...(this.account !== undefined ? { account: this.account } : {}) });
    const result = await this.run(this.bin, args, { timeoutMs: this.timeoutMs });

    if (result.timedOut) {
      throw new Error(
        `KeychainProvider: \`${this.bin}\` timed out after ${this.timeoutMs}ms — possibly waiting on a Keychain GUI prompt`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `KeychainProvider: ${diagnoseKeychainExit(result.exitCode, result.stderr)}`,
      );
    }

    const trimmed = result.stdout.trim();
    if (trimmed.length === 0) {
      throw new Error(
        'KeychainProvider: `security` returned exit 0 but empty stdout — Keychain entry exists but has no password set',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `KeychainProvider: Keychain payload is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).length === 0) {
      throw new Error(
        'KeychainProvider: Keychain payload JSON is empty or not an object',
      );
    }

    return {
      credentials: parsed as ClaudeCredentials,
      envOverrides: {},
      source: 'keychain',
    };
  }
}
