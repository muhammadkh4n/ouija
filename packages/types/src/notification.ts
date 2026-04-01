import type { BasePlugin } from './plugin.js';

// ---- Notification domain types ----

export type NotificationLevel = 'info' | 'warning' | 'error' | 'success';

export interface NotificationAction {
  label: string;
  url: string;
}

export interface Notification {
  /** Short heading */
  title: string;
  /** Body text (supports markdown where the channel allows it) */
  body: string;
  level: NotificationLevel;
  /** Deep links or CTA buttons */
  actions?: NotificationAction[];
  /** ISO 8601 — when the underlying event occurred */
  occurredAt: string;
  /** Opaque idempotency key — prevents duplicate sends on retry */
  idempotencyKey: string;
}

// ---- Notification plugin interface ----

export interface NotificationPlugin<TConfig = unknown> extends BasePlugin<TConfig> {
  /** Send a notification — idempotent on idempotencyKey */
  send(notification: Notification): Promise<void>;

  /** Verify credentials and channel reachability without side effects */
  testConnection(): Promise<{ ok: boolean; message?: string }>;
}
