// ---- Plane plugin configuration schema ----
// Defined as a const object so TypeScript preserves literal types.
// Use with Ajv for runtime validation via @ouija-dev/plugin-sdk.

export const planeConfigSchema = {
  type: 'object',
  properties: {
    baseUrl: { type: 'string', format: 'uri' },
    apiToken: { type: 'string', minLength: 1 },
    workspaceSlug: { type: 'string', minLength: 1 },
    webhookSecret: { type: 'string', minLength: 1 },
  },
  required: ['baseUrl', 'apiToken', 'workspaceSlug', 'webhookSecret'],
  additionalProperties: false,
} as const;

// ---- Derived TypeScript type ----

export interface PlaneConfig {
  baseUrl: string;
  apiToken: string;
  workspaceSlug: string;
  webhookSecret: string;
}
