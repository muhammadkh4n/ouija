-- Migration 002: Add assigned_agent_id to pipeline_instances
-- Stores the agent assigned via card assignment (manual trigger mode).
-- Used to override column mapping agentId when the card is later moved to a dispatch column.

ALTER TABLE pipeline_instances
  ADD COLUMN IF NOT EXISTS assigned_agent_id TEXT;
