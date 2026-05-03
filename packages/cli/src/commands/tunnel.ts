/**
 * `ouija tunnel` — Phase 3 Task 4.
 *
 * Wraps `cloudflared tunnel --url http://localhost:<port>` so a self-
 * hoster without public infra can produce a working webhook URL in
 * one command. Closes friction-log #19 — the manual Tailscale Funnel
 * / cloudflared / ngrok wiring disappears.
 *
 * Optional `--connect <owner/repo>` chains directly into
 * `ouija github connect <owner/repo>` once the tunnel URL appears,
 * so a fresh checkout can produce a working GitHub webhook with one
 * command + zero copy-paste.
 *
 * Implementation: spawns `cloudflared` as a child process in-line,
 * streams stdout/stderr, detects the `*.trycloudflare.com` URL with
 * a regex, and propagates SIGINT/SIGTERM so the operator can Ctrl-C
 * cleanly. Pure helpers (`parseTunnelArgs`, `extractTunnelUrl`,
 * `lineSplitter`) are unit-tested; the wired loop is integration
 * territory (Phase 3 Task 11 fizzy CI smoke).
 *
 * **Why quick tunnels and not named tunnels.** Quick tunnels need no
 * Cloudflare account / DNS setup — fits the "fresh-checkout to merged
 * PR in <10 minutes" definition-of-bridged criterion. Their tradeoff is
 * URL churn on every restart; Task 5 wires re-registering the GitHub
 * webhook automatically. Named tunnels (advanced-user path) are
 * documented in `docs/getting-started.md` per Task 13.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../lib/logger.js';
import { runGithubConnect } from './github-connect.js';

// ---- Pure types + helpers (unit-tested) ----

export interface TunnelConfig {
  port: number;
  /** Full URL the tunnel forwards to. Default `http://localhost:<port>`. */
  target: string;
  /** Optional `<owner/repo>` to auto-`ouija github connect` once the URL appears. */
  connectRepo: string | undefined;
  /** Path or name of the cloudflared binary. */
  cloudflaredBin: string;
}

interface ParseResult {
  ok: true;
  config: TunnelConfig;
}

interface ParseError {
  ok: false;
  error: string;
}

const DEFAULT_PORT = 4000;
const DEFAULT_BIN = 'cloudflared';

export function parseTunnelArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseResult | ParseError {
  let port = DEFAULT_PORT;
  let target: string | undefined;
  let connectRepo: string | undefined;
  let cloudflaredBin = env['CLOUDFLARED_BIN'] ?? DEFAULT_BIN;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--port' || arg === '--target' || arg === '--connect' || arg === '--bin') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ok: false, error: `${arg} requires a value` };
      }
      i++;
      switch (arg) {
        case '--port': {
          const n = Number(value);
          if (!Number.isInteger(n) || n <= 0 || n > 65535) {
            return { ok: false, error: `--port must be an integer in 1..65535; got "${value}"` };
          }
          port = n;
          break;
        }
        case '--target':
          if (!/^https?:\/\//.test(value)) {
            return {
              ok: false,
              error: `--target must start with http:// or https://; got "${value}"`,
            };
          }
          target = value.replace(/\/+$/, '');
          break;
        case '--connect': {
          const slash = value.indexOf('/');
          if (slash <= 0 || slash === value.length - 1) {
            return {
              ok: false,
              error: `--connect must look like "owner/repo"; got "${value}"`,
            };
          }
          connectRepo = value;
          break;
        }
        case '--bin':
          cloudflaredBin = value;
          break;
      }
      continue;
    }
    if (arg.startsWith('-')) {
      return { ok: false, error: `unknown flag: ${arg}` };
    }
    return { ok: false, error: `unexpected positional argument: ${arg}` };
  }

  return {
    ok: true,
    config: {
      port,
      target: target ?? `http://localhost:${port}`,
      connectRepo,
      cloudflaredBin,
    },
  };
}

const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/**
 * Extract a `*.trycloudflare.com` URL from a single line of cloudflared
 * output. Returns null when no match (most lines). The regex tolerates
 * whatever formatting cloudflared currently emits — leading timestamps,
 * "INF" prefixes, or the `Visit it at:` paragraph.
 */
export function extractTunnelUrl(line: string): string | null {
  const match = line.match(TUNNEL_URL_REGEX);
  return match === null ? null : match[0];
}

/**
 * Stateful line-splitter for chunked stream output. Holds a buffer
 * across calls so a `\n` straddling a chunk boundary doesn't drop the
 * line. Returns the lines emitted by feeding `chunk`; the final
 * trailing partial stays in the buffer until completed by a future
 * call (or `flush()`).
 */
export interface LineSplitter {
  feed(chunk: string): string[];
  flush(): string[];
}

export function createLineSplitter(): LineSplitter {
  let buf = '';
  return {
    feed(chunk: string): string[] {
      buf += chunk;
      const out: string[] = [];
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        out.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
      return out;
    },
    flush(): string[] {
      if (buf.length === 0) return [];
      const tail = buf;
      buf = '';
      return [tail];
    },
  };
}

// ---- Wired loop (not unit-tested) ----

export async function runTunnel(argv: readonly string[]): Promise<number> {
  const parsed = parseTunnelArgs(argv, process.env);
  if (!parsed.ok) {
    log.error(parsed.error);
    log.dim('  Usage: ouija tunnel [--port 4000] [--target http://localhost:4000] [--connect owner/repo] [--bin cloudflared]');
    return 1;
  }
  const config = parsed.config;

  log.step('ouija tunnel');
  log.info(`forwarding ${config.target} via cloudflared quick tunnel`);
  if (config.connectRepo !== undefined) {
    log.info(`will auto-connect ${config.connectRepo} once the URL is live`);
  }

  let child: ChildProcess;
  try {
    child = spawn(config.cloudflaredBin, ['tunnel', '--url', config.target, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    log.error(`failed to spawn cloudflared — ${err instanceof Error ? err.message : String(err)}`);
    log.dim('  Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    log.dim('  Or pass --bin <path-to-cloudflared> if it lives off-PATH.');
    return 2;
  }

  let detectedUrl: string | null = null;
  const stdoutSplitter = createLineSplitter();
  const stderrSplitter = createLineSplitter();

  const onLine = async (line: string, source: 'stdout' | 'stderr'): Promise<void> => {
    if (line.length === 0) return;
    log.dim(`[cloudflared:${source}] ${line}`);
    if (detectedUrl === null) {
      const url = extractTunnelUrl(line);
      if (url !== null) {
        detectedUrl = url;
        log.success(`tunnel live: ${url}`);
        log.info(`webhook target → ${url}/hooks/github/<secret>`);
        if (config.connectRepo !== undefined) {
          log.info(`running: ouija github connect ${config.connectRepo} --server-url ${url}`);
          const code = await runGithubConnect([
            config.connectRepo,
            '--server-url',
            url,
          ]);
          if (code !== 0) {
            log.error(`auto-connect exited ${code}; the tunnel itself stays up so you can retry manually`);
          }
        }
      }
    }
  };

  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    for (const line of stdoutSplitter.feed(chunk)) {
      void onLine(line, 'stdout');
    }
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    for (const line of stderrSplitter.feed(chunk)) {
      void onLine(line, 'stderr');
    }
  });

  // Propagate Ctrl-C / kill cleanly so cloudflared shuts down its tunnel
  // session rather than leaking a zombie connection that Cloudflare's
  // edge eventually times out on its own schedule.
  const forwardSignal = (sig: NodeJS.Signals): void => {
    if (!child.killed) child.kill(sig);
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  return new Promise<number>((resolve) => {
    child.on('error', (err) => {
      log.error(`cloudflared error — ${err.message}`);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log.dim('  Hint: cloudflared is not on PATH. Install it or pass --bin <path>.');
      }
      resolve(2);
    });
    child.on('exit', (code, signal) => {
      for (const line of stdoutSplitter.flush()) void onLine(line, 'stdout');
      for (const line of stderrSplitter.flush()) void onLine(line, 'stderr');
      if (signal !== null) {
        log.info(`cloudflared exited on ${signal}`);
      } else {
        log.info(`cloudflared exited (code ${code ?? 'null'})`);
      }
      resolve(code ?? 0);
    });
  });
}
