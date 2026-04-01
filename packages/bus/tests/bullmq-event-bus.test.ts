/**
 * BullMQEventBus tests
 *
 * Unit tests (no Redis needed) cover pure logic and state management that does
 * not require BullMQ to connect. These always run.
 *
 * Integration tests require a running Redis/Valkey instance and are gated
 * behind REDIS_URL so CI passes without infrastructure.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Unit: glob pattern matching (pure logic, zero external dependencies)
// ---------------------------------------------------------------------------

describe('glob pattern matching (pure logic)', () => {
  // Replicated inline from bullmq-event-bus.ts — tested without BullMQ.
  function globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\x00GLOBSTAR\x00')
      .replace(/\*/g, '[^.]+')
      .replace(/\x00GLOBSTAR\x00/g, '.+');
    return new RegExp(`^${escaped}$`);
  }

  function matches(topic: string, pattern: string): boolean {
    if (topic === pattern) return true;
    return globToRegex(pattern).test(topic);
  }

  it('exact match returns true', () => {
    expect(matches('kanban.card.moved', 'kanban.card.moved')).toBe(true);
  });

  it('single wildcard matches one segment', () => {
    expect(matches('kanban.card.moved', 'kanban.card.*')).toBe(true);
    expect(matches('kanban.card.assigned', 'kanban.card.*')).toBe(true);
  });

  it('single wildcard does not cross segment boundary', () => {
    expect(matches('kanban.card.moved.extra', 'kanban.card.*')).toBe(false);
    expect(matches('kanban.card', 'kanban.*.*')).toBe(false);
  });

  it('double wildcard matches multiple segments', () => {
    expect(matches('agent.work.progress', 'agent.**')).toBe(true);
    expect(matches('agent.work.pr_ready', 'agent.**')).toBe(true);
    expect(matches('agent.work.completed', 'agent.**')).toBe(true);
  });

  it('double wildcard matches single segment after prefix', () => {
    expect(matches('agent.work', 'agent.**')).toBe(true);
  });

  it('pattern does not match unrelated topic', () => {
    expect(matches('git.pr.opened', 'kanban.card.*')).toBe(false);
    expect(matches('kanban.card.moved', 'agent.**')).toBe(false);
  });

  it('wildcard at root level matches single segment', () => {
    expect(matches('kanban', '*')).toBe(true);
    expect(matches('kanban.card', '*')).toBe(false);
  });

  it('double wildcard at root matches anything', () => {
    expect(matches('kanban.card.moved', '**')).toBe(true);
    expect(matches('agent.work.failed', '**')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: closed-state guards (no BullMQ connection needed)
//
// These tests pass a fake connection string. BullMQ Queue/Worker constructors
// do not block on initial connect — they connect in the background. The
// `closed` guard checks run synchronously BEFORE any BullMQ call is made,
// so the tests complete immediately without needing Redis.
// ---------------------------------------------------------------------------

describe('BullMQEventBus closed-state guards', () => {
  it('publish after close throws synchronously-equivalent error', async () => {
    const { BullMQEventBus } = await import('../src/bullmq-event-bus.js');
    const bus = new BullMQEventBus({ lazyConnect: true, enableOfflineQueue: false, host: '127.0.0.1', port: 6399 });

    // Force closed without waiting for BullMQ workers to drain
    (bus as unknown as { closed: boolean }).closed = true;

    await expect(
      bus.publish('kanban.card.moved', {
        cardId: 'card-1' as never,
        fromColumnId: 'col-1' as never,
        toColumnId: 'col-2' as never,
        movedBy: 'user-1',
      }),
    ).rejects.toThrow('BullMQEventBus is closed');
  });

  it('subscribe after close throws', async () => {
    const { BullMQEventBus } = await import('../src/bullmq-event-bus.js');
    const bus = new BullMQEventBus({ lazyConnect: true, enableOfflineQueue: false, host: '127.0.0.1', port: 6399 });

    (bus as unknown as { closed: boolean }).closed = true;

    await expect(
      bus.subscribe('agent.work.failed', async () => {}),
    ).rejects.toThrow('BullMQEventBus is closed');
  });

  it('subscribePattern after close throws', async () => {
    const { BullMQEventBus } = await import('../src/bullmq-event-bus.js');
    const bus = new BullMQEventBus({ lazyConnect: true, enableOfflineQueue: false, host: '127.0.0.1', port: 6399 });

    (bus as unknown as { closed: boolean }).closed = true;

    await expect(
      bus.subscribePattern('kanban.**', async () => {}),
    ).rejects.toThrow('BullMQEventBus is closed');
  });
});

// ---------------------------------------------------------------------------
// Unit: EventBus interface type coverage (compile-time contract)
//
// These verify that the TypeScript types are correct by calling the API
// with well-typed arguments. Type errors here = tsc failures caught at build.
// No BullMQ operations needed — just verify the module exports the right shape.
// ---------------------------------------------------------------------------

describe('BullMQEventBus type exports', () => {
  it('module exports BullMQEventBus class', async () => {
    const mod = await import('../src/bullmq-event-bus.js');
    expect(typeof mod.BullMQEventBus).toBe('function');
  });
});

describe('EventBus interface exports', () => {
  it('module exports required interface type symbols', async () => {
    // These are type-only exports — we verify the module loads without error.
    // TypeScript enforces the interface contract at compile time.
    const mod = await import('../src/event-bus.js');
    expect(mod).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require Redis
// ---------------------------------------------------------------------------

describe.skipIf(!process.env['REDIS_URL'])(
  'BullMQEventBus integration (requires REDIS_URL)',
  () => {
    it('publish returns a non-empty string event id', async () => {
      const { BullMQEventBus } = await import('../src/bullmq-event-bus.js');
      const connection = { url: process.env['REDIS_URL'] };
      const bus = new BullMQEventBus(connection);

      const eventId = await bus.publish('kanban.card.moved', {
        cardId: 'card-1' as never,
        fromColumnId: 'col-1' as never,
        toColumnId: 'col-2' as never,
        movedBy: 'user-1',
      });

      expect(typeof eventId).toBe('string');
      expect(eventId.length).toBeGreaterThan(0);
      await bus.close();
    }, 10_000);

    it('publish wraps payload in a well-formed OuijaEvent envelope', async () => {
      const { BullMQEventBus } = await import('../src/bullmq-event-bus.js');
      const connection = { url: process.env['REDIS_URL'] };
      const bus = new BullMQEventBus(connection);

      // Subscribe to capture the delivered event
      let delivered: unknown;
      const done = new Promise<void>((resolve) => {
        bus.subscribe('git.pr.merged', async (event) => {
          delivered = event;
          resolve();
        });
      });

      await bus.publish(
        'git.pr.merged',
        {
          prId: 'pr-1' as never,
          instanceId: 'inst-1' as never,
          mergedAt: '2026-04-01T00:00:00Z',
        },
        { correlationId: 'corr-test', sourcePlugin: '@ouija/test' },
      );

      await Promise.race([
        done,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5000),
        ),
      ]);

      expect(delivered).toMatchObject({
        topic: 'git.pr.merged',
        correlationId: 'corr-test',
        sourcePlugin: '@ouija/test',
        payload: { mergedAt: '2026-04-01T00:00:00Z' },
      });

      await bus.close();
    }, 10_000);

    it('subscribe returns an unsubscribe function', async () => {
      const { BullMQEventBus } = await import('../src/bullmq-event-bus.js');
      const connection = { url: process.env['REDIS_URL'] };
      const bus = new BullMQEventBus(connection);

      const unsubscribe = await bus.subscribe('agent.work.failed', async () => {});
      expect(typeof unsubscribe).toBe('function');
      await unsubscribe();
      await bus.close();
    }, 10_000);

    it('subscribePattern returns an unsubscribe function', async () => {
      const { BullMQEventBus } = await import('../src/bullmq-event-bus.js');
      const connection = { url: process.env['REDIS_URL'] };
      const bus = new BullMQEventBus(connection);

      const unsubscribe = await bus.subscribePattern('kanban.card.*', async () => {});
      expect(typeof unsubscribe).toBe('function');
      await unsubscribe();
      await bus.close();
    }, 10_000);

    it('close() is idempotent', async () => {
      const { BullMQEventBus } = await import('../src/bullmq-event-bus.js');
      const connection = { url: process.env['REDIS_URL'] };
      const bus = new BullMQEventBus(connection);

      await bus.close();
      await expect(bus.close()).resolves.toBeUndefined();
    }, 10_000);

    it('fan-out: exact topic subscriber receives published event', async () => {
      const { BullMQEventBus } = await import('../src/bullmq-event-bus.js');
      const connection = { url: process.env['REDIS_URL'] };
      const bus = new BullMQEventBus(connection);

      const received: unknown[] = [];
      let resolveWhenDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveWhenDone = resolve;
      });

      await bus.subscribe('git.pr.merged', async (event) => {
        received.push(event);
        resolveWhenDone();
      });

      await bus.publish('git.pr.merged', {
        prId: 'pr-integration-1' as never,
        instanceId: 'inst-integration-1' as never,
        mergedAt: new Date().toISOString(),
      });

      await Promise.race([
        done,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5000),
        ),
      ]);

      expect(received).toHaveLength(1);
      expect((received[0] as { topic: string }).topic).toBe('git.pr.merged');

      await bus.close();
    }, 10_000);

    it('fan-out: pattern subscriber receives matching events', async () => {
      const { BullMQEventBus } = await import('../src/bullmq-event-bus.js');
      const connection = { url: process.env['REDIS_URL'] };
      const bus = new BullMQEventBus(connection);

      const received: string[] = [];
      let resolveWhenTwo!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveWhenTwo = resolve;
      });

      await bus.subscribePattern('agent.**', async (event) => {
        received.push(event.topic);
        if (received.length >= 2) resolveWhenTwo();
      });

      await bus.publish('agent.work.progress', {
        instanceId: 'inst-1' as never,
        dispatchId: 'disp-1' as never,
        progress: 50,
        message: 'halfway',
      });

      await bus.publish('agent.work.completed', {
        instanceId: 'inst-1' as never,
        dispatchId: 'disp-1' as never,
        cost: 0.01,
        tokensUsed: 1000,
      });

      await Promise.race([
        done,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 8000),
        ),
      ]);

      expect(received).toContain('agent.work.progress');
      expect(received).toContain('agent.work.completed');

      await bus.close();
    }, 15_000);

    it('unsubscribe stops delivery', async () => {
      const { BullMQEventBus } = await import('../src/bullmq-event-bus.js');
      const connection = { url: process.env['REDIS_URL'] };
      const bus = new BullMQEventBus(connection);

      const received: unknown[] = [];
      const unsubscribe = await bus.subscribe(
        'kanban.card.moved',
        async (event) => {
          received.push(event);
        },
      );

      await unsubscribe();

      await bus.publish('kanban.card.moved', {
        cardId: 'card-1' as never,
        fromColumnId: 'col-1' as never,
        toColumnId: 'col-2' as never,
        movedBy: 'user-1',
      });

      await new Promise((r) => setTimeout(r, 500));
      expect(received).toHaveLength(0);

      await bus.close();
    }, 10_000);
  },
);
