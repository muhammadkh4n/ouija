// EventBus interface + types
export type {
  EventBus,
  EventHandler,
  PatternEventHandler,
  PublishOptions,
  Unsubscribe,
} from './event-bus.js';

// JobQueue interface + types
export type {
  JobQueue,
  JobHandler,
  QueueName,
  QueueDataMap,
  EnqueueOptions,
  AgentDispatchJobData,
  StallCheckJobData,
  EventBusJobData,
} from './job-queue.js';
export { QUEUE_NAMES } from './job-queue.js';

// BullMQ implementations
export { BullMQEventBus } from './bullmq-event-bus.js';
export { BullMQJobQueue } from './bullmq-job-queue.js';
