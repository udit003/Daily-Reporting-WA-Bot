-- CXO seed reference (pre-known top-level executives).
--
-- When a user onboards and the name they type matches a known CXO, they are
-- auto-elevated to a top-level root (is_root = true, manager_id = NULL) and
-- skip the manager picker. Matching is done on `norm_name`, which is
-- case-, whitespace- and punctuation-insensitive (see src/util/name.ts), so
-- "gopal narang", "Gopal  Narang" and "Gopal Narang" all match.
--
-- Names are seeded idempotently by scripts/seed.ts (default: Gopal Narang,
-- Advait Narang, Soham Narang). Add more CXOs there.
CREATE TABLE IF NOT EXISTS cxos (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,          -- canonical display name
  norm_name  TEXT UNIQUE NOT NULL,   -- normalized match key
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (norm_name <> '')            -- never seed an empty key (would match punctuation-only input)
);
