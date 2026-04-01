/**
 * StallMonitor — Dead man's switch Layer 2 (spec §4.5).
 *
 * Layer 1 (BullMQ delayed job) is the primary stall detector. It fires
 * precisely at the stall threshold and resets with each heartbeat.
 *
 * Layer 2 (this class) is the safety net. It runs every 60 seconds and
 * queries Postgres for instances stuck in dispatching/running state past
 * their stall threshold. This catches anything that survives a Redis restart,
 * a missed BullMQ job, or a crash mid-side-effect.
 *
 * Operation:
 *  1. Compute cutoff = now - defaultStallThresholdMs
 *  2. Query findStalledCandidates(cutoff) → instances that haven't heartbeated
 *  3. For each candidate: call orchestrator.processStallDetected()
 *
 * The orchestrator (and pure transition function) handles idempotency:
 * if the pipeline is already in stalled state, the transition is rejected
 * and nothing changes.
 */

import type { Database, PipelineInstance, PipelineState } from '@ouija/types';
import { dispatchId as makeDispatchId } from '@ouija/types';
import type { Orchestrator } from './orchestrator.js';

// ---- Logger interface ----

interface StallMonitorLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: StallMonitorLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---- StallMonitor ----

export class StallMonitor {
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Database,
    private readonly orchestrator: Orchestrator,
    private readonly defaultStallThresholdMs: number = 300_000,
    private readonly logger: StallMonitorLogger = noopLogger,
  ) {}

  /**
   * Start the background scanner.
   *
   * @param intervalMs - Scan interval in milliseconds. Default: 60,000ms (1 min).
   */
  start(intervalMs: number = 60_000): void {
    if (this.intervalHandle !== undefined) {
      this.logger.warn('StallMonitor.start called while already running — ignoring');
      return;
    }
    this.logger.info('StallMonitor started', {
      intervalMs,
      defaultStallThresholdMs: this.defaultStallThresholdMs,
    });
    this.intervalHandle = setInterval(() => {
      this.scan().catch((err) => {
        this.logger.error('StallMonitor.scan threw unexpectedly', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
  }

  /**
   * Stop the background scanner. Safe to call when not started.
   */
  stop(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
      this.logger.info('StallMonitor stopped');
    }
  }

  /** True if the scanner is currently running. */
  get isRunning(): boolean {
    return this.intervalHandle !== undefined;
  }

  /**
   * Run one scan pass.
   *
   * Can be called manually — useful in tests and for forced recovery runs.
   * Finds all pipeline instances in dispatching/running state whose last
   * activity predates the cutoff, then fires stall_detected for each.
   */
  async scan(): Promise<void> {
    const cutoff = new Date(Date.now() - this.defaultStallThresholdMs);
    this.logger.info('StallMonitor.scan running', { cutoff: cutoff.toISOString() });

    let candidates: PipelineInstance[];
    try {
      candidates = await this.db.pipelines.findStalledCandidates(cutoff);
    } catch (err) {
      this.logger.error('StallMonitor.scan: DB query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (candidates.length === 0) {
      this.logger.info('StallMonitor.scan: no stalled candidates found');
      return;
    }

    this.logger.warn('StallMonitor.scan: stalled candidates detected', {
      count: candidates.length,
      instanceIds: candidates.map((c) => String(c.id)),
    });

    await Promise.all(
      candidates.map((instance) =>
        this._triggerStall(instance).catch((err) => {
          this.logger.error('StallMonitor: failed to trigger stall for instance', {
            instanceId: String(instance.id),
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    );
  }

  private async _triggerStall(instance: PipelineInstance): Promise<void> {
    const state = instance.state as PipelineState;

    // Safety check — findStalledCandidates should only return these states
    if (state.status !== 'dispatching' && state.status !== 'running') {
      this.logger.warn('StallMonitor._triggerStall: unexpected state, skipping', {
        instanceId: String(instance.id),
        status: state.status,
      });
      return;
    }

    const now = new Date().toISOString();
    const dispatchIdVal = makeDispatchId(state.dispatchId);

    await this.orchestrator.processStallDetected(String(instance.id), dispatchIdVal, now);
  }
}
