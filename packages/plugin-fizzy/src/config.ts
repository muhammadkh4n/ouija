export const fizzyConfigSchema = {
  type: 'object',
  properties: {
    baseUrl: { type: 'string', format: 'uri' },
    accessToken: { type: 'string', minLength: 1 },
    webhookSecret: { type: 'string', minLength: 1 },
  },
  required: ['baseUrl', 'accessToken', 'webhookSecret'],
  additionalProperties: false,
} as const;

export interface FizzyConfig {
  baseUrl: string;
  accessToken: string;
  webhookSecret: string;
}
