-- Migration 037: Enable RLS on all exposed tables
-- Found by pentest-scan.ts: 6 tables readable via anon key
-- Policy: service_role gets full access, anon gets nothing

-- security_audit_log
ALTER TABLE security_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON security_audit_log
  FOR ALL USING (auth.role() = 'service_role');

-- conversations
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON conversations
  FOR ALL USING (auth.role() = 'service_role');

-- intents
ALTER TABLE intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON intents
  FOR ALL USING (auth.role() = 'service_role');

-- deferred_actions
ALTER TABLE deferred_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON deferred_actions
  FOR ALL USING (auth.role() = 'service_role');

-- content_performance
ALTER TABLE content_performance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON content_performance
  FOR ALL USING (auth.role() = 'service_role');

-- social_growth
ALTER TABLE social_growth ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON social_growth
  FOR ALL USING (auth.role() = 'service_role');
