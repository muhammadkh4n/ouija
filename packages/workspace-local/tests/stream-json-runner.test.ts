/**
 * stream-json-runner.test.ts
 *
 * Mock-spawn tests for StreamJsonAgentRunner. Mirrors the style of
 * local-runner.test.ts: inject a fake spawn, drive a FakeChild EventEmitter
 * with synthetic stdout NDJSON lines, assert on the runner's observable
 * behaviour (argv, cwd, env, prompt serialization, structured result).
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { Writable } from 'node:stream';
import { StreamJsonAgentRunner } from '../src/stream-json-runner.js';
import type { Workspace } from '@ouija-dev/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-test-01',
    type: 'local',
    endpoint: '/workspace/my-repo',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FakeChild factory — same shape as the LocalAgentRunner test doubles
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: (signal?: string) => boolean;
  _exit: (code: number) => void;
  _error: (err: Error) => void;
  _stdout: (chunk: string) => void;
  _stderr: (chunk: string) => void;
  _stdinChunks: string[];
}

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter() as FakeChild;

  const stdinChunks: string[] = [];
  const stdin = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      stdinChunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  emitter._stdinChunks = stdinChunks;
  emitter.stdin = stdin;

  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();

  emitter.killed = false;
  emitter.kill = (_signal?: string) => {
    emitter.killed = true;
    return true;
  };

  emitter._exit = (code: number) => {
    emitter.emit('exit', code);
  };
  emitter._error = (err: Error) => {
    emitter.emit('error', err);
  };
  emitter._stdout = (chunk: string) => {
    emitter.stdout.emit('data', Buffer.from(chunk, 'utf8'));
  };
  emitter._stderr = (chunk: string) => {
    emitter.stderr.emit('data', Buffer.from(chunk, 'utf8'));
  };

  return emitter;
}

// ---------------------------------------------------------------------------
// NDJSON event fixtures
// ---------------------------------------------------------------------------

function systemEvent(): string {
  return JSON.stringify({ type: 'system', subtype: 'init' }) + '\n';
}

function assistantEvent(text: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    }) + '\n'
  );
}

function resultEvent(
  overrides: {
    subtype?: string;
    is_error?: boolean;
    result?: string;
    total_cost_usd?: number;
    num_turns?: number;
    duration_ms?: number;
  } = {},
): string {
  return (
    JSON.stringify({
      type: 'result',
      subtype: overrides.subtype ?? 'success',
      is_error: overrides.is_error ?? false,
      result: overrides.result ?? 'ok',
      total_cost_usd: overrides.total_cost_usd ?? 0.0123,
      num_turns: overrides.num_turns ?? 3,
      duration_ms: overrides.duration_ms ?? 1500,
    }) + '\n'
  );
}

// ---------------------------------------------------------------------------
// Argv + cwd + env
// ---------------------------------------------------------------------------

describe('StreamJsonAgentRunner — argv / cwd / env', () => {
  it('spawns claude with the stream-json flag combination', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);
    fake._stdout(systemEvent());
    fake._stdout(assistantEvent('hi'));
    fake._stdout(resultEvent());
    fake._exit(0);
    await runPromise;

    const args = spawnFn.mock.calls[0]?.[1] as string[];
    expect(args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ]);
  });

  it('sets cwd from workspace.endpoint', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(
      makeWorkspace({ endpoint: '/workspace/foo' }),
      'prompt',
      {},
      5_000,
    );
    fake._stdout(resultEvent());
    fake._exit(0);
    await runPromise;

    const opts = spawnFn.mock.calls[0]?.[2] as SpawnOptions;
    expect(opts.cwd).toBe('/workspace/foo');
  });

  it('does NOT leak ANTHROPIC_API_KEY from process.env unless caller provides it', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    // Inject a fake key into process.env for the duration of this test.
    const original = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'test-should-not-leak';
    try {
      const runner = new StreamJsonAgentRunner({ spawnFn });
      const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);
      fake._stdout(resultEvent());
      fake._exit(0);
      await runPromise;

      const opts = spawnFn.mock.calls[0]?.[2] as SpawnOptions;
      const env = opts.env as NodeJS.ProcessEnv;
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env['ANTHROPIC_API_KEY'];
      } else {
        process.env['ANTHROPIC_API_KEY'] = original;
      }
    }
  });

  it('forwards caller-provided env on top of the allowlist', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(
      makeWorkspace(),
      'prompt',
      { ANTHROPIC_API_KEY: 'caller-key', GITHUB_PAT: 'ghp_xxx' },
      5_000,
    );
    fake._stdout(resultEvent());
    fake._exit(0);
    await runPromise;

    const opts = spawnFn.mock.calls[0]?.[2] as SpawnOptions;
    const env = opts.env as NodeJS.ProcessEnv;
    expect(env['ANTHROPIC_API_KEY']).toBe('caller-key');
    expect(env['GITHUB_PAT']).toBe('ghp_xxx');
    expect(env['CI']).toBe('1');
  });

  it('spawns with a custom binaryPath when provided', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({
      binaryPath: '/opt/homebrew/bin/claude',
      spawnFn,
    });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);
    fake._stdout(resultEvent());
    fake._exit(0);
    await runPromise;

    expect(spawnFn.mock.calls[0]?.[0]).toBe('/opt/homebrew/bin/claude');
  });
});

// ---------------------------------------------------------------------------
// Prompt serialization
// ---------------------------------------------------------------------------

describe('StreamJsonAgentRunner — prompt serialization', () => {
  it('writes exactly one user message JSON line to stdin and closes it', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(
      makeWorkspace(),
      'Implement feature X',
      {},
      5_000,
    );
    fake._stdout(resultEvent());
    fake._exit(0);
    await runPromise;

    expect(fake._stdinChunks).toHaveLength(1);
    const line = fake._stdinChunks[0]!;
    expect(line.endsWith('\n')).toBe(true);

    const parsed = JSON.parse(line.trim());
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Implement feature X' },
    });
  });

  it('escapes special characters in the prompt via JSON.stringify', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const tricky = 'Line 1\nLine 2 "quoted"\\backslash\t';
    const runPromise = runner.run(makeWorkspace(), tricky, {}, 5_000);
    fake._stdout(resultEvent());
    fake._exit(0);
    await runPromise;

    const parsed = JSON.parse(fake._stdinChunks[0]!.trim());
    expect(parsed.message.content).toBe(tricky);
  });
});

// ---------------------------------------------------------------------------
// NDJSON parsing
// ---------------------------------------------------------------------------

describe('StreamJsonAgentRunner — NDJSON parsing', () => {
  it('parses happy path: system + assistant + result', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);
    fake._stdout(systemEvent());
    fake._stdout(assistantEvent('Hello, '));
    fake._stdout(assistantEvent('world.'));
    fake._stdout(
      resultEvent({ total_cost_usd: 0.42, num_turns: 7 }),
    );
    fake._exit(0);
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Hello, world.');
    expect(result.costUsd).toBe(0.42);
    expect(result.numTurns).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it('streams assistant text via options.onOutput', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const chunks: string[] = [];
    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(
      makeWorkspace(),
      'prompt',
      {},
      5_000,
      { onOutput: (c) => chunks.push(c) },
    );
    fake._stdout(assistantEvent('one'));
    fake._stdout(assistantEvent('two'));
    fake._stdout(resultEvent());
    fake._exit(0);
    await runPromise;

    expect(chunks).toEqual(['one', 'two']);
  });

  it('handles a JSON line split across two chunks', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);

    const assistantLine = assistantEvent('hello');
    // Cut the assistant line in half, including across the JSON boundary.
    const split = Math.floor(assistantLine.length / 2);
    fake._stdout(assistantLine.slice(0, split));
    fake._stdout(assistantLine.slice(split));
    fake._stdout(resultEvent());
    fake._exit(0);

    const result = await runPromise;
    expect(result.stdout).toBe('hello');
  });

  it('skips malformed JSON lines without aborting the run', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);
    fake._stdout('not valid json\n');
    fake._stdout(assistantEvent('real output'));
    fake._stdout(resultEvent());
    fake._exit(0);

    const result = await runPromise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('real output');
  });

  it('ignores assistant events without text blocks', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);
    // assistant message with tool_use only — no text
    fake._stdout(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: {} }],
        },
      }) + '\n',
    );
    fake._stdout(assistantEvent('follow-up'));
    fake._stdout(resultEvent());
    fake._exit(0);

    const result = await runPromise;
    expect(result.stdout).toBe('follow-up');
  });
});

// ---------------------------------------------------------------------------
// Result handling
// ---------------------------------------------------------------------------

describe('StreamJsonAgentRunner — result events', () => {
  it('marks the run as failed when subtype is not success', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);
    fake._stdout(assistantEvent('partial output'));
    fake._stdout(resultEvent({ subtype: 'error_max_turns', is_error: true }));
    fake._exit(1);

    const result = await runPromise;
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('partial output');
  });

  it('returns an error result when no result event is emitted', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);
    fake._stdout(systemEvent());
    fake._stdout(assistantEvent('partial'));
    fake._exit(0); // exit without result

    const result = await runPromise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ended without a result message');
  });

  it('falls back to result.result when no assistant block carried text', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);
    fake._stdout(resultEvent({ result: 'fallback text' }));
    fake._exit(0);

    const result = await runPromise;
    expect(result.stdout).toBe('fallback text');
  });
});

// ---------------------------------------------------------------------------
// Timeout + abort
// ---------------------------------------------------------------------------

describe('StreamJsonAgentRunner — lifecycle', () => {
  it('kills the child on timeout and marks timedOut', async () => {
    vi.useFakeTimers();
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 100);

    // Advance past the timeout — this triggers SIGTERM.
    await vi.advanceTimersByTimeAsync(101);
    expect(fake.killed).toBe(true);

    // Simulate the subprocess cleanly exiting after SIGTERM.
    fake._exit(143);
    const result = await runPromise;
    expect(result.timedOut).toBe(true);

    vi.useRealTimers();
  });

  it('kills the child when the abort signal fires', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const controller = new AbortController();
    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(
      makeWorkspace(),
      'prompt',
      {},
      10_000,
      { signal: controller.signal },
    );

    controller.abort();
    expect(fake.killed).toBe(true);

    fake._exit(143);
    await runPromise;
  });

  it('kills the child when the abort signal was already aborted before spawn', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const controller = new AbortController();
    controller.abort();

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(
      makeWorkspace(),
      'prompt',
      {},
      10_000,
      { signal: controller.signal },
    );

    expect(fake.killed).toBe(true);
    fake._exit(143);
    await runPromise;
  });

  it('rejects when spawn throws synchronously', async () => {
    const spawnFn = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT: claude not found');
    });

    const runner = new StreamJsonAgentRunner({ spawnFn });
    await expect(
      runner.run(makeWorkspace(), 'prompt', {}, 5_000),
    ).rejects.toThrow(/ENOENT/);
  });

  it('rejects on post-fork error', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);
    fake._error(new Error('broken pipe'));

    await expect(runPromise).rejects.toThrow(/broken pipe/);
  });
});

// ---------------------------------------------------------------------------
// DispatchOutcome (positive-evidence counters)
// ---------------------------------------------------------------------------

function assistantWithToolUse(
  name: string,
  input: Record<string, unknown>,
  id: string,
): string {
  return (
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id, name, input }],
      },
    }) + '\n'
  );
}

function toolResultEvent(toolUseId: string, isError: boolean): string {
  return (
    JSON.stringify({
      type: 'tool_result',
      tool_use_id: toolUseId,
      is_error: isError,
    }) + '\n'
  );
}

describe('StreamJsonAgentRunner — DispatchOutcome (positive evidence)', () => {
  it('reports zero-progress outcome when the agent makes no tool calls', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);

    // Simulate the 2026-04-19 smoke failure mode: system + result, no tool
    // calls, clean exit. Previously reported as succeeded; must now report
    // an outcome with zero positive evidence so the transition rejects it.
    fake._stdout(systemEvent());
    fake._stdout(resultEvent({ total_cost_usd: 0 }));
    fake._exit(0);
    const result = await runPromise;

    expect(result.outcome).toBeDefined();
    expect(result.outcome?.toolCallsMade).toBe(0);
    expect(result.outcome?.commitsPushed).toBe(0);
    expect(result.outcome?.prUrl).toBeUndefined();
  });

  it('counts inline assistant tool_use blocks as tool calls', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);

    fake._stdout(assistantWithToolUse('Read', { file_path: '/a' }, 't1'));
    fake._stdout(assistantWithToolUse('Edit', { file_path: '/a' }, 't2'));
    fake._stdout(assistantWithToolUse('Bash', { command: 'ls' }, 't3'));
    fake._stdout(resultEvent());
    fake._exit(0);
    const result = await runPromise;

    expect(result.outcome?.toolCallsMade).toBe(3);
  });

  it('extracts a PR URL from assistant text (gh pr create stdout)', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);

    fake._stdout(
      assistantEvent('PR opened at https://github.com/acme/backend/pull/42 ready'),
    );
    fake._stdout(resultEvent());
    fake._exit(0);
    const result = await runPromise;

    expect(result.outcome?.prUrl).toBe('https://github.com/acme/backend/pull/42');
  });

  it('counts git push tool_use as commitsPushed only when tool_result is non-error', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 5_000);

    // Two git-push Bash calls: one succeeds, one fails.
    fake._stdout(
      assistantWithToolUse(
        'Bash',
        { command: 'git push -u origin feat/abc' },
        'push-ok',
      ),
    );
    fake._stdout(toolResultEvent('push-ok', false));
    fake._stdout(
      assistantWithToolUse(
        'Bash',
        { command: 'git push' },
        'push-fail',
      ),
    );
    fake._stdout(toolResultEvent('push-fail', true));
    fake._stdout(resultEvent());
    fake._exit(0);
    const result = await runPromise;

    expect(result.outcome?.commitsPushed).toBe(1);
    // Two tool_use events were emitted — both count as tool calls regardless
    // of result success.
    expect(result.outcome?.toolCallsMade).toBe(2);
  });

  it('surfaces outcome even on timeout so dashboards see what progress was made', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new StreamJsonAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'prompt', {}, 50);

    fake._stdout(assistantWithToolUse('Read', { file_path: '/a' }, 't1'));
    // Deliberately do not emit result event. Let the timeout fire.
    await new Promise((r) => setTimeout(r, 80));
    fake._exit(143);
    const result = await runPromise;

    expect(result.timedOut).toBe(true);
    expect(result.outcome?.toolCallsMade).toBe(1);
  });
});
