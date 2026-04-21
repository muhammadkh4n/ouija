-- Migration 007: session_log_path on pipeline_instances
--
-- Surface the absolute path to the claude-code NDJSON session log for each
-- dispatch. Populated by the stream-json runner from the first `system.init`
-- event's `session_id`, combined with the workspace endpoint and the agent's
-- HOME, using Claude CLI's path-encoding convention (slashes → dashes):
--
--   ${HOME}/.claude/projects/${encodedWorkspacePath}/${session_id}.jsonl
--
-- Stored as an instance-level scalar (not on state JSONB) because the value
-- is set once per dispatch and does not change across state transitions.
-- The orchestrator stamps it on save when the DispatchOutcome carries it
-- and the instance has no prior value — never overwrites an existing path.
--
-- Fixes friction-log item #22 ("agent session logs buried, users can't reach them").

ALTER TABLE pipeline_instances
  ADD COLUMN IF NOT EXISTS session_log_path TEXT;
