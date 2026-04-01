/**
 * AgentDispatchWorker — consumes agentDispatch jobs from BullMQ and dispatches
 * them to the configured AgentPlugin.
 *
 * Job lifecycle:
 *   1. BullMQ dequeues an AgentDispatchJobData job.
 *   2. Worker assembles the full WorkOrder (DB lookups + JWT issuance).
 *   3. Worker calls agentPlugin.dispatch(workOrder) — returns a DispatchId.
 *   4. The plugin takes over: it runs the agent, sends heartbeats back to the
 *      server via the callbackUrl, and eventually reports success or failure.
 *
 * The worker's BullMQ job is considered complete once dispatch() returns.
 * The plugin owns the agent's entire lifecycle from that point on.
 *
 * Per architecture decision: no separate worker-level timeout is added on top
 * of the plugin's internal timeout. The plugin (ClaudeAgentPlugin) handles
 * SIGTERM/SIGKILL on the subprocess. The dead-man's switch (StallMonitor) in
 * the engine catches any cases where the plugin dies silently.
 */

import type { AgentPlugin } from '@ouija/types';
import type { JobQueue, AgentDispatchJobData } from '@ouija/bus';
import { QUEUE_NAMES } from '@ouija/bus';
import type { AssemblerDeps } from './work-order-assembler.js';
import { assembleWorkOrder } from './work-order-assembler.js';

// ---- Logger interface ----

export interface WorkerLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---- Options ----

export interface AgentWorkerOptions {
  jobQueue: JobQueue;
  agentPlugin: AgentPlugin;
  assemblerDeps: AssemblerDeps;
  logger?: WorkerLogger;
  /** Number of concurrent agent dispatches processed by this worker. Default: 1. */
  concurrency?: number;
}

// ---- AgentDispatchWorker ----

export class AgentDispatchWorker {
  private readonly jobQueue: JobQueue;
  private readonly agentPlugin: AgentPlugin;
  private readonly assemblerDeps: AssemblerDeps;
  private readonly logger: WorkerLogger;
  private readonly concurrency: number;
  private started = false;

  constructor(options: AgentWorkerOptions) {
    this.jobQueue = options.jobQueue;
    this.agentPlugin = options.agentPlugin;
    this.assemblerDeps = options.assemblerDeps;
    this.logger = options.logger ?? noopLogger;
    this.concurrency = options.concurrency ?? 1;
  }

  /**
   * Start consuming agentDispatch jobs from the queue.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async start(): Promise<void> {
    if (this.started) return;

    await this.jobQueue.process(
      QUEUE_NAMES.agentDispatch,
      async (data: AgentDispatchJobData, jobId: string) => {
        await this._handleJob(data, jobId);
      },
      this.concurrency,
    );

    this.started = true;
    this.logger.info('Agent dispatch worker started', { concurrency: this.concurrency });
  }

  /**
   * Stop the worker. In-flight jobs are allowed to complete; BullMQ drains
   * on jobQueue.close() which is called by the shutdown handler.
   */
  async stop(): Promise<void> {
    this.started = false;
    this.logger.info('Agent dispatch worker stopped');
  }

  // ---- Internal job handler ----

  private async _handleJob(
    data: AgentDispatchJobData,
    jobId: string,
  ): Promise<void> {
    this.logger.info('Processing agent dispatch job', {
      jobId,
      instanceId: data.instanceId,
      dispatchId: data.dispatchId,
      agentId: data.agentId,
      cardId: data.cardId,
    });

    try {
      // 1. Assemble the full WorkOrder from the minimal job data.
      const workOrder = await assembleWorkOrder(data, this.assemblerDeps);

      // 2. Hand off to the agent plugin. dispatch() returns immediately with a
      //    DispatchId — the plugin runs the agent asynchronously and reports
      //    back via the callbackUrl in the WorkOrder.
      const dispatchId = await this.agentPlugin.dispatch(workOrder);

      this.logger.info('Agent dispatched successfully', {
        jobId,
        instanceId: data.instanceId,
        dispatchId: String(dispatchId),
        agentId: data.agentId,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('Agent dispatch job failed', {
        jobId,
        instanceId: data.instanceId,
        dispatchId: data.dispatchId,
        error: errorMsg,
      });
      // Re-throw so BullMQ marks the job as failed and applies the retry policy.
      throw err;
    }
  }
}
