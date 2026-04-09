import type { PluginContext, PluginLogger } from '@ouija-dev/types';

// ---- Mock logger ----

export interface RecordedLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  meta?: Record<string, unknown>;
}

export interface MockLogger extends PluginLogger {
  /** All recorded log calls in insertion order. */
  entries: RecordedLogEntry[];
  /** Convenience: only entries at a given level. */
  entriesAt(level: RecordedLogEntry['level']): RecordedLogEntry[];
}

export function createMockLogger(): MockLogger {
  const entries: RecordedLogEntry[] = [];

  function log(level: RecordedLogEntry['level'], msg: string, meta?: Record<string, unknown>): void {
    entries.push({ level, msg, ...(meta !== undefined ? { meta } : {}) });
  }

  const logger: MockLogger = {
    entries,
    entriesAt(level) {
      return entries.filter((e) => e.level === level);
    },
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
  };

  return logger;
}

// ---- Mock context ----

export interface MockContext<TConfig> extends PluginContext<TConfig> {
  logger: MockLogger;
  /** All events published via publishEvent(), in insertion order. */
  publishedEvents: Array<{ topic: string; payload: unknown }>;
  /** All jobs enqueued via enqueueJob(), in insertion order. */
  enqueuedJobs: Array<{ queue: string; job: unknown; options?: { delay?: number; attempts?: number } }>;
}

export function createMockContext<TConfig>(config: TConfig): MockContext<TConfig> {
  const logger = createMockLogger();
  const publishedEvents: Array<{ topic: string; payload: unknown }> = [];
  const enqueuedJobs: Array<{ queue: string; job: unknown; options?: { delay?: number; attempts?: number } }> = [];

  return {
    config,
    logger,
    publishedEvents,
    enqueuedJobs,
    publishEvent: async (topic: string, payload: unknown): Promise<void> => {
      publishedEvents.push({ topic, payload });
    },
    enqueueJob: async (
      queue: string,
      job: unknown,
      options?: { delay?: number; attempts?: number },
    ): Promise<void> => {
      enqueuedJobs.push({ queue, job, ...(options !== undefined ? { options } : {}) });
    },
  };
}
