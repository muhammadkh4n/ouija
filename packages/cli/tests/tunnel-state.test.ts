/**
 * Tunnel-state module tests — Phase 3 Task 5.
 *
 * Covers `tunnelStatePath` (env precedence + default), `loadTunnelState`
 * (every failure mode → null; valid file → parsed), `saveTunnelState`
 * (atomic write + parent-dir creation + 0600 perms), `mergeRepo`
 * (idempotent insertion-order dedup), `detectUrlDrift` (the four cells
 * of the truth table), and `buildState` (the union-of-repos invariant
 * `runTunnel` depends on).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  buildState,
  detectUrlDrift,
  loadTunnelState,
  mergeRepo,
  saveTunnelState,
  tunnelStatePath,
  type TunnelState,
} from '../src/lib/tunnel-state.js';

describe('tunnelStatePath', () => {
  it('honors OUIJA_TUNNEL_STATE_PATH first', () => {
    const path = tunnelStatePath(
      {
        OUIJA_TUNNEL_STATE_PATH: '/explicit/state.json',
        OUIJA_HOME: '/ouija/home',
      },
      '/Users/test',
    );
    expect(path).toBe('/explicit/state.json');
  });

  it('falls back to OUIJA_HOME when OUIJA_TUNNEL_STATE_PATH unset', () => {
    const path = tunnelStatePath({ OUIJA_HOME: '/ouija/home' }, '/Users/test');
    expect(path).toBe('/ouija/home/tunnel-state.json');
  });

  it('falls back to ~/.ouija/tunnel-state.json by default', () => {
    const path = tunnelStatePath({}, '/Users/test');
    expect(path).toBe('/Users/test/.ouija/tunnel-state.json');
  });

  it('treats empty-string env vars as unset', () => {
    const path = tunnelStatePath(
      { OUIJA_TUNNEL_STATE_PATH: '', OUIJA_HOME: '' },
      '/Users/test',
    );
    expect(path).toBe('/Users/test/.ouija/tunnel-state.json');
  });
});

describe('loadTunnelState / saveTunnelState', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ouija-tunnel-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', async () => {
    const result = await loadTunnelState(join(dir, 'nope.json'));
    expect(result).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    const path = join(dir, 'broken.json');
    await fs.writeFile(path, 'not-json{', 'utf8');
    expect(await loadTunnelState(path)).toBeNull();
  });

  it('returns null on a JSON value with the wrong shape', async () => {
    const path = join(dir, 'wrong-shape.json');
    await fs.writeFile(path, JSON.stringify({ version: 99, hello: 'world' }), 'utf8');
    expect(await loadTunnelState(path)).toBeNull();
  });

  it('round-trips a valid state', async () => {
    const path = join(dir, 'state.json');
    const state: TunnelState = {
      version: 1,
      lastUrl: 'https://abc.trycloudflare.com',
      connectedRepos: ['octocat/Hello-World', 'octocat/spoon-knife'],
      updatedAt: '2026-05-03T12:00:00.000Z',
    };
    await saveTunnelState(path, state);
    const loaded = await loadTunnelState(path);
    expect(loaded).toEqual(state);
  });

  it('creates the parent directory if it does not exist', async () => {
    const path = join(dir, 'nested', 'sub', 'state.json');
    await saveTunnelState(path, {
      version: 1,
      lastUrl: null,
      connectedRepos: [],
      updatedAt: '2026-05-03T12:00:00.000Z',
    });
    const stat = await fs.stat(path);
    expect(stat.isFile()).toBe(true);
  });

  it('writes restrictive 0600 permissions', async () => {
    const path = join(dir, 'state.json');
    await saveTunnelState(path, {
      version: 1,
      lastUrl: null,
      connectedRepos: [],
      updatedAt: '2026-05-03T12:00:00.000Z',
    });
    const stat = await fs.stat(path);
    // Mask off everything but the permission bits; on Windows this is
    // best-effort, but the suite runs on POSIX in CI.
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('atomic rename leaves no .tmp residue on success', async () => {
    const path = join(dir, 'state.json');
    await saveTunnelState(path, {
      version: 1,
      lastUrl: 'https://x.trycloudflare.com',
      connectedRepos: [],
      updatedAt: '2026-05-03T12:00:00.000Z',
    });
    const entries = await fs.readdir(dir);
    expect(entries).toContain('state.json');
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });
});

describe('mergeRepo', () => {
  const baseState: TunnelState = {
    version: 1,
    lastUrl: null,
    connectedRepos: [],
    updatedAt: '2026-05-03T12:00:00.000Z',
  };

  it('appends a new repo when not present', () => {
    const next = mergeRepo(baseState, 'octocat/Hello-World');
    expect(next.connectedRepos).toEqual(['octocat/Hello-World']);
  });

  it('is idempotent on repeated calls', () => {
    const a = mergeRepo(baseState, 'octocat/Hello-World');
    const b = mergeRepo(a, 'octocat/Hello-World');
    expect(b.connectedRepos).toEqual(['octocat/Hello-World']);
  });

  it('preserves insertion order across additions', () => {
    let s = mergeRepo(baseState, 'a/x');
    s = mergeRepo(s, 'b/y');
    s = mergeRepo(s, 'c/z');
    expect(s.connectedRepos).toEqual(['a/x', 'b/y', 'c/z']);
  });

  it('does not mutate the input state', () => {
    const original = { ...baseState, connectedRepos: ['a/x'] };
    const next = mergeRepo(original, 'b/y');
    expect(original.connectedRepos).toEqual(['a/x']);
    expect(next.connectedRepos).toEqual(['a/x', 'b/y']);
    expect(next).not.toBe(original);
  });
});

describe('detectUrlDrift', () => {
  const baseState: TunnelState = {
    version: 1,
    lastUrl: 'https://abc.trycloudflare.com',
    connectedRepos: ['o/r'],
    updatedAt: '2026-05-03T12:00:00.000Z',
  };

  it('returns no drift when state is null', () => {
    expect(detectUrlDrift(null, 'https://abc.trycloudflare.com')).toEqual({
      drifted: false,
      previousUrl: null,
    });
  });

  it('returns no drift when persisted lastUrl is null (first detection)', () => {
    expect(
      detectUrlDrift({ ...baseState, lastUrl: null }, 'https://abc.trycloudflare.com'),
    ).toEqual({ drifted: false, previousUrl: null });
  });

  it('returns no drift when current URL matches persisted', () => {
    expect(detectUrlDrift(baseState, 'https://abc.trycloudflare.com')).toEqual({
      drifted: false,
      previousUrl: 'https://abc.trycloudflare.com',
    });
  });

  it('returns drift with the previous URL when they differ', () => {
    expect(detectUrlDrift(baseState, 'https://xyz.trycloudflare.com')).toEqual({
      drifted: true,
      previousUrl: 'https://abc.trycloudflare.com',
    });
  });
});

describe('buildState', () => {
  const fixedNow = new Date('2026-05-03T12:00:00.000Z');

  it('builds a fresh state on a first run with --connect', () => {
    const state = buildState({
      url: 'https://abc.trycloudflare.com',
      previousRepos: [],
      newRepo: 'octocat/Hello-World',
      now: fixedNow,
    });
    expect(state).toEqual<TunnelState>({
      version: 1,
      lastUrl: 'https://abc.trycloudflare.com',
      connectedRepos: ['octocat/Hello-World'],
      updatedAt: '2026-05-03T12:00:00.000Z',
    });
  });

  it('unions previous repos with the new one, deduping', () => {
    const state = buildState({
      url: 'https://abc.trycloudflare.com',
      previousRepos: ['a/x', 'b/y'],
      newRepo: 'a/x',
      now: fixedNow,
    });
    expect(state.connectedRepos).toEqual(['a/x', 'b/y']);
  });

  it('preserves previous repos when newRepo is undefined', () => {
    const state = buildState({
      url: 'https://abc.trycloudflare.com',
      previousRepos: ['a/x'],
      newRepo: undefined,
      now: fixedNow,
    });
    expect(state.connectedRepos).toEqual(['a/x']);
  });

  it('appends the new repo when not previously present', () => {
    const state = buildState({
      url: 'https://abc.trycloudflare.com',
      previousRepos: ['a/x'],
      newRepo: 'b/y',
      now: fixedNow,
    });
    expect(state.connectedRepos).toEqual(['a/x', 'b/y']);
  });

  it('uses Date.now() when `now` omitted (smoke)', () => {
    const before = Date.now();
    const state = buildState({
      url: 'https://abc.trycloudflare.com',
      previousRepos: [],
      newRepo: undefined,
    });
    const after = Date.now();
    const updatedAt = Date.parse(state.updatedAt);
    expect(updatedAt).toBeGreaterThanOrEqual(before);
    expect(updatedAt).toBeLessThanOrEqual(after);
  });
});
