-- Migration 006: Database cleanup decisions (Session 37)
--
-- 1. Purge 16 canceled deferred_actions (all dead records, 0 pending/completed)
-- 2. Drop sessions.duration_minutes (481/481 NULL, never populated)

-- Purge canceled deferred_actions
DELETE FROM deferred_actions WHERE status = 'canceled';

-- Drop unused duration_minutes column from sessions
ALTER TABLE sessions DROP COLUMN IF EXISTS duration_minutes;
