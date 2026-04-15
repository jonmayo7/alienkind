-- Migration 036: Immutable security audit log
-- The agent CANNOT modify or delete entries. Even service_role is blocked by triggers.

CREATE TABLE IF NOT EXISTS security_audit_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action_type TEXT NOT NULL,
  target TEXT,
  parameters JSONB DEFAULT '{}',
  context_hash TEXT,
  session_id TEXT,
  source TEXT NOT NULL DEFAULT 'unknown',
  severity TEXT NOT NULL DEFAULT 'info',
  outcome TEXT DEFAULT 'success'
);

-- Index for time-range queries (primary access pattern)
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON security_audit_log (created_at DESC);
-- Index for filtering by action type
CREATE INDEX IF NOT EXISTS idx_audit_log_action_type ON security_audit_log (action_type);
-- Index for severity-based queries
CREATE INDEX IF NOT EXISTS idx_audit_log_severity ON security_audit_log (severity) WHERE severity IN ('warn', 'critical');

-- IMMUTABLE ENFORCEMENT: Prevent UPDATE and DELETE even for service_role
-- Service role bypasses RLS, but cannot bypass BEFORE triggers that RAISE EXCEPTION
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'security_audit_log is immutable. Updates and deletes are not allowed.';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_immutable_update
  BEFORE UPDATE ON security_audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

CREATE TRIGGER audit_immutable_delete
  BEFORE DELETE ON security_audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

-- RLS enabled but open for insert (defense in depth — triggers are the real gate)
ALTER TABLE security_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow insert for authenticated" ON security_audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow select for authenticated" ON security_audit_log FOR SELECT USING (true);
