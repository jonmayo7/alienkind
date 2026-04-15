-- ============================================================
-- MIGRATION 003: Database Roles + Channel Constraint Fix
-- THIS IS THE LAST MIGRATION YOU PASTE MANUALLY.
-- After this, Keel can run migrations via psql.
-- Date: 2026-02-18
-- ============================================================

-- ============================================================
-- PART 1: Fix conversations channel constraint (from migration 002)
-- ============================================================

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check CHECK (channel IN (
  'terminal',
  'telegram_dm',
  'telegram_group',
  'telegram_community',
  'heartbeat',
  'nightly',
  'web',
  'discord_dm',
  'discord_channel',
  'slack_dm',
  'slack_channel'
));

-- ============================================================
-- PART 2: Create keel_readonly role
-- Used for monitoring, debugging, verifying data.
-- Can SELECT on everything. Cannot INSERT, UPDATE, DELETE anything.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keel_readonly') THEN
    CREATE ROLE keel_readonly LOGIN PASSWORD '[DB_ROLE_PASSWORD]';
  END IF;
END
$$;

-- Grant connect and usage
GRANT CONNECT ON DATABASE postgres TO keel_readonly;
GRANT USAGE ON SCHEMA public TO keel_readonly;

-- Grant SELECT on all existing tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO keel_readonly;

-- Auto-grant SELECT on any future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO keel_readonly;

-- ============================================================
-- PART 3: Verify
-- ============================================================

-- Show roles created
SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = 'keel_readonly';
