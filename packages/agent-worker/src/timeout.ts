/**
 * Timeout utility — wraps AbortController with an auto-abort timer.
 *
 * Per the architecture decision in the Phase 2 plan: the worker itself does
 * NOT enforce a separate outer timeout on top of the plugin's internal timeout.
 * The plugin (ClaudeAgentPlugin) owns the timeout lifecycle for the subprocess.
 *
 * This module is kept for any future cases where we need a worker-level
 * deadline guard (e.g. if the assembleWorkOrder call itself hangs).
 */

export interface TimeoutHandle {
  /** The AbortController — pass signal to any cancellable operation. */
  controller: AbortController;
  /** Call this when work completes to prevent the timer from firing. */
  cleanup(): void;
}

/**
 * Create an AbortController that auto-aborts after `ms` milliseconds.
 *
 * The timer is unreffed so it does not keep the Node.js event loop alive
 * when all other async work is done.
 */
export function createTimeout(ms: number): TimeoutHandle {
  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Timed out after ${ms}ms`));
  }, ms);

  // Prevent the timer from keeping the process alive on an otherwise idle loop.
  if (typeof timeoutId === 'object' && timeoutId !== null && 'unref' in timeoutId) {
    (timeoutId as NodeJS.Timeout).unref();
  }

  return {
    controller,
    cleanup() {
      clearTimeout(timeoutId);
    },
  };
}
