/**
 * `ouija tunnel` pure-helper tests.
 *
 * Covers `parseTunnelArgs` (env + flag validation, port + URL scheme
 * guards, owner/repo shape on `--connect`), `extractTunnelUrl`
 * (regex robustness against the formats cloudflared currently emits),
 * and `createLineSplitter` (handles chunk boundaries cleanly so
 * straddling `\n`s don't drop URLs). The subprocess wiring in
 * `runTunnel` is integration-only — covered via Phase 3 Task 11 fizzy
 * smoke against a real cloudflared binary.
 */

import { describe, it, expect } from 'vitest';
import {
  createLineSplitter,
  extractTunnelUrl,
  parseTunnelArgs,
} from '../src/commands/tunnel.js';

describe('parseTunnelArgs', () => {
  it('applies sensible defaults', () => {
    const result = parseTunnelArgs([], {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.port).toBe(4000);
    expect(result.config.target).toBe('http://localhost:4000');
    expect(result.config.connectRepo).toBeUndefined();
    expect(result.config.cloudflaredBin).toBe('cloudflared');
  });

  it('respects --port and rebuilds the default target', () => {
    const result = parseTunnelArgs(['--port', '8080'], {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.port).toBe(8080);
    expect(result.config.target).toBe('http://localhost:8080');
  });

  it('lets --target override the default URL', () => {
    const result = parseTunnelArgs(
      ['--target', 'http://127.0.0.1:9000/'],
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.target).toBe('http://127.0.0.1:9000');
  });

  it('respects CLOUDFLARED_BIN env when --bin is unset', () => {
    const result = parseTunnelArgs([], { CLOUDFLARED_BIN: '/usr/local/bin/cloudflared' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.cloudflaredBin).toBe('/usr/local/bin/cloudflared');
  });

  it('--bin overrides the env', () => {
    const result = parseTunnelArgs(['--bin', '/opt/cf'], { CLOUDFLARED_BIN: '/usr/local/bin/cloudflared' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.cloudflaredBin).toBe('/opt/cf');
  });

  it('parses --connect owner/repo', () => {
    const result = parseTunnelArgs(['--connect', 'octocat/Hello-World'], {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.connectRepo).toBe('octocat/Hello-World');
  });

  it('rejects malformed --connect (no slash, leading slash, trailing slash)', () => {
    for (const bogus of ['no-slash', '/no-owner', 'no-repo/']) {
      const result = parseTunnelArgs(['--connect', bogus], {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('--connect');
    }
  });

  it('rejects invalid --port', () => {
    for (const bogus of ['0', '-1', 'abc', '99999', '4000.5']) {
      const result = parseTunnelArgs(['--port', bogus], {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('--port');
    }
  });

  it('rejects --target without an http(s) scheme', () => {
    const result = parseTunnelArgs(['--target', 'localhost:4000'], {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('http://');
  });

  it('rejects flags without a value', () => {
    const result = parseTunnelArgs(['--port'], {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('requires a value');
  });

  it('rejects unknown flags', () => {
    const result = parseTunnelArgs(['--bogus', 'x'], {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unknown flag');
  });

  it('rejects unexpected positional args', () => {
    const result = parseTunnelArgs(['extra'], {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unexpected positional');
  });
});

describe('extractTunnelUrl', () => {
  it('finds the URL in cloudflared`s "Visit it at" paragraph', () => {
    const url = extractTunnelUrl(
      '  https://random-words-here.trycloudflare.com',
    );
    expect(url).toBe('https://random-words-here.trycloudflare.com');
  });

  it('finds the URL inside a timestamped log line', () => {
    const url = extractTunnelUrl(
      '2024-01-02T03:04:05Z INF +-------------+ https://abc-def-ghi.trycloudflare.com',
    );
    expect(url).toBe('https://abc-def-ghi.trycloudflare.com');
  });

  it('returns null when no URL appears in the line', () => {
    expect(extractTunnelUrl('cloudflared starting…')).toBeNull();
    expect(extractTunnelUrl('')).toBeNull();
    expect(extractTunnelUrl('https://example.com')).toBeNull();
  });

  it('matches case-insensitively on the scheme + host', () => {
    expect(extractTunnelUrl('HTTPS://Foo-Bar.TryCloudflare.com')).toBe(
      'HTTPS://Foo-Bar.TryCloudflare.com',
    );
  });
});

describe('createLineSplitter', () => {
  it('emits complete lines as they arrive', () => {
    const s = createLineSplitter();
    expect(s.feed('alpha\nbeta\ngamma\n')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('holds the trailing partial across chunks', () => {
    const s = createLineSplitter();
    expect(s.feed('alpha\nbet')).toEqual(['alpha']);
    expect(s.feed('a\ngamma')).toEqual(['beta']);
    expect(s.feed('\n')).toEqual(['gamma']);
  });

  it('flush returns the trailing partial without a newline', () => {
    const s = createLineSplitter();
    expect(s.feed('alpha')).toEqual([]);
    expect(s.flush()).toEqual(['alpha']);
  });

  it('flush returns nothing when buffer is empty', () => {
    const s = createLineSplitter();
    expect(s.feed('alpha\n')).toEqual(['alpha']);
    expect(s.flush()).toEqual([]);
  });

  it('handles back-to-back chunks containing many lines', () => {
    const s = createLineSplitter();
    const lines = s.feed('a\nb\nc\nd\n');
    expect(lines).toEqual(['a', 'b', 'c', 'd']);
    expect(s.feed('e\nf\n')).toEqual(['e', 'f']);
    expect(s.flush()).toEqual([]);
  });

  it('preserves empty lines (consecutive newlines)', () => {
    const s = createLineSplitter();
    expect(s.feed('a\n\nb\n')).toEqual(['a', '', 'b']);
  });
});
