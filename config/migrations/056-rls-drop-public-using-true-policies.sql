-- Migration 056: Drop USING(true) policies on {public} role
--
-- Root cause: Multiple tables had RLS ENABLED + FORCE but also had permissive
-- policies like "service_full_access" or "Allow all for authenticated" that
-- granted access to the {public} role (which includes anon) with USING(true).
-- This completely negated RLS — anyone with the anon key had full access.
--
-- The naming was deceptive: "service_full_access" sounds like it restricts to
-- service_role, but the actual role was {public}. Similarly, "Allow all for
-- authenticated" sounds like it requires auth, but {public} includes anon.
--
-- Detected: Pentest scan 2026-03-22 flagged deep_process_outputs (critical).
-- Full sweep found 13 additional tables with the same pattern.
--
-- Applied manually: 2026-03-22 ~04:50 UTC
-- Tables fixed in this migration:
--   1. deep_process_outputs — security findings (CRITICAL — confirmed data leak)
--   2. portfolio_snapshots — trading portfolio data
--   3. signals — trading signal data
--   4. strategy_config — trading strategy parameters
--   5. trades — trade execution history
--   6. terminal_state — mycelium coordination state
--
-- Tables requiring [HUMAN] review before fixing (may have web app dependencies):
--   - coordination_requests, memories, patterns, sessions, timeline,
--     skill_metrics — may be used by [PRODUCT]/[PRODUCT] web frontends
--   - transcription_records — in pentest protected list but has {public} policy
--   - client_product_c_* (6 tables) — [CLIENT_PRODUCT_C] application tables, may need client access
--
-- service_role bypasses RLS natively — no explicit policy needed for backend.

BEGIN;

-- Already applied to deep_process_outputs (see migration 055 update)

DROP POLICY IF EXISTS "service_full_access" ON portfolio_snapshots;
ALTER TABLE portfolio_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_full_access" ON signals;
ALTER TABLE signals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_full_access" ON strategy_config;
ALTER TABLE strategy_config FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_full_access" ON trades;
ALTER TABLE trades FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON terminal_state;
ALTER TABLE terminal_state FORCE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================
-- REMAINING TABLES NEEDING REVIEW (not auto-fixed — may break web apps)
-- ============================================================
-- Run these ONLY after confirming no web frontend reads via anon/authenticated key:
--
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON coordination_requests;
-- ALTER TABLE coordination_requests FORCE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON memories;
-- ALTER TABLE memories FORCE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON patterns;
-- ALTER TABLE patterns FORCE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON transcription_records;
-- ALTER TABLE transcription_records FORCE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON client_product_c_ai_assessments;
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON client_product_c_decisions;
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON client_product_c_human_scores;
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON client_product_c_organizations;
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON client_product_c_projects;
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON client_product_c_recommendations;
--
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON sessions;
-- ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON skill_metrics;
-- ALTER TABLE skill_metrics FORCE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS "Allow all for authenticated" ON timeline;
-- ALTER TABLE timeline FORCE ROW LEVEL SECURITY;

-- ============================================================
-- VERIFICATION
-- ============================================================
-- Should return 0 rows for fixed tables:
-- SELECT tablename, policyname, roles FROM pg_policies
-- WHERE tablename IN ('deep_process_outputs','portfolio_snapshots','signals','strategy_config','trades','terminal_state')
-- AND roles::text LIKE '%public%';
