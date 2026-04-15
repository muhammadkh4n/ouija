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
