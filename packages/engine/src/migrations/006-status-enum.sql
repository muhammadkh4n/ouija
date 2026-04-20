-- 006-status-enum.sql
-- GENERATED FILE — do not edit by hand.
--
-- Source of truth: packages/types/src/state-machine.ts (PIPELINE_STATUSES).
-- Regenerate with: npm run gen:migrations
-- CI enforces no drift (.github/workflows/ci.yml → "check migration drift").
--
-- Tenet 4: one source of truth for the state enum (TypeScript generates SQL).
-- See Ouija/Details — Architectural Tenets.md.
--
-- This migration replaces the check constraint from 001-initial-schema.sql
-- with one that covers every current PipelineStatus tag. Drop-if-exists +
-- add is used (not alter) because check constraints don't support ALTER.

ALTER TABLE pipeline_instances
  DROP CONSTRAINT IF EXISTS pipeline_instances_status_check;

ALTER TABLE pipeline_instances
  ADD CONSTRAINT pipeline_instances_status_check
    CHECK (status IN (
    'awaiting_review',
    'cancelled',
    'dispatching',
    'failed',
    'idle',
    'provisioning',
    'running',
    'stalled',
    'succeeded'
    ));
