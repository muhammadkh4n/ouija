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
    boards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          projectId: { type: 'string', minLength: 1 },
          boardId: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    projectNamePrefix: { type: 'string', minLength: 1 },
    ouijaServerUrl: { type: 'string', format: 'uri' },
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
  /**
   * Declared boards from ouija.config.yaml. Used by bootstrap to auto-
   * create Plane projects that reference a projectId which doesn't yet
   * exist (first-run self-hosters). Idempotent on subsequent starts.
   */
  boards?: Array<{ projectId?: string; boardId?: string }>;
  /**
   * Display-name prefix for auto-created projects. Defaults to "Ouija".
   * Each board gets `"<prefix> Board <N>"` (e.g. "Ouija Board 1").
   */
  projectNamePrefix?: string;
  /**
   * Externally-reachable ouija server URL — when set, the plugin logs the
   * exact webhook URL the self-hoster should paste into Plane's settings.
   */
  ouijaServerUrl?: string;
}
