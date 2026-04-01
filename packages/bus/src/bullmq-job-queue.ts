import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type {
  EnqueueOptions,
  JobHandler,
  JobQueue,
  QueueDataMap,
  QueueName,
} from './job-queue.js';

/**
 * BullMQ-backed JobQueue implementation.
 *
 * One BullMQ Queue per queue name. Workers are created lazily on the first
 * `process()` call for a given queue name.
 *
 * Assumptions:
 *  - Redis is configured with `maxmemory-policy noeviction`.
 *  - All queue names are treated as static. Dynamic queue creation at runtime
 *    is not supported in v1.
 */
export class BullMQJobQueue implements JobQueue {
  private readonly connection: ConnectionOptions;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Map<QueueName, Worker>();
  private closed = false;

  constructor(connection: ConnectionOptions) {
    this.connection = connection;
  }

  // -------------------------------------------------------------------------
  // enqueue
  // -------------------------------------------------------------------------

  async enqueue<TQueue extends QueueName>(
    queue: TQueue,
    data: QueueDataMap[TQueue],
    options: EnqueueOptions = {},
  ): Promise<string> {
    if (this.closed) throw new Error('BullMQJobQueue is closed');

    const q = this.getOrCreateQueue(queue);

    // Build options conditionally to satisfy exactOptionalPropertyTypes:
    // never assign `undefined` to an optional property.
    const jobOptions: Record<string, unknown> = {
      attempts: options.attempts ?? 3,
      backoff: options.backoff
        ? { type: options.backoff.type, delay: options.backoff.delay }
        : { type: 'exponential', delay: 1000 },
      priority: options.priority ?? 0,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 500 },
    };
    if (options.jobId !== undefined) jobOptions['jobId'] = options.jobId;
    if (options.delayMs !== undefined) jobOptions['delay'] = options.delayMs;

    const job = await q.add(queue, data, jobOptions as Parameters<typeof q.add>[2]);

    if (!job.id) {
      throw new Error(`BullMQ did not assign an ID to job on queue "${queue}"`);
    }

    return job.id;
  }

  // -------------------------------------------------------------------------
  // process
  // -------------------------------------------------------------------------

  async process<TQueue extends QueueName>(
    queue: TQueue,
    handler: JobHandler<QueueDataMap[TQueue]>,
    concurrency = 1,
  ): Promise<void> {
    if (this.closed) throw new Error('BullMQJobQueue is closed');

    // Close any existing worker for this queue before replacing the handler
    const existing = this.workers.get(queue);
    if (existing) {
      await existing.close();
      this.workers.delete(queue);
    }

    // Ensure the queue exists
    this.getOrCreateQueue(queue);

    const worker = new Worker<QueueDataMap[TQueue]>(
      queue,
      async (job) => {
        const jobId = job.id ?? 'unknown';
        await handler(job.data, jobId);
      },
      {
        connection: this.connection,
        concurrency,
      },
    );

    worker.on('failed', (job, err) => {
      console.error(
        `[BullMQJobQueue] job ${job?.id ?? 'unknown'} on queue "${queue}" failed:`,
        err,
      );
    });

    this.workers.set(queue, worker as unknown as Worker);
  }

  // -------------------------------------------------------------------------
  // cancelJob
  // -------------------------------------------------------------------------

  async cancelJob(queue: QueueName, jobId: string): Promise<void> {
    if (this.closed) return;

    const q = this.queues.get(queue);
    if (!q) return;

    const job = await q.getJob(jobId);
    if (!job) return;

    // Remove the job regardless of its state (waiting, delayed, etc.)
    // For active jobs, this will fail silently — a running job cannot be
    // force-removed; the worker must complete or fail it naturally.
    try {
      await job.remove();
    } catch {
      // Job may already be processing — log and move on
      console.warn(
        `[BullMQJobQueue] could not cancel job "${jobId}" on queue "${queue}" — it may be active`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const closePromises: Promise<void>[] = [];

    for (const worker of this.workers.values()) {
      closePromises.push(worker.close());
    }
    for (const queue of this.queues.values()) {
      closePromises.push(queue.close());
    }

    await Promise.all(closePromises);

    this.workers.clear();
    this.queues.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getOrCreateQueue(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;

    const queue = new Queue(name, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
      },
    });

    this.queues.set(name, queue);
    return queue;
  }
}
