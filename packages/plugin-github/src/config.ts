// ---- GitHub plugin config schema ----

export const githubConfigSchema = {
  type: 'object',
  properties: {
    personalAccessToken: { type: 'string', minLength: 1 },
    defaultOrg: { type: 'string' },
    webhookSecret: { type: 'string', minLength: 1 },
  },
  required: ['personalAccessToken', 'webhookSecret'],
  additionalProperties: false,
} as const;

// ---- Config type (inferred from schema shape) ----

export interface GitHubConfig {
  personalAccessToken: string;
  defaultOrg?: string;
  webhookSecret: string;
}
