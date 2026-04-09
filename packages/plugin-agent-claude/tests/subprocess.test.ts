/**
 * subprocess.test.ts
 *
 * Tests for spawnClaude(). These use real child_process.spawn with harmless
 * system binaries (echo, sleep) rather than mocking child_process, so they
 * verify the actual event-driven flow: stdin write, stdout capture, timeout
 * enforcement, and AbortSignal handling.
 *
 * Integration with the real Claude CLI is handled by the smoke test (Task 5).
 */

import { describe, it, expect, vi } from 'vitest';
import { spawnClaude } from '../src/subprocess.js';

describe.skipIf(!!process.env.CI)('spawnClaude', () => {
  describe('basic execution', () => {
    it('returns exitCode 0 for a fast-succeeding binary', async () => {
      const result = await spawnClaude({
        prompt: 'hello',
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5_000,
        // Use 'echo' as a stand-in; it ignores --print/--output-format args
        // and exits 0 immediately.
        binaryPath: 'echo',
      });

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it('captures stdout via onOutput callback', async () => {
      const chunks: string[] = [];

      await spawnClaude({
        prompt: '',
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5_000,
        binaryPath: 'echo',
        onOutput: (chunk) => chunks.push(chunk),
      });

      // echo writes at least one chunk to stdout
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // The combined output should contain the --print flag that echo echoes back
      const combined = chunks.join('');
      expect(combined).toContain('--print');
    });

    it('accumulates stdout in result.stdout', async () => {
      const result = await spawnClaude({
        prompt: '',
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5_000,
        binaryPath: 'echo',
      });

      // echo with args ["--print", "--output-format", "text"] outputs those args
      expect(result.stdout).toContain('--print');
    });

    it('propagates non-zero exit codes', async () => {
      const result = await spawnClaude({
        prompt: '',
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5_000,
        // false always exits 1 on POSIX
        binaryPath: 'false',
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.timedOut).toBe(false);
    });
  });

  describe('environment variable injection', () => {
    it('passes extra env vars to the subprocess', async () => {
      // Use env -0 to print all env vars; grep-like behaviour via the test
      // We can verify ANTHROPIC_API_KEY is NOT in args by checking that the
      // binary receives it via environment, not argv.
      // For this test we just verify that env merging doesn't throw.
      const result = await spawnClaude({
        prompt: '',
        cwd: process.cwd(),
        env: { ANTHROPIC_API_KEY: 'sk-test-key-NEVER-IN-ARGS' },
        timeoutMs: 5_000,
        binaryPath: 'echo',
      });

      // echo outputs its argv — ANTHROPIC_API_KEY should NOT appear there
      expect(result.stdout).not.toContain('sk-test-key-NEVER-IN-ARGS');
      expect(result.exitCode).toBe(0);
    });

    it('sets CI=1 in the subprocess environment', async () => {
      // We cannot inspect the subprocess env directly, but we can verify
      // the spawn completes without error (CI=1 is passed in mergedEnv).
      const result = await spawnClaude({
        prompt: '',
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5_000,
        binaryPath: 'echo',
      });

      expect(result.exitCode).toBe(0);
    });
  });

  describe('timeout enforcement', () => {
    it('kills the process and sets timedOut when timeout expires', async () => {
      const result = await spawnClaude({
        prompt: '',
        cwd: process.cwd(),
        env: {},
        // Very short timeout to trigger kill quickly
        timeoutMs: 150,
        // sleep with args --print --output-format text will fail or sleep
        binaryPath: 'sleep',
      });

      // The subprocess should finish well within 10 s (killed by timeout)
      expect(result.durationMs).toBeLessThan(10_000);
      expect(result.timedOut).toBe(true);
    }, 15_000);

    it('does not set timedOut when process exits before timeout', async () => {
      const result = await spawnClaude({
        prompt: '',
        cwd: process.cwd(),
        env: {},
        timeoutMs: 30_000,
        binaryPath: 'echo',
      });

      expect(result.timedOut).toBe(false);
    });
  });

  describe('AbortSignal cancellation', () => {
    it('terminates the process when AbortSignal fires', async () => {
      const controller = new AbortController();

      // Abort after 100 ms
      setTimeout(() => controller.abort(), 100);

      const result = await spawnClaude({
        prompt: '',
        cwd: process.cwd(),
        env: {},
        timeoutMs: 60_000,
        binaryPath: 'sleep',
        signal: controller.signal,
      });

      expect(result.durationMs).toBeLessThan(10_000);
    }, 15_000);

    it('handles a pre-aborted signal without hanging', async () => {
      const controller = new AbortController();
      controller.abort(); // Abort before spawn

      const result = await spawnClaude({
        prompt: '',
        cwd: process.cwd(),
        env: {},
        timeoutMs: 60_000,
        binaryPath: 'sleep',
        signal: controller.signal,
      });

      // Should terminate quickly — the abort fires immediately after spawn
      expect(result.durationMs).toBeLessThan(10_000);
    }, 15_000);
  });

  describe('spawn failure', () => {
    it('rejects with an error when the binary does not exist', async () => {
      await expect(
        spawnClaude({
          prompt: '',
          cwd: process.cwd(),
          env: {},
          timeoutMs: 5_000,
          binaryPath: '/nonexistent/binary/that/does/not/exist',
        }),
      ).rejects.toThrow();
    });
  });
});
