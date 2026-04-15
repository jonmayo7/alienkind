-- Migration 037: Enable RLS on all exposed tables
-- Found by pentest-scan.ts: 6 tables readable via anon key
-- Policy: service_role gets full access, anon gets nothing

-- security_audit_log (created in 036 — safe)
ALTER TABLE security_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON security_audit_log
  FOR ALL USING (auth.role() = 'service_role');

-- conversations (created in 001 — safe)
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON conversations
  FOR ALL USING (auth.role() = 'service_role');

-- intents (created in 012/013 — safe)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'intents') THEN
    ALTER TABLE intents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "service_role_full_access" ON intents
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- deferred_actions (not created in included migrations — guard)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'deferred_actions') THEN
    ALTER TABLE deferred_actions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "service_role_full_access" ON deferred_actions
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- content_performance (not created in included migrations — guard)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'content_performance') THEN
    ALTER TABLE content_performance ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "service_role_full_access" ON content_performance
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- social_growth (not created in included migrations — guard)
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'social_growth') THEN
    ALTER TABLE social_growth ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "service_role_full_access" ON social_growth
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
