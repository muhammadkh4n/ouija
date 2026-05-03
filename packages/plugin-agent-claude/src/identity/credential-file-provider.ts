/**
 * CredentialFileProvider — reads `~/.claude/.credentials.json` (or a
 * caller-supplied path) and parses it.
 *
 * The Linux / WSL path. On those platforms the Claude CLI persists
 * subscription credentials directly to disk; we just read them and
 * hand the JSON to the materialiser, which writes a fresh copy under
 * the per-dispatch home dir. Reading the operator's file is OK — we
 * don't write back to it, the runner gets its own private copy.
 *
 * On macOS the credentials live in Keychain instead, and this
 * provider's `isAvailable()` returns false; the `KeychainProvider`
 * is the right pick there.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AuthProvider,
  ClaudeCredentials,
  CredentialFileProviderConfig,
  ResolvedIdentity,
} from './types.js';

const DEFAULT_RELATIVE = ['.claude', '.credentials.json'];

export function defaultCredentialFilePath(home: string = homedir()): string {
  return join(home, ...DEFAULT_RELATIVE);
}

/** Quick + tolerant shape check. We don't fail on unknown extra keys. */
function looksLikeClaudeCredentials(value: unknown): value is ClaudeCredentials {
  if (typeof value !== 'object' || value === null) return false;
  // The CLI's known shape is `{ claudeAiOauth: {...} }`, but it's
  // forward-compat — accept any object and let the CLI validate at
  // its own layer. Empty objects we reject as obviously broken.
  return Object.keys(value).length > 0;
}

export class CredentialFileProvider implements AuthProvider {
  public readonly kind = 'credential-file' as const;
  private readonly path: string;

  constructor(config: Readonly<CredentialFileProviderConfig>) {
    this.path = config.path ?? defaultCredentialFilePath();
  }

  async isAvailable(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.path);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async resolve(): Promise<ResolvedIdentity> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      throw new Error(
        `CredentialFileProvider: cannot read ${this.path} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `CredentialFileProvider: ${this.path} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!looksLikeClaudeCredentials(parsed)) {
      throw new Error(
        `CredentialFileProvider: ${this.path} JSON shape is not recognisable as Claude credentials (empty object or non-object payload)`,
      );
    }
    return {
      credentials: parsed,
      envOverrides: {},
      source: 'credential-file',
    };
  }
}
