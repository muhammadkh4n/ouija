#!/usr/bin/env node
/**
 * Phase 3 Task 7 — KeychainProvider RexBook smoke.
 *
 * Standalone validation script the operator runs on macOS BEFORE
 * Task 8 wires `KeychainProvider` into the dispatch path. Three
 * checks the phase note calls out:
 *
 *   (a) The extracted Keychain payload parses as JSON.
 *   (b) `.credentials.json` materialised from it lets Claude CLI
 *       authenticate inside the runner container.
 *   (c) No GUI prompt fires during extraction.
 *
 * This script covers (a) and (c). Check (b) requires Task 8's
 * orchestrator wiring + a container with Claude CLI on it; the
 * Task-8 smoke gate validates that path end-to-end.
 *
 * USAGE — run on RexBook (or any macOS host that's signed into the
 * Claude CLI subscription):
 *
 *   node scripts/smoke/keychain-provider-check.mjs
 *
 * Exit codes:
 *   0   — both checks pass (JSON parses + no GUI-prompt timing)
 *   1   — `security` returned an error or empty payload
 *   2   — JSON parse failed
 *   3   — extraction took longer than the GUI-prompt threshold
 *   10  — wrong platform (script aborts early on non-darwin)
 *
 * The script is intentionally STANDALONE — no monorepo imports, no
 * build required. The KeychainProvider implementation in
 * `packages/plugin-agent-claude/src/identity/keychain-provider.ts`
 * mirrors the same `security` invocation; if this smoke passes, the
 * provider should pass too. Divergence risk is small enough to
 * accept (~30 LOC of overlap, no shared logic beyond the argv shape
 * + JSON parse).
 */

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const SERVICE = 'Claude Code-credentials';
const SECURITY_BIN = '/usr/bin/security';
const TIMEOUT_MS = 5_000;

// Anything above ~200ms strongly suggests Keychain Access showed a GUI
// dialog (or the entry's ACL forced one). 50ms is the baseline for a
// clean, ACL-allowed extraction on RexBook (verified 2026-04-20).
const GUI_PROMPT_THRESHOLD_MS = 200;

const colour = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function log(prefix, msg) {
  console.log(`${prefix} ${msg}`);
}

function runSecurity() {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const args = ['find-generic-password', '-s', SERVICE, '-w'];
    const started = performance.now();
    const child = spawn(SECURITY_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8').on('data', (c) => {
      stdout += c;
    });
    child.stderr.setEncoding('utf8').on('data', (c) => {
      stderr += c;
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5_000);
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      const elapsedMs = performance.now() - started;
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut,
        elapsedMs,
      });
    });
  });
}

function diagnose(exitCode, stderr) {
  const tail = stderr.trim().slice(-400);
  if (exitCode === 44) {
    return 'Keychain entry not found. Is Claude CLI signed in on this host? Run `claude /login` and retry.';
  }
  if (exitCode === 51) {
    return 'Keychain access denied (ACL). Open Keychain Access.app, find the "Claude Code-credentials" entry, and either grant /usr/bin/security access or set "Always Allow" on the entry.';
  }
  if (exitCode === 36) {
    return 'Keychain locked. Run `security unlock-keychain ~/Library/Keychains/login.keychain-db` and retry.';
  }
  return `security exited with code ${exitCode}${tail ? ` — stderr: ${tail}` : ''}`;
}

async function main() {
  console.log(colour.bold('Phase 3 Task 7 — KeychainProvider RexBook smoke'));
  console.log(colour.dim('  Validates checks (a) JSON parses + (c) no GUI prompt.'));
  console.log(colour.dim('  Check (b) — container Claude CLI auth — runs as part of Task 8.'));
  console.log('');

  // Platform guard
  if (process.platform !== 'darwin') {
    log(colour.red('✗'), `Wrong platform — KeychainProvider is macOS-only (current: ${process.platform})`);
    log(colour.dim(' '), 'On Linux/WSL use CredentialFileProvider or HelperCommandProvider.');
    process.exit(10);
  }
  log(colour.green('✓'), `Platform: darwin`);

  // Run security
  log(colour.dim('›'), `running: ${SECURITY_BIN} find-generic-password -s "${SERVICE}" -w`);
  let result;
  try {
    result = await runSecurity();
  } catch (err) {
    log(colour.red('✗'), `failed to spawn ${SECURITY_BIN} — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (result.timedOut) {
    log(
      colour.red('✗'),
      `\`security\` timed out after ${TIMEOUT_MS}ms — possibly waiting on a Keychain GUI prompt`,
    );
    log(colour.dim(' '), 'Open Keychain Access.app and grant Always Allow on the "Claude Code-credentials" entry, then retry.');
    process.exit(3);
  }

  if (result.exitCode !== 0) {
    log(colour.red('✗'), `\`security\` exited ${result.exitCode}`);
    log(colour.yellow('!'), diagnose(result.exitCode, result.stderr));
    process.exit(1);
  }

  if (result.stdout.trim().length === 0) {
    log(colour.red('✗'), '`security` returned exit 0 but empty stdout — Keychain entry exists but has no password set');
    process.exit(1);
  }

  log(colour.green('✓'), `\`security\` exit 0 in ${result.elapsedMs.toFixed(0)}ms`);

  // Check (c) — GUI-prompt timing
  if (result.elapsedMs > GUI_PROMPT_THRESHOLD_MS) {
    log(
      colour.yellow('!'),
      `Extraction took ${result.elapsedMs.toFixed(0)}ms (> ${GUI_PROMPT_THRESHOLD_MS}ms threshold) — a GUI dialog may have appeared.`,
    );
    log(
      colour.dim(' '),
      `Re-run a few times. If timing stays > ${GUI_PROMPT_THRESHOLD_MS}ms, the entry's ACL is forcing a prompt.`,
    );
    log(colour.dim(' '), 'Set "Always Allow" on the Keychain entry to bring this below threshold.');
    process.exit(3);
  }
  log(colour.green('✓'), `Check (c): no GUI prompt detected (${result.elapsedMs.toFixed(0)}ms < ${GUI_PROMPT_THRESHOLD_MS}ms threshold)`);

  // Check (a) — JSON parses
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (err) {
    log(colour.red('✗'), `Check (a): payload is not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
    log(colour.dim(' '), `First 80 chars of payload: ${JSON.stringify(result.stdout.slice(0, 80))}`);
    process.exit(2);
  }
  if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).length === 0) {
    log(colour.red('✗'), 'Check (a): payload parsed but is not a non-empty object');
    process.exit(2);
  }
  log(colour.green('✓'), `Check (a): payload parses as JSON (top-level keys: ${Object.keys(parsed).join(', ')})`);

  // Optional shape sniff — `claudeAiOauth.accessToken` is the canonical field
  // we expect; absence is non-fatal but worth logging in case Claude CLI's
  // schema changes underneath us.
  if (parsed.claudeAiOauth && typeof parsed.claudeAiOauth.accessToken === 'string') {
    log(colour.green('✓'), 'Shape sniff: `claudeAiOauth.accessToken` present');
  } else {
    log(
      colour.yellow('!'),
      'Shape sniff: `claudeAiOauth.accessToken` not found at expected path — Claude CLI schema may have changed. Update `KeychainProvider` shape check if so.',
    );
  }

  console.log('');
  log(colour.green(colour.bold('PASS')), 'Smoke complete. Paste the timing + top-level key list into the Build Log entry that closes Task 7.');
  console.log('');
  console.log(colour.dim('Next: Task 8 wires `KeychainProvider` + `materializeClaudeHome` into the orchestrator.'));
  console.log(colour.dim('That PR\'s smoke validates check (b) — actual Claude CLI auth from a materialised home inside the runner container.'));
}

main().catch((err) => {
  console.error(colour.red('✗'), `Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
