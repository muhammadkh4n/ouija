/**
 * LiveEventBus unit tests + registerLiveEventsBridge integration.
 *
 * The bus itself is a thin EventEmitter wrapper; the bridge logic filters
 * unrelated instance ids and tears down cleanly.
 */
import { describe, it, expect, vi } from 'vitest';
import { LiveEventBus, registerLiveEventsBridge } from '../src/live-events.js';
import type { OuijaEvent, OuijaTopic } from '@ouija-dev/types';
import type { EventBus, EventHandler, Unsubscribe } from '@ouija-dev/bus';

// ---- Minimal in-memory EventBus for the bridge test ----

function makeFakeBus(): EventBus & {
  fire: <T extends OuijaTopic>(topic: T, ev: OuijaEvent<T>) => Promise<void>;
} {
  const handlers = new Map<OuijaTopic, Set<EventHandler<OuijaTopic>>>();

  return {
    async publish() {
      /* unused */
    },
    async subscribe<T extends OuijaTopic>(
      topic: T,
      handler: EventHandler<T>,
    ): Promise<Unsubscribe> {
      const set = handlers.get(topic) ?? new Set();
      set.add(handler as EventHandler<OuijaTopic>);
      handlers.set(topic, set);
      return async () => {
        set.delete(handler as EventHandler<OuijaTopic>);
      };
    },
    async subscribePattern() {
      return async () => undefined;
    },
    async close() {
      /* unused */
    },
    async fire<T extends OuijaTopic>(topic: T, ev: OuijaEvent<T>): Promise<void> {
      const set = handlers.get(topic);
      if (!set) return;
      for (const handler of set) {
        await handler(ev as OuijaEvent<OuijaTopic>);
      }
    },
  } as EventBus & {
    fire: <T extends OuijaTopic>(topic: T, ev: OuijaEvent<T>) => Promise<void>;
  };
}

function progressEvent(instanceId: string): OuijaEvent<'agent.work.progress'> {
  return {
    id: `evt-${instanceId}`,
    topic: 'agent.work.progress',
    payload: {
      instanceId: instanceId as never,
      dispatchId: 'disp-1' as never,
      progress: 42,
      message: 'working',
    },
    timestamp: new Date().toISOString(),
    sourcePlugin: 'test',
    correlationId: 'corr-1',
  };
}

describe('LiveEventBus', () => {
  it('delivers events only to matching-instance listeners', () => {
    const bus = new LiveEventBus();
    const heard = vi.fn();
    const ignored = vi.fn();

    const unsubA = bus.subscribe('inst-A', heard);
    const unsubB = bus.subscribe('inst-B', ignored);

    bus.emit('inst-A', {
      topic: 'agent.work.progress',
      event: progressEvent('inst-A'),
    });

    expect(heard).toHaveBeenCalledTimes(1);
    expect(ignored).not.toHaveBeenCalled();

    unsubA();
    unsubB();
  });

  it('returns a disposer that detaches the listener', () => {
    const bus = new LiveEventBus();
    const listener = vi.fn();
    const unsub = bus.subscribe('inst-X', listener);

    unsub();
    bus.emit('inst-X', {
      topic: 'agent.work.progress',
      event: progressEvent('inst-X'),
    });

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('registerLiveEventsBridge', () => {
  it('forwards every supported topic to the live bus keyed by instanceId', async () => {
    const fakeBus = makeFakeBus();
    const live = new LiveEventBus();
    const heard = vi.fn();

    const off = live.subscribe('inst-1', heard);
    const unsubBridge = await registerLiveEventsBridge(fakeBus, live);

    await fakeBus.fire('agent.work.progress', progressEvent('inst-1'));

    expect(heard).toHaveBeenCalledTimes(1);
    const arg = heard.mock.calls[0]?.[0] as { topic: string; event: OuijaEvent };
    expect(arg.topic).toBe('agent.work.progress');
    expect(arg.event.id).toBe('evt-inst-1');

    off();
    await unsubBridge();
  });

  it('drops events whose payload has no instanceId', async () => {
    const fakeBus = makeFakeBus();
    const live = new LiveEventBus();
    const heard = vi.fn();

    live.subscribe('', heard);
    const unsubBridge = await registerLiveEventsBridge(fakeBus, live);

    // Build a progress event with an empty instanceId (unusual but possible
    // if callers misuse the API). The bridge must ignore it, not emit on "".
    const bogus: OuijaEvent<'agent.work.progress'> = {
      ...progressEvent('whatever'),
      payload: {
        ...progressEvent('whatever').payload,
        instanceId: '' as never,
      },
    };
    await fakeBus.fire('agent.work.progress', bogus);

    expect(heard).not.toHaveBeenCalled();
    await unsubBridge();
  });

  it('tears down all topic subscriptions on dispose', async () => {
    const fakeBus = makeFakeBus();
    const live = new LiveEventBus();
    const heard = vi.fn();

    live.subscribe('inst-2', heard);
    const unsubBridge = await registerLiveEventsBridge(fakeBus, live);
    await unsubBridge();

    await fakeBus.fire('agent.work.progress', progressEvent('inst-2'));
    expect(heard).not.toHaveBeenCalled();
  });
});
