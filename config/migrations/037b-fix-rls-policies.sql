-- Migration 037b: Fix RLS policies — drop overly permissive public policies
-- The previous "Allow all for authenticated" policies grant access to ALL roles including anon
-- We need: ONLY service_role has access (which bypasses RLS anyway, but be explicit)

-- Drop all existing policies on these tables and recreate correctly
-- security_audit_log (created in 036 — safe)
DROP POLICY IF EXISTS "Allow select for authenticated" ON security_audit_log;
DROP POLICY IF EXISTS "Allow insert for authenticated" ON security_audit_log;
DROP POLICY IF EXISTS "service_role_full_access" ON security_audit_log;

-- conversations (created in 001 — safe)
DROP POLICY IF EXISTS "Allow all for authenticated" ON conversations;
DROP POLICY IF EXISTS "service_role_full_access" ON conversations;

-- intents (created in 012/013 — guard)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'intents') THEN
    DROP POLICY IF EXISTS "Allow all for authenticated" ON intents;
    DROP POLICY IF EXISTS "Allow service role full access" ON intents;
    DROP POLICY IF EXISTS "service_role_full_access" ON intents;
  END IF;
END $$;

-- deferred_actions (not created in included migrations — guard)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'deferred_actions') THEN
    DROP POLICY IF EXISTS "Allow all for authenticated" ON deferred_actions;
    DROP POLICY IF EXISTS "service_role_full_access" ON deferred_actions;
  END IF;
END $$;

-- content_performance (not created in included migrations — guard)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'content_performance') THEN
    DROP POLICY IF EXISTS "Allow all for authenticated" ON content_performance;
    DROP POLICY IF EXISTS "service_role_full_access" ON content_performance;
  END IF;
END $$;

-- social_growth (not created in included migrations — guard)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'social_growth') THEN
    DROP POLICY IF EXISTS "Allow all for authenticated" ON social_growth;
    DROP POLICY IF EXISTS "service_role_full_access" ON social_growth;
  END IF;
END $$;

-- With RLS enabled and no permissive policies, anon key gets NOTHING.
-- Service role bypasses RLS by default, so no policy needed for it.
-- If we later need authenticated user access, add policies scoped to 'authenticated' role.
