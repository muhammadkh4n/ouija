import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { OuijaEvent, OuijaEventMap, OuijaTopic } from '@ouija-dev/types';
import type {
  EventBus,
  EventHandler,
  PatternEventHandler,
  PublishOptions,
  Unsubscribe,
} from './event-bus.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SubscriberEntry {
  key: string;
  topic: string; // exact topic or glob pattern
  isPattern: boolean;
  handler: PatternEventHandler;
  worker: Worker;
}

// ---------------------------------------------------------------------------
// Glob pattern matching
// ---------------------------------------------------------------------------

/**
 * Convert a glob-style pattern into a RegExp.
 *
 * Rules:
 *  - `*`  matches any sequence of characters that does not contain `.`
 *  - `**` matches any sequence of characters including `.`
 *  - `.`  is treated as a literal dot
 *
 * Examples:
 *  - `kanban.card.*`   matches `kanban.card.moved`, `kanban.card.created`
 *  - `agent.**`        matches `agent.work.progress`, `agent.work.pr_ready`
 *  - `git.*`           matches `git.pr` but NOT `git.pr.opened`
 */
function globToRegex(pattern: string): RegExp {
  // Escape all regex metacharacters except * which we handle specially
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars (. included)
    .replace(/\\\.\\\./g, '\\.') // shouldn't occur but safety net
    // Replace ** first (two stars), then single *
    .replace(/\*\*/g, '\x00GLOBSTAR\x00')
    .replace(/\*/g, '[^.]+')
    .replace(/\x00GLOBSTAR\x00/g, '.+');

  return new RegExp(`^${escaped}$`);
}

function topicMatchesPattern(topic: string, pattern: string): boolean {
  // Exact match short-circuit
  if (topic === pattern) return true;
  try {
    return globToRegex(pattern).test(topic);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// BullMQEventBus
// ---------------------------------------------------------------------------

/**
 * BullMQ-backed EventBus implementation.
 *
 * Fan-out strategy (v1 — simple and correct):
 *  Each registered subscriber gets its own BullMQ queue named
 *  `ouija.event-bus.<subscriberKey>`. When an event is published, one job is
 *  enqueued per subscriber whose topic/pattern matches. The subscriber's Worker
 *  processes that queue and calls the handler.
 *
 * This is O(N subscribers) on publish, which is acceptable for v1 where
 * subscriber counts are single digits. If N grows, swap to Redis Streams
 * consumer groups without changing the EventBus interface.
 *
 * Assumptions:
 *  - Redis is configured with `maxmemory-policy noeviction`. Jobs must never
 *    be silently dropped due to memory pressure.
 *  - Connection is managed externally and passed in via `connection` option.
 */
export class BullMQEventBus implements EventBus {
  private readonly connection: ConnectionOptions;
  private readonly subscribers = new Map<string, SubscriberEntry>();
  // One Queue per subscriber key for fan-out delivery
  private readonly deliveryQueues = new Map<string, Queue>();
  // Single publish queue used as the fan-out coordinator
  private readonly dispatchQueue: Queue;
  private readonly dispatchWorker: Worker;
  private closed = false;

  constructor(connection: ConnectionOptions) {
    this.connection = connection;

    // The dispatch queue receives one job per publish() call.
    // Its worker fans out to per-subscriber delivery queues.
    this.dispatchQueue = new Queue('ouija.event-bus.dispatch', {
      connection,
      defaultJobOptions: {
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
    });

    this.dispatchWorker = new Worker(
      'ouija.event-bus.dispatch',
      async (job) => {
        const event = job.data as OuijaEvent;
        await this.fanOut(event);
      },
      { connection, concurrency: 10 },
    );

    this.dispatchWorker.on('failed', (job, err) => {
      console.error(
        `[BullMQEventBus] dispatch job ${job?.id ?? 'unknown'} failed:`,
        err,
      );
    });
  }

  // -------------------------------------------------------------------------
  // publish
  // -------------------------------------------------------------------------

  async publish<TTopic extends OuijaTopic>(
    topic: TTopic,
    payload: OuijaEventMap[TTopic],
    options: PublishOptions = {},
  ): Promise<string> {
    if (this.closed) throw new Error('BullMQEventBus is closed');

    const event: OuijaEvent<TTopic> = {
      id: randomUUID(),
      topic,
      payload,
      timestamp: new Date().toISOString(),
      sourcePlugin: options.sourcePlugin ?? 'unknown',
      correlationId: options.correlationId ?? randomUUID(),
    };

    await this.dispatchQueue.add(`event:${topic}`, event, {
      jobId: `event:${event.id}`,
    });

    return event.id;
  }

  // -------------------------------------------------------------------------
  // subscribe (exact topic, fully typed)
  // -------------------------------------------------------------------------

  async subscribe<TTopic extends OuijaTopic>(
    topic: TTopic,
    handler: EventHandler<TTopic>,
  ): Promise<Unsubscribe> {
    // Wrap typed handler as PatternEventHandler so we can store it uniformly
    const patternHandler: PatternEventHandler = async (event) => {
      await handler(event as OuijaEvent<TTopic>);
    };

    return this.addSubscriber(topic, false, patternHandler);
  }

  // -------------------------------------------------------------------------
  // subscribePattern (glob, intentionally type-unsafe)
  // -------------------------------------------------------------------------

  async subscribePattern(
    pattern: string,
    handler: PatternEventHandler,
  ): Promise<Unsubscribe> {
    return this.addSubscriber(pattern, true, handler);
  }

  // -------------------------------------------------------------------------
  // replay
  // -------------------------------------------------------------------------

  /**
   * Replay is not natively supported by BullMQ (jobs are ephemeral).
   * A production implementation would query a persistent event store
   * (Postgres `pipeline_events` table) and re-deliver events.
   *
   * This stub iterates completed jobs in the dispatch queue as a best-effort
   * fallback. Callers should not rely on this for full catch-up — use the
   * Postgres event log (Task 5) once available.
   */
  async replay(
    topic: OuijaTopic,
    from: string,
    to: string,
    handler: PatternEventHandler,
  ): Promise<void> {
    if (this.closed) throw new Error('BullMQEventBus is closed');

    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();

    // BullMQ stores completed jobs temporarily. Fetch and filter.
    const completed = await this.dispatchQueue.getCompleted(0, 1000);

    const inRange = completed.filter((job) => {
      const event = job.data as OuijaEvent;
      if (event.topic !== topic) return false;
      const ts = new Date(event.timestamp).getTime();
      return ts >= fromMs && ts <= toMs;
    });

    // Sort ascending by timestamp
    inRange.sort((a, b) => {
      const aTs = new Date((a.data as OuijaEvent).timestamp).getTime();
      const bTs = new Date((b.data as OuijaEvent).timestamp).getTime();
      return aTs - bTs;
    });

    for (const job of inRange) {
      await handler(job.data as OuijaEvent);
    }
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    await this.dispatchWorker.close();
    await this.dispatchQueue.close();

    const closePromises: Promise<void>[] = [];
    for (const entry of this.subscribers.values()) {
      closePromises.push(entry.worker.close());
    }
    for (const queue of this.deliveryQueues.values()) {
      closePromises.push(queue.close());
    }
    await Promise.all(closePromises);

    this.subscribers.clear();
    this.deliveryQueues.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async addSubscriber(
    topicOrPattern: string,
    isPattern: boolean,
    handler: PatternEventHandler,
  ): Promise<Unsubscribe> {
    if (this.closed) throw new Error('BullMQEventBus is closed');

    const key = `sub:${randomUUID()}`;
    const deliveryQueueName = `ouija.event-bus.delivery.${key}`;

    const deliveryQueue = new Queue(deliveryQueueName, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 100 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 500 },
      },
    });

    const worker = new Worker(
      deliveryQueueName,
      async (job) => {
        const event = job.data as OuijaEvent;
        await handler(event);
      },
      { connection: this.connection, concurrency: 1 },
    );

    worker.on('failed', (job, err) => {
      console.error(
        `[BullMQEventBus] delivery job ${job?.id ?? 'unknown'} for subscriber ${key} failed:`,
        err,
      );
    });

    const entry: SubscriberEntry = {
      key,
      topic: topicOrPattern,
      isPattern,
      handler,
      worker,
    };

    this.subscribers.set(key, entry);
    this.deliveryQueues.set(key, deliveryQueue);

    const unsubscribe: Unsubscribe = async () => {
      this.subscribers.delete(key);
      const q = this.deliveryQueues.get(key);
      this.deliveryQueues.delete(key);
      await worker.close();
      if (q) await q.close();
    };

    return unsubscribe;
  }

  /**
   * Fan out a published event to all matching subscribers.
   * Called by the dispatch worker — runs inside BullMQ.
   */
  private async fanOut(event: OuijaEvent): Promise<void> {
    const enqueuePromises: Promise<unknown>[] = [];

    for (const [key, entry] of this.subscribers) {
      const matches = entry.isPattern
        ? topicMatchesPattern(event.topic, entry.topic)
        : event.topic === entry.topic;

      if (!matches) continue;

      const deliveryQueue = this.deliveryQueues.get(key);
      if (!deliveryQueue) continue;

      enqueuePromises.push(
        deliveryQueue.add(
          `deliver:${event.id}:${key}`,
          event,
          { jobId: `deliver:${event.id}:${key}` },
        ),
      );
    }

    await Promise.all(enqueuePromises);
  }
}
