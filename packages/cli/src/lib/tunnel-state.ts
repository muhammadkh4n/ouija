/**
 * Tunnel state — Phase 3 Task 5.
 *
 * Quick tunnels (`cloudflared tunnel --url ...`) generate a fresh random
 * `*.trycloudflare.com` host on every restart, so the webhook URL we
 * registered against GitHub last time goes stale the moment the tunnel
 * comes back up. Self-hosters who don't run a named-tunnel + DNS setup
 * would then have to rerun `ouija github connect` by hand each restart.
 *
 * This module persists a tiny snapshot — last-seen URL, the list of
 * `<owner/repo>` entries we've connected through this tunnel — to a
 * single JSON file. `runTunnel` reads it on startup, writes it once a
 * URL is detected, and uses the drift between persisted and current URL
 * to decide whether to auto-PATCH stale webhooks via `runGithubConnect`.
 *
 * The schema is deliberately tiny + versioned. If we ever change shape,
 * unknown versions read as `null` (treated identically to a missing
 * file — fresh start, no drift), so a forwards-incompatible bump just
 * means one extra manual `ouija github connect` after the upgrade.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface TunnelState {
  /** Schema version; bump only on incompatible changes. */
  version: 1;
  /** Last `*.trycloudflare.com` URL successfully detected; `null` before any detection. */
  lastUrl: string | null;
  /**
   * `<owner/repo>` entries we've auto-connected through this tunnel.
   * Insertion-order preserved so logs read predictably; deduped.
   */
  connectedRepos: string[];
  /** ISO-8601 timestamp of the last write. */
  updatedAt: string;
}

const STATE_FILE = 'tunnel-state.json';
const STATE_DIR = '.ouija';

/**
 * Resolve the on-disk state path, in priority order:
 *
 * 1. `OUIJA_TUNNEL_STATE_PATH` env — explicit absolute override (tests + CI).
 * 2. `OUIJA_HOME` env — `<OUIJA_HOME>/tunnel-state.json` (advanced operators).
 * 3. `<homedir>/.ouija/tunnel-state.json` — default for everyone else.
 *
 * Per-host (not per-cwd) on purpose: the operator's localhost server is
 * the same regardless of which project directory they're in.
 */
export function tunnelStatePath(
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir(),
): string {
  const explicit = env['OUIJA_TUNNEL_STATE_PATH'];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const ouijaHome = env['OUIJA_HOME'];
  if (ouijaHome !== undefined && ouijaHome.length > 0) {
    return join(ouijaHome, STATE_FILE);
  }
  return join(home, STATE_DIR, STATE_FILE);
}

/**
 * Type-guard for parsed JSON. Anything failing the shape check returns
 * false → caller treats the file as missing. No partial-recovery: we'd
 * rather start fresh than silently drop fields.
 */
function isTunnelState(value: unknown): value is TunnelState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 1) return false;
  if (v['lastUrl'] !== null && typeof v['lastUrl'] !== 'string') return false;
  if (!Array.isArray(v['connectedRepos'])) return false;
  if (!v['connectedRepos'].every((r) => typeof r === 'string')) return false;
  if (typeof v['updatedAt'] !== 'string') return false;
  return true;
}

/**
 * Read the state file. Returns `null` on every failure mode (missing
 * file, invalid JSON, unknown shape, permission denied) — the caller
 * uses null to mean "no prior state, treat as first run".
 */
export async function loadTunnelState(path: string): Promise<TunnelState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isTunnelState(parsed) ? parsed : null;
}

/**
 * Atomically write state to disk. Parent dir is created if missing.
 * The atomicity comes from `write tmp + rename`: a crash mid-write
 * leaves either the old file or the new file, never a half-truncated
 * one. Same `0600` permissions on the tmp avoid widening the window.
 */
export async function saveTunnelState(path: string, state: TunnelState): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, path);
}

/**
 * Add `repo` to `state.connectedRepos`, preserving insertion order and
 * deduping. Pure — returns a new state object even when the repo is
 * already present (immutable update style; cheap, predictable).
 */
export function mergeRepo(state: TunnelState, repo: string): TunnelState {
  if (state.connectedRepos.includes(repo)) {
    return { ...state, connectedRepos: [...state.connectedRepos] };
  }
  return { ...state, connectedRepos: [...state.connectedRepos, repo] };
}

export interface DriftResult {
  /** True iff state existed AND its lastUrl was a different concrete URL. */
  drifted: boolean;
  /** The previous URL that was overwritten, or `null` on a fresh start. */
  previousUrl: string | null;
}

/**
 * Compare `currentUrl` against the persisted `state.lastUrl`. Drift is
 * narrowly defined: state must exist, `lastUrl` must be a concrete
 * string, and the strings must differ. First-ever runs (state=null)
 * and runs where `lastUrl` was `null` are NOT drifts — we don't have a
 * stale webhook to chase.
 */
export function detectUrlDrift(
  state: TunnelState | null,
  currentUrl: string,
): DriftResult {
  if (state === null) return { drifted: false, previousUrl: null };
  if (state.lastUrl === null) return { drifted: false, previousUrl: null };
  if (state.lastUrl === currentUrl) return { drifted: false, previousUrl: state.lastUrl };
  return { drifted: true, previousUrl: state.lastUrl };
}

/**
 * Build a fresh state for a brand-new write. `connectedRepos` is the
 * union of any previously-persisted repos and a freshly-flagged one.
 */
export function buildState(input: {
  url: string;
  previousRepos: readonly string[];
  newRepo: string | undefined;
  now?: Date;
}): TunnelState {
  const repos: string[] = [...input.previousRepos];
  if (input.newRepo !== undefined && !repos.includes(input.newRepo)) {
    repos.push(input.newRepo);
  }
  return {
    version: 1,
    lastUrl: input.url,
    connectedRepos: repos,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
}
