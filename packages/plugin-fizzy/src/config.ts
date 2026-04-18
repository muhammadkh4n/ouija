export const fizzyConfigSchema = {
  type: 'object',
  properties: {
    baseUrl: { type: 'string', format: 'uri' },
    accessToken: { type: 'string', minLength: 1 },
    webhookSecret: { type: 'string', minLength: 1 },
    webhookUrl: { type: 'string', format: 'uri' },
    boardIds: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: ['baseUrl', 'accessToken', 'webhookSecret'],
  additionalProperties: false,
} as const;

export interface FizzyConfig {
  baseUrl: string;
  accessToken: string;
  webhookSecret: string;
  /**
   * Public URL Fizzy should POST webhook events to. When set (together with
   * boardIds), FizzyPlugin.start() auto-registers the webhook on each board
   * — removing the manual "copy the URL into Fizzy's webhook settings" step
   * for self-hosters.
   *
   * Example: http://ouija:4000/hooks/fizzy/<webhookSecret>
   */
  webhookUrl?: string;
  /** Board IDs that should have the webhook auto-registered. */
  boardIds?: string[];
}
