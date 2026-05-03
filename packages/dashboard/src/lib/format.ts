/**
 * Small presentation helpers. Pure functions, deterministic, no I/O.
 */

/**
 * Format an ISO-8601 timestamp as "2m ago" / "3h ago" / "yesterday".
 * Uses Intl.RelativeTimeFormat for locale-aware output.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = then - now.getTime();
  const absSec = Math.abs(diffMs) / 1000;

  const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  if (absSec < 60) return fmt.format(Math.round(diffMs / 1000), 'second');
  if (absSec < 3600) return fmt.format(Math.round(diffMs / 60000), 'minute');
  if (absSec < 86400) return fmt.format(Math.round(diffMs / 3600000), 'hour');
  if (absSec < 2592000) return fmt.format(Math.round(diffMs / 86400000), 'day');
  return new Date(iso).toLocaleDateString();
}

/** Shorten a UUID-like ID to the last 7 chars for display. */
export function shortId(id: string): string {
  if (id.length <= 8) return id;
  return id.slice(-7);
}

/** True if the status represents work currently in flight. */
export function isInFlight(status: string): boolean {
  return status === 'provisioning' || status === 'dispatching' || status === 'running';
}

/** True when the pipeline is sitting in the review loop awaiting human or CI signal. */
export function isAwaitingReview(status: string): boolean {
  return status === 'awaiting_review';
}

/**
 * Subset of PipelineSummary used by {@link isZeroTokenAnomaly}. Typed as a
 * structural contract so the predicate can be reused from list and detail
 * views without coupling to the full summary shape.
 */
export interface ZeroTokenAnomalyInput {
  status: string;
  tokensUsed?: number | null;
  prUrl?: string | null;
}

/**
 * "Zero-token success" anomaly — pipeline reports succeeded but there is no
 * observable evidence of work (no tokens reported, no PR opened). This is
 * defensive depth: after Task 4 (DispatchOutcome, v0.4.0) the transition
 * layer refuses to accept zero-progress completions, so this should never
 * fire for fresh dispatches. It is intended to surface:
 *
 *   1. pre-v0.4.0 historical rows where tokens_used was never populated and
 *      the run may or may not have actually done anything;
 *   2. future runners that forget to populate {@link DispatchOutcome} and
 *      slip past the positive-evidence gate.
 *
 * Null/undefined tokensUsed is treated the same as 0 — "no evidence reported".
 * A prUrl of empty string is treated as no URL.
 */
export function isZeroTokenAnomaly(pipeline: ZeroTokenAnomalyInput): boolean {
  if (pipeline.status !== 'succeeded') return false;
  const tokens = pipeline.tokensUsed;
  const hasTokens = tokens !== null && tokens !== undefined && tokens > 0;
  if (hasTokens) return false;
  const pr = pipeline.prUrl;
  const hasPr = pr !== null && pr !== undefined && pr.length > 0;
  if (hasPr) return false;
  return true;
}


/**
 * Subset of {@link import('./api-types.js').PipelineSummary} the dwell
 * helpers consume. Structural so list and detail views can both pass their
 * full summary without coupling to the format module.
 */
export interface DwellInput {
  status: string;
  stateEnteredAt: string;
  dwellBudgetMs?: number | null;
}

/**
 * Milliseconds the pipeline has spent in its current state. Returns 0 when
 * `stateEnteredAt` is in the future (clock skew between client + server).
 */
export function dwellMs(input: DwellInput, now: Date = new Date()): number {
  const entered = new Date(input.stateEnteredAt).getTime();
  if (Number.isNaN(entered)) return 0;
  return Math.max(0, now.getTime() - entered);
}

/**
 * Render a dwell duration as a compact "2m 17s" / "1h 23m" / "3d 4h" label.
 * Two units max, leading unit is the largest non-zero. <1s renders as "0s"
 * so the badge always has stable width during the first reconciler tick.
 */
export function formatDwell(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const sec = totalSec % 60;
    return sec === 0 ? `${totalMin}m` : `${totalMin}m ${sec}s`;
  }
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const min = totalMin % 60;
    return min === 0 ? `${totalHr}h` : `${totalHr}h ${min}m`;
  }
  const day = Math.floor(totalHr / 24);
  const hr = totalHr % 24;
  return hr === 0 ? `${day}d` : `${day}d ${hr}h`;
}

/**
 * True when the pipeline has overstayed its dwell budget. Mirrors the
 * server-side {@link resolveDwellBudgetMs} envelope: a null/missing budget
 * means "no budget enforced" → never over, regardless of dwell. Used to
 * paint the dwell badge red and to predict (rather than lag) the engine's
 * DwellReconciler next-tick action.
 */
export function isOverDwellBudget(input: DwellInput, now: Date = new Date()): boolean {
  const budget = input.dwellBudgetMs;
  if (budget === null || budget === undefined) return false;
  return dwellMs(input, now) > budget;
}


/**
 * Format a USD cost as a fixed-precision string. Below 1¢ rounds to "<$0.01"
 * so the badge never renders "$0.0000" — operators care about visible spend.
 */
export function formatCostUsd(usd: number | null | undefined): string | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return null;
  if (usd <= 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Compact token-count formatting: "12.4k" / "1.2M". Plain integers for <1000
 * so small dispatches don't render as "0.5k".
 */
export function formatTokens(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  if (n < 1000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Structural shape of the `dispatch.outcome` event payload that the
 * dashboard cares about. Mirrors `DispatchOutcomePayload` in
 * `@ouija-dev/types/events.ts` minus the branded ids; defined here to
 * keep the dashboard from importing across the package boundary (see
 * api-types docstring). The narrowing helper handles missing fields.
 */
export interface DispatchOutcomeEventPayload {
  outcome?: {
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    commitsPushed?: number;
    toolCallsMade?: number;
    durationMs?: number;
    prUrl?: string;
  };
  accepted?: boolean;
}

/**
 * Narrowing predicate + accessor for `dispatch.outcome` payloads. Returns
 * a metrics object the timeline row renders, or null when the payload
 * doesn't match the expected shape (defensive against schema drift).
 */
export function readDispatchOutcomeMetrics(payload: unknown): {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  commitsPushed: number | null;
  toolCallsMade: number | null;
  durationMs: number | null;
  prUrl: string | null;
  accepted: boolean | null;
} | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as DispatchOutcomEventPayloadShape;
  const o = p.outcome;
  if (o === undefined || o === null || typeof o !== 'object') return null;
  return {
    tokensIn: typeof o.tokensIn === 'number' ? o.tokensIn : null,
    tokensOut: typeof o.tokensOut === 'number' ? o.tokensOut : null,
    costUsd: typeof o.costUsd === 'number' ? o.costUsd : null,
    commitsPushed: typeof o.commitsPushed === 'number' ? o.commitsPushed : null,
    toolCallsMade: typeof o.toolCallsMade === 'number' ? o.toolCallsMade : null,
    durationMs: typeof o.durationMs === 'number' ? o.durationMs : null,
    prUrl: typeof o.prUrl === 'string' && o.prUrl.length > 0 ? o.prUrl : null,
    accepted: typeof p.accepted === 'boolean' ? p.accepted : null,
  };
}

interface DispatchOutcomEventPayloadShape {
  outcome?: {
    tokensIn?: unknown;
    tokensOut?: unknown;
    costUsd?: unknown;
    commitsPushed?: unknown;
    toolCallsMade?: unknown;
    durationMs?: unknown;
    prUrl?: unknown;
  };
  accepted?: unknown;
}
