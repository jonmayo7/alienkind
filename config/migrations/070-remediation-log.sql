-- Remediation log — tracks autonomous infrastructure fixes
-- Every fix: what broke, what was done, when, what mode, outcome
CREATE TABLE IF NOT EXISTS remediation_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_type TEXT NOT NULL,          -- listener_crash, stale_lock, dead_session, log_bloat, service_down
  issue_description TEXT NOT NULL,
  action_taken TEXT NOT NULL,        -- restart_service, clear_lock, rotate_session, truncate_log
  mode TEXT NOT NULL,                -- operator or builder (what mode the remediation ran in)
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failed', 'escalated')),
  escalation_reason TEXT,            -- if outcome=escalated, why (needs code change, needs [HUMAN])
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_remediation_log_created ON remediation_log (created_at DESC);
ALTER TABLE remediation_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'remediation_log' AND policyname = 'service_role_full_access') THEN
    CREATE POLICY "service_role_full_access" ON remediation_log FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
