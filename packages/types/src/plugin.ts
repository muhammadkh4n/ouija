import type { FastifyInstance } from 'fastify';

// ---- JSON Schema type (used in PluginManifest) ----

export type JSONSchema = Record<string, unknown>;

// ---- Minimal logger interface (structural — no concrete dependency) ----

export interface PluginLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---- Plugin health ----

export interface PluginHealth {
  healthy: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

// ---- Plugin manifest ----

export interface PluginManifest {
  /** e.g. "@ouija/plugin-plane" */
  name: string;
  /** semver */
  version: string;
  type: 'kanban' | 'git' | 'agent' | 'notification';
  /** e.g. ">=1.0 <2.0" — checked at startup */
  coreApiVersion: string;
  /** Validated by Ajv before init() */
  configSchema: JSONSchema;
  /** Other plugin names — used for topological sort */
  dependencies?: string[];
  events?: {
    produces: string[];
    consumes: string[];
  };
}

// ---- Plugin context (injected at init — NO database connection) ----
// Plugins communicate through the bus, never directly with the database.

export interface PluginContext<TConfig = unknown> {
  /** The validated, typed config for this plugin */
  config: TConfig;
  /** Structured logger scoped to this plugin */
  logger: PluginLogger;
  /**
   * Publish an event onto the event bus.
   * Typed loosely here — the bus package owns the full EventBus interface.
   */
  publishEvent(topic: string, payload: unknown): Promise<void>;
  /**
   * Enqueue a job onto the job queue.
   * Typed loosely here — the bus package owns the full JobQueue interface.
   */
  enqueueJob(queue: string, job: unknown, options?: { delay?: number; attempts?: number }): Promise<void>;
}

// ---- Base plugin interface ----

export interface BasePlugin<TConfig = unknown> {
  manifest: PluginManifest;
  init(context: PluginContext<TConfig>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<PluginHealth>;
  /** Optional: register HTTP routes on the Fastify server */
  registerRoutes?(server: FastifyInstance): Promise<void>;
}
