/**
 * Webhook activity tracker.
 *
 * Records the most recent successfully-verified webhook, per source and
 * overall. Used by the dashboard's "last webhook received" indicator so a
 * self-hoster can see at a glance whether wiring is working — without
 * having to drag a card and wait for a pipeline to appear.
 *
 * Intentionally in-memory + process-local. The cost of storing this in
 * Postgres just for a UI hint isn't worth it; a restart forgetting the
 * last-received time is a feature, not a bug (it means the user hasn't
 * seen activity since restart and that's the right thing to surface).
 *
 * Only records AFTER signature verification passes, so a rejected webhook
 * never moves the needle — a green indicator always means "real webhooks
 * are flowing in".
 */

export type WebhookSource = 'plane' | 'github' | 'fizzy';

export interface WebhookActivityEntry {
  source: WebhookSource;
  receivedAt: string;
}

export class WebhookActivityTracker {
  private lastBySource = new Map<WebhookSource, string>();
  private lastOverall: WebhookActivityEntry | null = null;

  record(source: WebhookSource): void {
    const now = new Date().toISOString();
    this.lastBySource.set(source, now);
    this.lastOverall = { source, receivedAt: now };
  }

  snapshot(): {
    last: WebhookActivityEntry | null;
    perSource: Record<string, string>;
  } {
    return {
      last: this.lastOverall,
      perSource: Object.fromEntries(this.lastBySource),
    };
  }
}
