/**
 * @ouija-dev/plugin-engram — notification plugin that ingests pipeline
 * events into an Engram memory instance.
 *
 * Why: gives Ouija-dispatched agents durable cross-run memory without
 * Ouija itself having to implement recall. The Claude Code agent that
 * runs inside each dispatch already has the `engram-memory` MCP tools
 * (memory_recall, memory_ingest) configured via the user's ~/.claude/
 * — if Ouija ingests pipeline events into Engram on one side, those
 * same events become recallable from the dispatched agent's side with
 * no additional wiring.
 *
 * This plugin is deliberately one-way. It writes. Reading happens in
 * the agent subprocess via MCP.
 *
 * Integration surface:
 *   - Subprocess shells out to `engram-ingest` (see EngramClient).
 *   - Degrades gracefully when the binary isn't on PATH — log a warning
 *     at startup, then no-op every send(). The Ouija server boots fine.
 */

import type {
  NotificationPlugin,
  Notification,
  PluginManifest,
  PluginContext,
  PluginHealth,
} from '@ouija-dev/types';

import type { EngramConfig } from './config.js';
import { engramConfigSchema, applyDefaults } from './config.js';
import { EngramClient, EngramIngestError } from './engram-client.js';
import { formatMemory } from './formatter.js';

const SENT_CACHE_MAX = 1_000;

export class EngramNotifyPlugin implements NotificationPlugin<EngramConfig> {
  readonly manifest: PluginManifest = {
    name: '@ouija-dev/plugin-engram',
    version: '0.1.0',
    type: 'notification',
    coreApiVersion: '>=1.0.0 <2.0.0',
    configSchema: engramConfigSchema as unknown as Record<string, unknown>,
    events: {
      produces: [],
      consumes: [
        'notification.send',
        'agent.work.completed',
        'agent.work.failed',
        'agent.work.pr_ready',
        'agent.work.stalled',
      ],
    },
  };

  private config!: Required<EngramConfig>;
  private logger!: PluginContext['logger'];
  /** Exposed for tests — dependency-injected by makeForTesting(). */
  client!: EngramClient;

  /**
   * Set by start() when the binary probe fails. While true, send() is
   * a no-op. Allows the Ouija server to boot even when Engram isn't
   * available in the current environment.
   */
  private disabled = false;

  /** LRU-ish idempotency cache keyed on notification.idempotencyKey. */
  private readonly sentCache = new Map<string, true>();

  async init(context: PluginContext<EngramConfig>): Promise<void> {
    this.config = applyDefaults(context.config);
    this.logger = context.logger;

    // Only set a real client when not already injected by a test.
    if (this.client === undefined) {
      this.client = new EngramClient({ binaryPath: this.config.binaryPath });
    }

    this.logger.info('Engram notification plugin initialised', {
      binaryPath: this.config.binaryPath,
      project: this.config.project,
      source: this.config.source,
      raw: this.config.raw,
    });
  }

  async start(): Promise<void> {
    // Probe the binary — if it's missing, disable sends but keep the
    // plugin alive. The operator will see the warning in logs.
    const available = await this.client.available();
    if (!available) {
      this.disabled = true;
      this.logger.warn(
        'engram-ingest binary not available — plugin disabled. ' +
          'Install @engram-mem/mcp globally or set binaryPath in the plugin config.',
        { binaryPath: this.config.binaryPath },
      );
      return;
    }
    this.logger.info('Engram notification plugin started');
  }

  async stop(): Promise<void> {
    this.sentCache.clear();
    this.logger.info('Engram notification plugin stopped');
  }

  async healthCheck(): Promise<PluginHealth> {
    if (this.disabled) {
      return {
        healthy: false,
        message: 'engram-ingest binary not available',
      };
    }
    const available = await this.client.available();
    return { healthy: available };
  }

  // ---- NotificationPlugin ----

  async send(notification: Notification): Promise<void> {
    if (this.disabled) return;

    if (this.sentCache.has(notification.idempotencyKey)) {
      this.logger.debug('Duplicate notification skipped', {
        idempotencyKey: notification.idempotencyKey,
      });
      return;
    }

    const content = formatMemory(notification);

    try {
      await this.client.ingest(
        {
          content,
          source: this.config.source,
          project: this.config.project,
          raw: this.config.raw,
        },
        this.config.timeoutMs,
      );
    } catch (err) {
      // Ingestion failures are non-fatal: log and move on. We don't want
      // Engram outages to cascade into the pipeline's notification fan-out.
      if (err instanceof EngramIngestError) {
        this.logger.warn('Engram ingest failed', {
          exitCode: err.exitCode,
          stderr: err.stderr.slice(0, 400),
        });
      } else {
        this.logger.warn('Engram ingest failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Track sent — bounded eviction.
    if (this.sentCache.size >= SENT_CACHE_MAX) {
      const first = this.sentCache.keys().next().value;
      if (first !== undefined) this.sentCache.delete(first);
    }
    this.sentCache.set(notification.idempotencyKey, true);

    this.logger.info('Memory ingested', {
      title: notification.title,
      level: notification.level,
      project: this.config.project,
    });
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    const available = await this.client.available();
    if (available) return { ok: true, message: 'engram-ingest reachable' };
    return { ok: false, message: 'engram-ingest binary not found on PATH' };
  }
}

// ---- Plugin factory ----

export const PluginFactory = {
  manifest: new EngramNotifyPlugin().manifest,
  create: (): EngramNotifyPlugin => new EngramNotifyPlugin(),
};

export default PluginFactory;

// ---- Re-exports for test doubles ----

export { EngramClient, EngramIngestError } from './engram-client.js';
export type { ExecFileFn, IngestOptions } from './engram-client.js';
export type { EngramConfig } from './config.js';
export { formatMemory } from './formatter.js';
