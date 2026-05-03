/**
 * Identity contract — Phase 3 Task 6.
 *
 * The Claude CLI authenticates from credentials stored at
 * `$HOME/.claude/.credentials.json`. Today we satisfy that contract
 * by bind-mounting the operator's host `~/.claude` directory into
 * the runner container — the source of friction-log items #7, #8,
 * #9 (mac Keychain doesn't surface there; backup-restore loops on a
 * read-only tmpfs; the operator's hooks-and-MCPs from `settings.json`
 * fire inside the runner and silently sabotage the dispatch).
 *
 * The narrow contract: an `AuthProvider` resolves a `ResolvedIdentity`
 * (credentials JSON + an env-overlay) from a single concrete source —
 * env, file, helper command, or macOS Keychain. The orchestrator will
 * later (Phase 3 Task 8) materialise a private, per-dispatch home
 * directory from the resolved identity and point Claude CLI at THAT
 * dir, so the operator's host config never leaks into runner space.
 *
 * This module ships the abstraction only — the runner doesn't yet
 * call it. Task 8 wires it up + flips compose to drop the bind mount.
 */

/**
 * Shape of the JSON the Claude CLI reads from `.credentials.json`.
 *
 * The known top-level key is `claudeAiOauth`; any other keys are
 * preserved verbatim (forward-compat with future CLI fields). We don't
 * touch the credential payload — providers parse it, the materialiser
 * writes it back out.
 */
export interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType?: string;
  };
  /**
   * Catch-all for forward-compat. Suppresses the eslint "unused" complaint
   * by being intentional + documented.
   */
  [key: string]: unknown;
}

/**
 * What every provider returns. Either a credentials blob (file-backed
 * providers — the materialiser writes it to `.credentials.json`) or a
 * pure env overlay (the `EnvProvider` — `ANTHROPIC_API_KEY` is set in
 * the subprocess env, no credential file at all).
 */
export interface ResolvedIdentity {
  /**
   * JSON written to `<claudeHome>/.credentials.json`. `null` for
   * env-only providers; in that case Claude CLI does NOT see a
   * credentials file, only `ANTHROPIC_API_KEY` in env.
   */
  credentials: ClaudeCredentials | null;
  /**
   * Env vars to merge into the subprocess env. Empty for file-based
   * providers; populated for `EnvProvider` (`ANTHROPIC_API_KEY`).
   */
  envOverrides: Record<string, string>;
  /**
   * Provider-discriminator + human label for logs. Must match the
   * provider's `kind`.
   */
  source: AuthProviderKind;
}

export type AuthProviderKind = 'env' | 'credential-file' | 'helper-command' | 'keychain';

/**
 * Discriminated union over per-provider configuration. All extra
 * fields beyond `kind` are provider-local — the factory dispatches
 * on `kind` and constructs the right concrete provider.
 */
export type AuthProviderConfig =
  | EnvProviderConfig
  | CredentialFileProviderConfig
  | HelperCommandProviderConfig
  | KeychainProviderConfig;

export interface EnvProviderConfig {
  kind: 'env';
  /** Env var name. Defaults to `ANTHROPIC_API_KEY`. */
  envVar?: string;
}

export interface CredentialFileProviderConfig {
  kind: 'credential-file';
  /** Absolute path. Defaults to `<homedir>/.claude/.credentials.json`. */
  path?: string;
}

export interface HelperCommandProviderConfig {
  kind: 'helper-command';
  /** Executable name or absolute path. */
  command: string;
  /** Argv after `command`. Optional. */
  args?: readonly string[];
  /** Per-invocation timeout in ms. Defaults to 10s — helpers should be fast. */
  timeoutMs?: number;
  /**
   * Optional env to forward to the helper. Allowlist style — we do NOT
   * spread `process.env` into helpers, the same `subprocess.ts` rule.
   */
  env?: Record<string, string>;
}

export interface KeychainProviderConfig {
  kind: 'keychain';
  /** Keychain "service" name. Defaults to `Claude Code-credentials`. */
  service?: string;
  /** Optional account scoping (`-a`); rarely needed for the Claude entry. */
  account?: string;
  /** `security` binary path; defaults to `/usr/bin/security` (macOS stock). */
  securityBin?: string;
  /** Per-invocation timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
}

/**
 * The provider contract. Implementations are stateless beyond their
 * config; `resolve()` may spawn subprocesses (Keychain, helper) and
 * read filesystem state (CredentialFile). Callers decide on caching.
 */
export interface AuthProvider {
  readonly kind: AuthProviderKind;
  /**
   * Quick, non-throwing precheck. Returns `true` iff `resolve()` has
   * a reasonable chance of succeeding (correct platform, env var
   * present, file exists). Soft failures don't throw — the factory
   * uses this to choose between providers in priority order without
   * paying the resolve cost.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Resolve the identity. Throws on hard failure (bad JSON, helper
   * exit non-zero, file unreadable when expected to exist).
   */
  resolve(): Promise<ResolvedIdentity>;
}
