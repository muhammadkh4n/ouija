-- Migration 004: PR → pipeline instance index
--
-- Webhooks for PR reviews (CodeRabbit, Copilot, Claude review, human) carry
-- only the PR URL — no Ouija instance_id. This index lets the orchestrator
-- look up which pipeline owns a given PR in O(1) without scanning the
-- pipeline_instances.state JSONB for a matching prUrl.
--
-- Written at agent_pr_ready time via the `record_pr_mapping` side effect.
-- The FK cascade keeps the index clean when an instance is hard-deleted;
-- soft-deletes (status=cancelled) leave the mapping in place intentionally
-- so late-arriving review webhooks don't 500.

CREATE TABLE IF NOT EXISTS pr_instance_index (
  pr_url      TEXT        NOT NULL,
  instance_id TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pr_instance_index_pkey PRIMARY KEY (pr_url),
  CONSTRAINT pr_instance_index_instance_fk
    FOREIGN KEY (instance_id) REFERENCES pipeline_instances (id) ON DELETE CASCADE
);

-- Reverse lookup: "which PRs has this instance opened?" (used by the
-- max-iteration guard when we want to inspect prior review cycles).
CREATE INDEX IF NOT EXISTS idx_pr_instance_index_instance
  ON pr_instance_index (instance_id);
