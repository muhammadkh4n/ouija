-- Migration 001: Initial schema
-- All timestamps use timestamptz (time-zone aware).
-- State columns use JSONB (PipelineState discriminated union serializes naturally).
-- NO updated_at triggers — application layer maintains updated_at directly.
-- pipeline_events is append-only; enforced by application layer (no UPDATE trigger needed).

-- ---- pipeline_instances ----
-- One row per active pipeline run. State is the full PipelineState JSONB blob.
-- status column is denormalised from state->>'status' for efficient indexed queries.

CREATE TABLE IF NOT EXISTS pipeline_instances (
  id           TEXT        NOT NULL,
  card_id      TEXT        NOT NULL,
  board_id     TEXT        NOT NULL,
  project_id   TEXT        NOT NULL,
  state        JSONB       NOT NULL,
  status       TEXT        NOT NULL
    CHECK (status IN ('idle','dispatching','running','succeeded','failed','stalled','cancelled')),
  attempt      INTEGER     NOT NULL DEFAULT 1,
  pr_url       TEXT,
  cost         NUMERIC(12, 6),
  tokens_used  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pipeline_instances_pkey PRIMARY KEY (id)
);

-- Efficient lookup by status (stall scanner, dashboard filters)
CREATE INDEX IF NOT EXISTS idx_pipeline_instances_status
  ON pipeline_instances (status);

-- Efficient listing of all pipelines for a given board
CREATE INDEX IF NOT EXISTS idx_pipeline_instances_board_id
  ON pipeline_instances (board_id);

-- Supports cursor pagination ordered by created_at DESC
CREATE INDEX IF NOT EXISTS idx_pipeline_instances_board_created
  ON pipeline_instances (board_id, created_at DESC);

-- ---- card_instance_index ----
-- O(1) lookup: card_id → current instance_id.
-- One row per card; upserted whenever a new pipeline instance is created for that card.

CREATE TABLE IF NOT EXISTS card_instance_index (
  card_id     TEXT NOT NULL,
  instance_id TEXT NOT NULL,

  CONSTRAINT card_instance_index_pkey PRIMARY KEY (card_id),
  CONSTRAINT card_instance_index_instance_fk
    FOREIGN KEY (instance_id) REFERENCES pipeline_instances (id) ON DELETE CASCADE
);

-- Reverse lookup: instance_id → card_id (used during instance load)
CREATE UNIQUE INDEX IF NOT EXISTS idx_card_instance_index_instance_id
  ON card_instance_index (instance_id);

-- ---- pipeline_events ----
-- Append-only timeline. No UPDATE or DELETE is ever issued by the application.
-- sequence_number is monotonically increasing per instance and is assigned by the
-- application (not a DB sequence) so that the caller controls idempotency keys.

CREATE TABLE IF NOT EXISTS pipeline_events (
  id              TEXT        NOT NULL,
  instance_id     TEXT        NOT NULL,
  topic           TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sequence_number INTEGER     NOT NULL,

  CONSTRAINT pipeline_events_pkey PRIMARY KEY (id),
  CONSTRAINT pipeline_events_instance_fk
    FOREIGN KEY (instance_id) REFERENCES pipeline_instances (id) ON DELETE CASCADE,

  -- Idempotency: prevent duplicate events from being appended
  CONSTRAINT pipeline_events_instance_seq_unique
    UNIQUE (instance_id, sequence_number)
);

-- Primary access pattern: fetch ordered timeline for a single instance
CREATE INDEX IF NOT EXISTS idx_pipeline_events_instance_seq
  ON pipeline_events (instance_id, sequence_number ASC);

-- ---- stall_check_jobs ----
-- Mirrors BullMQ delayed stall-check jobs for crash-recovery Layer 2.
-- PK is (instance_id, attempt) — one active job per attempt.

CREATE TABLE IF NOT EXISTS stall_check_jobs (
  instance_id   TEXT        NOT NULL,
  attempt       INTEGER     NOT NULL,
  bullmq_job_id TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT stall_check_jobs_pkey PRIMARY KEY (instance_id, attempt),
  CONSTRAINT stall_check_jobs_instance_fk
    FOREIGN KEY (instance_id) REFERENCES pipeline_instances (id) ON DELETE CASCADE
);

-- ---- board_configs ----
-- One config row per board. config_json holds the full PipelineConfig JSONB blob.

CREATE TABLE IF NOT EXISTS board_configs (
  board_id    TEXT        NOT NULL,
  project_id  TEXT        NOT NULL,
  config_json JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT board_configs_pkey PRIMARY KEY (board_id)
);

-- ---- webhook_dedup ----
-- Deduplication table for incoming webhook events.
-- 7-day TTL: records with expires_at < now() are stale and can be purged.
-- The TTL index supports the background purge query efficiently.

CREATE TABLE IF NOT EXISTS webhook_dedup (
  external_event_id TEXT        NOT NULL,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,

  CONSTRAINT webhook_dedup_pkey PRIMARY KEY (external_event_id)
);

-- TTL cleanup index: background job runs DELETE WHERE expires_at < now()
CREATE INDEX IF NOT EXISTS idx_webhook_dedup_expires_at
  ON webhook_dedup (expires_at);
