-- 005-expand-status-check.sql
-- The original check constraint on pipeline_instances.status was missing two
-- valid states from the state machine: 'provisioning' (after dispatch, before
-- agent acknowledges) and 'awaiting_review' (after agent opens a PR, before
-- reviewer feedback). Any attempt to persist those states crashed with:
--
--   violates check constraint "pipeline_instances_status_check"
--
-- Drop the old constraint and add a complete one.

ALTER TABLE pipeline_instances
  DROP CONSTRAINT IF EXISTS pipeline_instances_status_check;

ALTER TABLE pipeline_instances
  ADD CONSTRAINT pipeline_instances_status_check
    CHECK (status IN (
      'idle',
      'dispatching',
      'provisioning',
      'running',
      'awaiting_review',
      'succeeded',
      'failed',
      'stalled',
      'cancelled'
    ));
