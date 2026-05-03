/**
 * Factory + auto-detection for AuthProvider.
 *
 * Two callers in mind:
 *
 *  1. Explicit config — operator set `auth.method: keychain` (or
 *     similar) in `ouija.config.yaml`. Factory builds the named
 *     provider with their per-method options. Hard error if the
 *     provider is unavailable on this host.
 *
 *  2. Auto-detect — no explicit config. Factory walks the providers
 *     in priority order and returns the first one whose
 *     `isAvailable()` returns true. Order is:
 *       (a) `EnvProvider` — `ANTHROPIC_API_KEY` set wins over
 *           file/Keychain because it's the explicit "I want API-key
 *           billing" signal. Common case in CI + SaaS.
 *       (b) `KeychainProvider` — macOS only. Subscription path.
 *       (c) `CredentialFileProvider` — Linux/WSL subscription path.
 *
 *     `HelperCommandProvider` is NEVER auto-picked — it requires
 *     explicit operator opt-in (we won't guess at a script path).
 */

import { CredentialFileProvider, defaultCredentialFilePath } from './credential-file-provider.js';
import { EnvProvider } from './env-provider.js';
import { HelperCommandProvider } from './helper-command-provider.js';
import { KeychainProvider } from './keychain-provider.js';
import type { AuthProvider, AuthProviderConfig } from './types.js';

export function createAuthProvider(
  config: Readonly<AuthProviderConfig>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): AuthProvider {
  switch (config.kind) {
    case 'env':
      return new EnvProvider(config, env);
    case 'credential-file':
      return new CredentialFileProvider(config);
    case 'helper-command':
      return new HelperCommandProvider(config, { env });
    case 'keychain':
      return new KeychainProvider(config, { platform });
    default: {
      // Exhaustiveness guard — if a new kind is added to AuthProviderConfig,
      // TypeScript will complain about missing case here.
      const _exhaustive: never = config;
      throw new Error(`createAuthProvider: unknown kind ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Auto-detection order. Exported so tests can assert the priority
 * without re-implementing it.
 */
export const AUTO_DETECT_ORDER: ReadonlyArray<AuthProviderConfig> = [
  { kind: 'env' },
  { kind: 'keychain' },
  { kind: 'credential-file' },
] as const;

/**
 * Walk the auto-detect order and return the first provider whose
 * `isAvailable()` is true. Returns `null` when nothing fires — the
 * caller surfaces a helpful error pointing at the env vars / paths
 * we tried so the operator knows what to fix.
 */
export async function autoDetectAuthProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<AuthProvider | null> {
  for (const config of AUTO_DETECT_ORDER) {
    const provider = createAuthProvider(config, env, platform);
    if (await provider.isAvailable()) return provider;
  }
  return null;
}
