-- Migration 048: Fix RLS bypass on learning_ledger
--
-- Problem: Pentest scan (2026-03-11) found anon key can read the table.
-- Root cause: Migration 040 explicitly skipped this table with incorrect
-- assessment: labeled "renamed/superseded" — table exists and has data.
--
-- Original migration (018) created policies with USING (true)
-- which grants access to ALL roles including anon.
--
-- Fix: Same nuclear approach as migration 040 — drop all policies, enable RLS,
-- force RLS. Service_role bypasses RLS natively.
--
-- IMPORTANT: Run this in Supabase SQL Editor as a single transaction.
-- URL: https://supabase.com/dashboard/project/[SUPABASE_PROJECT_ID]/sql/new

BEGIN;

-- learning_ledger
DROP POLICY IF EXISTS "Allow service role full access" ON learning_ledger;
DROP POLICY IF EXISTS "Allow all for authenticated" ON learning_ledger;
DROP POLICY IF EXISTS "service_role_full_access" ON learning_ledger;
ALTER TABLE learning_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_ledger FORCE ROW LEVEL SECURITY;

COMMIT;

-- VERIFICATION (run after migration):
--
-- 1. Should return 0 rows — no permissive policies remain
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd
-- FROM pg_policies
-- WHERE tablename = 'learning_ledger'
-- ORDER BY policyname;
--
-- 2. Should show rowsecurity=true AND forcerowsecurity=true
-- SELECT relname, relrowsecurity, relforcerowsecurity
-- FROM pg_class
-- WHERE relname = 'learning_ledger';
--
-- 3. Run pentest scanner: npx tsx scripts/security/pentest-scan.ts
