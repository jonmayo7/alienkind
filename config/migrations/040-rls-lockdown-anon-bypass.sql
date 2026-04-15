-- Migration 040: Definitive RLS lockdown — close anon key bypass on ALL tables
--
-- Problem: Pentest scan (pentest-scan.ts) confirmed anon key can read 6 tables:
--   security_audit_log, conversations, intents, deferred_actions,
--   content_performance, social_growth
--
-- Root cause: Original table creation policies used USING (true) which grants
-- access to ALL roles including anon, despite policy names like "Allow all for
-- authenticated" or "Allow service role full access". Migration 037/037b
-- attempted to fix this but either wasn't fully applied or missed policies.
--
-- Scope: Fixes the 6 reported tables PLUS 9 additional tables found with the
-- same USING (true) vulnerability in migration history:
--   case_studies, podcast_episodes, memory_chunks, keel_predictions,
--   keel_outcomes, keel_experiences, content_feedback, review_messages,
--   mistakes
-- (learning_ledger and proposals were renamed/superseded — included for safety)
--
-- Fix: Nuclear approach — drop ALL policies on each table, re-enable RLS,
-- FORCE RLS (blocks even table owner), leave zero permissive policies.
-- Service_role bypasses RLS natively in Supabase (it's a superuser role),
-- so no explicit policy is needed for our backend scripts.
--
-- NOTE on FORCE ROW LEVEL SECURITY: This makes RLS apply even to the table
-- owner (postgres role). Our scripts use service_role which bypasses RLS
-- regardless of FORCE. This is defense-in-depth.
--
-- Tables with CORRECT RLS already (not touched here):
--   articles (has anon_read_published policy — intentional public access)
--   article_subscribers (uses auth.role() = 'service_role' check — correct)
--   perspectives_copublish (uses auth.role() = 'service_role' check — correct)
--   deep_process_outputs (created without permissive policy)
--
-- !! ERRATA (found 2026-03-13, pentest-scan finding):
--   social_drafts was listed as "correct" but actually uses USING (true) — VULNERABLE
--   learning_ledger was listed as "renamed/superseded" but table exists with data — VULNERABLE
--   Both fixed in migration 048.
--
-- Verification: Run `npx tsx scripts/security/pentest-scan.ts` after applying.
-- All tables should return empty arrays (not rows) via anon key.
--
-- IMPORTANT: Run this in Supabase SQL Editor as a single transaction.
-- URL: https://supabase.com/dashboard/project/[SUPABASE_PROJECT_ID]/sql/new

BEGIN;

-- ============================================================
-- PART 1: The 6 tables flagged by pentest scanner
-- ============================================================

-- 1. security_audit_log
DROP POLICY IF EXISTS "Allow insert for authenticated" ON security_audit_log;
DROP POLICY IF EXISTS "Allow select for authenticated" ON security_audit_log;
DROP POLICY IF EXISTS "service_role_full_access" ON security_audit_log;
DROP POLICY IF EXISTS "Allow all for authenticated" ON security_audit_log;
DROP POLICY IF EXISTS "Allow service role full access" ON security_audit_log;
ALTER TABLE security_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_audit_log FORCE ROW LEVEL SECURITY;

-- 2. conversations
DROP POLICY IF EXISTS "Allow all for authenticated" ON conversations;
DROP POLICY IF EXISTS "service_role_full_access" ON conversations;
DROP POLICY IF EXISTS "Allow service role full access" ON conversations;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;

-- 3. intents
DROP POLICY IF EXISTS "Allow all for authenticated" ON intents;
DROP POLICY IF EXISTS "Allow service role full access" ON intents;
DROP POLICY IF EXISTS "service_role_full_access" ON intents;
ALTER TABLE intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE intents FORCE ROW LEVEL SECURITY;

-- 4. deferred_actions
DROP POLICY IF EXISTS "Allow all for authenticated" ON deferred_actions;
DROP POLICY IF EXISTS "service_role_full_access" ON deferred_actions;
DROP POLICY IF EXISTS "Allow service role full access" ON deferred_actions;
ALTER TABLE deferred_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deferred_actions FORCE ROW LEVEL SECURITY;

-- 5. content_performance
DROP POLICY IF EXISTS "Allow all for authenticated" ON content_performance;
DROP POLICY IF EXISTS "service_role_full_access" ON content_performance;
DROP POLICY IF EXISTS "Allow service role full access" ON content_performance;
ALTER TABLE content_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_performance FORCE ROW LEVEL SECURITY;

-- 6. social_growth
DROP POLICY IF EXISTS "Allow all for authenticated" ON social_growth;
DROP POLICY IF EXISTS "service_role_full_access" ON social_growth;
DROP POLICY IF EXISTS "Allow service role full access" ON social_growth;
ALTER TABLE social_growth ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_growth FORCE ROW LEVEL SECURITY;

-- ============================================================
-- PART 2: Additional tables with same USING (true) vulnerability
-- ============================================================

-- 7. case_studies (migration 010)
DROP POLICY IF EXISTS "Allow all for authenticated" ON case_studies;
DROP POLICY IF EXISTS "service_role_full_access" ON case_studies;
DROP POLICY IF EXISTS "Allow service role full access" ON case_studies;
ALTER TABLE case_studies ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_studies FORCE ROW LEVEL SECURITY;

-- 8. podcast_episodes (migration 009)
DROP POLICY IF EXISTS "Allow all for authenticated" ON podcast_episodes;
DROP POLICY IF EXISTS "service_role_full_access" ON podcast_episodes;
DROP POLICY IF EXISTS "Allow service role full access" ON podcast_episodes;
ALTER TABLE podcast_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE podcast_episodes FORCE ROW LEVEL SECURITY;

-- 9. memory_chunks (migration 004)
DROP POLICY IF EXISTS "Allow all for authenticated" ON memory_chunks;
DROP POLICY IF EXISTS "service_role_full_access" ON memory_chunks;
DROP POLICY IF EXISTS "Allow service role full access" ON memory_chunks;
ALTER TABLE memory_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_chunks FORCE ROW LEVEL SECURITY;

-- 10. keel_predictions (migration 008)
DROP POLICY IF EXISTS "Allow all for authenticated" ON keel_predictions;
DROP POLICY IF EXISTS "service_role_full_access" ON keel_predictions;
DROP POLICY IF EXISTS "Allow service role full access" ON keel_predictions;
ALTER TABLE keel_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE keel_predictions FORCE ROW LEVEL SECURITY;

-- 11. keel_outcomes (migration 008)
DROP POLICY IF EXISTS "Allow all for authenticated" ON keel_outcomes;
DROP POLICY IF EXISTS "service_role_full_access" ON keel_outcomes;
DROP POLICY IF EXISTS "Allow service role full access" ON keel_outcomes;
ALTER TABLE keel_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE keel_outcomes FORCE ROW LEVEL SECURITY;

-- 12. keel_experiences (migration 008)
DROP POLICY IF EXISTS "Allow all for authenticated" ON keel_experiences;
DROP POLICY IF EXISTS "service_role_full_access" ON keel_experiences;
DROP POLICY IF EXISTS "Allow service role full access" ON keel_experiences;
ALTER TABLE keel_experiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE keel_experiences FORCE ROW LEVEL SECURITY;

-- 13. content_feedback (migration 011)
DROP POLICY IF EXISTS "Allow all for authenticated" ON content_feedback;
DROP POLICY IF EXISTS "Allow service role full access" ON content_feedback;
DROP POLICY IF EXISTS "service_role_full_access" ON content_feedback;
ALTER TABLE content_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_feedback FORCE ROW LEVEL SECURITY;

-- 14. review_messages (migration 016)
DROP POLICY IF EXISTS "Allow all for authenticated" ON review_messages;
DROP POLICY IF EXISTS "Allow service role full access" ON review_messages;
DROP POLICY IF EXISTS "service_role_full_access" ON review_messages;
ALTER TABLE review_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_messages FORCE ROW LEVEL SECURITY;

-- 15. mistakes (migration 019)
DROP POLICY IF EXISTS "Allow all for authenticated" ON mistakes;
DROP POLICY IF EXISTS "Allow service role full access" ON mistakes;
DROP POLICY IF EXISTS "service_role_full_access" ON mistakes;
ALTER TABLE mistakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mistakes FORCE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================
-- VERIFICATION QUERIES (run after migration)
-- ============================================================

-- 1. Should return 0 rows — no permissive policies on any of these tables
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd
-- FROM pg_policies
-- WHERE tablename IN (
--   'security_audit_log', 'conversations', 'intents',
--   'deferred_actions', 'content_performance', 'social_growth',
--   'case_studies', 'podcast_episodes', 'memory_chunks',
--   'keel_predictions', 'keel_outcomes', 'keel_experiences',
--   'content_feedback', 'review_messages', 'mistakes'
-- )
-- ORDER BY tablename, policyname;

-- 2. Should show all tables with rowsecurity=true AND forcerowsecurity=true
-- SELECT relname, relrowsecurity, relforcerowsecurity
-- FROM pg_class
-- WHERE relname IN (
--   'security_audit_log', 'conversations', 'intents',
--   'deferred_actions', 'content_performance', 'social_growth',
--   'case_studies', 'podcast_episodes', 'memory_chunks',
--   'keel_predictions', 'keel_outcomes', 'keel_experiences',
--   'content_feedback', 'review_messages', 'mistakes'
-- )
-- ORDER BY relname;

-- 3. Run pentest scanner: npx tsx scripts/security/pentest-scan.ts
