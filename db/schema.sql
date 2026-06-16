-- Browser Persona schema
-- PostgreSQL 14+

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Core recording
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recording_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  segmented_at  TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recording_sessions_user_started
  ON recording_sessions (user_id, started_at DESC);

-- Raw rrweb incremental events (append-only)
CREATE TABLE rrweb_events (
  id            BIGSERIAL PRIMARY KEY,
  session_id    UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  event_type    SMALLINT NOT NULL,
  timestamp_ms  BIGINT NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE INDEX idx_rrweb_events_session_ts
  ON rrweb_events (session_id, timestamp_ms);

-- ---------------------------------------------------------------------------
-- Normalized workflows (segmented from sessions)
-- ---------------------------------------------------------------------------

CREATE TYPE workflow_status AS ENUM (
  'raw',
  'intent_extracted'
);

CREATE TABLE workflows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  status          workflow_status NOT NULL DEFAULT 'raw',
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ NOT NULL,
  primary_domain  TEXT,
  step_count      INTEGER NOT NULL DEFAULT 0,
  fingerprint     TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflows_user_status ON workflows (user_id, status);

CREATE TABLE workflow_steps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  step_index      INTEGER NOT NULL,
  action          TEXT NOT NULL,
  target          JSONB NOT NULL DEFAULT '{}'::jsonb,
  value           JSONB,
  url             TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (workflow_id, step_index)
);

-- Semantic-only capture (extension captureMode=semantic; no rrweb payload)
CREATE TABLE session_semantic_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  step_index    INTEGER NOT NULL,
  action        TEXT NOT NULL,
  target        JSONB NOT NULL DEFAULT '{}'::jsonb,
  value         JSONB,
  url           TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (session_id, step_index)
);

CREATE INDEX idx_session_semantic_steps_session
  ON session_semantic_steps (session_id, step_index);

-- ---------------------------------------------------------------------------
-- Capabilities (approved intent workflows)
-- ---------------------------------------------------------------------------

CREATE TYPE capability_status AS ENUM ('approved', 'archived');

CREATE TABLE capabilities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          capability_status NOT NULL DEFAULT 'approved',
  name            TEXT NOT NULL,
  description     TEXT,
  category_path   TEXT[] NOT NULL DEFAULT '{}',
  parameters      JSONB NOT NULL DEFAULT '[]'::jsonb,
  step_template   JSONB NOT NULL,
  tasks           JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_workflow_id UUID REFERENCES workflows(id),
  risk_level      TEXT NOT NULL DEFAULT 'low',
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence      NUMERIC(4,3),
  llm_model       TEXT,
  llm_prompt_version TEXT,
  approved_at     TIMESTAMPTZ,
  approved_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_capabilities_user_status ON capabilities (user_id, status);
CREATE INDEX idx_capabilities_category ON capabilities USING GIN (category_path);

CREATE TABLE capability_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_id   UUID NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  parameters      JSONB NOT NULL DEFAULT '{}'::jsonb,
  task_results    JSONB NOT NULL DEFAULT '[]'::jsonb,
  planner_calls   INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_capability_runs_capability
  ON capability_runs (capability_id, finished_at DESC);

-- LLM intent proposals awaiting human review
CREATE TABLE intent_proposals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  proposal        JSONB NOT NULL,
  confidence      NUMERIC(4,3) NOT NULL,
  llm_model       TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  reviewed        BOOLEAN NOT NULL DEFAULT false,
  review_decision TEXT,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_intent_proposals_workflow_reviewed
  ON intent_proposals (workflow_id, reviewed);

-- ---------------------------------------------------------------------------
-- Domain allowlist / privacy
-- ---------------------------------------------------------------------------

CREATE TABLE recording_policies (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  allowed_domains TEXT[] NOT NULL DEFAULT '{}',
  block_input_names TEXT[] NOT NULL DEFAULT ARRAY['password','ssn','credit_card'],
  retention_days  INTEGER NOT NULL DEFAULT 30,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
