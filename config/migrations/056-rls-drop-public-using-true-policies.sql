-- Migration 056: Drop USING(true) policies on {public} role
--
-- Root cause: Multiple tables had RLS ENABLED + FORCE but also had permissive
-- policies like "service_full_access" or "Allow all for authenticated" that
-- granted access to the {public} role (which includes anon) with USING(true).
-- This completely negated RLS — anyone with the anon key had full access.
--
-- Detected: Pentest scan 2026-03-22 flagged deep_process_outputs (critical).
-- Full sweep found 13 additional tables with the same pattern.
--
-- service_role bypasses RLS natively — no explicit policy needed for backend.

BEGIN;

-- Already applied to deep_process_outputs (see migration 055 update)

-- portfolio_snapshots (not created in included migrations — guard)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'portfolio_snapshots') THEN
    DROP POLICY IF EXISTS "service_full_access" ON portfolio_snapshots;
    ALTER TABLE portfolio_snapshots FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

-- signals (not created in included migrations — guard)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'signals') THEN
    DROP POLICY IF EXISTS "service_full_access" ON signals;
    ALTER TABLE signals FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

-- strategy_config (not created in included migrations — guard)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'strategy_config') THEN
    DROP POLICY IF EXISTS "service_full_access" ON strategy_config;
    ALTER TABLE strategy_config FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

-- trades (not created in included migrations — guard)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'trades') THEN
    DROP POLICY IF EXISTS "service_full_access" ON trades;
    ALTER TABLE trades FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

-- terminal_state (created in 032 — safe)
DROP POLICY IF EXISTS "Service role full access" ON terminal_state;
ALTER TABLE terminal_state FORCE ROW LEVEL SECURITY;

COMMIT;
