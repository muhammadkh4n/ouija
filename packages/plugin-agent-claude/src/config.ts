/**
 * Configuration for the Claude Code agent dispatcher plugin.
 *
 * All secrets are referenced by name from the credential store —
 * raw secret values never appear in config objects.
 */
export interface ClaudeAgentConfig {
  /**
   * Credential store reference for the Anthropic API key.
   * Example: "cred:anthropic-key"
   * The worker resolves this ref to the actual key at runtime.
   */
  secretRef: string;

  /**
   * Default Claude model identifier.
   * Example: "claude-sonnet-4-20250514"
   */
  defaultModel: string;

  /**
   * Max agent runtime in milliseconds before SIGTERM is sent.
   * Must be between 60_000 (1 min) and 7_200_000 (2 hrs).
   */
  maxDurationMs: number;

  /**
   * Map of git hostname to credential store ref for repo access.
   * Example: { "github.com": "cred:github-pat" }
   *
   * At runtime the ref is resolved to the actual token, which is
   * injected into the git clone URL — never logged or exposed in
   * process arguments.
   */
  repoAccessTokens: Record<string, string>;

  /**
   * Base directory for temporary repo clones.
   * Defaults to os.tmpdir() when absent.
   */
  workDir?: string;

  /**
   * Absolute path to the claude CLI binary.
   * Defaults to "claude" (assumes it is on PATH).
   */
  claudeBinaryPath?: string;

  /** 'local' for subprocess, 'remote' for future SaaS providers. Defaults to 'local'. */
  executionMode?: 'local' | 'remote';
}

/**
 * JSON Schema for Ajv validation at plugin load time.
 * Must be kept in sync with ClaudeAgentConfig.
 */
export const claudeAgentConfigSchema = {
  type: 'object',
  required: ['secretRef', 'defaultModel', 'maxDurationMs', 'repoAccessTokens'],
  properties: {
    secretRef: {
      type: 'string',
      minLength: 1,
      description: 'Credential store reference for Anthropic API key',
    },
    defaultModel: {
      type: 'string',
      minLength: 1,
      description: 'Default Claude model to use',
    },
    maxDurationMs: {
      type: 'number',
      minimum: 60_000,
      maximum: 7_200_000,
      description: 'Max agent runtime in milliseconds',
    },
    repoAccessTokens: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Map of git hostname to credential store ref for repo access',
    },
    workDir: {
      type: 'string',
      description: 'Base temp directory for repo clones (defaults to os.tmpdir())',
    },
    claudeBinaryPath: {
      type: 'string',
      description: 'Absolute path to the claude CLI binary',
    },
    executionMode: {
      type: 'string',
      enum: ['local', 'remote'],
      description: 'Execution mode: local subprocess or remote sandbox',
    },
  },
  additionalProperties: false,
} as const;
