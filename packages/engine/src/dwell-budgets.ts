/**
 * Per-state dwell budgets — the table the {@link DwellReconciler} enforces.
 *
 * Each entry is the maximum time an instance may spend in that status before
 * the reconciler synthesises a `timed_out` trigger. Stricter than the
 * heartbeat-based stall monitor (which only catches dispatching/running/
 * provisioning via `lastHeartbeatAt` drift): this layer covers all live
 * states by anchoring on `instance.stateEnteredAt`.
 *
 * `running` deliberately falls through to the per-board
 * {@link PipelineConfig} so callers can plug a longer cap for boards whose
 * agents legitimately run for hours. Use {@link resolveDwellBudgetMs} to get
 * the effective budget for a given (status, config) pair.
 *
 * Tenet 6 ("per-state dwell budgets") incarnated here. Numbers are
 * deliberately conservative — a 60s dispatching cap means a worker that
 * never picks up the BullMQ job becomes visibly failed within 2 reconciler
 * ticks rather than wedging silently.
 */
import type { PipelineConfig, PipelineStatus } from '@ouija-dev/types';

/**
 * Static portion of the budget table. Statuses absent here have no dwell
 * budget — `idle/succeeded/failed/cancelled/stalled` are either terminal or
 * already-handled-by-other-mechanisms (the operator drives them via
 * `human_retry`/`admin_reset`).
 *
 * `running` maps to `null` to signal "consult the per-board config" — see
 * {@link resolveDwellBudgetMs}.
 */
export const DEFAULT_DWELL_BUDGETS_MS: Readonly<Partial<Record<PipelineStatus, number | null>>> =
  Object.freeze({
    dispatching: 60_000, // 1 min — worker should pick up immediately
    provisioning: 120_000, // 2 min — VM cold start grace
    running: null, // consult config.maxDurationMs (or fall back to hard cap)
    awaiting_review: 14 * 24 * 60 * 60 * 1000, // 14 days — review-loop death
  });

/**
 * Fallback `running` cap when neither the per-board config nor a per-column
 * override sets `maxDurationMs`. Six hours: longer than any reasonable agent
 * run, but bounded so a stuck `claude` subprocess can't pin a row forever.
 */
export const RUNNING_HARD_CAP_MS = 6 * 60 * 60 * 1000;

/**
 * Resolve the effective dwell budget for `status` against `config`. Returns
 * `undefined` when the status has no budget (terminal / no-op states). The
 * reconciler skips statuses that return `undefined`.
 *
 * For `running`, prefers `config.defaultStallThresholdMs * 4` as a rough
 * proxy for "max acceptable run" when the config does not set an explicit
 * cap. This keeps the budget connected to existing operator intuition (the
 * stall threshold is the only run-duration knob today) without adding a new
 * config field in the same PR — friction-log #X follow-up.
 */
export function resolveDwellBudgetMs(
  status: PipelineStatus,
  config: PipelineConfig,
): number | undefined {
  const raw = DEFAULT_DWELL_BUDGETS_MS[status];
  if (raw === undefined) return undefined;
  if (raw !== null) return raw;
  // running: derive from config until per-board maxDurationMs is wired (Phase 3+).
  if (config.defaultStallThresholdMs > 0) {
    return Math.min(config.defaultStallThresholdMs * 4, RUNNING_HARD_CAP_MS);
  }
  return RUNNING_HARD_CAP_MS;
}

/**
 * Statuses the reconciler iterates each tick. Derived from the budget table
 * so adding a new entry above automatically extends coverage. Returns the
 * statuses in a stable, deterministic order so logs and tests are stable.
 */
export function reconcilableStatuses(): PipelineStatus[] {
  return (Object.keys(DEFAULT_DWELL_BUDGETS_MS) as PipelineStatus[]).sort();
}
