-- Migration 008: state_entered_at on pipeline_instances
--
-- Anchors the Phase-2 dwell reconciler. Whenever an instance transitions to
-- a new status, `Orchestrator.applyTrigger` stamps `state_entered_at = now()`
-- alongside the JSONB state write. The reconciler then queries
-- `findOverbudgetCandidates(status, cutoff)` to find rows that have spent
-- longer than their per-state dwell budget (see engine/src/dwell-budgets.ts):
--
--   dispatching     →  60s
--   provisioning    → 120s
--   running         → instance.maxDurationMs (per board config)
--   awaiting_review →  14d
--
-- Backfill rule for existing rows: pick the most recent
-- `pipeline_events.occurred_at` row where `topic = 'pipeline.transitioned'`
-- for that instance, falling back to `pipeline_instances.created_at` when no
-- transition history exists. This guarantees the column is NOT NULL after
-- migration without inventing a fake "entered now" timestamp that would mask
-- already-overdue instances on the very first reconciler tick post-deploy.
--
-- Index is on (status, state_entered_at) so the reconciler scan filters
-- both columns at once — a partial index per live status was considered but
-- ruled out: the reconciler enumerates every status in the budget table on
-- each tick, and a single composite index serves all those queries.

ALTER TABLE pipeline_instances
  ADD COLUMN IF NOT EXISTS state_entered_at TIMESTAMPTZ;

UPDATE pipeline_instances pi
   SET state_entered_at = COALESCE(
         (SELECT MAX(pe.occurred_at)
            FROM pipeline_events pe
           WHERE pe.instance_id = pi.id
             AND pe.topic = 'pipeline.transitioned'),
         pi.created_at)
 WHERE pi.state_entered_at IS NULL;

ALTER TABLE pipeline_instances
  ALTER COLUMN state_entered_at SET NOT NULL,
  ALTER COLUMN state_entered_at SET DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_pipeline_instances_status_entered
  ON pipeline_instances (status, state_entered_at);
