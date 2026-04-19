/**
 * Postgres repository implementations for the Ouija pipeline engine.
 *
 * Rules:
 * - Parameterized queries ONLY. Never string-concatenate user input into SQL.
 * - State (PipelineState) is stored as JSONB and deserialized on read.
 * - Application layer maintains updated_at — no DB triggers.
 * - pipeline_events is append-only; the application never issues UPDATE/DELETE against it.
 * - All public methods work with the branded ID types from @ouija-dev/types.
 */

import { Pool, PoolClient } from 'pg';
import type {
  PipelineRepository,
  PipelineEventRepository,
  BoardConfigRepository,
  DeduplicationRepository,
  AgentRepository,
  AgentRecord,
  PrInstanceRepository,
  UnitOfWork,
  Database,
  CursorPage,
  PipelineEventRecord,
} from '@ouija-dev/types';
import type {
  PipelineInstance,
  PipelineConfig,
  PipelineState,
} from '@ouija-dev/types';
import type { CardId, InstanceId, BoardId } from '@ouija-dev/types';
import {
  instanceId as makeInstanceId,
  cardId as makeCardId,
  boardId as makeBoardId,
} from '@ouija-dev/types';

// ---- Cursor helpers ----

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const raw = Buffer.from(cursor, 'base64').toString('utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['createdAt'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['id'] !== 'string'
  ) {
    throw new Error('Invalid pagination cursor');
  }
  return parsed as { createdAt: string; id: string };
}

// ---- Row → Domain mappers ----

interface PipelineInstanceRow {
  id: string;
  card_id: string;
  board_id: string;
  project_id: string;
  state: PipelineState;
  attempt: number;
  assigned_agent_id: string | null;
  pr_url: string | null;
  cost: string | null;
  tokens_used: number | null;
  created_at: Date;
  updated_at: Date;
}

// Extract scalar fields (prUrl, cost, tokensUsed) from the state JSONB so the scalar DB columns
// always mirror state — eliminating the dual-source-of-truth bug where a running pipeline had
// state.prUrl but pipeline_instances.pr_url stayed NULL. State is the only writer; columns are a
// denormalised projection for SQL tooling.
function scalarsFromState(state: PipelineState): {
  prUrl: string | null;
  cost: number | null;
  tokensUsed: number | null;
} {
  const s = state as Partial<{ prUrl: string; cost: number; tokensUsed: number }>;
  return {
    prUrl: s.prUrl ?? null,
    cost: s.cost ?? null,
    tokensUsed: s.tokensUsed ?? null,
  };
}

function rowToInstance(row: PipelineInstanceRow): PipelineInstance {
  const base: PipelineInstance = {
    id: makeInstanceId(row.id),
    cardId: makeCardId(row.card_id),
    boardId: makeBoardId(row.board_id),
    projectId: row.project_id,
    state: row.state,
    attempt: row.attempt,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  // Scalar fields (prUrl, cost, tokensUsed) are derived from state JSONB rather than read from
  // the scalar columns — guarantees reads match writes without depending on DB-level sync.
  if (row.assigned_agent_id !== null) base.assignedAgentId = row.assigned_agent_id;
  const scalars = scalarsFromState(row.state);
  if (scalars.prUrl !== null) base.prUrl = scalars.prUrl;
  if (scalars.cost !== null) base.cost = scalars.cost;
  if (scalars.tokensUsed !== null) base.tokensUsed = scalars.tokensUsed;
  return base;
}

interface PipelineEventRow {
  id: string;
  instance_id: string;
  topic: string;
  payload: unknown;
  occurred_at: Date;
  sequence_number: number;
}

function rowToEventRecord(row: PipelineEventRow): PipelineEventRecord {
  // topic is a free-text column; validated at write time so cast is safe here
  return {
    id: row.id,
    instanceId: makeInstanceId(row.instance_id),
    topic: row.topic as PipelineEventRecord['topic'],
    payload: row.payload as PipelineEventRecord['payload'],
    occurredAt: row.occurred_at.toISOString(),
    sequence: row.sequence_number,
  };
}

// ---- PostgresPipelineRepository ----

export class PostgresPipelineRepository implements PipelineRepository {
  constructor(private readonly client: Pool | PoolClient) {}

  async findById(id: InstanceId): Promise<PipelineInstance | undefined> {
    const result = await this.client.query<PipelineInstanceRow>(
      `SELECT id, card_id, board_id, project_id, state, attempt,
              assigned_agent_id, pr_url, cost, tokens_used, created_at, updated_at
         FROM pipeline_instances
        WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row !== undefined ? rowToInstance(row) : undefined;
  }

  async findByCardId(cardId: CardId): Promise<PipelineInstance | undefined> {
    const result = await this.client.query<PipelineInstanceRow>(
      `SELECT pi.id, pi.card_id, pi.board_id, pi.project_id, pi.state, pi.attempt,
              pi.assigned_agent_id, pi.pr_url, pi.cost, pi.tokens_used, pi.created_at, pi.updated_at
         FROM pipeline_instances pi
         JOIN card_instance_index cii ON cii.instance_id = pi.id
        WHERE cii.card_id = $1`,
      [cardId],
    );
    const row = result.rows[0];
    return row !== undefined ? rowToInstance(row) : undefined;
  }

  async listByBoard(
    boardId: BoardId,
    cursor?: string,
    limit = 25,
  ): Promise<CursorPage<PipelineInstance>> {
    const pageSize = Math.min(limit, 100);

    let rows: PipelineInstanceRow[];

    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor);
      const result = await this.client.query<PipelineInstanceRow>(
        `SELECT id, card_id, board_id, project_id, state, attempt,
                pr_url, cost, tokens_used, created_at, updated_at
           FROM pipeline_instances
          WHERE board_id = $1
            AND (created_at, id) < ($2::timestamptz, $3)
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [boardId, decoded.createdAt, decoded.id, pageSize + 1],
      );
      rows = result.rows;
    } else {
      const result = await this.client.query<PipelineInstanceRow>(
        `SELECT id, card_id, board_id, project_id, state, attempt,
                pr_url, cost, tokens_used, created_at, updated_at
           FROM pipeline_instances
          WHERE board_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        [boardId, pageSize + 1],
      );
      rows = result.rows;
    }

    const hasMore = rows.length > pageSize;
    const items = rows.slice(0, pageSize).map(rowToInstance);

    // exactOptionalPropertyTypes: only include nextCursor key when a value exists
    if (hasMore) {
      const last = items[items.length - 1];
      if (last !== undefined) {
        return { items, nextCursor: encodeCursor(last.createdAt, last.id) };
      }
    }

    return { items };
  }

  async save(instance: PipelineInstance): Promise<void> {
    const status = instance.state.status;
    // Scalar columns derived from state — never from instance.prUrl/cost/tokensUsed. This
    // collapses dual-source-of-truth: state JSONB is the only writer.
    const scalars = scalarsFromState(instance.state);
    await this.client.query(
      `INSERT INTO pipeline_instances
             (id, card_id, board_id, project_id, state, status, attempt,
              assigned_agent_id, pr_url, cost, tokens_used, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11,
               $12::timestamptz, $13::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         state             = EXCLUDED.state,
         status            = EXCLUDED.status,
         attempt           = EXCLUDED.attempt,
         assigned_agent_id = EXCLUDED.assigned_agent_id,
         pr_url            = EXCLUDED.pr_url,
         cost              = EXCLUDED.cost,
         tokens_used       = EXCLUDED.tokens_used,
         updated_at        = EXCLUDED.updated_at`,
      [
        instance.id,
        instance.cardId,
        instance.boardId,
        instance.projectId,
        JSON.stringify(instance.state),
        status,
        instance.attempt,
        instance.assignedAgentId ?? null,
        scalars.prUrl,
        scalars.cost,
        scalars.tokensUsed,
        instance.createdAt,
        instance.updatedAt,
      ],
    );

    // Maintain O(1) card → instance index
    await this.client.query(
      `INSERT INTO card_instance_index (card_id, instance_id)
       VALUES ($1, $2)
       ON CONFLICT (card_id) DO UPDATE SET instance_id = EXCLUDED.instance_id`,
      [instance.cardId, instance.id],
    );
  }

  async delete(id: InstanceId): Promise<void> {
    // card_instance_index row cascades on DELETE due to FK ON DELETE CASCADE
    await this.client.query(
      `DELETE FROM pipeline_instances WHERE id = $1`,
      [id],
    );
  }

  /**
   * Find instances that are stuck in dispatching/running state with a
   * last_heartbeat_at (embedded in state JSONB) older than the cutoff.
   * Used by the Layer-2 stall scanner.
   */
  async findStalledCandidates(cutoff: Date): Promise<PipelineInstance[]> {
    const result = await this.client.query<PipelineInstanceRow>(
      `SELECT id, card_id, board_id, project_id, state, attempt,
              assigned_agent_id, pr_url, cost, tokens_used, created_at, updated_at
         FROM pipeline_instances
        WHERE status IN ('dispatching', 'running')
          AND (
            -- dispatching: no heartbeat yet; use dispatched_at embedded in state
            (state->>'status' = 'dispatching'
              AND (state->>'dispatchedAt')::timestamptz < $1)
            OR
            -- running: heartbeat exists; stalled if heartbeat is old
            (state->>'status' = 'running'
              AND (state->>'lastHeartbeatAt')::timestamptz < $1)
          )`,
      [cutoff.toISOString()],
    );
    return result.rows.map(rowToInstance);
  }
}

// ---- PostgresPipelineEventRepository ----

export class PostgresPipelineEventRepository implements PipelineEventRepository {
  constructor(private readonly client: Pool | PoolClient) {}

  async append(record: PipelineEventRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO pipeline_events
             (id, instance_id, topic, payload, occurred_at, sequence_number)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6)
       ON CONFLICT (instance_id, sequence_number) DO NOTHING`,
      [
        record.id,
        record.instanceId,
        record.topic,
        JSON.stringify(record.payload),
        record.occurredAt,
        record.sequence,
      ],
    );
  }

  async appendMany(records: PipelineEventRecord[]): Promise<void> {
    if (records.length === 0) return;

    // Build a single multi-row INSERT for efficiency
    const valuePlaceholders: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const record of records) {
      valuePlaceholders.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}::jsonb, $${paramIndex + 4}::timestamptz, $${paramIndex + 5})`,
      );
      params.push(
        record.id,
        record.instanceId,
        record.topic,
        JSON.stringify(record.payload),
        record.occurredAt,
        record.sequence,
      );
      paramIndex += 6;
    }

    await this.client.query(
      `INSERT INTO pipeline_events
             (id, instance_id, topic, payload, occurred_at, sequence_number)
       VALUES ${valuePlaceholders.join(', ')}
       ON CONFLICT (instance_id, sequence_number) DO NOTHING`,
      params,
    );
  }

  async listByInstance(instanceId: InstanceId): Promise<PipelineEventRecord[]> {
    const result = await this.client.query<PipelineEventRow>(
      `SELECT id, instance_id, topic, payload, occurred_at, sequence_number
         FROM pipeline_events
        WHERE instance_id = $1
        ORDER BY sequence_number ASC`,
      [instanceId],
    );
    return result.rows.map(rowToEventRecord);
  }
}

// ---- PostgresBoardConfigRepository ----

interface BoardConfigRow {
  board_id: string;
  project_id: string;
  config_json: PipelineConfig;
  created_at: Date;
  updated_at: Date;
}

export class PostgresBoardConfigRepository implements BoardConfigRepository {
  constructor(private readonly client: Pool | PoolClient) {}

  async findByBoardId(boardId: BoardId): Promise<PipelineConfig | undefined> {
    const result = await this.client.query<BoardConfigRow>(
      `SELECT board_id, project_id, config_json, created_at, updated_at
         FROM board_configs
        WHERE board_id = $1`,
      [boardId],
    );
    const row = result.rows[0];
    return row !== undefined ? row.config_json : undefined;
  }

  async listAll(): Promise<PipelineConfig[]> {
    const result = await this.client.query<BoardConfigRow>(
      `SELECT board_id, project_id, config_json, created_at, updated_at
         FROM board_configs
        ORDER BY updated_at DESC`,
    );
    return result.rows.map((row) => row.config_json);
  }

  async save(config: PipelineConfig): Promise<void> {
    const now = new Date().toISOString();
    await this.client.query(
      `INSERT INTO board_configs (board_id, project_id, config_json, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz, $4::timestamptz)
       ON CONFLICT (board_id) DO UPDATE SET
         project_id  = EXCLUDED.project_id,
         config_json = EXCLUDED.config_json,
         updated_at  = EXCLUDED.updated_at`,
      [config.boardId, config.boardId, JSON.stringify(config), now],
    );
  }

  async delete(boardId: BoardId): Promise<void> {
    await this.client.query(
      `DELETE FROM board_configs WHERE board_id = $1`,
      [boardId],
    );
  }
}

// ---- PostgresDeduplicationRepository ----

const DEFAULT_DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class PostgresDeduplicationRepository implements DeduplicationRepository {
  constructor(private readonly client: Pool | PoolClient) {}

  async isDuplicate(externalEventId: string): Promise<boolean> {
    const result = await this.client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM webhook_dedup
          WHERE external_event_id = $1
            AND expires_at > now()
       ) AS exists`,
      [externalEventId],
    );
    return result.rows[0]?.exists ?? false;
  }

  async markProcessed(
    externalEventId: string,
    ttlMs: number = DEFAULT_DEDUP_TTL_MS,
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    await this.client.query(
      `INSERT INTO webhook_dedup (external_event_id, processed_at, expires_at)
       VALUES ($1, $2::timestamptz, $3::timestamptz)
       ON CONFLICT (external_event_id) DO UPDATE SET
         processed_at = EXCLUDED.processed_at,
         expires_at   = EXCLUDED.expires_at`,
      [externalEventId, now.toISOString(), expiresAt.toISOString()],
    );
  }

  async purgeExpired(): Promise<number> {
    const result = await this.client.query<never>(
      `DELETE FROM webhook_dedup WHERE expires_at < now()`,
    );
    return result.rowCount ?? 0;
  }
}

// ---- PostgresAgentRepository ----

interface AgentRow {
  id: string;
  config_json: Record<string, unknown>;
  secrets_vault: AgentRecord['secretsVault'];
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    config: row.config_json,
    secretsVault: row.secrets_vault,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly client: Pool | PoolClient) {}

  async findById(id: string): Promise<AgentRecord | undefined> {
    const result = await this.client.query<AgentRow>(
      `SELECT id, config_json, secrets_vault, active, created_at, updated_at
         FROM agents WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row !== undefined ? rowToAgent(row) : undefined;
  }

  async listAll(activeOnly = true): Promise<AgentRecord[]> {
    const result = activeOnly
      ? await this.client.query<AgentRow>(
          `SELECT id, config_json, secrets_vault, active, created_at, updated_at
             FROM agents WHERE active = true
             ORDER BY created_at ASC`,
        )
      : await this.client.query<AgentRow>(
          `SELECT id, config_json, secrets_vault, active, created_at, updated_at
             FROM agents
             ORDER BY created_at ASC`,
        );
    return result.rows.map(rowToAgent);
  }

  async save(record: AgentRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO agents (id, config_json, secrets_vault, active, created_at, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, $5::timestamptz, $6::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         config_json   = EXCLUDED.config_json,
         secrets_vault = EXCLUDED.secrets_vault,
         active        = EXCLUDED.active,
         updated_at    = EXCLUDED.updated_at`,
      [
        record.id,
        JSON.stringify(record.config),
        record.secretsVault !== null ? JSON.stringify(record.secretsVault) : null,
        record.active,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async softDelete(id: string): Promise<void> {
    await this.client.query(
      `UPDATE agents SET active = false, updated_at = now() WHERE id = $1`,
      [id],
    );
  }
}

// ---- PostgresPrInstanceRepository ----

export class PostgresPrInstanceRepository implements PrInstanceRepository {
  constructor(private readonly client: Pool | PoolClient) {}

  async record(prUrl: string, instanceId: string): Promise<void> {
    await this.client.query(
      `INSERT INTO pr_instance_index (pr_url, instance_id)
       VALUES ($1, $2)
       ON CONFLICT (pr_url) DO UPDATE SET instance_id = EXCLUDED.instance_id`,
      [prUrl, instanceId],
    );
  }

  async findInstanceByPrUrl(prUrl: string): Promise<string | undefined> {
    const result = await this.client.query<{ instance_id: string }>(
      `SELECT instance_id FROM pr_instance_index WHERE pr_url = $1`,
      [prUrl],
    );
    return result.rows[0]?.instance_id;
  }
}

// ---- Transactional UnitOfWork ----

class TransactionalUnitOfWork implements UnitOfWork {
  readonly pipelines: PostgresPipelineRepository;
  readonly pipelineEvents: PostgresPipelineEventRepository;
  readonly boardConfigs: PostgresBoardConfigRepository;
  readonly agents: PostgresAgentRepository;
  readonly prInstances: PostgresPrInstanceRepository;

  constructor(client: PoolClient) {
    this.pipelines = new PostgresPipelineRepository(client);
    this.pipelineEvents = new PostgresPipelineEventRepository(client);
    this.boardConfigs = new PostgresBoardConfigRepository(client);
    this.agents = new PostgresAgentRepository(client);
    this.prInstances = new PostgresPrInstanceRepository(client);
  }
}

// ---- PostgresDatabase ----

export class PostgresDatabase implements Database {
  readonly pipelines: PostgresPipelineRepository;
  readonly pipelineEvents: PostgresPipelineEventRepository;
  readonly boardConfigs: PostgresBoardConfigRepository;
  readonly deduplication: PostgresDeduplicationRepository;
  readonly agents: PostgresAgentRepository;
  readonly prInstances: PostgresPrInstanceRepository;

  constructor(private readonly pool: Pool) {
    this.pipelines = new PostgresPipelineRepository(pool);
    this.pipelineEvents = new PostgresPipelineEventRepository(pool);
    this.boardConfigs = new PostgresBoardConfigRepository(pool);
    this.deduplication = new PostgresDeduplicationRepository(pool);
    this.agents = new PostgresAgentRepository(pool);
    this.prInstances = new PostgresPrInstanceRepository(pool);
  }

  async transaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const uow = new TransactionalUnitOfWork(client);
      const result = await fn(uow);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}

// ---- Factory ----

/**
 * Create a PostgresDatabase from a connection string.
 * Call pool.end() on shutdown to drain connections.
 */
export function createDatabase(connectionString: string): {
  db: PostgresDatabase;
  pool: Pool;
} {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  const db = new PostgresDatabase(pool);
  return { db, pool };
}
