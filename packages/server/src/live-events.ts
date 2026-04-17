/**
 * Live pipeline event fan-out for SSE subscribers.
 *
 * One process-local EventEmitter bridges instance-scoped topics from the
 * durable eventBus (BullMQ) to ephemeral SSE listeners. A single boot-time
 * subscription on the eventBus re-emits each relevant event on this emitter
 * keyed by pipeline instance id. Each SSE request attaches a per-instance
 * listener and detaches on disconnect — no BullMQ churn per connection.
 *
 * Topics forwarded (all instance-scoped via payload.instanceId):
 *   - agent.work.progress
 *   - agent.work.pr_ready
 *   - agent.work.completed
 *   - agent.work.failed
 *   - git.pr.opened
 *   - git.pr.merged
 */
import { EventEmitter } from 'node:events';
import type { EventBus, Unsubscribe } from '@ouija-dev/bus';
import type { OuijaTopic, OuijaEvent } from '@ouija-dev/types';

const FORWARDED_TOPICS = [
  'agent.work.progress',
  'agent.work.pr_ready',
  'agent.work.completed',
  'agent.work.failed',
  'git.pr.opened',
  'git.pr.merged',
] as const satisfies readonly OuijaTopic[];

type ForwardedTopic = (typeof FORWARDED_TOPICS)[number];

export interface LiveEvent<T extends ForwardedTopic = ForwardedTopic> {
  readonly topic: T;
  readonly event: OuijaEvent<T>;
}

export type LiveEventListener = (event: LiveEvent) => void;

/**
 * Per-instance event channel used by SSE handlers.
 *
 * Event name is the pipeline instance id. This keeps fan-out O(1) per
 * subscriber and avoids broadcasting unrelated instances to every SSE
 * connection.
 */
export class LiveEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Cap at 0 (unlimited) — one listener per active SSE connection is fine,
    // and we explicitly track teardown via the returned disposer.
    this.emitter.setMaxListeners(0);
  }

  subscribe(instanceId: string, listener: LiveEventListener): () => void {
    this.emitter.on(instanceId, listener);
    return () => {
      this.emitter.off(instanceId, listener);
    };
  }

  emit(instanceId: string, event: LiveEvent): void {
    this.emitter.emit(instanceId, event);
  }
}

/**
 * Wire the durable event bus to the live bus. Returns a disposer that
 * unsubscribes all forwarded topics — call on shutdown.
 */
export async function registerLiveEventsBridge(
  eventBus: EventBus,
  live: LiveEventBus,
): Promise<() => Promise<void>> {
  const unsubs: Unsubscribe[] = [];

  for (const topic of FORWARDED_TOPICS) {
    const unsub = await eventBus.subscribe(topic, async (event) => {
      const payload = event.payload as { instanceId?: string };
      const instanceId = payload.instanceId;
      if (typeof instanceId !== 'string' || instanceId.length === 0) return;
      live.emit(instanceId, {
        topic,
        event: event as unknown as OuijaEvent<ForwardedTopic>,
      });
    });
    unsubs.push(unsub);
  }

  return async () => {
    for (const unsub of unsubs) {
      try {
        await unsub();
      } catch {
        // best-effort cleanup on shutdown
      }
    }
  };
}
