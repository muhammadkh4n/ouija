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
