import type { OuijaEvent, OuijaTopic } from '@ouija/types';

// ---------------------------------------------------------------------------
// Queue names — single source of truth
// ---------------------------------------------------------------------------

export const QUEUE_NAMES = {
  agentDispatch: 'ouija.agent-dispatch',
  stallCheck: 'ouija.stall-check',
  eventBus: 'ouija.event-bus',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ---------------------------------------------------------------------------
// Job data types (implementation-specific — live here, not in @ouija/types)
// ---------------------------------------------------------------------------

export interface AgentDispatchJobData {
  instanceId: string;
  dispatchId: string;
  agentId: string;
  cardId: string;
  projectId: string;
  workOrderDescription: string;
  /** ISO timestamp of when this dispatch was requested */
  dispatchedAt: string;
}

export interface StallCheckJobData {
  instanceId: string;
  dispatchId: string;
  /** ISO timestamp the stall check should fire at (BullMQ delay handles this) */
  expectedBy: string;
}

/**
 * Internal job data used by BullMQEventBus to fan-out events to subscribers.
 * The subscriberKey uniquely identifies the registered handler.
 */
export interface EventBusJobData {
  event: OuijaEvent;
  subscriberKey: string;
}

// ---------------------------------------------------------------------------
// QueueDataMap — typed mapping from queue name → job data type
// ---------------------------------------------------------------------------

export interface QueueDataMap {
  [QUEUE_NAMES.agentDispatch]: AgentDispatchJobData;
  [QUEUE_NAMES.stallCheck]: StallCheckJobData;
  [QUEUE_NAMES.eventBus]: EventBusJobData;
}

// ---------------------------------------------------------------------------
// Enqueue options
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  /** BullMQ job ID. If provided, duplicate jobs with same ID are deduplicated. */
  jobId?: string;
  /** Delay in milliseconds before the job becomes active. */
  delayMs?: number;
  /** Number of retry attempts on failure. Defaults to 3. */
  attempts?: number;
  /** Backoff strategy for retries. */
  backoff?: {
    type: 'exponential' | 'fixed';
    delay: number;
  };
  /** Priority (lower number = higher priority). Defaults to 0. */
  priority?: number;
}

// ---------------------------------------------------------------------------
// Job handler types
// ---------------------------------------------------------------------------

export type JobHandler<TData> = (
  data: TData,
  jobId: string,
) => Promise<void>;

// ---------------------------------------------------------------------------
// JobQueue interface
// ---------------------------------------------------------------------------

/**
 * JobQueue — durable task dispatch interface.
 *
 * Design rules (Decision 2 in spec §2.4):
 *  - Separate from EventBus at the interface level.
 *  - Typed via QueueDataMap: `enqueue<TQueue>` ensures data matches queue.
 *  - One queue per concern (agentDispatch, stallCheck, eventBus).
 *  - BullMQ implementation uses noeviction Redis — jobs must never be evicted.
 */
export interface JobQueue {
  /**
   * Enqueue a job on the specified queue.
   * Returns the BullMQ job ID.
   */
  enqueue<TQueue extends QueueName>(
    queue: TQueue,
    data: QueueDataMap[TQueue],
    options?: EnqueueOptions,
  ): Promise<string>;

  /**
   * Register a processor for the specified queue.
   * Workers are created lazily on the first `process()` call per queue.
   * Calling process() twice on the same queue replaces the handler.
   */
  process<TQueue extends QueueName>(
    queue: TQueue,
    handler: JobHandler<QueueDataMap[TQueue]>,
    concurrency?: number,
  ): Promise<void>;

  /**
   * Remove a job by ID from the specified queue.
   * No-ops if the job does not exist or is already completed.
   */
  cancelJob(queue: QueueName, jobId: string): Promise<void>;

  /**
   * Gracefully shut down all workers, waiting for in-flight jobs to complete.
   */
  close(): Promise<void>;
}
