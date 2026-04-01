import { describe, it, expect } from 'vitest';
import { createTimeout } from '../src/timeout.js';

describe('createTimeout', () => {
  it('creates a non-aborted controller initially', () => {
    const { controller, cleanup } = createTimeout(10_000);
    expect(controller.signal.aborted).toBe(false);
    cleanup();
  });

  it('aborts after the specified duration', async () => {
    const { controller, cleanup } = createTimeout(50);
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    expect(controller.signal.aborted).toBe(true);
    cleanup(); // safe to call after abort
  });

  it('does not abort when cleanup is called before the timeout fires', async () => {
    const { controller, cleanup } = createTimeout(50);
    cleanup(); // cancel the timer immediately
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    expect(controller.signal.aborted).toBe(false);
  });

  it('returns different controllers for independent timeouts', () => {
    const a = createTimeout(10_000);
    const b = createTimeout(10_000);
    expect(a.controller).not.toBe(b.controller);
    a.cleanup();
    b.cleanup();
  });
});
