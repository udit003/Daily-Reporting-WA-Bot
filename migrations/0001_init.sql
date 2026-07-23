-- 0001_init.sql — extensions, tables, indexes, constraints.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE teams (                       -- OPTIONAL reference metadata (not part of onboarding)
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                    SERIAL PRIMARY KEY,
  wa_id                 TEXT UNIQUE NOT NULL,          -- chat_id (1:1 JID); canonical identity
  phone                 TEXT UNIQUE NOT NULL,          -- normalized digits; auto-captured from JID; never asked
  name                  TEXT,
  team_id               INTEGER REFERENCES teams(id),  -- NULLABLE / optional; not set during onboarding
  is_manager            BOOLEAN NOT NULL DEFAULT false, -- DERIVED: flipped true when someone reports to them
  is_root               BOOLEAN NOT NULL DEFAULT false, -- CHANGE E: informational top-level marker; NOT unique (multiple roots allowed)
  manager_id            INTEGER REFERENCES users(id),
  onboarding_state      TEXT NOT NULL DEFAULT 'new',    -- new|ask_name|ask_manager|ask_pending_manager_phone|done
  pending_manager_phone TEXT,                          -- normalized digits
  last_reminder_sent_at TIMESTAMPTZ,                   -- for escalation cadence
  reminder_count_today  INTEGER NOT NULL DEFAULT 0,    -- reset when a new IST day starts
  reminder_day          DATE,                          -- IST day the count/last-sent belong to
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (manager_id IS NULL OR manager_id <> id)       -- no self-manager
);
CREATE INDEX idx_users_manager ON users(manager_id);
CREATE INDEX idx_users_pending_mgr ON users(pending_manager_phone);
-- CHANGE E: NO single-root unique index. Any number of users may be a top-level
-- root (manager_id NULL, is_root=true). Already-migrated DBs additionally run
-- migrations/0003_multi_root.sql which drops the historical uq_single_root index.

CREATE TABLE projects (
  id SERIAL PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  norm_name TEXT UNIQUE NOT NULL,        -- normalized; conflict-safe uniqueness
  aliases TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_projects_norm_trgm ON projects USING gin (norm_name gin_trgm_ops);

CREATE TABLE reports (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  report_date DATE NOT NULL,             -- FIXED IST day
  raw_transcript TEXT NOT NULL,          -- Whisper transcript (voice) OR original text body
  structured_json JSONB NOT NULL,
  source_kind TEXT NOT NULL,             -- 'voice' | 'audio' | 'text'
  language TEXT,                         -- detected (voice) | 'text-provided' | NULL
  source_message_id TEXT UNIQUE NOT NULL, -- Whapi message id; dedup (text and voice alike)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reports_user_date ON reports(user_id, report_date);

CREATE TABLE report_projects (
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  PRIMARY KEY (report_id, project_id)
);

CREATE TABLE inbound_messages (
  id SERIAL PRIMARY KEY,
  whapi_message_id TEXT UNIQUE NOT NULL, -- idempotency key
  wa_id TEXT NOT NULL,
  batch_seq INTEGER NOT NULL,            -- preserves messages[] order
  raw JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',-- pending|processing|done|failed
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX idx_inbound_pending ON inbound_messages(status, received_at);

CREATE TABLE settings (                    -- runtime-configurable key/value (reminder schedule)
  key   TEXT PRIMARY KEY,                  -- reminder_start | reminder_interval_min | reminder_stop
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
