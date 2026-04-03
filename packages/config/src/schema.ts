import { createRequire } from 'node:module';
import type { ErrorObject } from 'ajv';
import type { OuijaConfig, AgentProfileConfig } from './types.js';

// ajv and ajv-formats are CJS. Under NodeNext ESM, createRequire gives
// clean access to their default exports without type gymnastics.
const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Ajv = require('ajv').default as new (opts?: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => ((data: unknown) => boolean) & {
    errors?: ErrorObject[] | null;
  };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const addFormats = require('ajv-formats').default as (
  ajv: unknown,
) => void;

export type ValidationResult =
  | { valid: true; config: OuijaConfig }
  | { valid: false; errors: string[] };

interface RawOuijaConfig {
  claudeHome?: string | null;
  agents: AgentProfileConfig[];
}

const agentProfileSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
    avatar: { type: 'string', nullable: true },
    systemPrompt: { type: 'string', nullable: true },
    configDir: { type: 'string', nullable: true },
    model: { type: 'string', minLength: 1 },
    triggerMode: { type: 'string', enum: ['auto', 'manual'] },
    auth: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['api-key', 'bedrock', 'vertex', 'foundry', 'api-key-helper', 'proxy'],
        },
        secretRef: { type: 'string', minLength: 1 },
      },
      required: ['method', 'secretRef'],
      additionalProperties: false,
    },
    repos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string', nullable: true },
          path: { type: 'string', nullable: true },
          baseBranch: { type: 'string', minLength: 1 },
          default: { type: 'boolean', nullable: true },
        },
        required: ['baseBranch'],
        additionalProperties: false,
      },
      minItems: 1,
    },
    limits: {
      type: 'object',
      properties: {
        maxDurationMs: { type: 'number', minimum: 60000, maximum: 7200000 },
        stallThresholdMs: { type: 'number', minimum: 30000, nullable: true },
      },
      required: ['maxDurationMs'],
      additionalProperties: false,
    },
  },
  required: [
    'id', 'name', 'email', 'model', 'triggerMode', 'auth', 'repos', 'limits',
  ],
  additionalProperties: false,
} as const;

const configSchema = {
  type: 'object' as const,
  properties: {
    claudeHome: { type: 'string', nullable: true },
    agents: {
      type: 'array',
      items: agentProfileSchema,
      minItems: 1,
    },
  },
  required: ['agents'],
  additionalProperties: false,
};

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(configSchema);

function semanticChecks(data: RawOuijaConfig): string[] {
  const errors: string[] = [];

  const ids = new Set<string>();
  for (const agent of data.agents) {
    if (ids.has(agent.id)) {
      errors.push(`Duplicate agent ID: "${agent.id}"`);
    }
    ids.add(agent.id);
  }

  for (const agent of data.agents) {
    for (let i = 0; i < agent.repos.length; i++) {
      const repo = agent.repos[i]!;
      const hasUrl = repo.url !== undefined && repo.url !== null;
      const hasPath = repo.path !== undefined && repo.path !== null;
      if (hasUrl && hasPath) {
        errors.push(
          `Agent "${agent.id}" repo[${i}]: must have url or path, not both`,
        );
      }
      if (!hasUrl && !hasPath) {
        errors.push(
          `Agent "${agent.id}" repo[${i}]: must have either url or path`,
        );
      }
    }

    const defaultCount = agent.repos.filter((r) => r.default === true).length;
    if (defaultCount === 0) {
      errors.push(`Agent "${agent.id}": exactly one repo must be marked default`);
    } else if (defaultCount > 1) {
      errors.push(
        `Agent "${agent.id}": only one repo can be marked default, found ${defaultCount}`,
      );
    }
  }

  return errors;
}

export function validateConfig(data: unknown): ValidationResult {
  if (!validate(data)) {
    const errors = (validate.errors ?? []).map(
      (e: ErrorObject) => `${e.instancePath || '/'}: ${e.message ?? 'unknown error'}`,
    );
    return { valid: false, errors };
  }

  const raw = data as RawOuijaConfig;
  const semErrors = semanticChecks(raw);
  if (semErrors.length > 0) {
    return { valid: false, errors: semErrors };
  }

  const config: OuijaConfig = {
    claudeHome: raw.claudeHome ?? null,
    agents: raw.agents,
  };

  return { valid: true, config };
}
