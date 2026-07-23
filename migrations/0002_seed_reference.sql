-- 0002_seed_reference.sql — optional reference rows.
--
-- The primary, idempotent seed lives in scripts/seed.ts (projects, optional
-- teams, settings defaults, optional demo CEO). This migration is intentionally
-- minimal: it only guarantees the reminder `settings` rows exist with sane
-- defaults so the reminder cron has values to read even before `npm run seed`.
-- All statements are conflict-safe and therefore idempotent.

INSERT INTO settings (key, value) VALUES
  ('reminder_start', '17:00'),
  ('reminder_interval_min', '15'),
  ('reminder_stop', '22:00')
ON CONFLICT (key) DO NOTHING;
