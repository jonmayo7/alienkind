-- ============================================================
-- MIGRATION 003: Containment Field Database Roles
-- Creates the database-level defense-in-depth layer for containment fields.
-- Containment fields are enforced at THREE layers: hooks (guard-bash.sh),
-- engine (consciousness-engine.ts sessionMode checks), and DB role (this file).
-- Losing any one layer weakens defense-in-depth.
--
-- THIS IS THE LAST MIGRATION YOU PASTE MANUALLY.
-- After this, future migrations can run via psql.
-- ============================================================

-- ============================================================
-- PART 1: Confirm conversations channel constraint (re-applied from 002 for safety)
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
-- PART 2: Create partner_readonly role — containment field at DB layer
-- Used for monitoring, debugging, verifying data.
-- Can SELECT on everything. Cannot INSERT, UPDATE, DELETE anything.
-- Forkers: replace the password below with a secure value before running.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'partner_readonly') THEN
    CREATE ROLE partner_readonly LOGIN PASSWORD 'CHANGE_ME_BEFORE_RUNNING';
  END IF;
END
$$;

-- Grant connect and usage
GRANT CONNECT ON DATABASE postgres TO partner_readonly;
GRANT USAGE ON SCHEMA public TO partner_readonly;

-- Grant SELECT on all existing tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO partner_readonly;

-- Auto-grant SELECT on any future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO partner_readonly;

-- ============================================================
-- PART 3: Verify
-- ============================================================

-- Show role created
SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = 'partner_readonly';
