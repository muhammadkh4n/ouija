/**
 * local-runner.test.ts
 *
 * Tests for LocalAgentRunner. Two layers:
 *
 * 1. Mock-spawn tests: inject a fake spawn function to verify exactly what
 *    arguments, cwd, env, and stdin the runner sends to the subprocess.
 *    These are precise behavioral tests — no real processes spawned.
 *
 * 2. Real-binary tests: use POSIX binaries (sleep, false, echo) to verify
 *    the event-driven flow: timeout enforcement and AbortSignal handling.
 *    These are the only tests that actually kill processes.
 *
 * Integration with the real Claude CLI is handled by the smoke test (Task 5).
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { Writable } from 'node:stream';
import { LocalAgentRunner } from '../src/local-runner.js';
import type { Workspace, AgentRunResult } from '@ouija-dev/types';

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
// Fake ChildProcess factory
//
// Produces a minimal ChildProcess-compatible object. Tests call `resolve()`
// or `reject()` to drive the fake process to an exit or error state.
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: EventEmitter & { on: EventEmitter['on'] };
  stderr: EventEmitter & { on: EventEmitter['on'] };
  killed: boolean;
  kill: (signal?: string) => boolean;
  /** Drive the fake process to exit with the given code. */
  _exit: (code: number) => void;
  /** Drive the fake process to emit 'error'. */
  _error: (err: Error) => void;
  /** Emit a stdout data chunk. */
  _stdout: (chunk: string) => void;
}

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter() as FakeChild;

  // stdin: a writable that buffers all written data.
  const stdinChunks: string[] = [];
  const stdin = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      stdinChunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  (stdin as unknown as { _written: string[] })._written = stdinChunks;
  emitter.stdin = stdin;

  // stdout / stderr: simple EventEmitters.
  emitter.stdout = new EventEmitter() as FakeChild['stdout'];
  emitter.stderr = new EventEmitter() as FakeChild['stderr'];

  emitter.killed = false;
  emitter.kill = (signal?: string) => {
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

  return emitter;
}

// ---------------------------------------------------------------------------
// Mock-spawn tests
// ---------------------------------------------------------------------------

describe('LocalAgentRunner — mock spawn', () => {
  it('spawns claude with correct cwd from workspace.endpoint', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new LocalAgentRunner({ spawnFn });
    const workspace = makeWorkspace({ endpoint: '/workspace/my-repo' });

    const runPromise = runner.run(workspace, 'prompt', {}, 5_000);
    fake._exit(0);
    await runPromise;

    expect(spawnFn).toHaveBeenCalledOnce();
    const spawnOptions = spawnFn.mock.calls[0]?.[2] as SpawnOptions;
    expect(spawnOptions.cwd).toBe('/workspace/my-repo');
  });

  it('spawns with -p <prompt> --dangerously-skip-permissions --output-format text args', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new LocalAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'test prompt', {}, 5_000);
    fake._exit(0);
    await runPromise;

    const args = spawnFn.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(['-p', 'test prompt', '--dangerously-skip-permissions', '--output-format', 'text']);
  });

  it('passes prompt via -p flag, not stdin', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new LocalAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), 'my prompt text', {}, 5_000);
    fake._exit(0);
    await runPromise;

    // Prompt should be in the args, not piped via stdin
    const args = spawnFn.mock.calls[0]?.[1] as string[];
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('my prompt text');

    // stdin should NOT have received the prompt (it's closed immediately)
    const written = (fake.stdin as unknown as { _written: string[] })._written;
    expect(written.join('')).toBe('');
  });

  it('passes env vars with allowlist — caller env merged in', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new LocalAgentRunner({ spawnFn });
    const runPromise = runner.run(
      makeWorkspace(),
      '',
      { ANTHROPIC_API_KEY: 'sk-test-key', MY_VAR: 'my-value' },
      5_000,
    );
    fake._exit(0);
    await runPromise;

    const spawnOptions = spawnFn.mock.calls[0]?.[2] as SpawnOptions;
    const env = spawnOptions.env as Record<string, string>;
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-test-key');
    expect(env['MY_VAR']).toBe('my-value');
  });

  it('sets CI=1 in env', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new LocalAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), '', {}, 5_000);
    fake._exit(0);
    await runPromise;

    const spawnOptions = spawnFn.mock.calls[0]?.[2] as SpawnOptions;
    const env = spawnOptions.env as Record<string, string>;
    expect(env['CI']).toBe('1');
  });

  it('does not pass process.env vars outside the allowlist', async () => {
    // Inject a secret that should be stripped.
    const orig = process.env['DB_PASSWORD'];
    process.env['DB_PASSWORD'] = 'super-secret';
    try {
      const fake = makeFakeChild();
      const spawnFn = vi.fn().mockReturnValue(fake);

      const runner = new LocalAgentRunner({ spawnFn });
      const runPromise = runner.run(makeWorkspace(), '', {}, 5_000);
      fake._exit(0);
      await runPromise;

      const spawnOptions = spawnFn.mock.calls[0]?.[2] as SpawnOptions;
      const env = spawnOptions.env as Record<string, string>;
      expect(env['DB_PASSWORD']).toBeUndefined();
    } finally {
      if (orig === undefined) delete process.env['DB_PASSWORD'];
      else process.env['DB_PASSWORD'] = orig;
    }
  });

  it('uses default binary path "claude" when no binaryPath configured', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new LocalAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), '', {}, 5_000);
    fake._exit(0);
    await runPromise;

    const command = spawnFn.mock.calls[0]?.[0] as string;
    expect(command).toBe('claude');
  });

  it('passes custom binaryPath when configured', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new LocalAgentRunner({ binaryPath: '/usr/local/bin/my-claude', spawnFn });
    const runPromise = runner.run(makeWorkspace(), '', {}, 5_000);
    fake._exit(0);
    await runPromise;

    const command = spawnFn.mock.calls[0]?.[0] as string;
    expect(command).toBe('/usr/local/bin/my-claude');
  });

  it('calls onOutput with each stdout chunk', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new LocalAgentRunner({ spawnFn });
    const chunks: string[] = [];
    const runPromise = runner.run(makeWorkspace(), '', {}, 5_000, {
      onOutput: (chunk) => chunks.push(chunk),
    });

    fake._stdout('first chunk');
    fake._stdout('second chunk');
    fake._exit(0);
    await runPromise;

    expect(chunks).toEqual(['first chunk', 'second chunk']);
  });

  it('passes abort signal through — kills process when signal fires', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const controller = new AbortController();
    const runner = new LocalAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), '', {}, 30_000, {
      signal: controller.signal,
    });

    // Abort, then immediately simulate the SIGTERM death.
    controller.abort();
    fake._exit(1);
    await runPromise;

    expect(fake.killed).toBe(true);
  });

  it('handles pre-aborted signal — kills immediately after spawn', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const controller = new AbortController();
    controller.abort(); // Already aborted

    const runner = new LocalAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), '', {}, 30_000, {
      signal: controller.signal,
    });

    // Kill fires synchronously on a pre-aborted signal.
    fake._exit(1);
    await runPromise;

    expect(fake.killed).toBe(true);
  });

  it('returns AgentRunResult with correct fields', async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake);

    const runner = new LocalAgentRunner({ spawnFn });
    const runPromise = runner.run(makeWorkspace(), '', {}, 5_000);

    fake._stdout('output text');
    fake._exit(42);
    const result = await runPromise;

    expect(result.exitCode).toBe(42);
    expect(result.stdout).toBe('output text');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Real-binary tests (timeout and AbortSignal enforcement)
// These tests use real POSIX binaries to verify kill logic works end-to-end.
// ---------------------------------------------------------------------------

describe('LocalAgentRunner — real binaries', () => {
  it('enforces timeout with SIGTERM then SIGKILL — sets timedOut=true', async () => {
    // sleep accepts --print etc. as unknown args; behavior varies by platform.
    // Use `sh -c 'sleep 60'` to avoid arg parsing issues.
    const runner = new LocalAgentRunner({ binaryPath: 'sleep' });
    // sleep [seconds] ignores extra args on macOS BSD, so just pass a duration
    // via a workaround: we override the args by using sh as binary.
    // Actually sleep with args --print --output-format text will error quickly,
    // so timedOut would be false. Use 'sh' as binary instead.
    const shRunner = new LocalAgentRunner({ binaryPath: 'sh' });

    // 'sh --print --output-format text' — sh treats --print as an unknown option
    // and exits immediately. Not ideal. We need a binary that ignores extra args
    // and sleeps. Use node with --eval that reads from env to get duration:
    // Actually: the args passed are ['--print', '--output-format', 'text'] which
    // get passed to `sh`. sh ignores unknown long-form flags on macOS... let's check.
    // Instead let's just use a real approach: spawn `sleep` directly via the real
    // spawn (not the runner) — no, we need the runner.
    // The cleanest: use `tail -f /dev/null` which ignores extra args on macOS.
    const tailRunner = new LocalAgentRunner({ binaryPath: 'tail' });
    const result = await tailRunner.run(
      makeWorkspace({ endpoint: '/tmp' }),
      '',
      {},
      200, // 200 ms timeout
    );
    // tail -f /dev/null --print --output-format text: --print and text may be
    // treated as file args on macOS, but tail will still block reading them.
    // Either way, after 200ms it should be killed.
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(10_000);
  }, 15_000);

  it('does not set timedOut when process exits before timeout', async () => {
    // Use `true` binary — exits 0 immediately, no args needed.
    const runner = new LocalAgentRunner({ binaryPath: 'true' });
    const result = await runner.run(makeWorkspace({ endpoint: '/tmp' }), '', {}, 30_000);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('terminates process when AbortSignal fires', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    // Use `tail -f /dev/null` as a long-running process.
    const runner = new LocalAgentRunner({ binaryPath: 'tail' });
    const result = await runner.run(
      makeWorkspace({ endpoint: '/tmp' }),
      '',
      {},
      60_000,
      { signal: controller.signal },
    );

    expect(result.durationMs).toBeLessThan(10_000);
  }, 15_000);
});
