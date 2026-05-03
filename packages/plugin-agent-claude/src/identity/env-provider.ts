/**
 * EnvProvider — reads an Anthropic API key from a single env var.
 *
 * The simplest provider, and the production-ready one for the API-key
 * billing path + CI smoke. Self-hosters paying per-token set
 * `ANTHROPIC_API_KEY=sk-ant-...` in `.env`; the orchestrator resolves
 * it here, the materialiser writes NO credentials file (`.credentials.
 * json` is for OAuth subscription tokens), and the subprocess env
 * carries `ANTHROPIC_API_KEY` directly. Claude CLI reads it.
 *
 * Forward-compat note: this is also the path SaaS / E2B remote
 * runners will use, since they can't access the operator's Keychain
 * and shouldn't touch a credential file at all.
 */

import type {
  AuthProvider,
  EnvProviderConfig,
  ResolvedIdentity,
} from './types.js';

const DEFAULT_ENV_VAR = 'ANTHROPIC_API_KEY';

export class EnvProvider implements AuthProvider {
  public readonly kind = 'env' as const;
  private readonly envVar: string;
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(
    config: Readonly<EnvProviderConfig>,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.envVar = config.envVar ?? DEFAULT_ENV_VAR;
    this.env = env;
  }

  async isAvailable(): Promise<boolean> {
    const value = this.env[this.envVar];
    return typeof value === 'string' && value.length > 0;
  }

  async resolve(): Promise<ResolvedIdentity> {
    const value = this.env[this.envVar];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `EnvProvider: ${this.envVar} is not set in the environment`,
      );
    }
    return {
      credentials: null,
      envOverrides: { [this.envVar]: value },
      source: 'env',
    };
  }
}
