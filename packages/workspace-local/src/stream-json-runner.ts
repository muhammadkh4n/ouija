/**
 * StreamJsonAgentRunner — AgentRunner that drives the `claude` CLI via its
 * stream-json stdio protocol.
 *
 * This runner gives you structured events (assistant text, tool_use, cost,
 * turn count) while still preserving **subscription auth** — it spawns the
 * same interactive `claude` binary that `LocalAgentRunner` uses, so the
 * session in ~/.claude/ is picked up and dispatches bill against Claude
 * Pro / Max instead of burning API tokens.
 *
 * The flag combination is load-bearing:
 *   -p
 *     Print mode (one-shot, not interactive). Required to use stream-json.
 *   --input-format stream-json
 *     Read NDJSON messages on stdin. We send exactly one user message and
 *     close stdin immediately — this is cold-per-dispatch, not warm.
 *   --output-format stream-json
 *     Emit NDJSON events on stdout (system / assistant / tool_use /
 *     tool_result / result / rate_limit_event).
 *   --verbose
 *     REQUIRED when combining --print with --output-format=stream-json —
 *     without it the CLI errors out at startup. Confirmed empirically.
 *   --dangerously-skip-permissions
 *     Auto-accept tool calls (agent mode).
 *
 * Security invariants (same as LocalAgentRunner):
 *  - process.env is NEVER spread into the subprocess. Only an allowlist of
 *    safe vars (PATH, HOME, TMPDIR, SHELL, LANG, LC_ALL, USER, TERM,
 *    NODE_ENV) is forwarded, then caller-provided env is merged on top.
 *  - ANTHROPIC_API_KEY is deliberately NOT in the allowlist. Callers that
 *    want API billing must pass it via the `env` param — otherwise the
 *    subprocess falls back to ~/.claude/ session auth, which is the point.
 *
 * Termination order (timeout or AbortSignal):
 *  1. SIGTERM
 *  2. 5s grace period
 *  3. SIGKILL
 */

import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  DispatchOutcome,
  Workspace,
} from '@ouija-dev/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Spawn function signature — matches the subset used by the runner. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface StreamJsonAgentRunnerOptions {
  /** Path to the claude binary. Defaults to "claude" (PATH lookup). */
  binaryPath?: string;
  /** Injectable spawn — test-only. Defaults to node:child_process.spawn. */
  spawnFn?: SpawnFn;
}

// ---------------------------------------------------------------------------
// Environment allowlist (identical to LocalAgentRunner)
// ---------------------------------------------------------------------------

/**
 * ⚠️  HOME risk — see SECURITY.md. Forwarding HOME gives the subprocess
 * access to the user's dotfiles (.ssh, .gitconfig, .config/gh, .aws, etc).
 * Acceptable for single-user self-hosting; not acceptable for shared hosts.
 * Follow-up work will synthesize a minimal HOME.
 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'SHELL',
  'LANG',
  'LC_ALL',
  'USER',
  'TERM',
  'NODE_ENV',
] as const;

// ---------------------------------------------------------------------------
// Stream-json event types
//
// We only model the fields we actually consume. The real protocol has more
// fields; parsing is forgiving — unknown fields are ignored.
// ---------------------------------------------------------------------------

interface AssistantMessageEvent {
  type: 'assistant';
  message?: {
    content?: Array<
      | { type: 'text'; text?: string }
      | { type: 'tool_use'; name?: string; input?: Record<string, unknown> }
      | { type: string; [k: string]: unknown }
    >;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

interface ResultEvent {
  type: 'result';
  subtype: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type StreamJsonEvent =
  | AssistantMessageEvent
  | ResultEvent
  | { type: 'system'; [k: string]: unknown }
  | { type: 'tool_use'; [k: string]: unknown }
  | { type: 'tool_result'; [k: string]: unknown }
  | { type: 'rate_limit_event'; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/**
 * Regex matching the GitHub PR URL the agent prints to stdout after running
 * `gh pr create`. Kept narrow — requires the literal `/pull/<digits>` suffix
 * so marketing URLs like `https://github.com/foo/bar` don't trip it.
 */
const PR_URL_REGEX = /https:\/\/github\.com\/[^\s"'<>()]+\/pull\/\d+/i;

// ---------------------------------------------------------------------------
// StreamJsonAgentRunner
// ---------------------------------------------------------------------------

export class StreamJsonAgentRunner implements AgentRunner {
  private readonly binaryPath: string;
  private readonly spawnFn: SpawnFn;

  constructor(options: StreamJsonAgentRunnerOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'claude';
    this.spawnFn = options.spawnFn ?? spawn;
  }

  async run(
    workspace: Workspace,
    prompt: string,
    env: Record<string, string>,
    timeoutMs: number,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const binary = this.binaryPath;
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    // Build env: allowlist from process.env, then caller env, then CI=1.
    const safeBaseEnv: Record<string, string | undefined> = {};
    for (const key of ENV_ALLOWLIST) {
      if (process.env[key] !== undefined) {
        safeBaseEnv[key] = process.env[key];
      }
    }
    const mergedEnv: Record<string, string | undefined> = {
      ...safeBaseEnv,
      ...env,
      CI: '1',
    };

    const spawnFn = this.spawnFn;

    return new Promise<AgentRunResult>((resolve, reject) => {
      const startTime = Date.now();
      let timedOut = false;
      const assistantText: string[] = [];
      const stderrChunks: string[] = [];
      let terminalResult: ResultEvent | undefined;

      // ---- Positive-evidence counters (Tenet 3 / DispatchOutcome) ----
      // toolCallsMade — every `tool_use` block emitted by the agent.
      // commitsPushed — successful `Bash` tool_use whose command contains
      //   `git push` AND the tool_result did not report failure.
      let toolCallsMade = 0;
      let commitsPushed = 0;
      // Keys: tool_use id → true when we've tentatively counted a git push.
      // We only count it as committed if the matching tool_result doesn't
      // carry `is_error: true`. Preserves honesty on failed push attempts.
      const pendingPushIds = new Map<string, true>();
      // Assistant-event usage field (one or more events may carry it). Tallied
      // so we report aggregate tokens even if the terminal result omits usage.
      let assistantTokensIn = 0;
      let assistantTokensOut = 0;

      // NDJSON parse buffer — stdout chunks don't align with \n boundaries.
      let lineBuffer = '';

      let child: ChildProcess;
      try {
        child = spawnFn(binary, args, {
          cwd: workspace.endpoint,
          env: mergedEnv as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(
          new Error(
            `Failed to spawn ${binary}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }

      // Write the prompt as a single stream-json user message, then close stdin.
      // Cold-per-dispatch: we don't keep stdin open for follow-up turns.
      const userMessage = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
      });
      if (child.stdin) {
        child.stdin.write(userMessage + '\n');
        child.stdin.end();
      }

      // ---- stdout: parse NDJSON events ----
      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => {
          lineBuffer += chunk.toString('utf8');
          let newlineIdx: number;
          while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
            const line = lineBuffer.slice(0, newlineIdx);
            lineBuffer = lineBuffer.slice(newlineIdx + 1);
            if (line.trim() === '') continue;

            let event: StreamJsonEvent;
            try {
              event = JSON.parse(line) as StreamJsonEvent;
            } catch {
              // Malformed line — drop it and continue. The CLI shouldn't
              // emit garbage, but if it does we don't want to abort the run.
              continue;
            }

            if (event.type === 'assistant') {
              const assistant = event as AssistantMessageEvent;
              const blocks = assistant.message?.content ?? [];
              for (const block of blocks) {
                if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
                  const text = (block as { text: string }).text;
                  assistantText.push(text);
                  options?.onOutput?.(text);
                } else if (block.type === 'tool_use') {
                  toolCallsMade++;
                  const tu = block as {
                    id?: string;
                    name?: string;
                    input?: Record<string, unknown>;
                  };
                  // Heuristic: Bash invocations whose command includes
                  // `git push` are candidate push attempts. We confirm them
                  // only when the matching tool_result is non-error.
                  if (tu.name === 'Bash' && typeof tu.input?.['command'] === 'string') {
                    const cmd = tu.input['command'] as string;
                    if (/\bgit\s+push\b/.test(cmd) && typeof tu.id === 'string') {
                      pendingPushIds.set(tu.id, true);
                    }
                  }
                }
              }
              const usage = assistant.message?.usage;
              if (usage?.input_tokens !== undefined) {
                assistantTokensIn += usage.input_tokens;
              }
              if (usage?.output_tokens !== undefined) {
                assistantTokensOut += usage.output_tokens;
              }
            } else if (event.type === 'tool_use') {
              // Some CLI versions emit tool_use as a top-level event instead
              // of an inline content block. Count both shapes.
              toolCallsMade++;
              const tu = event as {
                id?: string;
                name?: string;
                input?: Record<string, unknown>;
              };
              if (tu.name === 'Bash' && typeof tu.input?.['command'] === 'string') {
                const cmd = tu.input['command'] as string;
                if (/\bgit\s+push\b/.test(cmd) && typeof tu.id === 'string') {
                  pendingPushIds.set(tu.id, true);
                }
              }
            } else if (event.type === 'tool_result') {
              const tr = event as {
                tool_use_id?: string;
                is_error?: boolean;
              };
              if (typeof tr.tool_use_id === 'string' && pendingPushIds.has(tr.tool_use_id)) {
                if (tr.is_error !== true) {
                  commitsPushed++;
                }
                pendingPushIds.delete(tr.tool_use_id);
              }
            } else if (event.type === 'result') {
              terminalResult = event as ResultEvent;
            }
          }
        });
      }

      // ---- stderr: buffer only ----
      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          stderrChunks.push(chunk.toString('utf8'));
        });
      }

      // ---- kill helper ----
      const killChild = (): void => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5_000);
      };

      // ---- timeout enforcement ----
      const timeoutId = setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutMs);

      // ---- external cancellation ----
      const onAbort = (): void => {
        killChild();
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      // ---- error (post-fork spawn failure) ----
      child.on('error', (err) => {
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });

      // ---- exit: build structured result ----
      child.on('exit', (code) => {
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener('abort', onAbort);

        const stdout = assistantText.join('');
        const stderr = stderrChunks.join('');
        const durationMs = Date.now() - startTime;

        if (timedOut) {
          // Timed-out runs may still have produced observable progress. Surface
          // what we saw so the orchestrator can reason about it even though
          // the pipeline will transition via agent_failed, not agent_completed.
          resolve({
            exitCode: code ?? 1,
            stdout,
            stderr,
            timedOut: true,
            durationMs,
            outcome: buildOutcome(),
          });
          return;
        }

        if (terminalResult === undefined) {
          // Missing terminal event = protocol failure. Even if the child
          // exited cleanly, we can't trust the result without the terminal
          // envelope. Force exitCode 1.
          resolve({
            exitCode: 1,
            stdout,
            stderr: stderr || 'stream-json ended without a result message',
            timedOut: false,
            durationMs,
            outcome: buildOutcome(),
          });
          return;
        }

        const isError =
          terminalResult.is_error === true ||
          (terminalResult.subtype !== undefined &&
            terminalResult.subtype !== 'success');

        // If the CLI's result event includes a `result` text field and we
        // haven't seen an equivalent assistant block, include it in stdout.
        // This is a fallback — normally the assistant block carries the text.
        if (
          typeof terminalResult.result === 'string' &&
          terminalResult.result.length > 0 &&
          assistantText.length === 0
        ) {
          assistantText.push(terminalResult.result);
        }

        resolve({
          exitCode: isError ? code ?? 1 : 0,
          stdout: assistantText.join(''),
          stderr,
          timedOut: false,
          durationMs,
          ...(terminalResult.total_cost_usd !== undefined
            ? { costUsd: terminalResult.total_cost_usd }
            : {}),
          ...(terminalResult.num_turns !== undefined
            ? { numTurns: terminalResult.num_turns }
            : {}),
          outcome: buildOutcome(terminalResult, durationMs),
        });
      });

      // Inline helper so we capture counters + terminalResult from closure.
      function buildOutcome(
        result?: ResultEvent,
        explicitDurationMs?: number,
      ): DispatchOutcome {
        const combinedStdout = assistantText.join('');
        const prMatch = PR_URL_REGEX.exec(combinedStdout);
        const tokensIn = result?.usage?.input_tokens ?? assistantTokensIn;
        const tokensOut = result?.usage?.output_tokens ?? assistantTokensOut;
        const outcome: DispatchOutcome = {
          commitsPushed,
          toolCallsMade,
          tokensIn,
          tokensOut,
        };
        if (prMatch !== null) outcome.prUrl = prMatch[0];
        if (result?.total_cost_usd !== undefined) {
          outcome.costUsd = result.total_cost_usd;
        }
        const duration = explicitDurationMs ?? (Date.now() - startTime);
        outcome.durationMs = duration;
        return outcome;
      }
    });
  }
}
