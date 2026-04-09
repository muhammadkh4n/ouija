import type { OuijaEvent, OuijaEventMap, OuijaTopic } from '@ouija-dev/types';

/**
 * Handler for a specific typed topic. Receives the full OuijaEvent envelope.
 */
export type EventHandler<TTopic extends OuijaTopic> = (
  event: OuijaEvent<TTopic>,
) => Promise<void>;

/**
 * Handler for pattern subscriptions. Type-unsafe by design — wildcards cannot
 * be statically constrained to a single payload shape.
 */
export type PatternEventHandler = (event: OuijaEvent) => Promise<void>;

/**
 * Unsubscribe function returned by subscribe / subscribePattern.
 * Calling it deregisters the handler and cleans up any BullMQ workers.
 */
export type Unsubscribe = () => Promise<void>;

/**
 * EventBus — pub/sub interface for Ouija domain events.
 *
 * Design rules (Decision 2 in spec §2.4):
 *  - Separate from JobQueue at the interface level even though both use BullMQ.
 *  - `subscribe` is typed: the handler receives the exact payload for TTopic.
 *  - `subscribePattern` is intentionally type-unsafe: wildcards span multiple
 *    topics and therefore multiple payload shapes. Callers must narrow.
 *  - `replay` allows catch-up processing from persistent event storage.
 */
export interface EventBus {
  /**
   * Publish an event to all subscribers of `topic`.
   * The bus generates the event envelope (id, timestamp, correlationId).
   * Returns the generated event id.
   */
  publish<TTopic extends OuijaTopic>(
    topic: TTopic,
    payload: OuijaEventMap[TTopic],
    options?: PublishOptions,
  ): Promise<string>;

  /**
   * Subscribe to an exact topic. Returns an unsubscribe function.
   * The handler is called once per published event.
   */
  subscribe<TTopic extends OuijaTopic>(
    topic: TTopic,
    handler: EventHandler<TTopic>,
  ): Promise<Unsubscribe>;

  /**
   * Subscribe to events matching a glob-style pattern, e.g. `kanban.card.*`
   * or `agent.**`. Intentionally type-unsafe — callers must narrow the payload
   * themselves. Returns an unsubscribe function.
   */
  subscribePattern(
    pattern: string,
    handler: PatternEventHandler,
  ): Promise<Unsubscribe>;

  /**
   * Replay stored events for a topic between `from` and `to` (ISO strings).
   * Events are delivered to `handler` in chronological order.
   * Used for catch-up processing and debugging.
   */
  replay(
    topic: OuijaTopic,
    from: string,
    to: string,
    handler: PatternEventHandler,
  ): Promise<void>;

  /**
   * Gracefully shut down the bus, draining in-flight handlers.
   */
  close(): Promise<void>;
}

export interface PublishOptions {
  /** Explicit correlationId to propagate across services. Defaults to a new UUID. */
  correlationId?: string;
  /** Source plugin identifier. Defaults to 'unknown'. */
  sourcePlugin?: string;
}
