import type { OuijaConfig } from './types.js';

/**
 * Structured deprecation notice emitted at config-load time. Pure data so
 * tests can assert on it without intercepting `process.emitWarning`.
 *
 * New `code` values must be unique and stable — CI pipelines grep these to
 * fail the build when a deprecated surface is still in use.
 */
export interface DeprecationWarning {
  code: string;
  message: string;
  agentId?: string;
}

/**
 * Opt-out env var for the `runner: local` deprecation. Set to `'1'` to
 * suppress the warning during migration. This is the only supported value —
 * deliberately strict to avoid truthy-string guessing games (e.g. `'true'`
 * vs `'yes'` vs `'on'`). Documented in docs/configuration.md#runners.
 */
const ALLOW_LOCAL_RUNNER_VALUE = '1';

/**
 * Inspect an `OuijaConfig` for deprecated usage and return structured
 * warnings. Pure: no I/O, no side effects. Caller decides how to surface
 * them — typically via {@link emitDeprecationWarnings}.
 *
 * Current deprecations:
 *
 *   - `runner: 'local'` — the text-mode runner cannot report
 *     `DispatchOutcome` positive evidence (no structured events), so
 *     Tenet 3 is unenforceable for it. Two-release sunset: warn in
 *     v0.4.0, remove in v0.5.0. Replacement: `runner: 'stream-json'`
 *     (same subscription auth, plus structured events).
 *
 * Suppress `runner: 'local'` warnings during migration by setting
 * `OUIJA_ALLOW_LOCAL_RUNNER=1` in the process environment.
 */
export function collectDeprecationWarnings(
  config: OuijaConfig,
  env: NodeJS.ProcessEnv = process.env,
): DeprecationWarning[] {
  const warnings: DeprecationWarning[] = [];
  const suppressLocalRunner =
    env.OUIJA_ALLOW_LOCAL_RUNNER === ALLOW_LOCAL_RUNNER_VALUE;

  for (const agent of config.agents) {
    if (agent.runner === 'local' && !suppressLocalRunner) {
      warnings.push({
        code: 'OUIJA_LOCAL_RUNNER_DEPRECATED',
        agentId: agent.id,
        message:
          `Agent "${agent.id}": runner: 'local' is deprecated and will be ` +
          `removed in v0.5.0. The text-mode runner cannot report ` +
          `DispatchOutcome positive evidence (no structured events), so ` +
          `zero-progress dispatches cannot be detected. Migrate to ` +
          `runner: 'stream-json' — same subscription auth, plus ` +
          `structured events for the dashboard. To suppress this warning ` +
          `during migration, set OUIJA_ALLOW_LOCAL_RUNNER=1. See ` +
          `docs/configuration.md#runners.`,
      });
    }
  }

  return warnings;
}

/**
 * Emit each warning via Node's `process.emitWarning` so it surfaces through
 * the standard `DeprecationWarning` channel (stderr, `--no-deprecation`
 * honoured, pino and similar loggers can attach a `'warning'` listener).
 * Separated from {@link collectDeprecationWarnings} so callers can choose a
 * different sink (test runner asserting on the array, structured logger).
 */
export function emitDeprecationWarnings(warnings: DeprecationWarning[]): void {
  for (const w of warnings) {
    process.emitWarning(w.message, {
      code: w.code,
      type: 'DeprecationWarning',
    });
  }
}
