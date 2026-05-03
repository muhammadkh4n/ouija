/**
 * DwellReconciler — Phase-2 dwell-budget enforcement.
 *
 * Complements (does NOT replace) `StallMonitor`. Where the stall monitor
 * scans for heartbeat drift on the dispatching/running/provisioning trio,
 * this reconciler scans every status with an entry in
 * {@link DEFAULT_DWELL_BUDGETS_MS} — including `awaiting_review`, which the
 * stall monitor does not cover at all (the agent has already exited).
 *
 * Each tick:
 *   1. For every reconcilable status, compute `cutoff = now - budgetMs`.
 *   2. Query `db.pipelines.findOverbudgetCandidates(status, cutoff, batch)`.
 *   3. For each row, observe the dwell time (`now - stateEnteredAt`) and
 *      call `orchestrator.requestTimedOut(...)`. The orchestrator routes the
 *      synthesised `timed_out` trigger through `applyTrigger`, which the
 *      pure `handleTimedOut` resolves to `failed (retryable)` for live
 *      states and `stalled` for `awaiting_review`.
 *
 * Idempotency: the pure handler rejects when the live state has drifted out
 * of `trigger.fromStatus` between the reconciler's query and the
 * orchestrator's transaction — `applyTrigger` writes nothing on rejection,
 * so a slow reconciler racing with a real transition never double-fires.
 *
 * Bounded batches: each per-status query is capped at `batchSize` (default
 * 50) so a backlog of thousands of overdue rows still fits in one tick. The
 * remainder lands on the next tick.
 */

import type { Database, PipelineConfig, PipelineStatus } from '@ouija-dev/types';
import type { Orchestrator } from './orchestrator.js';
import {
  DEFAULT_DWELL_BUDGETS_MS,
  reconcilableStatuses,
  resolveDwellBudgetMs,
} from './dwell-budgets.js';

// ---- Logger interface (mirrors StallMonitor for consistency) ----

interface DwellReconcilerLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: DwellReconcilerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---- Config resolver ----

/**
 * The reconciler is board-agnostic — a single instance handles every
 * pipeline across every board. To resolve `running`'s budget (which depends
 * on per-board `defaultStallThresholdMs`) the caller injects this lookup.
 * Returning `undefined` makes the reconciler skip the row (e.g. when the
 * board config has been deleted between scan and resolution).
 */
export type DwellConfigResolver = (boardId: string) => Promise<PipelineConfig | undefined>;

// ---- DwellReconciler ----

export interface DwellReconcilerOptions {
  /** Scan interval in milliseconds. Default 60_000 (one minute). */
  intervalMs?: number;
  /** Per-status batch cap per tick. Default 50. */
  batchSize?: number;
  /** Optional logger; defaults to no-op. */
  logger?: DwellReconcilerLogger;
}

export class DwellReconciler {
  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly logger: DwellReconcilerLogger;

  constructor(
    private readonly db: Database,
    private readonly orchestrator: Orchestrator,
    private readonly resolveConfig: DwellConfigResolver,
    options: DwellReconcilerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.batchSize = options.batchSize ?? 50;
    this.logger = options.logger ?? noopLogger;
  }

  /** Start the background scanner. Idempotent. */
  start(): void {
    if (this.intervalHandle !== undefined) {
      this.logger.warn('DwellReconciler.start called while already running — ignoring');
      return;
    }
    this.logger.info('DwellReconciler started', {
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
      statuses: reconcilableStatuses(),
    });
    this.intervalHandle = setInterval(() => {
      this.scan().catch((err) => {
        this.logger.error('DwellReconciler.scan threw unexpectedly', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);
  }

  /** Stop the background scanner. Safe to call when not started. */
  stop(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
      this.logger.info('DwellReconciler stopped');
    }
  }

  /** True if the scanner is currently running. */
  get isRunning(): boolean {
    return this.intervalHandle !== undefined;
  }

  /**
   * Run one scan pass. Public for tests and forced recovery runs. Iterates
   * the reconcilable statuses in deterministic order; each status query is
   * independent (a failure on one status logs and continues to the next).
   *
   * Returns the number of `timed_out` triggers fired so callers (tests,
   * dashboards) can assert progress.
   */
  async scan(): Promise<number> {
    const now = Date.now();
    let totalFired = 0;

    for (const status of reconcilableStatuses()) {
      // running needs a per-board config to compute its budget. Use the
      // static fallback (RUNNING_HARD_CAP_MS via resolveDwellBudgetMs with
      // a stub config) for the cutoff query, then re-resolve per-row before
      // firing — that way a long per-board cap still gates the trigger
      // even if the static cutoff includes the row.
      const queryBudgetMs = this.staticCutoffBudget(status);
      if (queryBudgetMs === undefined) continue;
      const cutoff = new Date(now - queryBudgetMs);

      let candidates;
      try {
        candidates = await this.db.pipelines.findOverbudgetCandidates(
          status,
          cutoff,
          this.batchSize,
        );
      } catch (err) {
        this.logger.error('DwellReconciler.scan: DB query failed', {
          status,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (candidates.length === 0) continue;

      this.logger.warn('DwellReconciler.scan: overbudget candidates detected', {
        status,
        count: candidates.length,
        instanceIds: candidates.map((c) => String(c.id)),
      });

      for (const instance of candidates) {
        try {
          const config = await this.resolveConfig(String(instance.boardId));
          if (config === undefined) {
            this.logger.warn('DwellReconciler: board config missing, skipping', {
              instanceId: String(instance.id),
              boardId: String(instance.boardId),
            });
            continue;
          }
          const budgetMs = resolveDwellBudgetMs(status, config);
          if (budgetMs === undefined) continue;

          const enteredMs = new Date(instance.stateEnteredAt).getTime();
          const observedDwellMs = now - enteredMs;
          // Re-check against the per-board budget (running may be longer
          // than the static cutoff used for the query).
          if (observedDwellMs < budgetMs) continue;

          const outcome = await this.orchestrator.requestTimedOut(
            String(instance.id),
            status,
            budgetMs,
            observedDwellMs,
          );
          if (outcome.kind === 'timed_out') {
            totalFired += 1;
          }
        } catch (err) {
          this.logger.error('DwellReconciler: failed to time out instance', {
            instanceId: String(instance.id),
            status,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (totalFired > 0) {
      this.logger.warn('DwellReconciler.scan: timed_out fired', { count: totalFired });
    }
    return totalFired;
  }

  /**
   * Static cutoff budget used for the SQL query. For statuses with a fixed
   * budget this matches `resolveDwellBudgetMs`; for `running` (which needs
   * a per-board config) it falls back to the smallest plausible cap so the
   * query selects every row that *might* be overbudget — the per-row check
   * inside `scan()` then filters back down using the resolved per-board
   * budget. This avoids requiring a config-per-status mapping at query time.
   */
  private staticCutoffBudget(status: PipelineStatus): number | undefined {
    const raw = DEFAULT_DWELL_BUDGETS_MS[status];
    if (raw === undefined) return undefined;
    if (raw !== null) return raw;
    // running: use the lowest known stall-threshold (~5 min default) so the
    // query includes any row that has been running ≥ that long. The per-row
    // re-check enforces the actual per-board budget.
    return 300_000;
  }
}
