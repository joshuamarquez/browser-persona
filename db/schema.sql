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
  user_agent    TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recording_sessions_user_started
  ON recording_sessions (user_id, started_at DESC);

-- Raw rrweb incremental events (append-only)
CREATE TABLE rrweb_events (
  id            BIGSERIAL PRIMARY KEY,
  session_id    UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,              -- order within session
  event_type    SMALLINT NOT NULL,             -- rrweb EventType
  timestamp_ms  BIGINT NOT NULL,               -- rrweb event timestamp
  payload       JSONB NOT NULL,                -- full rrweb event object
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE INDEX idx_rrweb_events_session_ts
  ON rrweb_events (session_id, timestamp_ms);

-- ---------------------------------------------------------------------------
-- Normalized workflows (segmented from sessions)
-- ---------------------------------------------------------------------------

CREATE TYPE workflow_status AS ENUM (
  'raw',           -- segmented, not yet mined
  'candidate',     -- matched by pattern miner
  'labeled',       -- LLM proposal exists
  'approved',      -- human approved
  'rejected'
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
  fingerprint     TEXT,                        -- hash of normalized step sequence
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflows_user_status ON workflows (user_id, status);
CREATE INDEX idx_workflows_fingerprint ON workflows (fingerprint);

-- Semantic steps extracted from rrweb (replay-oriented, not pixel replay)
CREATE TABLE workflow_steps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  step_index      INTEGER NOT NULL,
  action          TEXT NOT NULL,               -- navigate | click | fill | select | scroll | wait | submit
  target          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- selectors, role, text, aria-label
  value           JSONB,                       -- input value (redacted if sensitive)
  url             TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL,
  source_event_ids BIGINT[] DEFAULT '{}',      -- rrweb_events.id refs
  UNIQUE (workflow_id, step_index)
);

-- ---------------------------------------------------------------------------
-- Pattern mining + capabilities
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_patterns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint     TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  example_workflow_id UUID REFERENCES workflows(id),
  step_template   JSONB NOT NULL,              -- normalized step sequence template
  domains         TEXT[] NOT NULL DEFAULT '{}',
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);

CREATE TYPE capability_status AS ENUM ('draft', 'approved', 'archived');

CREATE TABLE capabilities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern_id      UUID REFERENCES workflow_patterns(id),
  status          capability_status NOT NULL DEFAULT 'draft',
  name            TEXT NOT NULL,
  description     TEXT,
  category_path   TEXT[] NOT NULL DEFAULT '{}',  -- e.g. {'Reporting','Sales'}
  parameters      JSONB NOT NULL DEFAULT '[]'::jsonb,
  step_template   JSONB NOT NULL,                -- parameterized steps for Playwright
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

-- LLM labeling proposals (audit trail + human review)
CREATE TABLE labeling_proposals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  pattern_id      UUID REFERENCES workflow_patterns(id),
  proposal        JSONB NOT NULL,              -- full LLM JSON output
  confidence      NUMERIC(4,3) NOT NULL,
  llm_model       TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  reviewed        BOOLEAN NOT NULL DEFAULT false,
  review_decision TEXT,                        -- approve | edit | reject
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Map workflows to patterns (many workflows -> one pattern)
CREATE TABLE workflow_pattern_members (
  pattern_id      UUID NOT NULL REFERENCES workflow_patterns(id) ON DELETE CASCADE,
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  PRIMARY KEY (pattern_id, workflow_id)
);

-- ---------------------------------------------------------------------------
-- Domain allowlist / privacy
-- ---------------------------------------------------------------------------

CREATE TABLE recording_policies (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  allowed_domains TEXT[] NOT NULL DEFAULT '{}',  -- empty = all (dev only)
  block_input_names TEXT[] NOT NULL DEFAULT ARRAY['password','ssn','credit_card'],
  retention_days  INTEGER NOT NULL DEFAULT 30,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
