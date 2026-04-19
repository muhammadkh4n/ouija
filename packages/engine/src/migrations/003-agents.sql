-- Migration 003: Agents table — dashboard-driven agent CRUD
--
-- Stores AgentProfileConfig as JSONB (schema-flexible, validated at write time by ajv)
-- alongside an AES-256-GCM encrypted secrets_vault for per-agent credentials
-- (ANTHROPIC_API_KEY, AWS_ACCESS_KEY_ID, etc). The YAML file remains a valid
-- alternative source; the server prefers DB rows when both exist.
--
-- active=false is a soft delete — pipelines that reference an old agent still
-- resolve a name/email for timeline display but won't dispatch. Hard delete is
-- deferred until we have a retention/archival policy.

CREATE TABLE IF NOT EXISTS agents (
  id             TEXT        NOT NULL,
  config_json    JSONB       NOT NULL,
  -- Encrypted blob: {"iv":"base64","tag":"base64","ciphertext":"base64","fields":["ANTHROPIC_API_KEY",...]}
  -- Null when the agent only uses env-var-based secretRefs and no values are
  -- provisioned through the dashboard.
  secrets_vault  JSONB,
  active         BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT agents_pkey PRIMARY KEY (id)
);

-- Efficient lookup: "list all active agents" — the dashboard's default query.
CREATE INDEX IF NOT EXISTS idx_agents_active
  ON agents (active) WHERE active = true;
