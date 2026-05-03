import type { CardId, InstanceId, BoardId } from './ids.js';
import type { PipelineInstance, PipelineConfig, PipelineStatus } from './state-machine.js';
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

  /**
   * Find instances currently in `status` whose `state_entered_at` predates
   * `cutoff`, capped at `limit` rows. Used by the Phase-2 dwell reconciler
   * (`DwellReconciler`) to enforce per-state dwell budgets — different from
   * `findStalledCandidates`, which is heartbeat-based and only covers the
   * dispatching/running/provisioning trio. The cap is the implementation's
   * safety belt: a runaway reconciler with thousands of overdue rows still
   * processes one bounded batch per tick.
   */
  findOverbudgetCandidates(
    status: PipelineStatus,
    cutoff: Date,
    limit: number,
  ): Promise<PipelineInstance[]>;
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

// ---- Agent record ----
// The `config` field holds the full AgentProfileConfig shape from @ouija-dev/config
// but is typed here as Record<string, unknown> to avoid a types→config dependency.
// Validation happens at the HTTP layer via ajv, not here.

export interface EncryptedVaultBlob {
  iv: string;
  tag: string;
  ciphertext: string;
  /** Field names present in the vault (inspectable without decrypting). */
  fields: string[];
}

export interface AgentRecord {
  id: string;
  config: Record<string, unknown>;
  secretsVault: EncryptedVaultBlob | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---- PR → instance mapping ----
// Written at agent_pr_ready time; read by the webhook path that normalises
// a review/comment webhook into a pipeline trigger.

export interface PrInstanceMapping {
  prUrl: string;
  instanceId: string;
  createdAt: string;
}

export interface PrInstanceRepository {
  /** Upsert — agent_pr_ready is idempotent, so late retries must not duplicate rows. */
  record(prUrl: string, instanceId: string): Promise<void>;
  findInstanceByPrUrl(prUrl: string): Promise<string | undefined>;
}

export interface AgentRepository {
  findById(id: string): Promise<AgentRecord | undefined>;
  /**
   * List agents. When activeOnly=true (the default) only rows with active=true
   * are returned — this is the dispatch-time lookup path. The dashboard's
   * "show all agents including deactivated" view passes activeOnly=false.
   */
  listAll(activeOnly?: boolean): Promise<AgentRecord[]>;
  save(record: AgentRecord): Promise<void>;
  /** Soft delete — sets active=false so pipeline history can still resolve the name. */
  softDelete(id: string): Promise<void>;
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
  agents?: AgentRepository;
  prInstances?: PrInstanceRepository;
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
  /**
   * Agent CRUD. Optional because in-process tests and older deployments may run
   * without the 003-agents migration applied — consumers that need it check for
   * presence and fall back to YAML-provided profiles when missing.
   */
  agents?: AgentRepository;
  /**
   * PR → instance index (migration 004). Optional for the same reason as
   * `agents`: deployments without the migration applied continue to run, the
   * review loop just stays dormant until the migration lands.
   */
  prInstances?: PrInstanceRepository;

  /** Liveness check — throws if DB is unreachable */
  ping(): Promise<void>;
}
