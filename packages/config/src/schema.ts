import { createRequire } from 'node:module';
import type { ErrorObject } from 'ajv';
import type { OuijaConfig, AgentProfileConfig, BoardConfig } from './types.js';

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
  boards?: BoardConfig[];
}

const agentProfileSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
    kanbanUserId: { type: 'string', nullable: true },
    avatar: { type: 'string', nullable: true },
    systemPrompt: { type: 'string', nullable: true },
    configDir: { type: 'string', nullable: true },
    model: { type: 'string', minLength: 1 },
    triggerMode: { type: 'string', enum: ['auto', 'manual'] },
    runner: {
      type: 'string',
      enum: ['local', 'stream-json', 'sdk'],
      nullable: true,
    },
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
          projectId: { type: 'string', nullable: true },
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

const boardColumnSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    action: { type: 'string', enum: ['dispatch_agent', 'close_and_notify', 'noop'] },
    agentId: { type: 'string', nullable: true },
  },
  required: ['name', 'action'],
  additionalProperties: false,
} as const;

const boardSchema = {
  type: 'object',
  properties: {
    boardId: { type: 'string', nullable: true },
    projectId: { type: 'string', nullable: true },
    columns: {
      type: 'array',
      items: boardColumnSchema,
    },
    defaultStallThresholdMs: { type: 'number', minimum: 30000, nullable: true },
    autoStartOnAssign: { type: 'boolean', nullable: true },
  },
  required: ['columns'],
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
    boards: {
      type: 'array',
      items: boardSchema,
      nullable: true,
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

  // Board semantic checks
  if (data.boards) {
    const boardIds = new Set<string>();
    for (let b = 0; b < data.boards.length; b++) {
      const board = data.boards[b]!;
      const resolvedId = board.boardId ?? board.projectId;

      if (resolvedId === undefined) {
        errors.push(`Board[${b}]: must have boardId or projectId`);
        continue;
      }

      if (boardIds.has(resolvedId)) {
        errors.push(`Duplicate board ID: "${resolvedId}"`);
      }
      boardIds.add(resolvedId);

      for (let c = 0; c < board.columns.length; c++) {
        const col = board.columns[c]!;
        if (col.action === 'dispatch_agent' && !col.agentId) {
          errors.push(
            `Board "${resolvedId}" column "${col.name}": agentId is required when action is dispatch_agent`,
          );
        }
      }
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
    ...(raw.boards ? { boards: raw.boards } : {}),
  };

  return { valid: true, config };
}
