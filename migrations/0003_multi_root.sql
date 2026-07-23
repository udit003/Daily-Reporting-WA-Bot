-- 0003_multi_root.sql — CHANGE E: allow any number of top-level roots.
--
-- The original 0001 schema created a partial unique index (`uq_single_root`)
-- that permitted at most one completed root. CHANGE E makes `is_root` an
-- informational top-level marker only: multiple users may have
-- `manager_id = NULL` and `is_root = true`, each heading their own subtree.
-- Dropping the index is idempotent and safe on both fresh and already-migrated
-- databases.
DROP INDEX IF EXISTS uq_single_root;
