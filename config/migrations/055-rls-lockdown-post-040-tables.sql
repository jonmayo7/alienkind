-- Migration 055: RLS lockdown for tables created after migration 040
--
-- Problem: Pentest scan (2026-03-21) detected anon key can read deep_process_outputs.
-- Root cause: Migration 034 created deep_process_outputs WITHOUT enabling RLS.
-- Migration 040 listed it as "correct" — wrong assumption. "No permissive policy"
-- means nothing when RLS isn't enabled in the first place.
--
-- Full audit found 8 more tables with the same gap:
--   - deep_process_outputs (034): NO RLS — contains security findings, vulnerability details
--   - daily_events (047): RLS enabled but USING(true) policy — anon can read
--   - system_events (051): NO RLS — VGE event store
--   - pipeline_traces (051): NO RLS — pipeline observability
--   - facts (051): NO RLS — knowledge graph with provenance
--   - fact_edges (051): NO RLS — knowledge graph relationships
--   - pipeline_fitness (051): NO RLS — AIRE health metrics
--   - cross_repo_patterns (052): NO RLS — cross-repo learnings
--
-- Fix: ENABLE + FORCE on all tables. Drop USING(true) policies.
-- service_role bypasses RLS natively — no explicit policy needed.
--
-- IMPORTANT: Run this in Supabase SQL Editor as a single transaction.

BEGIN;

-- ============================================================
-- 1. deep_process_outputs (CRITICAL — confirmed data leak)
-- ============================================================
-- NOTE: Migration 034 created a "service_full_access" policy with roles={public},
-- USING(true) — which grants anon full access even with RLS enabled.
-- ENABLE+FORCE alone is insufficient when a permissive policy exists.
-- Applied manually 2026-03-22 04:45 UTC.
DROP POLICY IF EXISTS "service_full_access" ON deep_process_outputs;
ALTER TABLE deep_process_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE deep_process_outputs FORCE ROW LEVEL SECURITY;

-- ============================================================
-- 2. daily_events (fix USING(true) policy)
-- ============================================================
DROP POLICY IF EXISTS "daily_events_service_all" ON daily_events;
ALTER TABLE daily_events FORCE ROW LEVEL SECURITY;

-- ============================================================
-- 3. VGE tables (migration 051) — all missing RLS
-- ============================================================
ALTER TABLE system_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_events FORCE ROW LEVEL SECURITY;

ALTER TABLE pipeline_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_traces FORCE ROW LEVEL SECURITY;

ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts FORCE ROW LEVEL SECURITY;

ALTER TABLE fact_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE fact_edges FORCE ROW LEVEL SECURITY;

ALTER TABLE pipeline_fitness ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_fitness FORCE ROW LEVEL SECURITY;

-- ============================================================
-- 4. cross_repo_patterns (migration 052) — missing RLS
-- ============================================================
ALTER TABLE cross_repo_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_repo_patterns FORCE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================
-- VERIFICATION (run after migration)
-- ============================================================

-- 1. All tables should show relrowsecurity=true AND relforcerowsecurity=true
-- SELECT relname, relrowsecurity, relforcerowsecurity
-- FROM pg_class
-- WHERE relname IN (
--   'deep_process_outputs', 'daily_events',
--   'system_events', 'pipeline_traces', 'facts', 'fact_edges', 'pipeline_fitness',
--   'cross_repo_patterns'
-- )
-- ORDER BY relname;

-- 2. No USING(true) policies should exist on any of these tables
-- SELECT schemaname, tablename, policyname, permissive, qual
-- FROM pg_policies
-- WHERE tablename IN (
--   'deep_process_outputs', 'daily_events',
--   'system_events', 'pipeline_traces', 'facts', 'fact_edges', 'pipeline_fitness',
--   'cross_repo_patterns'
-- )
-- ORDER BY tablename;

-- 3. Run pentest scanner: npx tsx scripts/security/pentest-scan.ts
