/**
 * @ouija-dev/plugin-engram configuration schema.
 *
 * All fields optional — the plugin boots with sensible defaults and
 * degrades gracefully when the `engram-ingest` binary isn't on PATH.
 */

export interface EngramConfig {
  /**
   * Path to the `engram-ingest` executable. Defaults to `engram-ingest`
   * (looked up via PATH). Override when running in Docker and you've
   * mounted the binary at a specific location.
   */
  binaryPath?: string;

  /**
   * Project scope tag passed to `engram-ingest --project`. Defaults to
   * `ouija`. Use this to isolate Ouija memories from other Engram sources
   * (chat, git commits, etc.).
   */
  project?: string;

  /**
   * Provenance tag passed to `engram-ingest --source`. Defaults to
   * `ouija-pipeline`.
   */
  source?: string;

  /**
   * Max subprocess wall-clock time in milliseconds. Defaults to 30_000.
   *
   * engram-ingest does three network round-trips per call: OpenAI embedding,
   * Supabase insert, Neo4j upsert. Measured 10.3 s for a fresh ingest
   * (2026-04-19, Neo4j on remote VPS); 10 s was too tight and SIGTERM'd the
   * subprocess just as it completed. 30 s gives comfortable headroom without
   * letting a real stall hold a notification.send job indefinitely. Matches
   * engram-ingest's own --timeout default of 60 s with a 2× safety margin.
   */
  timeoutMs?: number;

  /**
   * When true (default), skip the salience classifier by passing `--raw`.
   * Pipeline events are always "interesting" to Ouija so classification
   * is wasted latency and OpenAI spend.
   */
  raw?: boolean;
}

export const engramConfigSchema = {
  type: 'object',
  properties: {
    binaryPath: { type: 'string', minLength: 1 },
    project: { type: 'string', minLength: 1 },
    source: { type: 'string', minLength: 1 },
    timeoutMs: { type: 'number', minimum: 1_000, maximum: 120_000 },
    raw: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

/** Apply defaults to a partial EngramConfig. Pure function — no I/O. */
export function applyDefaults(partial: EngramConfig): Required<EngramConfig> {
  return {
    binaryPath: partial.binaryPath ?? 'engram-ingest',
    project: partial.project ?? 'ouija',
    source: partial.source ?? 'ouija-pipeline',
    timeoutMs: partial.timeoutMs ?? 30_000,
    raw: partial.raw ?? true,
  };
}
