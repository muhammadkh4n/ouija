import type { CardId, InstanceId, BoardId } from './ids.js';
import type { PipelineInstance, PipelineConfig } from './state-machine.js';
import type { OuijaTopic, OuijaEventMap } from './events.js';

// ---- Pagination cursors ----

export interface CursorPage<T> {
  items: T[];
  /** Opaque base64-encoded cursor, undefined when no more pages */
  nextCursor?: string;
}

export interface OffsetPage<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

// ---- Pipeline event record (append-only timeline entry) ----

export interface PipelineEventRecord {
  id: string;
  instanceId: InstanceId;
  topic: OuijaTopic;
  payload: OuijaEventMap[OuijaTopic];
  occurredAt: string;
  /** Monotonically increasing per instance — used for idempotency keys */
  sequence: number;
}

// ---- Deduplication record ----

export interface DeduplicationRecord {
  externalEventId: string;
  processedAt: string;
  /** Unix timestamp in ms — records with ttlExpiresAt < now() are stale */
  ttlExpiresAt: number;
}

// ---- Repository interfaces (all async) ----

export interface PipelineRepository {
  /** Find an instance by its own ID */
  findById(id: InstanceId): Promise<PipelineInstance | undefined>;

  /** O(1) lookup — card_instance_index table */
  findByCardId(cardId: CardId): Promise<PipelineInstance | undefined>;

  /** List instances for a board, cursor-paginated */
  listByBoard(boardId: BoardId, cursor?: string, limit?: number): Promise<CursorPage<PipelineInstance>>;

  /** Insert or full-replace an instance row */
  save(instance: PipelineInstance): Promise<void>;

  /** Hard delete — only valid for cancelled/succeeded instances older than retention period */
  delete(id: InstanceId): Promise<void>;

  /**
   * Find instances in dispatching/running state whose last activity (dispatchedAt or
   * lastHeartbeatAt from the state JSONB) predates `cutoff`.
   * Used by the Layer-2 stall scanner (StallMonitor) for crash recovery.
   */
  findStalledCandidates(cutoff: Date): Promise<PipelineInstance[]>;
}

export interface PipelineEventRepository {
  /** Append a single event — never updates existing rows */
  append(record: PipelineEventRecord): Promise<void>;

  /** Append multiple events in one DB round-trip */
  appendMany(records: PipelineEventRecord[]): Promise<void>;

  /** Fetch ordered timeline for a single instance */
  listByInstance(instanceId: InstanceId): Promise<PipelineEventRecord[]>;
}

export interface BoardConfigRepository {
  findByBoardId(boardId: BoardId): Promise<PipelineConfig | undefined>;
  /** List all configured boards. Used by the dashboard to populate a board picker. */
  listAll(): Promise<PipelineConfig[]>;
  save(config: PipelineConfig): Promise<void>;
  delete(boardId: BoardId): Promise<void>;
}

export interface DeduplicationRepository {
  /** Returns true if the event has already been processed */
  isDuplicate(externalEventId: string): Promise<boolean>;

  /** Record that this event has been processed */
  markProcessed(externalEventId: string, ttlMs?: number): Promise<void>;

  /** Purge expired records (7-day TTL) — called by background job */
  purgeExpired(): Promise<number>;
}

// ---- Unit of Work (transactional boundary) ----

export interface UnitOfWork {
  pipelines: PipelineRepository;
  pipelineEvents: PipelineEventRepository;
  boardConfigs: BoardConfigRepository;
}

// ---- Database factory (produces read-only repos and transactional UoWs) ----

export interface Database {
  /** Start a transaction; callback receives a unit-of-work */
  transaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>;

  /** Read-only access outside transactions */
  pipelines: PipelineRepository;
  pipelineEvents: PipelineEventRepository;
  boardConfigs: BoardConfigRepository;
  deduplication: DeduplicationRepository;

  /** Liveness check — throws if DB is unreachable */
  ping(): Promise<void>;
}
