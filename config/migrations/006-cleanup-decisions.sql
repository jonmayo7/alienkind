-- Migration 006: Database cleanup decisions (Session 37)
--
-- 1. Purge canceled deferred_actions (if table exists)
-- 2. Drop sessions.duration_minutes (if column exists)

-- Purge canceled deferred_actions (conditional — table may not exist on fresh installs)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'deferred_actions') THEN
    DELETE FROM deferred_actions WHERE status = 'canceled';
  END IF;
END $$;

-- Drop unused duration_minutes column from sessions (IF EXISTS handles missing table/column)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'sessions') THEN
    ALTER TABLE sessions DROP COLUMN IF EXISTS duration_minutes;
  END IF;
END $$;
