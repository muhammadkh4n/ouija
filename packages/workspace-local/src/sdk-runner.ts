/**
 * SdkAgentRunner -- AgentRunner implementation using the Claude Agent SDK.
 *
 * Uses @anthropic-ai/claude-agent-sdk query() instead of raw subprocess.
 * Provides structured output, cost tracking, and proper lifecycle management.
 *
 * Falls back gracefully if the SDK package is not installed (import error
 * surfaces at construction time).
 */

import type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  Workspace,
} from '@ouija-dev/types';

export interface SdkAgentRunnerOptions {
  /** Claude model to use. Defaults to "claude-sonnet-4-20250514". */
  model?: string;
  /** Path to the Claude Code executable. Resolved automatically if omitted. */
  executablePath?: string;
}

export class SdkAgentRunner implements AgentRunner {
  private readonly model: string;
  private readonly executablePath: string | undefined;

  constructor(options: SdkAgentRunnerOptions = {}) {
    this.model = options.model ?? 'claude-sonnet-4-20250514';
    this.executablePath = options.executablePath;
  }

  async run(
    workspace: Workspace,
    prompt: string,
    env: Record<string, string>,
    timeoutMs: number,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const startTime = Date.now();
    let timedOut = false;
    const outputChunks: string[] = [];
    let costUsd: number | undefined;
    let numTurns: number | undefined;

    // Convert AbortSignal to AbortController for the SDK
    const controller = new AbortController();

    // Wire external signal
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    // Timeout enforcement
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      // Resolve executable path: explicit > SDK bundled cli.js > system 'claude'
      let cliPath = this.executablePath;
      if (!cliPath) {
        try {
          const { createRequire } = await import('node:module');
          const require = createRequire(import.meta.url);
          const sdkDir = require.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
          cliPath = sdkDir;
        } catch {
          // Fallback: let the SDK try its own resolution
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queryOptions: any = {
        cwd: workspace.endpoint,
        model: this.model,
        abortController: controller,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        env: { ...env, CI: '1' },
      };
      if (cliPath) {
        queryOptions.pathToClaudeCodeExecutable = cliPath;
      }

      const q = query({ prompt, options: queryOptions });

      for await (const msg of q) {
        // Collect assistant text output
        if (msg.type === 'assistant' && 'message' in msg) {
          const content = msg.message?.content ?? [];
          const text = content
            .map((b) => {
              if (b !== null && typeof b === 'object' && (b as { type: unknown }).type === 'text') {
                const rec = b as { text?: unknown };
                return typeof rec.text === 'string' ? rec.text : '';
              }
              return '';
            })
            .join('');
          if (text) {
            outputChunks.push(text);
            options?.onOutput?.(text);
          }
        }

        // Capture result
        if (msg.type === 'result') {
          clearTimeout(timeoutId);

          if ('total_cost_usd' in msg) {
            costUsd = msg.total_cost_usd as number;
          }
          if ('num_turns' in msg) {
            numTurns = msg.num_turns as number;
          }

          if (msg.subtype === 'success') {
            const resultText = 'result' in msg ? String(msg.result ?? '') : '';
            if (resultText) outputChunks.push(resultText);

            return {
              exitCode: 0,
              stdout: outputChunks.join('\n'),
              stderr: '',
              timedOut: false,
              durationMs: Date.now() - startTime,
              ...(costUsd !== undefined ? { costUsd } : {}),
              ...(numTurns !== undefined ? { numTurns } : {}),
            };
          }

          // Error subtypes: error_max_turns, error_during_execution, error_max_budget_usd
          const errorMsg = 'error' in msg ? String(msg.error ?? msg.subtype) : msg.subtype;
          return {
            exitCode: 1,
            stdout: outputChunks.join('\n'),
            stderr: errorMsg,
            timedOut: msg.subtype === 'error_max_turns',
            durationMs: Date.now() - startTime,
            ...(costUsd !== undefined ? { costUsd } : {}),
            ...(numTurns !== undefined ? { numTurns } : {}),
          };
        }
      }

      // Generator exhausted without a result message
      clearTimeout(timeoutId);
      return {
        exitCode: 1,
        stdout: outputChunks.join('\n'),
        stderr: 'SDK query ended without a result message',
        timedOut,
        durationMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      // AbortError from the controller means timeout or external cancel
      if (timedOut) {
        return {
          exitCode: 1,
          stdout: outputChunks.join('\n'),
          stderr: `Agent timed out after ${Math.round((Date.now() - startTime) / 1000)}s`,
          timedOut: true,
          durationMs: Date.now() - startTime,
        };
      }

      return {
        exitCode: 1,
        stdout: outputChunks.join('\n'),
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
    }
  }
}
