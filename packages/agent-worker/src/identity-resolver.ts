/**
 * IdentityResolver — Phase 3 Task 8.
 *
 * Per-dispatch glue between the identity layer (Phase 3 Task 6) and
 * the agent worker. Each dispatch gets a private materialised
 * `<rootDir>/<dispatchId>/` containing the resolved credentials +
 * neutral `settings.json` + `.claude.json` seed. The plugin sets
 * `HOME` to that dir so Claude CLI's `~/.claude/...` resolves there
 * instead of the operator's host config — closing friction-log
 * #7+#8+#9 (no more `$HOME/.claude` bind mount).
 *
 * Cleanup is intentionally NOT this module's concern — the plugin's
 * `_runAgent` finally block does it once per dispatch (it already
 * cleans the workspace; same lifetime). That keeps lifecycle
 * coupled to the consumer of the dir, not its allocator.
 *
 * Caching: the AuthProvider's `resolve()` may spawn a subprocess
 * (Keychain / helper). We cache the result for the worker's
 * lifetime — credentials don't change between dispatches in the
 * same worker process, and we'd like to avoid hammering the
 * Keychain on every job. The cache TTL is implicit (process
 * lifetime); that's fine because `materializeClaudeHome` rewrites
 * the on-disk copy anyway, so a token rotation that happens between
 * dispatches gets picked up on the next worker restart.
 */

import { join } from 'node:path';
import {
  type AuthProvider,
  type ResolvedIdentity,
  materializeClaudeHome,
} from '@ouija-dev/plugin-agent-claude';

export interface ResolvedDispatchHome {
  /** Absolute path to the materialised home dir for this dispatch. */
  claudeHome: string;
  /** Source of credentials, for log telemetry. Mirrors `provider.kind`. */
  source: ResolvedIdentity['source'];
  /**
   * `true` when the home dir is per-dispatch ephemeral and the plugin
   * should `rm -rf` it on dispatch end. Always true here — kept on
   * the return shape so future "shared static home" providers can
   * set false and skip cleanup.
   */
  ephemeral: true;
}

export interface IdentityResolverOptions {
  /**
   * Parent dir for per-dispatch home dirs. Each dispatch gets a
   * `<rootDir>/<dispatchId>/`. Defaults to `/run/ouija/claude-home`
   * — the path Phase 3's compose files reserve for it.
   */
  rootDir?: string;
}

export const DEFAULT_CLAUDE_HOME_ROOT = '/run/ouija/claude-home';

export class IdentityResolver {
  private readonly provider: AuthProvider;
  private readonly rootDir: string;
  private cached: ResolvedIdentity | null = null;

  constructor(provider: AuthProvider, opts: IdentityResolverOptions = {}) {
    this.provider = provider;
    this.rootDir = opts.rootDir ?? DEFAULT_CLAUDE_HOME_ROOT;
  }

  /**
   * Resolve a per-dispatch home dir. Spawns the provider's
   * `resolve()` once (cached for the resolver's lifetime), then
   * materialises a fresh dir for this `dispatchId`.
   *
   * `dispatchId` is used verbatim as a path component; callers MUST
   * ensure it's a safe filename (the orchestrator's UUIDs already
   * are). We don't sanitise here on purpose — passing `..` should
   * fail loud, not silently strip.
   */
  async resolve(dispatchId: string): Promise<ResolvedDispatchHome> {
    if (dispatchId.length === 0 || dispatchId.includes('/') || dispatchId.includes('..')) {
      throw new Error(
        `IdentityResolver: dispatchId must be a non-empty filesystem-safe string; got "${dispatchId}"`,
      );
    }

    if (this.cached === null) {
      this.cached = await this.provider.resolve();
    }
    const identity = this.cached;

    const targetDir = join(this.rootDir, dispatchId);
    await materializeClaudeHome({
      targetDir,
      credentials: identity.credentials,
    });

    return {
      claudeHome: targetDir,
      source: identity.source,
      ephemeral: true,
    };
  }

  /**
   * Returns the env overrides the resolved identity wants applied
   * to the agent subprocess (`ANTHROPIC_API_KEY` for `EnvProvider`;
   * empty for file-based providers). Always safe to call after at
   * least one `resolve()`; throws if called before.
   */
  getEnvOverrides(): Record<string, string> {
    if (this.cached === null) {
      throw new Error('IdentityResolver: getEnvOverrides() called before any resolve()');
    }
    return { ...this.cached.envOverrides };
  }

  /** Source kind for telemetry. Throws if called before any resolve(). */
  getSource(): ResolvedIdentity['source'] {
    if (this.cached === null) {
      throw new Error('IdentityResolver: getSource() called before any resolve()');
    }
    return this.cached.source;
  }
}
